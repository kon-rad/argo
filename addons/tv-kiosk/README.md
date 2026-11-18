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

## Optional windowed desktop and offline voice MVP

`sb-tv mode windowed` persists an ordinary browser window as the default for start,
autostart, reload and toggle. The existing Chromium profile and login are retained.
F11 optionally enters/exits fullscreen. `sb-tv mode kiosk` restores the original TV
default. Installations without a `~/.config/sb-tv/default-mode` file stay in kiosk
mode. Browse mode remains the existing temporary fullscreen alternative.

The optional voice helper uses local Vosk recognition and Chrome DevTools Protocol
(CDP), with no cloud keys, model agent, arbitrary shell commands or desktop-wide key
injection. It is separate from the app's voice-output addon. It does not implement
Hiring Desk approvals or payment.

Flow: press Ctrl+Alt+V with the browser visible, wait for the **Listening** notification,
say one command in the five-second recording, and watch the browser action. This is
press-to-record, not hold-to-talk. The model loads on each invocation; there is no
always-listening daemon. A lock prevents overlapping captures. Audio stays in memory.

### Install on an existing Pi desktop

Use the desktop user's account, with an existing `sb-tv` setup and working microphone.
Pair a Bluetooth keyboard from the desktop's Bluetooth -> Add Device menu first.
Use its actual manual for the pairing/Fn combination, then verify sleep/reboot reconnect.

```bash
sudo apt install python3-venv libportaudio2 libnotify-bin unzip
mkdir -p ~/.local/share/sb-tv
cd ~/.local/share/sb-tv
curl -fLO https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip vosk-model-small-en-us-0.15.zip
```

The model is a separate download; select the language/model and check its license
on the [Vosk model list](https://alphacephei.com/vosk/models). From the engine checkout:

```bash
bash addons/tv-kiosk/install-voice.sh "$HOME/.local/share/sb-tv/vosk-model-small-en-us-0.15"
```

The installer backs up launcher/key configuration under `~/.local/state/sb-tv/`,
installs a user venv and helper, preserves existing labwc bindings, adds Ctrl+Alt+V,
and installs the updated launcher with sudo. It refuses to overwrite a different
Ctrl+Alt+V binding. It restarts this profile's browser window and reloads labwc
configuration. No OS image, photos, Wi-Fi or browser profile is replaced.

An optional second installer argument selects the microphone by name substring or ID.
Names are preferable because device IDs can change after reboot:

```bash
~/.config/sb-tv/voice-venv/bin/python ~/.config/sb-tv/voice.py devices
bash addons/tv-kiosk/install-voice.sh /path/to/extracted/model "USB Microphone"
~/.config/sb-tv/voice-venv/bin/python ~/.config/sb-tv/voice.py check
```

`check` proves browser attachment only. Test actual speech and record its latency and
accuracy on the target device before calling voice control working. Notifications
need a desktop notification service; foreground `voice.py listen` prints the same
state and allows Ctrl+C cancellation. Shortcut captures always end within the bounded
recording interval after model/device initialization.

### Commands and limits

| Say exactly | Action |
|---|---|
| `back` / `forward` | Navigate within the selected tab's history |
| `reload page` | Request a reload |
| `scroll down` / `scroll up` | Scroll by 70% of viewport height |
| `enter fullscreen` / `leave fullscreen` | Set the browser window state explicitly |
| `next tab` / `previous tab` | Cycle same-window tabs in stable target-ID order |
| `cancel` | Discard this recording without an action |

CDP does not supply visual tab-strip order; tab cycling uses stable session IDs, so
it can differ from left-to-right order. Only a visible HTTP(S) page can be the initial
target. Focus one browser window if several are visible. A tab switch, navigation or
reload during capture invalidates the command. Unknown/combined phrases are rejected.
Exact transcript matching is not a guarantee against STT errors; test with real noise.

Opting into voice creates `~/.config/sb-tv/voice-enabled`, which makes this dedicated
Chromium profile expose CDP on **127.0.0.1:9222**. Verify with `ss -ltnp` on the Pi;
never forward or expose that port. Other local processes can control this browser
through CDP. Existing TV installations do not open a debug port unless explicitly
enabled. The helper refuses remote WebSocket URLs and ignores HTTP proxy settings.

To disable voice, remove `~/.config/sb-tv/voice-enabled`, remove only the added C-A-v
binding from `~/.config/labwc/rc.xml`, run `labwc --reconfigure`, and `sb-tv reload`.
To roll back the launcher/configuration, restore the corresponding files from the
installer's printed backup directory. Retain any unrelated bindings added afterward.

### Verification

```bash
python3 -m pytest addons/tv-kiosk/tests
# Optional real Chrome protocol test, using a fresh temporary profile and local page:
TV_VOICE_TEST_CHROME=/path/to/chrome python3 -m pytest addons/tv-kiosk/tests/test_voice_browser.py
```

Tests cover launcher flags/defaults, tab/page change rejection, fixed actions,
loopback restrictions and non-destructive keybinding setup. The opt-in browser test
also checks real scrolling, window state, history, tab activation and stale-page
rejection. They do not substitute for Pi boot, Bluetooth and microphone checks.
