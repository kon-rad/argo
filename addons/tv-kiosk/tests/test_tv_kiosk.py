"""Tests for the TV kiosk add-on: flash.sh --render output and sb-tv's one page."""
import os
import subprocess
from pathlib import Path

ADDON = Path(__file__).resolve().parents[1]
FLASH = ADDON / "flash.sh"
SBTV = ADDON / "bin" / "sb-tv"


def env(tmp_path, **over):
    key = tmp_path / "id.pub"
    key.write_text("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFake test@example\n")
    e = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "TV_PASSWORD": "s3cret pass",
        "WIFI_SSID": "Cafe O'Brien",
        "WIFI_PASSWORD": "wifi-pass-123",
        "TV_PAGE": "https://example.com/tv?kiosk=1",
        "TV_SSH_PUBKEY": str(key),
    }
    e.update(over)
    return e


def render(tmp_path, **over):
    out = tmp_path / "out"
    r = subprocess.run(["bash", str(FLASH), "--render", str(out)], env=env(tmp_path, **over),
                       capture_output=True, text=True)
    return r, out


def test_scripts_parse():
    for f in (FLASH, SBTV, ADDON / "install.sh"):
        subprocess.run(["bash", "-n", str(f)], check=True)


def test_render_writes_cloud_init(tmp_path):
    r, out = render(tmp_path)
    assert r.returncode == 0, r.stderr
    ud = (out / "user-data").read_text()
    assert ud.startswith("#cloud-config\n")
    assert "hostname: 'sb-tv'" in ud
    assert "- name: 'tv'" in ud
    assert "passwd: '$6$" in ud
    assert "ssh_pwauth: false" in ud
    assert "/boot/firmware/tv-kiosk/install.sh" in ud
    nc = (out / "network-config").read_text()
    assert "'Cafe O''Brien':" in nc  # YAML single-quote escaping
    assert "password: 'wifi-pass-123'" in nc


def test_password_never_in_plain_text(tmp_path):
    r, out = render(tmp_path)
    for f in out.rglob("*"):
        if f.is_file():
            assert "s3cret pass" not in f.read_text()


def test_page_written(tmp_path):
    r, out = render(tmp_path)
    assert (out / "tv-kiosk" / "pages").read_text() == "https://example.com/tv?kiosk=1\n"


def test_old_pages_list_uses_its_first_entry(tmp_path):
    r, out = render(tmp_path, TV_PAGE="", TV_PAGES="https://example.com/ 60; https://example.com/projects 30;")
    assert r.returncode == 0, r.stderr
    assert (out / "tv-kiosk" / "pages").read_text() == "https://example.com/\n"


def test_authkey_only_when_set(tmp_path):
    r, out = render(tmp_path)
    assert not (out / "tv-kiosk" / "tailscale-authkey").exists()
    r, out = render(tmp_path, TS_AUTHKEY="tskey-auth-fake")
    assert (out / "tv-kiosk" / "tailscale-authkey").read_text().strip() == "tskey-auth-fake"


def test_missing_setting_fails(tmp_path):
    r, _ = render(tmp_path, WIFI_SSID="")
    assert r.returncode != 0
    assert "WIFI_SSID" in r.stderr


def test_bad_hostname_rejected(tmp_path):
    r, _ = render(tmp_path, TV_HOSTNAME="Bad Name")
    assert r.returncode != 0


