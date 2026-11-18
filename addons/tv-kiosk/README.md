# TV kiosk

A Raspberry Pi behind a TV that shows your Second Brain full screen. It boots straight into a Chromium kiosk on one page and stays there: nothing switches or reloads the page on a timer, so a video plays through. Move between pages at the TV with the app's keyboard shortcuts (Ctrl+Win+<letter>; the ⓘ button at the top right of the app lists them), or change the page over SSH.

Tested target: Raspberry Pi 4, Raspberry Pi OS (64-bit, with desktop) Trixie, which uses cloud-init for first-boot setup. Older images (Bookworm and earlier) are not supported by `flash.sh`.

## What's here

| File | Runs on | Does |
|---|---|---|
| `flash.sh` | Your computer (macOS or Linux) | Writes the OS with `xz | dd`, then puts cloud-init `user-data`, `network-config` and the installer on the boot partition |
| `install.sh` | The Pi, once, at first boot (cloud-init `runcmd`) | Enables SSH, waits for Wi-Fi, installs `wtype` and `grim`, installs Tailscale and joins with your auth key (then deletes the key), turns on desktop autologin, turns off screen blanking, installs `sb-tv` and its autostart entry, reboots |
| `bin/sb-tv` | The Pi | Starts and stops the kiosk, sets its page |
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
| `TV_PAGE` | yes | | The page to show, e.g. `https://your-app/tv?kiosk=1`. The old `TV_PAGES` list still works; its first entry is used |
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
| Show a page | `sb-tv url https://your-app/tv?kiosk=1` |
| Go to another page at the TV | The app's shortcuts: **Ctrl+Win+T** TV, **Ctrl+Win+A** agents, **Ctrl+Win+O** org and so on; add **Shift** for a page's full-screen view (`Ctrl+Shift+Win+T` back to the TV channel). **Ctrl+Win+/** lists them |
| Open or close the kiosk at the TV | **Ctrl+Alt+M** (Ctrl+Option+M on a Mac keyboard), or `sb-tv toggle` |
| Browse the app at the TV: swap the kiosk for a normal full-screen browser (same login, F11 shows the URL bar) and back | **Ctrl+Alt+N**, or `sb-tv browse` |
| Restart the browser (also picks up a new app deploy) | `sb-tv reload` |
| Turn it off | `sb-tv stop` |
| Screenshot the TV | `grim /tmp/tv.png`, then `scp` it back |

The page lives in `~/.config/sb-tv/pages`: the first URL in it. Extra Chromium flags (zoom on a big TV: `--force-device-scale-factor=1.5`) go in `SB_TV_CHROMIUM_FLAGS`. Pages keep their own data fresh (they poll the API); the kiosk never reloads them.

## Not covered

- Long-lived logins. The kiosk logs in like a person; if your app's session expires, sign in again with a keyboard.
- Turning the TV on and off (HDMI-CEC: `sudo apt install cec-utils`).
- Raspberry Pi 5 and Pi OS Lite have not been tried.
