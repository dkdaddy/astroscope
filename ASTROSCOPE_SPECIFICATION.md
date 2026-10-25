# System Architecture & Technical Specification Document
## Project: AstroScope Remote Capture, Manual Focus & Mount Controller
**Target Hardware:** ZWO ASI678MC | Host: Linux / Raspberry Pi (arm64), macOS (arm64/x64) & Windows (x64) | Remote Client: Modern Web Browser  
**Status:** Approved for Implementation | **Document Version:** 1.1.0  

---

## 1. Executive Summary & Vision

The objective of this project is to build a responsive, cross-platform, web-accessible astrophotography capture and mount control application tailored for the **ZWO ASI678MC** (Sony IMX678 sensor), coupled with a high-fidelity **Synthetic Physics Mock Camera** so full development, UI validation, and focus/stacking testing can be performed without physical hardware attached.

The system provides:
1. **Low-latency live preview & manual focus assistance** (real-time sub-frame ROI extraction, Bayer-aware luminance extraction, and Laplacian variance / HFR sharpness calculation).
2. **Uncompressed Lucky Imaging recording** directly to standard `.ser` v3 format (with microsecond per-frame timestamp trailers) at high framerates.
3. **Physics-Based Mock Camera Simulator** emulating IMX678 sensor physics (RGGB Bayer CFA, HCG read-noise step at Gain 182, shot & thermal dark current noise, atmospheric seeing turbulence, focus defocus PSF blur + interactive virtual focuser, planetary & star-field targets, and mount drift/jog response).
4. **Hardware abstraction and future extensibility** for telescope mount slewing/tracking (via standard INDI / Mock INDI protocols) and future Deep Sky Object (DSO) live stacking.

To enable rapid iteration without build toolchain friction, **Phase 1** is implemented as a single, modular **Node.js (TypeScript)** backend leveraging `koffi` (Foreign Function Interface) to bind the vendor's precompiled C library (`ASICamera2`), with automatic or configurable fallback to the `MockCameraDriver`. The architecture is strictly decoupled with clean interface boundaries, allowing zero-friction extraction into a high-performance **C++ sidecar daemon** in **Phase 2** when sustained, uncompressed 4K 47 FPS I/O and SIMD-accelerated DSO live stacking are required.

---

## 2. Hardware Profile & Operational Constraints

### 2.1 Sensor Profile: Sony IMX678 (ZWO ASI678MC)
* **Sensor Type:** 1/1.8" Color CMOS Back-Illuminated (Rolling Shutter).
* **Native Pixel Resolution:** $3840 \times 2160$ (8.29 Megapixels, 16:9).
* **Pixel Pitch:** $2.0\,\mu\text{m} \times 2.0\,\mu\text{m}$.
* **Bayer Filter Pattern:** `RGGB` (standard Bayer arrangement: Even row `R G`, Odd row `G B`).
* **Hardware ROI Constraints (ZWO SDK):**
  * `width` must be a multiple of 8 (`width % 8 === 0`).
  * `height` must be a multiple of 2 (`height % 2 === 0`).
  * `startX` and `startY` must be even (`% 2 === 0`) to preserve the `RGGB` Bayer phase.
* **ADC Resolution:** 12-bit native.
  * In `RAW8` mode: Sensor downscales/trims to 8 bits ($3840 \times 2160 \times 1 = 8{,}294{,}400\text{ bytes/frame} \approx 8.29\text{ MB}$).
  * In `RAW16` mode: Sensor packs 12 bits into 16-bit unsigned integers, left-shifted to 16-bit range $0\text{--}65535$ ($3840 \times 2160 \times 2 = 16{,}588{,}800\text{ bytes/frame} \approx 16.59\text{ MB}$).
* **Max Full-Resolution Frame Rates:**
  * 8-bit mode: Up to $47.5\text{ FPS}$ (Bandwidth: $\approx 394\text{ MB/s}$).
  * 12-bit packed in 16-bit: Up to $24.2\text{ FPS}$ (Bandwidth: $\approx 401\text{ MB/s}$).
* **Full Well Capacity:** $11.27\,k e^-$ at Gain 0.
* **Gain Behavior & HCG Switch:**
  * Gain range: 0 to 500 (in $0.1\text{ dB}$ steps inside the SDK: $\text{Gain}_{\text{linear}} = 10^{\text{Gain} / 200}$).
  * **Critical Switching Threshold:** **Gain 182**. At Gain 182, the sensor activates High Conversion Gain (HCG) mode. Read noise drops precipitously from $\approx 2.7\,e^-$ to $\approx 0.8\,e^-$, while maintaining an exceptional $\approx 10.5$ stops of dynamic range.

### 2.2 Host Environments & Storage Constraints
* **Development Workstation (macOS arm64/x64, Windows 11 x64, Linux x64):**
  * High single-thread performance, NVMe storage. Used for prototyping, desktop sessions, and Mock Camera development.
* **Telescope Host (Raspberry Pi 5 / 4 / arm64 Linux):**
  * **Pi 5:** Dedicated PCIe 2.0/3.0 lane supports an M.2 NVMe HAT. Dedicated RP1 I/O controller isolates USB 3.0 bus bandwidth. Can sustain continuous 400 MB/s disk writes without throttling.
  * **Pi 4:** USB 3.0 ports share a single PCIe lane (VL805 controller, capped at ~400 MB/s aggregate).
  * **Storage Rule:** Uncompressed lucky imaging MUST target local NVMe/SSD storage. Writing high-throughput lucky imaging directly to MicroSD cards is strictly forbidden.
  * **Network Rule:** 4K uncompressed streams over 2.4/5GHz Wi-Fi are physically impossible. The preview stream across the network is downsampled ($2\times2$ or $4\times4$ super-pixel binning) paired with a native $1:1$ crop of the active focus ROI so network bandwidth stays within 2–8 Mbps.

---

## 3. High-Level System Architecture & Phased Evolution

The system is designed with a strict **Hexagonal / Ports-and-Adapters** architecture. The core application logic does not depend on whether the camera driver is accessed via in-process FFI, the synthetic Mock Camera simulator, or out-of-process IPC.

### 3.1 Phase 1 Architecture: Pure Node.js & Koffi FFI (with Mock Camera Simulator)
* **Language & Runtime:** TypeScript / Node.js (v20+ LTS).
* **C SDK Binding:** Dynamic foreign function interface via `koffi` loading `ASICamera2.dll` (Windows), `libASICamera2.dylib` (macOS), or `libASICamera2.so` (Linux aarch64/x64). Zero native compilation or C++ build tools required. Automatically falls back to `MockCameraDriver` when `ASTROSCOPE_MOCK=1` or when no physical ZWO camera/SDK is present.
* **Concurrency Model:** A dedicated Node `worker_thread` executes the camera acquisition loop (`ASIGetVideoData()` or synthetic frame generation). Frames are transferred to the main thread via transferable `ArrayBuffer`s.
* **Network & Transport:**
  * Fastify for static SPA assets and HTTP REST endpoints.
  * `ws` (WebSockets) for bi-directional binary preview frames and JSON telemetry/commands.
