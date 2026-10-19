#!/bin/bash
# Flash an SD card for the TV kiosk (needs root and xz): Raspberry Pi OS (cloud-init image, Trixie or newer)
# plus first-boot config that joins Wi-Fi and Tailscale and starts the kiosk.
#
#   flash.sh --image <raspios.img.xz> --device /dev/diskN   write the card (erases it)
#   flash.sh --render <dir>                                 only write the config files to <dir>
#
# Settings come from the environment (load your .env first). Required:
#   TV_PASSWORD     password for TV_USER (sudo); only its SHA-512 hash goes on the card
#   WIFI_SSID, WIFI_PASSWORD
#   TV_PAGE         the page to show: "https://host/tv?kiosk=1" (TV_PAGES, the old
#                   ';'-separated list, still works: its first entry is used)
# Optional:
#   TV_HOSTNAME (sb-tv)  TV_USER (tv)  TV_SSH_PUBKEY (~/.ssh/id_ed25519.pub)
#   WIFI_COUNTRY (US)    TV_TIMEZONE (UTC)  TV_KEYBOARD (us)
#   TS_AUTHKEY      Tailscale pre-auth key; the Pi joins your tailnet on first boot
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="" DEVICE="" RENDER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image)  IMAGE="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --render) RENDER="$2"; shift 2 ;;
    *) sed -n '2,16p' "$0"; exit 1 ;;
  esac
done

TV_HOSTNAME="${TV_HOSTNAME:-sb-tv}"
TV_USER="${TV_USER:-tv}"
TV_SSH_PUBKEY="${TV_SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
WIFI_COUNTRY="${WIFI_COUNTRY:-US}"
TV_TIMEZONE="${TV_TIMEZONE:-UTC}"
TV_KEYBOARD="${TV_KEYBOARD:-us}"
TV_PAGE="${TV_PAGE:-$(printf '%s' "${TV_PAGES:-}" | cut -d';' -f1 | awk '{print $1}')}"
for v in TV_PASSWORD WIFI_SSID WIFI_PASSWORD TV_PAGE; do
  [ -n "${!v:-}" ] || { echo "flash.sh: $v is not set" >&2; exit 1; }
