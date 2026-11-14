"""Preserve existing labwc bindings and install one press-to-record command."""
from pathlib import Path
import shlex
import xml.etree.ElementTree as ET


def configure(home, model, device=None):
    home = Path(home)
    conf = home / ".config/sb-tv"
    rc = home / ".config/labwc/rc.xml"
    conf.mkdir(parents=True, exist_ok=True)
    rc.parent.mkdir(parents=True, exist_ok=True)
    if rc.exists():
        tree = ET.parse(rc)
        root = tree.getroot()
    else:
        root = ET.Element("labwc_config")
        tree = ET.ElementTree(root)
    namespace = root.tag.split("}")[0][1:] if root.tag.startswith("{") else ""
    if namespace:
        ET.register_namespace("", namespace)
    def tag(name):
        return f"{{{namespace}}}{name}" if namespace else name
    keyboard = root.find(tag("keyboard"))
    if keyboard is None:
        keyboard = ET.SubElement(root, tag("keyboard"))
    runner = conf / "voice-run"
    runner_command = shlex.quote(str(runner))
    existing = [b for b in keyboard.findall(tag("keybind")) if b.get("key") == "C-A-v"]
    for binding in existing:
        actions = binding.findall(tag("action"))
        if len(actions) != 1 or actions[0].get("command") != runner_command:
            raise ValueError("Ctrl+Alt+V is already assigned; preserve it and choose a different binding manually")
    # Construct output before mutating existing files; invalid XML/conflicts fail first.
    command = [str(conf / "voice-venv/bin/python"), str(conf / "voice.py"),
               "listen", "--model", str(Path(model).resolve())]
    if device:
        command += ["--device", str(device)]
    if not existing:
        binding = ET.SubElement(keyboard, tag("keybind"), {"key": "C-A-v"})
        ET.SubElement(binding, tag("action"), {"name": "Execute", "command": runner_command})
    # A plain executable wrapper avoids interpreting model/device text as shell code.
    runner.write_text("#!/bin/sh\nexec " + shlex.join(command) + "\n")
    runner.chmod(0o700)
    tree.write(rc, encoding="unicode", xml_declaration=True)
    (conf / "default-mode").write_text("windowed\n")
    (conf / "voice-enabled").touch(mode=0o600)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model")
    parser.add_argument("--device")
    args = parser.parse_args()
    configure(Path.home(), args.model, args.device)