def test_sb_tv_page_is_the_first_url(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    # An old rotation file: only its first page is shown, and its time is ignored.
    (conf / "pages").write_text("# comment\n\nhttps://a.example/ 45\nhttps://b.example/\n")
    r = subprocess.run(["bash", str(SBTV), "page"], env={"PATH": os.environ["PATH"],
                       "HOME": str(tmp_path), "SB_TV_CONF": str(conf)},
                       capture_output=True, text=True, check=True)
    assert r.stdout == "https://a.example/\n"


def test_sb_tv_never_switches_or_reloads_pages():
    text = SBTV.read_text()
    for gone in ("_rotate", "wtype", "F5", "Tab"):
        assert gone not in text, gone


def bash4():
    """The launcher also runs on macOS bash 3.2 for isolated regression tests."""
    import shutil
    return shutil.which("bash")


def sbtv(tmp_path, conf, *args):
    # A stub nohup keeps the test from launching Chromium.
    stubs = tmp_path / "stubs"
    stubs.mkdir(exist_ok=True)
    (stubs / "nohup").write_text("#!/bin/sh\nexit 0\n")
    (stubs / "nohup").chmod(0o755)
    return subprocess.run([bash4(), str(SBTV), *args], env={"PATH": f"{stubs}:{os.environ['PATH']}",
                          "HOME": str(tmp_path), "SB_TV_CONF": str(conf)},
                          capture_output=True, text=True)


def test_url_sets_the_one_page(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    (conf / "pages").write_text("https://a.example/ 45\nhttps://b.example/ 30\n")
    assert sbtv(tmp_path, conf, "url", "https://a.example/tv?kiosk=1").returncode == 0
    assert (conf / "pages").read_text() == "https://a.example/tv?kiosk=1\n"
    out = sbtv(tmp_path, conf, "status").stdout
    assert "mode: kiosk" in out and "page: https://a.example/tv?kiosk=1" in out


def test_url_needs_one_url(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    for args in (("url",), ("url", "https://a.example/", "https://b.example/")):
        r = sbtv(tmp_path, conf, *args)
        assert r.returncode == 1 and "usage" in r.stdout


def test_install_writes_a_valid_toggle_keybind():
    import re
    import xml.etree.ElementTree as ET
    text = (ADDON / "install.sh").read_text()
    xml = re.search(r'rc\.xml" <<\'EOF\'\n(.*?)\nEOF', text, re.S).group(1)
    ns = {"o": "http://openbox.org/3.4/rc"}
    binds = {b.get("key"): b.find("o:action", ns).get("command")
             for b in ET.fromstring(xml).findall("o:keyboard/o:keybind", ns)}
    assert binds == {"C-A-m": "/usr/local/bin/sb-tv toggle",
                     "C-A-n": "/usr/local/bin/sb-tv browse"}


def test_browse_toggles_and_drops_kiosk_param(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    (conf / "pages").write_text("https://a.example/tv?kiosk=1\n")
    assert sbtv(tmp_path, conf, "browse").returncode == 0
    assert (conf / "browse").exists()
    assert "mode: browse" in sbtv(tmp_path, conf, "status").stdout
    # The pages file is untouched, so the second press restores the same kiosk.
    assert (conf / "pages").read_text() == "https://a.example/tv?kiosk=1\n"
    assert sbtv(tmp_path, conf, "browse").returncode == 0
    assert not (conf / "browse").exists()


def test_browse_url_strips_only_kiosk(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    cases = {"https://a.example/tv?kiosk=1": "https://a.example/tv",
             "https://a.example/tv?kiosk=1&ep=3": "https://a.example/tv?ep=3",
             "https://a.example/tv?ep=3&kiosk=1": "https://a.example/tv?ep=3",
             "https://a.example/": "https://a.example/"}
    for page, want in cases.items():
        (conf / "pages").write_text(page + "\n")
        preamble = SBTV.read_text().split('\ncase "${1:-start}"', 1)[0]
        r = subprocess.run([bash4(), "-c", preamble + "\nbrowse_url"],
                           env={"PATH": os.environ["PATH"], "HOME": str(tmp_path), "SB_TV_CONF": str(conf)},
                           capture_output=True, text=True)
        assert r.stdout.strip() == want, (page, r.stdout, r.stderr)


def launch_args(tmp_path, mode=None, voice=False):
    """Execute the real launcher with isolated process/audio/browser substitutes."""
    import time
    conf = tmp_path / "conf"
    conf.mkdir()
    (conf / "pages").write_text("https://example.com/?kiosk=1\n")
    if mode:
        (conf / "default-mode").write_text(mode + "\n")
    if voice:
        (conf / "voice-enabled").touch()
    stubs = tmp_path / "stubs"
    stubs.mkdir()
    for name, body in {"pgrep": "exit 1", "wpctl": "exit 0", "chromium": "exit 0",
                       "nohup": 'printf "%s\\n" "$@" > "$HOME/args.tmp"\nmv "$HOME/args.tmp" "$HOME/args"'}.items():
        file = stubs / name
        file.write_text("#!/bin/sh\n" + body + "\n")
        file.chmod(0o755)
    result = subprocess.run(["bash", str(SBTV), "start"], capture_output=True, text=True,
                            env={"HOME": str(tmp_path), "PATH": f"{stubs}:{os.environ['PATH']}",
                                 "SB_TV_CONF": str(conf)})
    if result.returncode:
        return result, []
    for _ in range(500):
        if (tmp_path / "args").exists():
            return result, (tmp_path / "args").read_text().splitlines()
        time.sleep(0.01)
    raise AssertionError("launcher did not call Chromium")


def test_tv_default_stays_kiosk_without_debug_port(tmp_path):
    result, args = launch_args(tmp_path)
    assert result.returncode == 0
    assert "--kiosk" in args
    assert not any("remote-debugging" in arg for arg in args)


def test_windowed_has_no_fullscreen_flags_and_preserves_profile(tmp_path):
    result, args = launch_args(tmp_path, "windowed", voice=True)
    assert result.returncode == 0
    assert "--kiosk" not in args and "--start-fullscreen" not in args and "" not in args
    assert "https://example.com/" in args
    assert f"--user-data-dir={tmp_path}/conf/chromium-profile" in args
    assert "--remote-debugging-address=127.0.0.1" in args
    assert "--remote-debugging-port=9222" in args


def test_windowed_without_voice_has_no_empty_argument(tmp_path):
    result, args = launch_args(tmp_path, "windowed")
    assert result.returncode == 0
    assert "--kiosk" not in args and "--start-fullscreen" not in args and "" not in args
    assert not any("remote-debugging" in arg for arg in args)


def test_bad_persisted_mode_refuses_to_launch(tmp_path):
    result, args = launch_args(tmp_path, "invalid")
    assert result.returncode != 0 and args == []


def test_mode_command_validates_and_persists(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    (conf / "pages").write_text("https://example.com/\n")
    assert sbtv(tmp_path, conf, "mode", "windowed").returncode == 0
    assert (conf / "default-mode").read_text() == "windowed\n"
    assert "mode: windowed" in sbtv(tmp_path, conf, "status").stdout
    assert sbtv(tmp_path, conf, "mode", "bad").returncode != 0
    assert (conf / "default-mode").read_text() == "windowed\n"
