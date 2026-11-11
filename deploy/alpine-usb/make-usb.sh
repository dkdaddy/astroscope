#!/usr/bin/env bash
# Build a headless Alpine Linux installer USB (UEFI). Boot a mini PC from it and
# it installs Alpine + AstroScope onto the PC's internal disk, then powers off.
# Remove the USB and power on to boot from the internal disk.
# Run on a Linux host as root.
#
#   sudo ./make-usb.sh --ssh-key ~/.ssh/id_ed25519.pub --install-to auto \
#        --sdk ./libASICamera2.so /dev/sdX
#   sudo ./make-usb.sh --ssh-key ~/.ssh/id_ed25519.pub --install-to auto --image astroscope.img
#   ./make-usb.sh --ssh-key ~/.ssh/id_ed25519.pub --install-to auto --overlay-only
#
# --image writes a disk image instead of a device; flash it with Rufus (DD mode),
# balenaEtcher or dd. Works from WSL.
#
# --install-to auto|/dev/nvme0n1 is the disk that will be ERASED on the mini PC.
# "auto" only proceeds if the PC has exactly one internal disk.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ALPINE_BRANCH="${ALPINE_BRANCH:-v3.24}"
REPO="${REPO:-https://github.com/dkdaddy/astroscope.git}"
BRANCH="${BRANCH:-main}"
DEVICE_HOSTNAME="${DEVICE_HOSTNAME:-astroscope}"
CACHE_DIR="${CACHE_DIR:-$HERE/cache}"
OUT_DIR="${OUT_DIR:-$HERE/out}"

SSH_KEY="" SDK="" ISO="" OVERLAY_ONLY=0 ASSUME_YES=0 FORCE=0 DEV="" IMAGE=""
IMAGE_MIB="${IMAGE_MIB:-1024}"
# How many times the boot-media search is retried (each try ~6-8 s).
FINDFS_TRIES="${FINDFS_TRIES:-25}"
INSTALL_TO="" POWEROFF=1 REINSTALL=0 RESET_KEY=0 DEBUG_BOOT=0 DISABLE_SD=0
# SD card reader drivers. On some mini PCs the empty reader retries forever
# ("mmc0: Timeout waiting for hardware cmd interrupt") and early boot never
# finds the USB stick. module_blacklist= is enforced by the kernel itself.
SD_MODULES="sdhci,sdhci_pci,sdhci_acpi"
KEYMAP=none CONSOLE_LOGIN=1 CONSOLE_HASH=""
WIFI_SSID="" WIFI_PSK="" WIFI_COUNTRY="" WIFI_PSK_SET=0

die() { echo "error: $*" >&2; exit 1; }