* **Client-Side Heavy Lifting:** Bayer-aware luminance extraction and focus evaluation (Laplacian variance + star HFR) on an ROI is performed client-side on the browser canvas in TypeScript to preserve Pi CPU cycles.

```
+-----------------------------------------------------------------------------------------+
|                                    PHASE 1 RUNTIME                                      |
|                                                                                         |
|  +--------------------------------+                  +-------------------------------+  |
|  |     Camera Worker Thread       |                  |       Main Event Thread       |  |
|  |                                |                  |                               |  |
|  |  ICameraDriver:                |                  |  - Fastify HTTP Server        |  |
|  |  - ZwoKoffiDriver OR           |                  |  - WebSocket Hub (ws)         |  |
|  |    MockCameraDriver (Physics)  |                  |  - Mount Controller (INDI/Sim)|  |
|  |  - SER v3 Writer (+Timestamps) |  postMessage     |  - Telemetry State Store      |  |
|  |  - Preview Binning & 1:1 ROI   | ---------------> |                               |  |
|  +--------------------------------+ (TransArrayBuf) +---------------+---------------+  |
+----------------------------------------------------------------------|------------------+
                                                                       |
                                                                       | Local Wi-Fi (WS)
                                                                       v
+-----------------------------------------------------------------------------------------+
|                                  BROWSER CLIENT (SPA)                                   |
|                                                                                         |
|  - Canvas 2D / WebGL Viewport (RGGB Debayer / Auto-Stretch / Histogram)                 |
|  - 1:1 Native Resolution ROI Zoom PIP Window                                            |
|  - Client-Side Focus Calculator (Bayer Super-Pixel Luminance + Laplacian Variance)      |
|  - Focus Score History Sparkline (Peak & Current Score)                                 |
|  - Mount Virtual Hand Controller, Target Selector & Virtual Focuser Knob (Sim Mode)     |
+-----------------------------------------------------------------------------------------+
```

### 3.2 Phase 2 Architecture: C++ Sidecar Daemon (Zero-Copy & High FPS)
* **Trigger to Transition:** Transitioning from planetary/lunar ROI capture to sustained, full-resolution 4K 47 FPS recording on Raspberry Pi, or adding real-time DSO multi-star live stacking.
* **Implementation:** The `camera-worker.ts` is replaced by a standalone C++20 daemon executable (`asi_core`).
* **Inter-Process Communication (IPC):** Unix Domain Socket (UDS) on Linux/macOS or Named Pipes on Windows.
* **Storage Path:** C++ opens direct binary file descriptors (`O_DIRECT` / POSIX `write()`) to stream SER frames straight into NVMe disk blocks, completely bypassing the Node.js V8 heap and garbage collector.
* **Contract:** The protocol between Node.js and the UI remains 100% identical.

---

## 4. Key Design Decisions & Architectural Trade-offs

| Decision Point | Chosen Alternative | Rejected Alternative | Technical Rationale & Trade-off |
| :--- | :--- | :--- | :--- |
| **C Library Binding (Phase 1)** | `koffi` (Dynamic FFI) | `node-addon-api` / N-API C++ addon | **Rationale:** Zero-compilation setup. Works out of the box with `npm install` across Windows, macOS, and Linux Pi without `node-gyp`, Python build scripts, or C++ compilers. |
| **Worker Concurrency** | Dedicated `worker_threads` | Main event loop / asynchronous callbacks | **Rationale:** `ASIGetVideoData()` is a blocking C call waiting on USB frame completion. Calling it on the main Node event loop would starve HTTP and WebSocket connections. |
| **Focus Metric Execution** | Browser-Side on Bayer-Superpixel Luminance of ROI | Raw Bayer 1-px Laplacian or Server-Side Full Frame | **Rationale:** Running a 1-px Laplacian directly on un-debayered RGGB data measures color filter checkerboard contrast rather than optical sharpness. Extracting $2\times2$ $(R+2G+B)/4$ luminance on the ROI in the browser takes $<1\text{ ms}$ and isolates true optical gradients. |
| **Lucky Imaging Storage Format** | Standard Astronomical `.ser` v3 (with Trailer) | `.avi` / `.mp4` / uncompressed DNG | **Rationale:** Planetary lucky imaging software (AutoStakkert!, PlanetarySystemStacker, Registax) requires uncompressed RAW Bayer frames with 64-bit timestamps. Video codecs introduce lossy compression artifacts. |
| **Mount Protocol Interface** | INDI Protocol (TCP Socket / XML) + Built-in Sim | Direct Serial Only | **Rationale:** On Linux/Raspberry Pi, INDI is the native standard supporting virtually all commercial mounts. A built-in simulated mount state machine feeds coordinates back into the Mock Camera so slewing/jogging visibly shifts the sky in the viewport. |
| **Preview Stream Transport** | Downsampled Viewport + Full-Res 1:1 Focus ROI | Full-frame 4K uncompressed stream | **Rationale:** Full 4K uncompressed stream requires 390 MB/s. Sending a binned viewport frame plus a native-resolution 1:1 crop of the focus box gives both full-field context and pixel-accurate focus inspection under 5 Mbps. |

---

## 5. Functional Requirements (Capabilities)

### 5.1 Camera Initialization & Control
* **FR-CAM-01 (Detection & Fallback):** Discover connected ZWO cameras via `ASIGetNumOfConnectedCameras()` and connect to index 0, or initialize `MockCameraDriver` when running in mock/development mode (`ASTROSCOPE_MOCK=1` or when no hardware is detected).
* **FR-CAM-02 (Telemetry):** Query and report camera static & dynamic parameters: model name (`ZWO ASI678MC` or `ZWO ASI678MC (Simulated)`), sensor dimensions ($3840 \times 2160$), pixel pitch ($2.0\,\mu\text{m}$), color Bayer pattern (`RGGB`), supported bit depths (`RAW8`, `RAW16`), sensor temperature ($^\circ\text{C}$), and actual capture FPS.
* **FR-CAM-03 (Exposure Control):** Dynamically set exposure duration between $10\,\mu\text{s}$ and $3{,}600{,}000{,}000\,\mu\text{s}$ ($1\text{ hour}$). Live mode defaults to $30\text{ ms}$ ($30{,}000\,\mu\text{s}$).
* **FR-CAM-04 (Gain & HCG):** Provide a gain slider (0 to 500) with a prominent marker/preset button at **Gain 182** (the HCG switch point for IMX678) and **Gain 0** (Unity/Max Full Well).
* **FR-CAM-05 (Hardware ROI & Subframing):** Support on-the-fly ROI configuration (`ASISetROIFormat` + `ASISetStartPos`), enforcing ZWO alignment rules (`width % 8 === 0`, `height % 2 === 0`, `x % 2 === 0`, `y % 2 === 0`), with presets ($3840 \times 2160$, $1920 \times 1080$, $1024 \times 768$, $640 \times 480$, $400 \times 400$).
* **FR-CAM-06 (Bandwidth Overload & High Speed):** Allow adjusting USB traffic parameter (`ASI_BANDWIDTHOVERLOAD`) from 40 to 100 and toggling `ASI_HIGH_SPEED_MODE` (0 or 1).
* **FR-CAM-07 (Bit Depth Switching):** Allow switching between `RAW8` (8-bit high FPS) and `RAW16` (12-bit ADC packed into 16-bit unsigned little-endian).

