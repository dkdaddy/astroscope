# Alpine installer USB for AstroScope

Builds a UEFI-bootable USB that **installs Alpine Linux plus AstroScope onto a mini PC's internal disk**, headless (no monitor/keyboard). After the install the PC powers itself off; remove the USB and it boots from the internal disk.

## Building from Windows (WSL)
Build an image file, then flash it with Rufus (choose "DD Image" mode if asked) or balenaEtcher. Run this single line in **PowerShell**:

```powershell
wsl -d Ubuntu -u root -- bash /mnt/c/Users/bobco/code/astroscope/deploy/alpine-usb/make-usb.sh --ssh-key /mnt/c/Users/bobco/.ssh/id_ed25519.pub --install-to auto --sdk /mnt/c/Users/bobco/zwo-sdk/libASICamera2.so --wifi-ssid "Office" --wifi-country GB --disable-sd-reader --image /mnt/c/Users/bobco/astroscope-usb.img
```

- It asks for the console password, then the Wi-Fi passphrase. The image is written to `C:\Users\bobco\astroscope-usb.img`.
- `-d Ubuntu` matters: the default WSL distro here is `docker-desktop`, which lacks the tools (and mounts C: at `/mnt/host/c`). Paths in the command are Ubuntu paths (`/mnt/c/...`).
- Keep it on one line in PowerShell; trailing `\` line continuations only work in a Linux shell.
- A `wsl: Failed to translate 'D:\kotlinc\bin'` warning is harmless (a stale Windows PATH entry).
- `--sdk` is the Linux x64 `libASICamera2.so` from ZWO's developer SDK (`lib/x64/libASICamera2.so.1.42`, renamed). Omit it to run the simulator.
- From a Linux host you can write straight to the stick instead: `sudo ./make-usb.sh ... /dev/sdX`.

**Writing the image to the stick without extra tools:** WSL can't see USB sticks (`wsl --mount` doesn't support them), so use the built-in PowerShell script. Open PowerShell **as Administrator**:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\bobco\code\astroscope\deploy\alpine-usb\write-usb.ps1
```

It lists only USB disks, asks for the disk number twice, erases that stick, writes `C:\Users\bobco\astroscope-usb.img` and reads it back to verify. Use `-Image <path>` for a different image.

Needs `curl sfdisk wipefs mkfs.vfat lsblk losetup cpio gzip openssl` (Ubuntu: `apt install fdisk dosfstools openssl curl cpio`).

| Option | Meaning |
|---|---|
| `--install-to auto\|/dev/nvme0n1` | **Required.** Disk on the mini PC that gets ERASED. `auto` only proceeds if the PC has exactly one internal (non-USB) disk of at least ~8 GB. |
| `--ssh-key FILE` | **Required.** Public key for root (password login is disabled). |
| `--sdk FILE` | `libASICamera2.so` (Linux x64) copied to the new system. Without it the simulator is used. |
| `--repo`, `--branch`, `--hostname` | Source repo (default `dkdaddy/astroscope`, `main`), hostname (default `astroscope`). |
| `--no-poweroff`, `--reinstall` | Stay up after install; reinstall even if the disk already has an AstroScope install. |
| `--reset-key` | Recovery: **no erase**. Replaces root's SSH keys on the existing install with the ones in `--ssh-key`, then powers off (see below). |
| `--console-password-hash HASH`, `--no-console-login` | Console (keyboard + monitor) login as root. By default `make-usb.sh` asks for a password (hashed with `openssl passwd -6`; needs `openssl`). SSH remains key-only. `--no-console-login` locks the console account. |
| `--keymap "gb gb"` | Console keyboard layout and variant (default `none` = US). |
| `--wifi-ssid`, `--wifi-psk`, `--wifi-country GB` | Configure Wi-Fi on the installed system (passphrase prompted if omitted; empty = open network). |
| `--image FILE` | Write a disk image instead of a device (works in WSL; flash with Rufus/balenaEtcher). |
| `--debug-boot` | Troubleshooting: show kernel messages and trace Alpine's early boot (`debug_init`), including how it searches for the stick. |
| `--disable-sd-reader` | Stop the SD card reader driver loading (`module_blacklist=sdhci,sdhci_pci,sdhci_acpi`, enforced by the kernel) on the stick and on the installed system. For mini PCs whose empty reader keeps logging `mmc0: Timeout waiting for hardware cmd interrupt` / `SDHCI REGISTER DUMP`. Alternative: disable the SD/eMMC controller in the BIOS. Don't use it if the PC's only internal storage is eMMC. |
| `--overlay-only` | Only write `out/local.apkovl.tar.gz`. |