# Single-quote a value so the target's sh can safely source it.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --install-to) INSTALL_TO="$2"; shift 2 ;;
    --console-password-hash) CONSOLE_HASH="$2"; shift 2 ;;
    --no-console-login) CONSOLE_LOGIN=0; shift ;;
    --keymap) KEYMAP="$2"; shift 2 ;;
    --wifi-ssid) WIFI_SSID="$2"; shift 2 ;;
    --wifi-psk) WIFI_PSK="$2"; WIFI_PSK_SET=1; shift 2 ;;
    --wifi-country) WIFI_COUNTRY="$2"; shift 2 ;;
    --sdk) SDK="$2"; shift 2 ;;
    --iso) ISO="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --hostname) DEVICE_HOSTNAME="$2"; shift 2 ;;
    --no-poweroff) POWEROFF=0; shift ;;
    --reinstall) REINSTALL=1; shift ;;
    --reset-key) RESET_KEY=1; shift ;;
    --debug-boot) DEBUG_BOOT=1; shift ;;
    --disable-sd-reader) DISABLE_SD=1; shift ;;
    --image) IMAGE="$2"; shift 2 ;;
    --overlay-only) OVERLAY_ONLY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    /dev/*) DEV="$1"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$SSH_KEY" ] || die "--ssh-key <public key file> is required (the drive has no password login)"
[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY"
[ -n "$INSTALL_TO" ] || die "--install-to auto|/dev/<disk> is required (the disk on the mini PC that will be erased)"
[ -z "$SDK" ] || [ -f "$SDK" ] || die "SDK file not found: $SDK"

# Console (keyboard + monitor) password. SSH stays key-only; only the hash is stored.
if [ "$CONSOLE_LOGIN" -eq 1 ] && [ -z "$CONSOLE_HASH" ]; then
  command -v openssl >/dev/null || die "openssl is required to hash the console password (or pass --console-password-hash / --no-console-login)"
  read -r -s -p "Console login password for root: " pw1; echo
  read -r -s -p "Repeat password: " pw2; echo
  [ -n "$pw1" ] && [ "$pw1" = "$pw2" ] || die "passwords empty or do not match"
  CONSOLE_HASH="$(printf '%s' "$pw1" | openssl passwd -6 -stdin)"
fi
[ "$CONSOLE_LOGIN" -eq 1 ] || CONSOLE_HASH=""

if [ -n "$WIFI_SSID" ] && [ "$WIFI_PSK_SET" -eq 0 ]; then
  read -r -s -p "Wi-Fi passphrase for '$WIFI_SSID' (empty = open network): " WIFI_PSK; echo
fi
[ -z "$WIFI_PSK" ] || { [ ${#WIFI_PSK} -ge 8 ] && [ ${#WIFI_PSK} -le 63 ]; } || die "Wi-Fi passphrase must be 8-63 characters"
mkdir -p "$OUT_DIR" "$CACHE_DIR"

build_overlay() {
  local stage out="$OUT_DIR/local.apkovl.tar.gz"
  stage="$(mktemp -d)"
  cp -a "$HERE/overlay/." "$stage/"

  sed -i "s#@ALPINE_BRANCH@#$ALPINE_BRANCH#g" "$stage/etc/apk/repositories"
  echo "$DEVICE_HOSTNAME" > "$stage/etc/hostname"
  {
    printf 'REPO=%s\nBRANCH=%s\nTARGET_DISK=%s\nPOWEROFF=%s\nREINSTALL=%s\nRESET_KEY=%s\n' \
      "$(sq "$REPO")" "$(sq "$BRANCH")" "$(sq "$INSTALL_TO")" "$POWEROFF" "$REINSTALL" "$RESET_KEY"
    printf 'KEYMAP=%s\nCONSOLE_PW_HASH=%s\n' "$(sq "$KEYMAP")" "$(sq "$CONSOLE_HASH")"
    printf 'WIFI_SSID=%s\nWIFI_PSK=%s\nWIFI_COUNTRY=%s\n' "$(sq "$WIFI_SSID")" "$(sq "$WIFI_PSK")" "$(sq "$WIFI_COUNTRY")"
    [ "$DISABLE_SD" -eq 0 ] || printf 'EXTRA_KERNELOPTS=%s\n' "$(sq "module_blacklist=$SD_MODULES")"
  } > "$stage/etc/astroscope-provision.conf"
  chmod 600 "$stage/etc/astroscope-provision.conf"

  # Single source of truth for the service definition.
  install -D -m 755 "$HERE/../alpine/astroscope.initd" "$stage/etc/init.d/astroscope"
  chmod 755 "$stage/etc/local.d/01-setup.start"

  install -d -m 700 "$stage/root/.ssh"
  install -m 600 "$SSH_KEY" "$stage/root/.ssh/authorized_keys"

  # With an apkovl present Alpine does not create its default runlevels, so
  # list the standard set for a diskless boot (modloop provides kernel modules).
  mkdir -p "$stage/etc/runlevels/sysinit" "$stage/etc/runlevels/boot" \
    "$stage/etc/runlevels/default" "$stage/etc/runlevels/shutdown"
  for s in devfs dmesg mdev hwdrivers modloop; do
    ln -sf "/etc/init.d/$s" "$stage/etc/runlevels/sysinit/$s"
  done
  for s in hwclock modules sysctl hostname bootmisc syslog seedrng networking; do
    ln -sf "/etc/init.d/$s" "$stage/etc/runlevels/boot/$s"
  done
  for s in mount-ro killprocs savecache; do
    ln -sf "/etc/init.d/$s" "$stage/etc/runlevels/shutdown/$s"
  done
  ln -sf /etc/init.d/local "$stage/etc/runlevels/default/local"

  # The overlay is extracted over / on boot; drop group/world write bits
  # inherited from Windows/NTFS mounts.
  chmod -R go-w "$stage"
  tar --owner=0 --group=0 --numeric-owner -czf "$out" -C "$stage" .
  rm -rf "$stage"
  echo "Built $out" >&2
}

fetch_iso() {
  [ -n "$ISO" ] && { echo "$ISO"; return; }
  local base="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_BRANCH/releases/x86_64"
  local yaml info name sha
  yaml="$(curl -fsSL "$base/latest-releases.yaml")"
  info="$(printf '%s\n' "$yaml" | awk '
    /^  flavor:/ {f=$2}
    /^  iso:/    {i=$2}
    /^  sha256:/ {if (f=="alpine-standard") {print i, $2; exit}}')"
  name="${info% *}"; sha="${info#* }"
  [ -n "$name" ] || die "could not find alpine-standard ISO in $base/latest-releases.yaml"
  if [ ! -f "$CACHE_DIR/$name" ]; then
    echo "Downloading $name" >&2
    curl -fL -o "$CACHE_DIR/$name.part" "$base/$name"
    mv "$CACHE_DIR/$name.part" "$CACHE_DIR/$name"
  fi
  echo "$sha  $CACHE_DIR/$name" | sha256sum -c - >&2 || die "ISO checksum mismatch"
  echo "$CACHE_DIR/$name"
}

# build_retry_initrd ALPINE_INITRAMFS OUT.gz
# Extra initramfs layered on top of Alpine's: the real nlplug-findfs is kept as
# nlplug-findfs.real and replaced by a wrapper that retries the search.
build_retry_initrd() {
  local src="$1" out="$2" d
  d="$(mktemp -d)"
  mkdir -p "$d/usr/sbin"
  (cd "$d" && gzip -dc "$src" | cpio -id --quiet usr/sbin/nlplug-findfs) \
    || die "could not extract nlplug-findfs from $src"
  [ -x "$d/usr/sbin/nlplug-findfs" ] || die "nlplug-findfs not found in $src"
  mv "$d/usr/sbin/nlplug-findfs" "$d/usr/sbin/nlplug-findfs.real"
  cat > "$d/usr/sbin/nlplug-findfs" <<EOF
#!/usr/bin/sh
# AstroScope: retry Alpine's boot-media search; slow USB sticks appear late.
tries=$FINDFS_TRIES
i=1
while :; do
	/usr/sbin/nlplug-findfs.real "\$@" && exit 0
	[ "\$i" -ge "\$tries" ] && exit 1
	echo "AstroScope: boot media not found yet, retrying (\$i/\$tries)..." >&2
	sleep 2
	i=\$((i + 1))
done
EOF
  chmod 755 "$d/usr/sbin/nlplug-findfs"
  (cd "$d" && find usr | cpio -o -H newc -R 0:0 --quiet | gzip -9) > "$out"
  rm -rf "$d"
}

build_overlay
if [ "$OVERLAY_ONLY" -eq 1 ]; then
  echo "Copy $OUT_DIR/local.apkovl.tar.gz to the root of the Alpine boot partition." >&2
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -n "$DEV" ] || [ -n "$IMAGE" ] || die "target required: a USB device (/dev/sdX) or --image FILE"
[ -z "$DEV" ] || [ -z "$IMAGE" ] || die "give either a device or --image, not both"
for tool in curl sfdisk wipefs mkfs.vfat mount sha256sum lsblk losetup cpio gzip; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done

if [ -z "$IMAGE" ]; then
  [ -b "$DEV" ] || die "$DEV is not a block device"
  name="$(basename "$DEV")"
  if ! readlink -f "/sys/block/$name" | grep -q '/usb' && [ "$(cat "/sys/block/$name/removable" 2>/dev/null)" != 1 ] && [ "$FORCE" -ne 1 ]; then
    die "$DEV does not look like a USB/removable drive (use --force to override)"
  fi
  if lsblk -nro MOUNTPOINT "$DEV" | grep -qE '^(/|/boot|/boot/efi|/home)$'; then
    die "$DEV holds a system mount point; refusing"
  fi
fi

ISO_FILE="$(fetch_iso)"

echo
if [ "$RESET_KEY" -eq 1 ]; then
  echo "--reset-key: booting a mini PC from it will NOT erase anything; it only replaces root's SSH keys on the install on $INSTALL_TO, then powers off."
else
  echo "Booting a mini PC from it will ERASE its internal disk ($INSTALL_TO) with no further prompt."
fi
if [ -z "$IMAGE" ]; then
  lsblk -o NAME,SIZE,MODEL,TRAN "$DEV"
  echo "This writes the installer to $DEV (all data on it is destroyed)."
  if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Type the USB device name ($DEV) to continue: " answer
    [ "$answer" = "$DEV" ] || die "aborted"
  fi
fi

WORK="$(mktemp -d)"
LOOP=""
cleanup() {
  set +e
  for m in iso boot; do mountpoint -q "$WORK/$m" && umount "$WORK/$m"; done
  [ -z "$LOOP" ] || losetup -d "$LOOP"
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/iso" "$WORK/boot"

if [ -n "$IMAGE" ]; then
  rm -f "$IMAGE"
  truncate -s "${IMAGE_MIB}M" "$IMAGE"
  LOOP="$(losetup -fP --show "$IMAGE")"
  DEV="$LOOP"
fi

part() { case "$DEV" in *[0-9]) echo "${DEV}p$1" ;; *) echo "${DEV}$1" ;; esac; }

umount "$DEV"?* 2>/dev/null || true
wipefs -a "$DEV" >/dev/null
sfdisk "$DEV" >/dev/null <<EOF
label: gpt
type=U, name=ALPINE
EOF
[ -z "$LOOP" ] || partx -u "$LOOP" 2>/dev/null || partx -a "$LOOP" 2>/dev/null || true
udevadm settle 2>/dev/null || sleep 2
for _ in 1 2 3 4 5; do [ -b "$(part 1)" ] && break; sleep 1; done
[ -b "$(part 1)" ] || die "partition $(part 1) did not appear"

mkfs.vfat -F32 -n ALPINE "$(part 1)" >/dev/null

mount -o loop,ro "$ISO_FILE" "$WORK/iso"
mount "$(part 1)" "$WORK/boot"

echo "Copying Alpine to the USB"
cp -r --no-preserve=all "$WORK/iso/." "$WORK/boot/"

# Alpine's nlplug-findfs gives up looking for the boot media after ~6 s without
# new device events (its -t/usbdelay option does not extend that). Slow real USB
# sticks show up later -> "Mounting boot media failed". Add a second initramfs
# that replaces it with a wrapper which retries the search.
build_retry_initrd "$WORK/iso/boot/initramfs-lts" "$WORK/boot/boot/astroscope-initrd.gz"
sed -i 's#^\(initrd[[:space:]]*/boot/initramfs-lts\)[[:space:]]*$#\1 /boot/astroscope-initrd.gz#' "$WORK/boot/boot/grub/grub.cfg"
sed -i 's#^\(INITRD /boot/initramfs-lts\)[[:space:]]*$#\1,/boot/astroscope-initrd.gz#' "$WORK/boot/boot/syslinux/syslinux.cfg"
grep -q 'astroscope-initrd.gz' "$WORK/boot/boot/grub/grub.cfg" || die "could not add the retry initrd to grub.cfg"

