# TV kiosk

A Raspberry Pi behind a TV that shows your Second Brain full screen. It boots straight into a Chromium kiosk with one tab per page, rotates through them, and reloads each page as it comes up so the data is fresh. You change what it shows over SSH.

Tested target: Raspberry Pi 4, Raspberry Pi OS (64-bit, with desktop) Trixie, which uses cloud-init for first-boot setup. Older images (Bookworm and earlier) are not supported by `flash.sh`.

## What's here

| File | Runs on | Does |
|---|---|---|
| `flash.sh` | Your computer (macOS or Linux) | Writes the OS with `xz | dd`, then puts cloud-init `user-data`, `network-config` and the installer on the boot partition |
| `install.sh` | The Pi, once, at first boot (cloud-init `runcmd`) | Enables SSH, waits for Wi-Fi, installs `wtype` and `grim`, installs Tailscale and joins with your auth key (then deletes the key), turns on desktop autologin, turns off screen blanking, installs `sb-tv` and its autostart entry, reboots |
| `bin/sb-tv` | The Pi | Starts, stops and rotates the kiosk |
| `tests/` | CI | `python3 -m pytest addons` |

## Flash a card

You need `xz` and the OS image downloaded (`.img.xz` from raspberrypi.com/software/operating-systems).

```bash
set -a; . ./.env; set +a          # your settings, see below
addons/tv-kiosk/flash.sh --image 2026-10-06-raspios-trixie-arm64.img.xz --device /dev/disk4
```

It refuses non-removable disks and asks you to type the device path again before erasing. Writing a raw disk needs root: run it with `sudo` (it says so and stops if not).

| Variable | Required | Default | What |
|---|---|---|---|
| `TV_PASSWORD` | yes | | Login and sudo password. Only its SHA-512 hash goes on the card |
| `WIFI_SSID`, `WIFI_PASSWORD` | yes | | The Wi-Fi the TV is on |
| `TV_PAGES` | yes | | `;`-separated pages, each `<url> [seconds]` |
| `TS_AUTHKEY` | no | | Tailscale pre-auth key (one-off). Without it, run `sudo tailscale up` on the Pi yourself |
| `TV_HOSTNAME` | no | `sb-tv` | |
| `TV_USER` | no | `tv` | |
| `TV_SSH_PUBKEY` | no | `~/.ssh/id_ed25519.pub` | The key allowed to SSH in. Password SSH is off |
| `WIFI_COUNTRY` | no | `US` | Two-letter Wi-Fi regulatory country |
| `TV_TIMEZONE`, `TV_KEYBOARD` | no | `UTC`, `us` | |

`flash.sh --render <dir>` writes the same files to a folder without touching a disk, so you can check them.

The Wi-Fi password stays in `network-config` on the boot partition, as with Raspberry Pi Imager. The Tailscale key is deleted after it is used.

## First boot

Card in, micro-HDMI from the port next to USB-C (HDMI0) to the TV, power last. First boot takes about 5 minutes: it resizes the card, runs cloud-init, installs packages and reboots once into the kiosk. Then:

```bash
ssh -l tv sb-tv.local    # same network
ssh -l tv sb-tv          # anywhere on your tailnet
sudo cat /var/log/tv-kiosk-install.log
```

If your app needs a login, plug in a keyboard once and sign in. The kiosk's Chromium profile is its own (`~/.config/sb-tv/chromium-profile`), so the session survives reboots until the app expires it.

## Control it

| You want | Command |
|---|---|
| What's showing | `sb-tv status` |
| Show one page | `sb-tv url https://your-app/projects` |
| Show several, rotating | `sb-tv url https://your-app/ https://your-app/projects` |
| Add a page with its own time | `sb-tv add https://your-app/ring 30` |
| Restart the browser | `sb-tv reload` |
| Turn it off | `sb-tv stop` |
| Screenshot the TV | `grim /tmp/tv.png`, then `scp` it back |

Pages live in `~/.config/sb-tv/pages`, one `<url> [seconds]` per line. Rotation sends Ctrl+Tab and F5 with `wtype`. A single page reloads every `SB_TV_REFRESH` seconds (default 300). Extra Chromium flags (zoom on a big TV: `--force-device-scale-factor=1.5`) go in `SB_TV_CHROMIUM_FLAGS`.

## Not covered

- Long-lived logins. The kiosk logs in like a person; if your app's session expires, sign in again with a keyboard.
- Turning the TV on and off (HDMI-CEC: `sudo apt install cec-utils`).
- Raspberry Pi 5 and Pi OS Lite have not been tried.
