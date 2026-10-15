#!/bin/bash
# First-boot installer for the TV kiosk. Runs as root from cloud-init (runcmd), or by
# hand: sudo bash install.sh. Safe to run again. Reads its settings from kiosk.env
# next to it, which flash.sh writes. Log: /var/log/tv-kiosk-install.log
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
exec >>/var/log/tv-kiosk-install.log 2>&1
echo "== tv-kiosk install $(date -Is)"
# shellcheck source=/dev/null
. "$SRC/kiosk.env"
: "${TV_USER:?kiosk.env must set TV_USER}"
TV_HOSTNAME="${TV_HOSTNAME:-sb-tv}"
WIFI_COUNTRY="${WIFI_COUNTRY:-}"
HOME_DIR=$(getent passwd "$TV_USER" | cut -d: -f6)

# 1. SSH first, so a failure later can still be fixed remotely.
systemctl enable --now ssh || true
[ -n "$WIFI_COUNTRY" ] && raspi-config nonint do_wifi_country "$WIFI_COUNTRY" || true

# 2. Wait for the network (Wi-Fi can take a minute on first boot).
for _ in $(seq 60); do
  curl -fsS -m 5 -o /dev/null https://pkgs.tailscale.com && break
  sleep 5
done

# 3. Packages: wtype drives the tab rotation, grim takes screenshots.
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y wtype grim curl
command -v chromium >/dev/null || command -v chromium-browser >/dev/null || apt-get install -y chromium

# 4. Tailscale. The auth key is used once and deleted from the boot partition.
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
if [ -s "$SRC/tailscale-authkey" ]; then
  tailscale up --auth-key="file:$SRC/tailscale-authkey" --hostname="$TV_HOSTNAME" && rm -f "$SRC/tailscale-authkey"
fi

# 5. Desktop autologin and no screen blanking, so the kiosk starts with no keyboard.
raspi-config nonint do_boot_behaviour B4 || true
raspi-config nonint do_blanking 1 || true

# 6. The kiosk: control script, pages, autostart entry.
install -m 0755 "$SRC/sb-tv" /usr/local/bin/sb-tv
install -d -o "$TV_USER" -g "$TV_USER" "$HOME_DIR/.config/sb-tv" "$HOME_DIR/.config/autostart"
if [ -s "$SRC/pages" ] && [ ! -s "$HOME_DIR/.config/sb-tv/pages" ]; then
  install -m 0644 -o "$TV_USER" -g "$TV_USER" "$SRC/pages" "$HOME_DIR/.config/sb-tv/pages"
fi
cat > "$HOME_DIR/.config/autostart/sb-tv.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Second Brain TV
Exec=/usr/local/bin/sb-tv autostart
X-GNOME-Autostart-enabled=true
EOF
chown "$TV_USER:$TV_USER" "$HOME_DIR/.config/autostart/sb-tv.desktop"

# Ctrl+Alt+M opens or closes the kiosk. Pi OS binds it to the magnifier; labwc runs with
# -m (merge config), so this small user rc.xml adds to /etc/xdg/labwc/rc.xml and wins for
# that key. Written only if the user has no rc.xml of their own.
install -d -o "$TV_USER" -g "$TV_USER" "$HOME_DIR/.config/labwc"
if [ ! -e "$HOME_DIR/.config/labwc/rc.xml" ]; then
  cat > "$HOME_DIR/.config/labwc/rc.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <keyboard>
    <keybind key="C-A-m">
      <action name="Execute" command="/usr/local/bin/sb-tv toggle" />
    </keybind>
  </keyboard>
</openbox_config>
EOF
  chown "$TV_USER:$TV_USER" "$HOME_DIR/.config/labwc/rc.xml"
fi

touch "$SRC/installed"
echo "== tv-kiosk install done $(date -Is), rebooting"
# Reboot once so autologin takes effect; cloud-init does not rerun runcmd.
systemctl reboot
