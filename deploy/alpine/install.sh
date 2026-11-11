#!/bin/sh
# Install AstroScope as an OpenRC service on Alpine Linux.
# Run as root from anywhere:  sh deploy/alpine/install.sh
# Optional: ASI_SDK_LIB=/path/to/libASICamera2.so to install the ZWO SDK.
set -eu

SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR=/opt/astroscope
APP_USER=astroscope

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }

# gcompat: the prebuilt ZWO SDK is linked against glibc, Alpine uses musl.
# libusb/eudev: camera access and device-permission rules.
apk add --no-cache nodejs npm libusb libstdc++ gcompat eudev udev-init-scripts rsync

addgroup -S plugdev 2>/dev/null || true
adduser -S -D -h "$APP_DIR" -G users "$APP_USER" 2>/dev/null || true
addgroup "$APP_USER" plugdev 2>/dev/null || true

mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude logs --exclude recordings --exclude bin --exclude .git \
  "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/logs" "$APP_DIR/recordings" "$APP_DIR/bin"

if [ -n "${ASI_SDK_LIB:-}" ]; then
  install -m 755 "$ASI_SDK_LIB" "$APP_DIR/bin/libASICamera2.so"
fi

cd "$APP_DIR"
npm ci
npm run build
npm prune --omit=dev
chown -R "$APP_USER":users "$APP_DIR"

# ZWO cameras (vendor 03c3) must be accessible without root.
cat > /etc/udev/rules.d/99-zwo-asi.rules <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="03c3", MODE="0666", GROUP="plugdev"
EOF
rc-update add udev sysinit 2>/dev/null || true
rc-update add udev-trigger sysinit 2>/dev/null || true
rc-service udev restart 2>/dev/null || true
udevadm control --reload 2>/dev/null || true
udevadm trigger 2>/dev/null || true

install -m 755 "$SRC_DIR/deploy/alpine/astroscope.initd" /etc/init.d/astroscope
rc-update add astroscope default
rc-service astroscope restart

echo "AstroScope installed. Open http://$(hostname):3000"
[ -f "$APP_DIR/bin/libASICamera2.so" ] || echo "NOTE: no ZWO SDK found in $APP_DIR/bin; the simulator will be used."
