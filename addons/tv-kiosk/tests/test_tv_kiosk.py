"""Tests for the TV kiosk add-on: flash.sh --render output and sb-tv page parsing."""
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
        "TV_PAGES": "https://example.com/ 60; https://example.com/projects 30;",
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


def test_pages_split(tmp_path):
    r, out = render(tmp_path)
    assert (out / "tv-kiosk" / "pages").read_text() == \
        "https://example.com/ 60\nhttps://example.com/projects 30\n"


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


def test_sb_tv_pages_parsing(tmp_path):
    conf = tmp_path / "conf"
    conf.mkdir()
    (conf / "pages").write_text("# comment\n\nhttps://a.example/ 45\nhttps://b.example/\n")
    r = subprocess.run(["bash", str(SBTV), "pages"], env={"PATH": os.environ["PATH"],
                       "HOME": str(tmp_path), "SB_TV_CONF": str(conf), "SB_TV_SECONDS": "20"},
                       capture_output=True, text=True, check=True)
    assert r.stdout == "https://a.example/\t45\nhttps://b.example/\t20\n"