### 5.2 Live View & Manual Focus Assistant
* **FR-FOC-01 (Continuous Live View):** Stream preview frames over WebSockets at a selectable rate (5 to 25 FPS) with client-side RGGB debayering and optional display histogram stretch / white-balance.
* **FR-FOC-02 (Interactive ROI Focus Box):** The user can click and drag a rectangular focus bounding box (default $256 \times 256$ or $400 \times 400$ sensor pixels) anywhere on the preview canvas.
* **FR-FOC-03 (Bayer-Aware Focus Metric Calculation):**
  * Convert the raw RGGB ROI into a green-weighted luminance buffer $Y(u, v) = \frac{1}{4}\left(R + G_1 + G_2 + B\right)$ (or debayered luminance) so the Bayer color filter array pattern does not create false high-frequency checkerboard variance.
  * Compute edge variance via the discrete $3\times3$ Laplacian kernel:
    $$\text{Focus Score} = \text{Var}\left(\nabla^2 Y_{\text{ROI}}\right) = \frac{1}{N} \sum_{u,v} \left( L(u, v) - \bar{L} \right)^2$$
  * Where $L(u,v) = Y(u+1, v) + Y(u-1, v) + Y(u, v+1) + Y(u, v-1) - 4 Y(u, v)$.
* **FR-FOC-04 (Focus Metric Visualization):** Display the instantaneous numeric score, the session peak score (with a "Reset Peak" button), and a rolling time-series sparkline (last 120 frames) showing the focus curve as the user turns the focuser knob.
* **FR-FOC-05 (1:1 Native Zoom PIP Window):** Provide a secondary picture-in-picture window showing the selected focus ROI at true 1:1 native sensor pixel resolution to visually assess star Airy discs or planetary detail.

### 5.3 Lucky Imaging (Capture Engine)
* **FR-CAP-01 (SER Video Recording):** Record uncompressed `RAW8` or `RAW16` frames directly from the camera worker into an astronomical `.ser` v3 container at full hardware frame rate.
* **FR-CAP-02 (SER v3 Header & Trailer Compliance):** Write a valid 178-byte Little-Endian SER header and optional per-frame timestamp trailer:
  * `FileID`: `"LUCAM-RECORDER"` (14 bytes)
  * `LuID`: `0` (4-byte int32 LE)
  * `ColorID`: `8` (Bayer RGGB, 4-byte int32 LE)
  * `LittleEndian`: `0` (4-byte int32 LE, standard SER convention recognized by AutoStakkert! / PIPP)
  * `ImageWidth` / `ImageHeight` matching the active ROI
  * `PixelDepthPerPlane`: `8` or `16`
  * `FrameCount`: Updated on file close at byte offset 38
  * `DateTime` / `DateTimeUTC`: 64-bit SER timestamps ($100\text{ ns}$ ticks since `0001-01-01T00:00:00`) at offsets 162 and 170, plus the trailing `FrameCount * 8`-byte timestamp array appended at `close()`.
* **FR-CAP-03 (Capture Limits):** Allow recording limits specified by total frame count (e.g., 1000 frames) or total elapsed time (e.g., 60 seconds), or manual stop.
* **FR-CAP-04 (Snapshot):** Allow single-frame capture to disk.

### 5.4 Telescope Mount Control (INDI Integration & Built-in Simulator)
* **FR-MNT-01 (INDI Connection & Fallback):** Connect over TCP to local or remote `indiserver` (default `127.0.0.1:7624`), or run an internal simulated equatorial mount when `indiserver` is unavailable.
* **FR-MNT-02 (Coordinate Monitoring):** Continuously track and broadcast equatorial coordinates (Right Ascension $\alpha$ in hours $0\text{--}24$, Declination $\delta$ in degrees $-90^\circ\text{ to }+90^\circ$) and current tracking state.
* **FR-MNT-03 (Virtual Hand Controller):** Provide directional jog controls (N, S, E, W) with configurable slew speeds (`GUIDE` $0.5\times$, `CENTER` $4\times$, `FIND` $32\times$, `MAX` $800\times$ sidereal) that update both the mount telemetry and the Mock Camera's sky offset in real time.
* **FR-MNT-04 (Tracking Modes):** Toggle tracking between `SIDEREAL`, `LUNAR`, `SOLAR`, and `OFF` (when `OFF`, the Mock Camera exhibits realistic sidereal drift across the sensor!).
* **FR-MNT-05 (Sync & Slew):** Support commanding GOTO slews to user-specified RA/Dec coordinates or preset targets (Jupiter, Saturn, Moon, Pleiades / Starfield) and synchronizing mount coordinates.

---

## 6. Comprehensive Mock Camera Specification (`MockCameraDriver`)

To allow full-featured offline development and realistic testing of exposure, gain (including the Gain 182 HCG transition), ROI cropping, SER recording, mount jogging, and manual focusing, the system includes a physics-based **ZWO ASI678MC Synthetic Camera Simulator**.

### 6.1 Exact SDK Behavioral Emulation
1. **Sensor Geometry & Alignment Validation:**
   * Native dimensions: $3840 \times 2160$, `RGGB` Bayer matrix, $2.0\,\mu\text{m}$ pixels, 12-bit ADC.
   * Enforces identical ZWO SDK validation rules: rejects ROI widths not divisible by 8, heights not divisible by 2, or out-of-bounds `startX`/`startY`, throwing the corresponding `ASI_ERROR_INVALID_SIZE` error codes.
   * Supports Bin 1 ($1\times1$) and Bin 2 ($2\times2$) hardware binning and `RAW8` / `RAW16` pixel formats.
