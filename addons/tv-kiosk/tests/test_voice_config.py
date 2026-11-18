import importlib.util
from pathlib import Path
import shlex
import xml.etree.ElementTree as ET

import pytest

SPEC = importlib.util.spec_from_file_location("voice_config", Path(__file__).parents[1] / "configure_voice.py")
config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(config)


@pytest.mark.parametrize("ns", ["", ' xmlns="http://openbox.org/3.4/rc"'])
def test_setup_preserves_existing_keys_and_is_idempotent(tmp_path, ns):
    rc = tmp_path / ".config/labwc/rc.xml"
    rc.parent.mkdir(parents=True)
    rc.write_text(f'<labwc_config{ns}><keyboard><keybind key="C-A-m"><action name="Execute" command="sb-tv toggle"/></keybind></keyboard></labwc_config>')
    config.configure(tmp_path, tmp_path / "model")
    config.configure(tmp_path, tmp_path / "model")
    root = ET.parse(rc).getroot()
    bindings = {b.get("key"): b for b in root.iter() if b.tag.endswith("keybind")}
    assert len(bindings) == 2 and set(bindings) == {"C-A-m", "C-A-v"}
    assert (tmp_path / ".config/sb-tv/default-mode").read_text() == "windowed\n"


def test_conflicting_hotkey_does_not_rewrite_existing_config(tmp_path):
    rc = tmp_path / ".config/labwc/rc.xml"
    rc.parent.mkdir(parents=True)
    original = '<labwc_config><keyboard><keybind key="C-A-v"><action name="Execute" command="other-app"/></keybind></keyboard></labwc_config>'
    rc.write_text(original)
    with pytest.raises(ValueError, match="already assigned"):
        config.configure(tmp_path, tmp_path / "model")
    assert rc.read_text() == original
    assert not (tmp_path / ".config/sb-tv/voice-enabled").exists()


def test_wrapper_quotes_device_and_model_without_shell_execution(tmp_path):
    model = tmp_path / "model $(touch should-not-exist)"
    device = "USB mic; touch should-not-exist"
    config.configure(tmp_path, model, device)
    wrapper = (tmp_path / ".config/sb-tv/voice-run").read_text().splitlines()[1]
    argv = shlex.split(wrapper)
    assert argv[-4:] == ["--model", str(model), "--device", device]
    assert not (tmp_path / "should-not-exist").exists()


def test_new_config_has_only_one_binding(tmp_path):
    config.configure(tmp_path, tmp_path / "model")
    rc = tmp_path / ".config/labwc/rc.xml"
    assert len(ET.parse(rc).findall("keyboard/keybind")) == 1