KOPTS=""
[ "$DISABLE_SD" -eq 0 ] || KOPTS=" module_blacklist=$SD_MODULES"
# --debug-boot: trace the initramfs (set -x, nlplug-findfs -d) and show kernel messages.
[ "$DEBUG_BOOT" -eq 0 ] || KOPTS="$KOPTS debug_init"
for cfg in "$WORK/boot/boot/grub/grub.cfg" "$WORK/boot/boot/syslinux/syslinux.cfg"; do
  [ -f "$cfg" ] || continue
  sed -i "s/modules=loop,squashfs,sd-mod,usb-storage/&$KOPTS/" "$cfg"
  [ "$DEBUG_BOOT" -eq 0 ] || sed -i "s/ quiet//" "$cfg"
done
cp "$OUT_DIR/local.apkovl.tar.gz" "$WORK/boot/local.apkovl.tar.gz"
[ -z "$SDK" ] || install -m 755 "$SDK" "$WORK/boot/libASICamera2.so"

sync
if [ -n "$IMAGE" ]; then
  umount "$WORK/boot" "$WORK/iso"
  losetup -d "$LOOP"; LOOP=""
  echo "Done: $IMAGE. Write it to a USB stick with Rufus (DD mode), balenaEtcher or dd."
else
  echo "Done."
fi
echo "1. Connect the mini PC to Ethernet (with internet), Secure Boot off, boot from this USB."
echo "2. It installs to $INSTALL_TO and powers itself off (about 5-10 minutes)."
echo "3. Remove the USB and power on. The first boot from the internal disk builds AstroScope (a few minutes)."
echo "4. ssh root@$DEVICE_HOSTNAME.local, then open http://$DEVICE_HOSTNAME.local:3000"
[ -z "$CONSOLE_HASH" ] || echo "   With a keyboard and monitor you can log in as root on the console with the password you set."
[ -z "$WIFI_SSID" ] || echo "   Wi-Fi '$WIFI_SSID' is configured on the installed system; the install itself still needs Ethernet."