2. **Realistic Frame Pacing & USB Bandwidth Constraints:**
   * Frame interval is governed by:
     $$T_{\text{frame}} = \max\left( \text{exposureUs}, \; T_{\text{USB}}(\text{width}, \text{height}, \text{bitDepth}, \text{bandwidth}, \text{highSpeed}) \right)$$
   * At full resolution ($3840 \times 2160$), max framerate caps at $47.5\text{ FPS}$ in `RAW8` and $24.2\text{ FPS}$ in `RAW16`.
   * Reducing ROI size (e.g., $640 \times 480$) proportionally increases maximum simulated framerate (up to $250+\text{ FPS}$ for planetary subframes) just like the physical IMX678 readout.
3. **Thermal Simulation:**
   * Simulates sensor warming from ambient ($20.0^\circ\text{C}$) toward steady-state operating temperature ($\approx 28.5^\circ\text{C}$) during active capture based on framerate and exposure duty cycle, with dark current scaling exponentially with temperature (doubling every $6.0^\circ\text{C}$).

### 6.2 Radiometric & IMX678 Sensor Physics Pipeline
Each pixel $(x, y)$ in the active ROI is rendered into true `RGGB` Bayer mosaic values according to the following physical pipeline:

1. **System Gain & HCG Read-Noise Model:**
   * Gain parameter $G \in [0, 500]$ maps to linear amplification $A(G) = 10^{G / 200}$.
   * System conversion gain ($e^-/\text{ADU}_{12}$) at $G=0$ is $g_0 = 11270 / 4095 \approx 2.752\,e^-/\text{ADU}$, scaling as $g(G) = g_0 / A(G)$.
   * **HCG Step at Gain 182:**
     $$\sigma_{\text{read}}(G) = \begin{cases} 2.70 - 0.005 \cdot G \;\,e^- & \text{if } G < 182 \quad (\text{LCG Mode}) \\ 0.85 \cdot 10^{-(G - 182)/1200} \;\,e^- & \text{if } G \ge 182 \quad (\text{HCG Mode}) \end{cases}$$
   * Switching Gain from `180` to `182` visibly drops background read-noise floor in dark sky regions by more than $3\times$, matching the real ZWO ASI678MC sensor chart.
2. **Optical Defocus (Focuser Position) & Atmospheric Seeing:**
   * The simulator maintains a virtual focuser position $F \in [0, 1000]$ (in microns/steps) with true best focus at $F_{\text{optimal}} = 500$.
   * **Defocus Blur Radius ($\sigma_{\text{defocus}}$):**
     $$\sigma_{\text{defocus}} = \sigma_{\text{airy}} + k_{\text{f-ratio}} \cdot |F - F_{\text{optimal}}|$$
   * **Atmospheric Seeing Jitter:** High-frequency Perlin/harmonic phase wander $(\Delta x_{\text{seeing}}(t), \Delta y_{\text{seeing}}(t))$ of $\approx 0.5\text{--}1.8\text{ px}$ RMS plus momentary "lucky imaging" calm intervals so recording a `.ser` stream produces realistic sharp vs. blurred frames.
3. **Selectable Synthetic Sky Targets (`scene` preset):**
   * **`JUPITER` (Default Planetary + Moons):**
     * Renders a multi-banded oblate planetary disc with equatorial belts, zones, the Great Red Spot (rotating slowly over time), limb darkening, differential RGB spectral coloration, and 4 Galilean moons (Io, Europa, Ganymede, Callisto) that serve as point-source focus references alongside planetary surface detail.
   * **`SATURN`:**
     * Renders Saturn's oblate globe with Cassini division ring geometry and Titan.
   * **`MOON` (Lunar Crater Terminators):**
     * High-contrast procedural lunar crater field (Copernicus/Tycho-style rim shadows and central peaks) ideal for testing full-frame Laplacian contrast focusing.
   * **`STARFIELD` (DSO / Globular Cluster & Calibration Stars):**
     * 150+ stars with realistic Planck blackbody color temperatures ($3000\,\text{K}$ red giants to $12000\,\text{K}$ blue-white stars) rendered with analytical 2D Gaussian / Moffat Point Spread Functions (PSF) whose FWHM responds directly to $\sigma_{\text{defocus}}$.
4. **Mount Coupling & Sidereal Drift:**
   * Mount RA/Dec offsets from `MountController` shift the target position across the sensor in real time when the user presses `N / S / E / W` jog buttons.
   * If mount tracking is toggled `OFF`, the sky drifts continuously across the sensor at sidereal rate ($15''/\text{sec}$).