**"Mounting boot media failed" on real hardware:** Alpine's early boot gives up looking for the stick after about 6 seconds without new device events (its `usbdelay` option doesn't extend this), and slow USB sticks appear later. The stick therefore carries a small second initramfs (`boot/astroscope-initrd.gz`, loaded after Alpine's) that wraps the search and retries it for up to about 3 minutes, printing `AstroScope: boot media not found yet, retrying (n/25)...`. Set `FINDFS_TRIES` to change the number of attempts.

## What happens
1. **USB boot (live, RAM):** the hook [01-setup.start](./overlay/etc/local.d/01-setup.start) gets a DHCP lease, starts sshd (so a failed install can be inspected), picks the target disk, and runs `setup-alpine` with an answer file (`-m sys`, ext4, GRUB EFI, openssh, chrony, avahi, Node/git/libusb/gcompat). It then sets the console password (or locks it), disables SSH password auth, configures Wi-Fi if requested, stages the SDK, writes a marker, writes a report to the USB stick and powers off. About 1-2 minutes on a fast connection.
2. **Remove the USB, power on:** Alpine boots from the SSD. The same hook sees it is no longer running from RAM and, on this first boot only, creates the service user, opens USB device permissions for ZWO cameras, clones the repo to `/opt/astroscope`, runs `npm ci` + build, and starts the OpenRC service. A few minutes.
3. `ssh root@astroscope.local`, then browse to `http://astroscope.local:3000`.

If the USB is left in and the PC boots it again, the installer finds the marker on the SSD, does nothing and powers off, so it won't wipe the disk twice.

**Did the install work?** Plug the stick into any PC: `ASTROSCOPE-INSTALL-OK.txt` or `ASTROSCOPE-INSTALL-FAILED.txt` in its root holds the installer log. If it failed, the mini PC stays on with SSH running on the installer, so you can also `ssh root@<ip>` and look at `/var/log/astroscope-provision.log`.

## Logs and troubleshooting
- Install and first-boot log: `/var/log/astroscope-provision.log`; the installer's own log is also kept on the SSD as `/var/log/astroscope-install.log`. Re-run the first-boot step by deleting `/var/lib/astroscope-provisioned` and rebooting.
- App log: `/opt/astroscope/logs/astroscope.log`; recordings go to `/opt/astroscope/recordings`.

## Remote debugging
SSH is key-only and TCP forwarding is on. The box has `bash curl tar libstdc++ gcompat procps htop nano`, which is what VS Code Remote-SSH needs on Alpine.

- **Shell and logs:** `ssh root@astroscope.local`, then `rc-service astroscope restart`, `tail -f /var/log/astroscope.err /opt/astroscope/logs/astroscope.log`.
- **VS Code Remote-SSH:** connect to `root@astroscope.local` and open `/opt/astroscope`. Alpine support in Remote-SSH is experimental; if it fails, enable the extension's musl/"Alpine" compatibility setting or fall back to the SSH tunnel below.
- **Node inspector (breakpoints in `src/`):** on the box run `echo 'ASTROSCOPE_INSPECT=1' > /etc/conf.d/astroscope && rc-service astroscope restart`. The inspector listens on `127.0.0.1:9229` only. From your PC: `ssh -L 9229:127.0.0.1:9229 root@astroscope.local`, then in VS Code use an *Attach to Node* config on port 9229 with `"localRoot": "${workspaceFolder}"` and `"remoteRoot": "/opt/astroscope"`. The server build emits source maps and runs with `--enable-source-maps`. Remove the conf.d line to turn it off.
- **Rebuilding on the box:** the first-boot build prunes dev dependencies. To rebuild there: `cd /opt/astroscope && npm ci && npm run build && rc-service astroscope restart`.
- Deleting `/var/lib/astroscope-provisioned` and rebooting re-runs the first-boot step (it fetches `main` again).

## Console login and Wi-Fi
- **Console:** with a monitor and keyboard, log in at the prompt as `root` with the password given to `make-usb.sh`. Root can still only log in over SSH with a key. In `--reset-key` mode the console password is also reset if you give one (`--no-console-login` leaves the existing one unchanged).
- **Wi-Fi:** `wpa_supplicant`, the Wi-Fi firmware packages (Intel, MediaTek, Realtek, Atheros, Broadcom) and your network are installed on the SSD, and the interface (normally `wlan0`) is started at boot. **The install itself and the first-boot build still need Ethernet**, because the USB's live system has no Wi-Fi. After the first boot completes you can unplug Ethernet. Change networks later with `nano /etc/wpa_supplicant/wpa_supplicant.conf` (or `wpa_cli`) and `rc-service wpa_supplicant restart`. Check with `iw dev` and `ip addr show wlan0`.
- **Secrets on the USB:** the Wi-Fi passphrase (plain text) and console password hash are stored in `local.apkovl.tar.gz` on the USB. They are removed from the copy installed on the SSD, but keep the USB safe. The installed system stores the Wi-Fi passphrase only as a hash in `wpa_supplicant.conf` (root-only).

## Recovery
- **Lost or compromised SSH key:** SSH needs a key, and the console password (if you set one) only works with a keyboard and monitor. Build a new USB with a new key and `--reset-key`, boot the PC from it (needs no network), wait for it to power off, remove the USB and power on. Nothing else on the disk, including recordings, is touched. (Alternatively mount the SSD from any Linux machine and replace `/root/.ssh/authorized_keys`.)
- **Several keys:** `--ssh-key` takes a file; put more than one public key in it (for example a backup key kept offline) and all of them are installed.
- **SSD failed:** build the USB again and install to a new disk; the app is re-cloned from GitHub. **Recordings exist only on the SSD**, so copy them off regularly, for example `scp -r root@astroscope.local:/opt/astroscope/recordings .`
- **Moving the SSD to another PC:** it boots (GRUB uses the UEFI fallback path), but the network config was written for the old PC's NIC names. If the new PC has no network, edit `/etc/network/interfaces` on the SSD from another Linux machine, or reinstall with `--reinstall`.
- **Multiple disks in the mini PC:** use `--install-to /dev/<disk>` instead of `auto` (`auto` refuses to guess).

## Notes
- Both steps need Ethernet with internet access (apk and git). The router must hand out DHCP.
- Secure Boot must be off. UEFI only.
- With no display, wait until the PC powers off before removing the USB.
- **Tested end to end in a UEFI VM (QEMU/OVMF, NVMe disk, USB stick image):** install, power-off, first boot from disk, app on port 3000, reboot, SSH key login, password SSH refused, SSH port forwarding, console password login, missing Wi-Fi adapter not breaking Ethernet, and the USB-left-in case not wiping the disk. Not covered by the VM: real Wi-Fi association, Secure Boot / BIOS boot-order settings, and the real ZWO camera. The ZWO SDK is glibc-linked and loads via `gcompat`.
