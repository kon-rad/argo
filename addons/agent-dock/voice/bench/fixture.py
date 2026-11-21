#!/usr/bin/env python3
"""Create a disposable synthetic roster and two independent linked worktrees."""
import json
from pathlib import Path
import subprocess
import tempfile


def create(parent=None):
    root = Path(tempfile.mkdtemp(prefix="dock-fixture-", dir=parent))
    vault = root / "vault"
    roster = vault / ".agents/org"
    roster.mkdir(parents=True)
    agents = {}
    repo = root / "base"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "color.py").write_text('color = "grey"\n')
    (repo / "test_color.py").write_text(
        'import unittest\nfrom color import color\n\nclass ColorTest(unittest.TestCase):\n'
        '    def test_color(self):\n        self.assertEqual(color, "violet")\n')
    (repo / "first.txt").write_text("violet\n")
    (repo / "second.txt").write_text("silver\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid",
                    "commit", "-qm", "synthetic failing color test"], check=True)
    for name, marker in (("guide", "violet"), ("writer", "silver")):
        workspace = root / name
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", "--detach", str(workspace)], check=True)
        (workspace / "marker.txt").write_text(marker + "\n")
        (vault / (name + ".md")).write_text(f"You are the fixture {name}. Read marker.txt for your marker.\n")
        agents[name] = dict(runtime="codex", model="gpt-6-sol", tools=["Read"], permission_mode="plan",
                            prompt_file=name + ".md", role="Synthetic fixture")
    agents["guide"].update(tools=["Read", "Write", "Edit", "Bash"], permission_mode="acceptEdits")
    (roster / "org-agents.json").write_text(json.dumps({"agents":agents}))
    return root


if __name__ == "__main__":
    print(create())