done
[ -r "$TV_SSH_PUBKEY" ] || { echo "flash.sh: no SSH public key at $TV_SSH_PUBKEY" >&2; exit 1; }
[[ "$TV_HOSTNAME" =~ ^[a-z0-9-]+$ ]] || { echo "flash.sh: TV_HOSTNAME must be lowercase letters, digits, -" >&2; exit 1; }
[[ "$TV_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "flash.sh: bad TV_USER" >&2; exit 1; }

# YAML single-quoted scalar: double any single quote.
q(){ local s=${1//\'/\'\'}; printf "'%s'" "$s"; }

render(){
  local out="$1"
  mkdir -p "$out/tv-kiosk"
  chmod 700 "$out"
  local hash; hash=$(printf '%s' "$TV_PASSWORD" | openssl passwd -6 -stdin 2>/dev/null || true)
  [[ "$hash" == '$6$'* ]] || { echo "flash.sh: 'openssl passwd -6' failed; needs OpenSSL, not LibreSSL (put Homebrew's openssl first in PATH)" >&2; exit 1; }
  local key; key=$(head -n1 "$TV_SSH_PUBKEY")
  cat > "$out/user-data" <<EOF
#cloud-config
hostname: $(q "$TV_HOSTNAME")
manage_etc_hosts: true
timezone: $(q "$TV_TIMEZONE")
keyboard:
  model: pc105
  layout: $(q "$TV_KEYBOARD")
users:
  - name: $(q "$TV_USER")
    groups: users,adm,dialout,audio,netdev,video,plugdev,cdrom,games,input,gpio,spi,i2c,render,sudo
    shell: /bin/bash
    lock_passwd: false
    passwd: $(q "$hash")
    ssh_authorized_keys:
      - $(q "$key")
enable_ssh: true
ssh_pwauth: false
runcmd:
  - [bash, /boot/firmware/tv-kiosk/install.sh]
EOF
  cat > "$out/network-config" <<EOF
network:
  version: 2
  wifis:
    renderer: NetworkManager
    wlan0:
      dhcp4: true
      regulatory-domain: $(q "$WIFI_COUNTRY")
      access-points:
        $(q "$WIFI_SSID"):
          password: $(q "$WIFI_PASSWORD")
      optional: true
EOF
  cat > "$out/tv-kiosk/kiosk.env" <<EOF
TV_USER=$TV_USER
TV_HOSTNAME=$TV_HOSTNAME
WIFI_COUNTRY=$WIFI_COUNTRY
EOF
  printf '%s\n' "$TV_PAGE" > "$out/tv-kiosk/pages"
  install -m 0755 "$HERE/install.sh" "$out/tv-kiosk/install.sh"
  install -m 0755 "$HERE/bin/sb-tv" "$out/tv-kiosk/sb-tv"
  if [ -n "${TS_AUTHKEY:-}" ]; then
    (umask 077; printf '%s\n' "$TS_AUTHKEY" > "$out/tv-kiosk/tailscale-authkey")
  fi
}

if [ -n "$RENDER" ]; then render "$RENDER"; echo "rendered to $RENDER"; exit 0; fi

[ -n "$IMAGE" ] && [ -n "$DEVICE" ] || { echo "flash.sh: need --image and --device (or --render)" >&2; exit 1; }
[ -r "$IMAGE" ] || { echo "flash.sh: cannot read $IMAGE" >&2; exit 1; }
command -v xz >/dev/null || { echo "flash.sh: needs xz (brew install xz / apt install xz-utils)" >&2; exit 1; }

# Refuse anything that isn't a removable external disk.
if [ "$(uname)" = Darwin ]; then
  info=$(diskutil info "$DEVICE")
  grep -Eq 'Device Location: +External|Removable Media: +Removable' <<<"$info" || { echo "flash.sh: $DEVICE is not an external disk" >&2; exit 1; }
  grep -q 'Internal: +Yes' <<<"$info" && { echo "flash.sh: $DEVICE is internal" >&2; exit 1; }
  size=$(awk -F'[()]' '/Disk Size/{print $2; exit}' <<<"$info")
else
  [ "$(lsblk -dno RM "$DEVICE")" = 1 ] || { echo "flash.sh: $DEVICE is not removable" >&2; exit 1; }
  size=$(lsblk -dno SIZE "$DEVICE")
fi
raw="$DEVICE"; [ "$(uname)" = Darwin ] && raw="/dev/r${DEVICE#/dev/}"
[ -w "$raw" ] || { echo "flash.sh: can't write $raw; run with sudo" >&2; exit 1; }
echo "About to ERASE $DEVICE ($size) and write $(basename "$IMAGE")."
if [ "${TV_FLASH_YES:-}" != 1 ]; then
  read -r -p "Type the device path again to confirm: " ok
  [ "$ok" = "$DEVICE" ] || { echo "aborted"; exit 1; }
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
render "$WORK/cfg"

[ "$(uname)" = Darwin ] && diskutil unmountDisk "$DEVICE" >/dev/null
# Plain xz | dd. Raspberry Pi Imager's CLI hung at "Unmounting drive" on macOS
# (even as root), and it drops --cloudinit-* for a local image file anyway.
echo "Writing... (about 5-10 minutes)"
case "$IMAGE" in
  *.xz) xz -dc "$IMAGE" ;;
  *)    cat "$IMAGE" ;;
esac | dd of="$raw" bs=4194304 2>&1 | tail -1
sync

# Copy the installer onto the boot partition (FAT, first partition).
if [ "$(uname)" = Darwin ]; then
  diskutil mount "${DEVICE}s1" >/dev/null
  BOOT=$(diskutil info "${DEVICE}s1" | awk -F': +' '/Mount Point/{print $2}')
else
  BOOT=$(mktemp -d); mount "${DEVICE}1" "$BOOT"
fi
[ -f "$BOOT/cmdline.txt" ] || { echo "flash.sh: $BOOT does not look like a Pi boot partition" >&2; exit 1; }
# Replace the image's default cloud-init files (Pi OS reads them from the boot partition).
cp "$WORK/cfg/user-data" "$BOOT/user-data"
cp "$WORK/cfg/network-config" "$BOOT/network-config"
rm -rf "$BOOT/tv-kiosk"
cp -R "$WORK/cfg/tv-kiosk" "$BOOT/tv-kiosk"
sync
echo "boot partition: $(ls "$BOOT/tv-kiosk" | tr '\n' ' ')"
if [ "$(uname)" = Darwin ]; then diskutil eject "$DEVICE" >/dev/null; else umount "$BOOT"; fi
echo "Done. Put the card in the Pi, power it on, wait ~5 min, then: ssh $TV_USER@$TV_HOSTNAME"