5. **Bayer CFA Sampling, Shot Noise & ADC Quantization:**
   * For each pixel $(x, y)$, only the native Bayer color channel (`R` at $(2i, 2j)$, `G` at $(2i+1, 2j)$ and $(2i, 2j+1)$, `B` at $(2i+1, 2j+1)$) is sampled, using realistic IMX678 quantum efficiency curves ($QE_R, QE_G, QE_B$).
   * Photoelectrons $\lambda_e = (\text{SignalRate}_{c}(x,y) + \text{SkyBackground}_c + \text{DarkCurrent}(T)) \cdot \text{exposureSec}$.
   * Shot noise + read noise + bias offset are applied, quantized to 12-bit $[0, 4095]$, and written out as `RAW8` ($\text{ADU}_{12} \gg 4$) or `RAW16` ($\text{ADU}_{12} \ll 4$, matching ZWO's 16-bit left-shifted output).
6. **Fault Injection Hooks:**
   * Supports triggering simulated `ASI_ERROR_CAMERA_REMOVED` disconnects and reconnects via API/WebSocket command to test **NFR-REL-01** in the UI.

---

## 7. Non-Functional Requirements & Engineering Standards

* **NFR-PERF-01 (Preview Latency):** Live preview glass-to-glass latency from camera photon capture to browser canvas presentation must be $<150\text{ ms}$ over a local Wi-Fi connection.
* **NFR-PERF-02 (Node Event Loop Freedom):** The Node.js main event loop lag must remain $<20\text{ ms}$ at all times; no blocking synchronous I/O or full-frame image transformations are permitted on the main thread.
* **NFR-REL-01 (Graceful Disconnect):** If the camera is unplugged or the USB link drops, the worker thread must trap `ASI_ERROR_CAMERA_REMOVED`, terminate streaming cleanly, and broadcast a reconnect warning rather than crashing the process.
* **NFR-PORT-01 (Cross-Platform Execution):** The backend must run identically on:
  * Linux aarch64 (Raspberry Pi 5 / 4 running Raspberry Pi OS 64-bit).
  * macOS arm64 / x64 (Apple Silicon & Intel).
  * Windows 11 / 10 x64.
  * Linux x86_64.
* **NFR-EXT-01 (Interface Segregation):** All camera operations must adhere to a strict TypeScript interface (`ICameraDriver`) to allow transparent swapping between `ZwoKoffiDriver`, `MockCameraDriver`, and a future C++ sidecar without altering server routes or UI components.

---

## 8. Data Contracts & Protocol Specifications

### 8.1 WebSocket Transport Protocol
The client and server communicate via a single WebSocket connection (`/ws/live`). Communication consists of **JSON control messages** (client to server and server telemetry) and **Binary Preview Frames** (server to client).

#### 8.1.1 Binary Preview Frame Header (24-Byte Aligned Little-Endian)
Binary preview frames are prepended with a fixed 24-byte Little-Endian binary header (all 16-bit and 32-bit fields are naturally aligned for zero-copy `DataView` / typed array access in the browser):

| Byte Offset | Data Type | Field Name | Description |
| :--- | :--- | :--- | :--- |
| `0 - 3` | `uint32` | `magic` | Magic header marker: `0x41535452` (`"ASTR"` in ASCII LE) |
| `4 - 7` | `uint32` | `frameNumber` | Monotonically increasing 32-bit frame sequence counter |
| `8 - 9` | `uint16` | `width` | Transmitted frame width in pixels |
| `10 - 11`| `uint16` | `height` | Transmitted frame height in pixels |
| `12` | `uint8` | `pixelFormat` | `0` = RAW8 Bayer RGGB, `1` = JPEG, `2` = RAW16, `3` = RGB24 |
| `13` | `uint8` | `frameType` | `0` = Full/Binned Viewport Preview, `1` = 1:1 Native Focus ROI Crop |
| `14 - 15`| `uint16` | `binFactor` | Effective spatial downsample/bin factor (`1`, `2`, `4`) |
| `16 - 19`| `float32`| `serverScore` | Optional server focus score (`0.0` when calculated client-side) |
| `20 - 23`| `uint32` | `payloadSize` | Size in bytes of image payload immediately following byte 23 |
| `24 - ...`| `uint8[]` | `payload` | Raw or compressed image pixel bytes |

#### 8.1.2 JSON Control & Telemetry Messages
* **Client $\to$ Server: Set Camera Settings**
  ```json
  {
    "action": "SET_CONFIG",
    "payload": {
      "gain": 182,
      "exposureUs": 30000,
      "bandwidth": 80,
      "highSpeed": 1,
      "bitDepth": 8,
      "roi": { "x": 0, "y": 0, "width": 1920, "height": 1080, "bin": 1 }
    }
  }
  ```
* **Client $\to$ Server: Set Focus ROI Box (for 1:1 Native Sub-Stream)**
  ```json
  {
    "action": "SET_FOCUS_ROI",
    "payload": {
      "x": 1720,
      "y": 880,
      "width": 400,
      "height": 400
    }
  }
  ```
* **Client $\to$ Server: Set Mock Simulator Controls (Active in Mock Mode)**
  ```json
  {
    "action": "SET_MOCK_PARAMS",
    "payload": {
      "scene": "JUPITER",
      "focuserPosition": 500,
      "seeingArcsec": 1.2,
      "cloudCover": 0.0
    }
  }
  ```
* **Client $\to$ Server: Start / Stop SER Recording**
  ```json
  {
    "action": "START_RECORDING",
    "payload": {
      "filename": "Jupiter_20261025_1100.ser",
      "limitType": "FRAMES",
      "limitValue": 2000
    }
  }
  ```
* **Client $\to$ Server: Mount Slew / Jog / Tracking**
  ```json
  {
    "action": "MOUNT_JOG",
    "payload": {
      "direction": "NORTH",
      "speed": "GUIDE",
      "durationMs": 500
    }
  }
  ```
* **Server $\to$ Client: System Telemetry Broadcast (2 Hz)**
  ```json
  {
    "type": "TELEMETRY",
    "timestamp": 1792926000000,
    "camera": {
      "connected": true,
      "isMock": true,
      "name": "ZWO ASI678MC (Simulated)",
      "fps": 46.8,
      "temperatureC": 22.4,
      "gain": 182,
      "hcgActive": true,
      "readNoiseElec": 0.85,
      "exposureUs": 20000,
      "bitDepth": 8,
      "roi": { "x": 0, "y": 0, "width": 3840, "height": 2160, "bin": 1 },
      "isRecording": false,
      "recordedFrames": 0,
      "mock": {
        "scene": "JUPITER",
        "focuserPosition": 500,
        "optimalFocusPosition": 500,
        "seeingArcsec": 1.2
      }
    },
    "mount": {
      "connected": true,
      "isSimulated": true,
      "driver": "INDI Simulated EQMount",
      "ra": 2.7541,
      "dec": 15.5344,
      "tracking": true,
      "trackRate": "SIDEREAL"
    },
    "system": {
      "cpuTempC": 48.5,
      "diskFreeGb": 412.8,
      "eventLoopLagMs": 1.2
    }
  }
  ```

---

## 9. Directory Structure & Code Layout

```
astroscope/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── bin/
│   ├── ASICamera2.dll             # Precompiled ZWO Windows SDK (optional)
│   ├── libASICamera2.dylib        # Precompiled ZWO macOS SDK (optional)
│   └── libASICamera2.so           # Precompiled ZWO Linux arm64/x64 SDK (optional)
├── recordings/                    # Default output directory for .ser & snapshot captures
├── src/
│   ├── common/                    # Shared types & protocol definitions
│   │   ├── protocol.ts            # Binary header pack/unpack & JSON message schemas
│   │   └── camera-interface.ts    # ICameraDriver & MockParams contracts
│   ├── server/                    # Node.js backend
│   │   ├── index.ts               # Fastify bootstrap, REST API & WebSocket routing
│   │   ├── camera/
│   │   │   ├── koffi-bindings.ts  # ZWO ASICamera2 C FFI declarations (lazy-loaded)
│   │   │   ├── camera-driver.ts   # Hardware ZWO controller implementation
│   │   │   ├── mock-camera.ts     # Physics-based IMX678 synthetic camera simulator
│   │   │   ├── camera-worker.ts   # Worker thread acquisition, binning & SER recording loop
│   │   │   └── ser-writer.ts      # Binary SER v3 container + timestamp trailer writer
│   │   ├── mount/
│   │   │   ├── indi-client.ts     # TCP socket INDI XML protocol parser
│   │   │   └── mount-controller.ts# High-level mount state machine + built-in simulator
│   │   └── state/
│   │       └── app-state.ts       # Central pub/sub state manager
│   └── client/                    # Browser SPA (Vite + TypeScript)
│       ├── index.html
│       ├── main.ts
│       ├── components/
│       │   ├── Viewport.ts        # RGGB Debayering Canvas 2D/WebGL viewer + interactive ROI
│       │   ├── FocusAnalyzer.ts   # Bayer super-pixel luminance & Laplacian / HFR calculator
│       │   ├── FocusGraph.ts      # High-DPI time-series sparkline & peak tracker
│       │   ├── MountControl.ts    # Virtual hand controller, RA/Dec & Focuser simulator UI
│       │   └── CameraSettings.ts  # Exposure, Gain (HCG 182 preset), ROI & SER capture UI
│       └── styles/
│           └── app.css
└── tests/
    ├── mocks/
    │   └── mock-camera.ts         # Re-exports & test harness helpers for MockCameraDriver
    ├── unit/
    │   ├── ser-writer.test.ts     # SER v3 178-byte header + timestamp trailer verification
    │   ├── laplacian.test.ts      # Bayer luminance + Laplacian focus curve verification
    │   └── mock-camera.test.ts    # IMX678 HCG read-noise, ROI validation, defocus & drift tests
    └── integration/
        └── protocol.test.ts       # Binary header & end-to-end WebSocket contract validation
```

---

## 10. Implementation Reference Code

### 10.1 Camera Interface Definition (`src/common/camera-interface.ts`)
```typescript
export interface CameraProperties {
  cameraId: number;
  name: string;
  maxWidth: number;
  maxHeight: number;
  pixelSizeUm: number;
  isColor: boolean;
  bayerPattern: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';
  bitDepth: number;
  isMock: boolean;
}

export interface CameraROI {
  x: number;
  y: number;
  width: number;
  height: number;
  bin: number;
}

export type MockSceneType = 'JUPITER' | 'SATURN' | 'MOON' | 'STARFIELD';

export interface MockCameraParams {
  scene: MockSceneType;
  focuserPosition: number;       // 0..1000 (500 = optimal focus)
  seeingArcsec: number;          // e.g. 0.5..4.0 arcsec
  cloudCover: number;            // 0.0..1.0
  skyOffsetPx: { dx: number; dy: number };
}

export interface ICameraDriver {
  initialize(): Promise<CameraProperties>;
  setExposure(microseconds: number): Promise<void>;
  setGain(gain: number): Promise<void>;
  setBitDepth(bitDepth: 8 | 16): Promise<void>;
  setBandwidth(bandwidth: number): Promise<void>;
  setHighSpeedMode(enabled: boolean): Promise<void>;
  setROI(roi: CameraROI): Promise<CameraROI>;
  getTemperature(): Promise<number>;
  startCapture(onFrame: (frame: Buffer, frameNumber: number, timestampUs: bigint) => void): Promise<void>;
  stopCapture(): Promise<void>;
  close(): Promise<void>;
  setMockParams?(params: Partial<MockCameraParams>): void;
  getMockParams?(): MockCameraParams;
}
```

### 10.2 Complete Koffi C-Bindings (`src/server/camera/koffi-bindings.ts`)
```typescript
import koffi from 'koffi';
import path from 'node:path';
import fs from 'node:fs';

export const ASI_ERROR_CODE = {
  SUCCESS: 0,
  INVALID_INDEX: 1,
  INVALID_ID: 2,
  INVALID_CONTROL_TYPE: 3,
  CAMERA_CLOSED: 4,
  CAMERA_REMOVED: 5,
  INVALID_PATH: 6,
  OUTOF_RESOURCE: 7,
  INVALID_SIZE: 8,
  TIMEOUT: 9,
  INVALID_FRAME_FORMAT: 10,
  SYSTEM_RESOURCE_ERROR: 11
} as const;

export const ASI_CONTROL_TYPE = {
  GAIN: 0,
  EXPOSURE: 1,
  GAMMA: 2,
  WB_R: 3,
  WB_B: 4,
  OFFSET: 5,
  BANDWIDTHOVERLOAD: 6,
  OVERCLOCK: 7,
  TEMPERATURE: 8, // Returns 10x degrees C (e.g. 225 = 22.5C)
  FLIP: 9,
  AUTO_MAX_GAIN: 10,
  AUTO_MAX_EXP: 11,
  AUTO_TARGET_BRIGHTNESS: 12,
  HARDWARE_BIN: 13,
  HIGH_SPEED_MODE: 14,
  COOLER_POWER_PERC: 15,
  TARGET_TEMP: 16,
  COOLER_ON: 17,
  FAN_ON: 19
} as const;

export const ASI_IMG_TYPE = {
  RAW8: 0,
  RGB24: 1,
  RAW16: 2,
  Y8: 3,
  END: -1
} as const;

export const ASI_BAYER_PATTERN = {
  RG: 0,
  BG: 1,
  GR: 2,
  GB: 3
} as const;

export function resolveSdkLibraryPath(): string {
  const binDir = path.resolve(process.cwd(), 'bin');
  if (process.platform === 'win32') return path.join(binDir, 'ASICamera2.dll');
  if (process.platform === 'darwin') return path.join(binDir, 'libASICamera2.dylib');
  return path.join(binDir, 'libASICamera2.so');
}

export function loadAsiSdk() {
  const libPath = resolveSdkLibraryPath();
  if (!fs.existsSync(libPath)) {
    return null;
  }

  const lib = koffi.load(libPath);

  const ASI_CAMERA_INFO = koffi.struct('ASI_CAMERA_INFO', {
    Name: koffi.array('char', 64),
    CameraID: 'int',
    MaxHeight: 'long',
    MaxWidth: 'long',
    IsColorCam: 'int',
    BayerPattern: 'int',
    SupportedBins: koffi.array('int', 16),
    SupportedVideoFormat: koffi.array('int', 8),
    PixelSize: 'double',
    MechanicalShutter: 'int',
    ST4Port: 'int',
    IsCoolerCam: 'int',
    IsUSB3Host: 'int',
    IsUSB3Camera: 'int',
    ElecPerADU: 'float',
    BitDepth: 'int',
    IsTriggerCam: 'int',
    Unused: koffi.array('char', 16)
  });

  return {
    ASI_CAMERA_INFO,
    ASIGetNumOfConnectedCameras: lib.func('int ASIGetNumOfConnectedCameras()'),
    ASIGetCameraProperty: lib.func('int ASIGetCameraProperty(_Out_ ASI_CAMERA_INFO *pCameraInfo, int iCameraIndex)'),
    ASIOpenCamera: lib.func('int ASIOpenCamera(int iCameraID)'),
    ASIInitCamera: lib.func('int ASIInitCamera(int iCameraID)'),
    ASICloseCamera: lib.func('int ASICloseCamera(int iCameraID)'),
    ASISetControlValue: lib.func('int ASISetControlValue(int iCameraID, int ControlType, long lValue, int bAuto)'),
    ASIGetControlValue: lib.func('int ASIGetControlValue(int iCameraID, int ControlType, _Out_ long *plValue, _Out_ int *pbAuto)'),
    ASISetROIFormat: lib.func('int ASISetROIFormat(int iCameraID, int iWidth, int iHeight, int iBin, int Img_type)'),
    ASIGetROIFormat: lib.func('int ASIGetROIFormat(int iCameraID, _Out_ int *piWidth, _Out_ int *piHeight, _Out_ int *piBin, _Out_ int *pImg_type)'),
    ASISetStartPos: lib.func('int ASISetStartPos(int iCameraID, int iStartX, int iStartY)'),
    ASIGetStartPos: lib.func('int ASIGetStartPos(int iCameraID, _Out_ int *piStartX, _Out_ int *piStartY)'),
    ASIStartVideoCapture: lib.func('int ASIStartVideoCapture(int iCameraID)'),
    ASIStopVideoCapture: lib.func('int ASIStopVideoCapture(int iCameraID)'),
    ASIGetVideoData: lib.func('int ASIGetVideoData(int iCameraID, _Out_ uint8_t *pBuffer, long lBuffSize, int iWaitms)')
  };
}
```

### 10.3 Validated SER v3 Format Writer (`src/server/camera/ser-writer.ts`)
```typescript
import fs from 'node:fs';

// Number of 100-ns ticks between 0001-01-01T00:00:00Z and 1970-01-01T00:00:00Z
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;

export function dateToSerTicks(unixMs: number = Date.now(), offsetMinutes = 0): bigint {
  const adjustedMs = BigInt(Math.round(unixMs + offsetMinutes * 60_000));
  return TICKS_AT_UNIX_EPOCH + adjustedMs * 10_000n;
}

export class SerWriter {
  private fd: number | null = null;
  private frameCount = 0;
  private bytesPerFrame: number;
  private frameTimestamps: bigint[] = [];

  constructor(
    private filePath: string,
    private width: number,
    private height: number,
    private is16Bit = false,
    private metadata: { observer?: string; instrument?: string; telescope?: string } = {}
  ) {
    this.bytesPerFrame = width * height * (is16Bit ? 2 : 1);
  }

  open(): void {
    this.fd = fs.openSync(this.filePath, 'w');
    this.frameCount = 0;
    this.frameTimestamps = [];

    const nowMs = Date.now();
    const localOffsetMin = -new Date(nowMs).getTimezoneOffset();
    const localTicks = dateToSerTicks(nowMs, localOffsetMin);
    const utcTicks = dateToSerTicks(nowMs, 0);

    // 178-Byte SER v3 Header specification
    const header = Buffer.alloc(178);
    header.write('LUCAM-RECORDER', 0, 14, 'ascii'); // FileID (14 bytes)
    header.writeInt32LE(0, 14);                      // LuID (0)
    header.writeInt32LE(8, 18);                      // ColorID (8 = Bayer RGGB)
    header.writeInt32LE(0, 22);                      // LittleEndian (0 = Little-Endian per AutoStakkert!)
    header.writeInt32LE(this.width, 26);             // ImageWidth
    header.writeInt32LE(this.height, 30);            // ImageHeight
    header.writeInt32LE(this.is16Bit ? 16 : 8, 34);  // PixelDepthPerPlane
    header.writeInt32LE(0, 38);                      // FrameCount (updated on close)

    header.write((this.metadata.observer ?? 'AstroScope Observer').slice(0, 40), 42, 40, 'ascii');
    header.write((this.metadata.instrument ?? 'ZWO ASI678MC').slice(0, 40), 82, 40, 'ascii');
    header.write((this.metadata.telescope ?? 'AstroScope OTA').slice(0, 40), 122, 40, 'ascii');

    header.writeBigInt64LE(localTicks, 162);         // DateTime (Local)
    header.writeBigInt64LE(utcTicks, 170);           // DateTime_UTC

    fs.writeSync(this.fd, header, 0, 178);
  }

  writeFrame(frameBuffer: Buffer, timestampTicks?: bigint): void {
    if (this.fd === null) throw new Error('SER file not open.');
    if (frameBuffer.length !== this.bytesPerFrame) {
      throw new Error(`Buffer mismatch: expected ${this.bytesPerFrame}, got ${frameBuffer.length}`);
    }
    fs.writeSync(this.fd, frameBuffer, 0, frameBuffer.length);
    this.frameTimestamps.push(timestampTicks ?? dateToSerTicks(Date.now(), 0));
    this.frameCount++;
  }

  close(): void {
    if (this.fd === null) return;

    // 1. Append optional SER v3 Trailer (8-byte 64-bit UTC timestamp per frame)
    if (this.frameTimestamps.length > 0) {
      const trailer = Buffer.alloc(this.frameTimestamps.length * 8);
      for (let i = 0; i < this.frameTimestamps.length; i++) {
        trailer.writeBigInt64LE(this.frameTimestamps[i], i * 8);
      }
      fs.writeSync(this.fd, trailer, 0, trailer.length);
    }

    // 2. Overwrite FrameCount at header offset 38
    const countBuf = Buffer.alloc(4);
    countBuf.writeInt32LE(this.frameCount, 0);
    fs.writeSync(this.fd, countBuf, 0, 4, 38);

    fs.closeSync(this.fd);
    this.fd = null;
  }
}
```

### 10.4 Browser Bayer Luminance & Laplacian Focus Algorithm (`src/client/components/FocusAnalyzer.ts`)
```typescript
/**
 * Extracts 2x2 Bayer RGGB super-pixel green-weighted luminance (R + G1 + G2 + B) / 4
 * so the Bayer CFA pattern does not introduce artificial pixel-to-pixel checkerboard variance.
 */
export function extractBayerSuperpixelLuminance(
  rawBayer: Uint8Array,
  width: number,
  height: number
): { luma: Float32Array; lumaWidth: number; lumaHeight: number } {
  const lumaWidth = Math.floor(width / 2);
  const lumaHeight = Math.floor(height / 2);
  const luma = new Float32Array(lumaWidth * lumaHeight);

  for (let sy = 0; sy < lumaHeight; sy++) {
    const r0 = (sy * 2) * width;
    const r1 = (sy * 2 + 1) * width;
    const outRow = sy * lumaWidth;
    for (let sx = 0; sx < lumaWidth; sx++) {
      const c0 = sx * 2;
      const r = rawBayer[r0 + c0];
      const g1 = rawBayer[r0 + c0 + 1];
      const g2 = rawBayer[r1 + c0];
      const b = rawBayer[r1 + c0 + 1];
      luma[outRow + sx] = 0.25 * (r + g1 + g2 + b);
    }
  }

  return { luma, lumaWidth, lumaHeight };
}

/**
 * Evaluates the 3x3 Laplacian variance over a grayscale/luminance buffer.
 * High focus = steep optical gradients = high variance.
 */
export function computeLaplacianScore(
  grayPixels: Uint8Array | Uint8ClampedArray | Float32Array,
  roiWidth: number,
  roiHeight: number
): number {
  if (roiWidth < 3 || roiHeight < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  const count = (roiWidth - 2) * (roiHeight - 2);

  for (let y = 1; y < roiHeight - 1; y++) {
    const rowOffset = y * roiWidth;
    const prevRow = (y - 1) * roiWidth;
    const nextRow = (y + 1) * roiWidth;

    for (let x = 1; x < roiWidth - 1; x++) {
      // 3x3 Laplacian operator: [ 0, 1, 0 ], [ 1, -4, 1 ], [ 0, 1, 0 ]
      const lap =
        grayPixels[prevRow + x] +
        grayPixels[rowOffset + (x - 1)] -
        (4 * grayPixels[rowOffset + x]) +
        grayPixels[rowOffset + (x + 1)] +
        grayPixels[nextRow + x];

      sum += lap;
      sumSq += lap * lap;
    }
  }

  const mean = sum / count;
  const variance = (sumSq / count) - (mean * mean);
  return Math.max(0, variance);
}
```

---

## 11. Phase 2 DSO Live Stacking Architectural Specification

When extending the system to Deep Sky Object (DSO) live stacking, the C++ sidecar daemon (`asi_core`) activates an accelerated image registration and rejection pipeline.

### 11.1 Processing Pipeline
1. **Calibration:** Real-time Dark frame subtraction and Flat frame division:
   $$I_{\text{calibrated}} = \frac{I_{\text{raw}} - \text{Dark}}{\text{Flat} - \text{Dark}_{\text{flat}}} \times \overline{\text{Flat}}$$
2. **Star Detection & Centroiding:** Fast thresholding followed by connected-component labeling to identify stars ($>5\sigma$ above background RMS) and compute sub-pixel barycentric centroids:
   $$x_c = \frac{\sum x \cdot I(x,y)}{\sum I(x,y)}, \quad y_c = \frac{\sum y \cdot I(x,y)}{\sum I(x,y)}$$
3. **Triangle Matching & Transformation:** Compute pairwise star asterisms (similar to `astroalign`) to match candidate triangles against the reference frame, solving for the 2D Affine Transformation matrix:
   $$\begin{bmatrix} x' \\ y' \\ 1 \end{bmatrix} = \begin{bmatrix} a & b & t_x \\ c & d & t_y \\ 0 & 0 & 1 \end{bmatrix} \begin{bmatrix} x \\ y \\ 1 \end{bmatrix}$$
4. **Outlier Rejection & Accumulation:** Execute rolling Winsorized sigma-clipping or Running Average stacking into a 32-bit floating-point accumulator buffer.
5. **Nonlinear Stretch for Preview:** Apply Midtone Transfer Function (MTF) stretching to convert the high-dynamic-range 32-bit stacked buffer into an 8-bit sRGB preview pushed to Node.js and the browser.

---

## 12. Verification & Testing Matrix

| Test Suite | Target | Verification Method | Acceptance Criteria |
| :--- | :--- | :--- | :--- |
| **UT-01** | `SerWriter` | Create synthetic frame buffer; verify written file against standard 178-byte SER v3 layout and 8-byte per-frame timestamp trailer using binary inspection. | Byte 0-13 is `"LUCAM-RECORDER"`, ColorID=8, FrameCount at offset 38 matches, file size $= 178 + N \cdot \text{frameBytes} + N \cdot 8$. |
| **UT-02** | `FocusAnalyzer` | Pass synthetic flat Bayer image vs. defocused star/planet vs. sharp focus target (`focuserPosition = 500`). | Flat Bayer RGGB image variance $= 0.0$; focus score peaks monotonically at `focuserPosition = 500`. |
| **UT-03** | `MockCameraDriver` | Verify IMX678 HCG read noise drop at Gain 182, ZWO ROI modulo validation (`width % 8`, `height % 2`), and mount drift coupling. | Read noise RMS at Gain 182 is $<40\%$ of Gain 180 in electron units; invalid ROI throws error; sky shifts with mount offset. |
| **IT-01** | Worker & WebSocket | Run capture loop with `MockCameraDriver` and verify 24-byte `ASTR` binary preview frames and 1:1 focus ROI crop streaming. | Worker thread runs smoothly; WebSocket emits valid 24-byte aligned binary headers (`0x41535452`) and `TELEMETRY` JSON packets. |
| **IT-02** | `INDI Mount Client` | Spin up mock TCP server mimicking INDI protocol responses for `EQUATORIAL_EOD_COORD` and test built-in simulated mount jogs. | State store parses RA/Dec coordinates accurately and updates MockCamera sky offset during jogs. |
| **ST-01** | Stress / Leak Test | Run continuous video preview for 60 minutes on Raspberry Pi 5 or dev host. | Zero process memory growth (RSS flat within $\pm 15\text{ MB}$); Node event loop lag $<20\text{ ms}$. |

---

## 13. Coding Agent Prompt & Implementation Instructions

When handing this specification document to an automated coding agent (e.g. Antigravity, Claude Code, Codex, or Gemini CLI), prepend the following prompt:

```text
You are an expert systems software engineer and astrophotography software architect. 
Please review the attached "System Architecture & Technical Specification Document" (Version 1.1.0).

Implement Phase 1 of this project using TypeScript, Node.js (v20+), Koffi, Fastify, WebSockets, and a Vite-based browser SPA frontend.
Follow these mandatory constraints:
1. Adhere strictly to the directory structure and file boundaries defined in Section 9.
2. Implement the ICameraDriver interface in src/common/camera-interface.ts and bind the precompiled ZWO SDK using Koffi as specified in Section 10.2.
3. Build the physics-based MockCameraDriver in src/server/camera/mock-camera.ts (and re-export in tests/mocks/mock-camera.ts) matching Section 6 (RGGB Bayer CFA, Gain 182 HCG read-noise step, Jupiter/Saturn/Moon/Starfield targets, virtual focuser defocus PSF, seeing turbulence, and mount drift).
4. Execute camera capture inside a dedicated worker_thread (src/server/camera/camera-worker.ts).
5. Implement the compliant 178-byte SER v3 writer + timestamp trailer in src/server/camera/ser-writer.ts accompanied by unit tests.
6. Build the browser frontend with RGGB debayering Canvas 2D rendering, 1:1 native ROI PIP zoom window, virtual focuser & target controls for Mock mode, and the Bayer-aware Laplacian focus analyzer from Section 10.4.
7. Include complete npm scripts for 'dev', 'build', and 'test'.
```
