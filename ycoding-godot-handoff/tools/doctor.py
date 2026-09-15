#!/usr/bin/env python3
"""Read-only local checkout/tool inventory. Does not install, mutate Git or start services."""
from __future__ import annotations
import argparse
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path


def run(argv: list[str], cwd: Path | None = None) -> dict:
    try:
        if argv and argv[0] == "git":
            argv = ["git", "--no-optional-locks", *argv[1:]]
        result = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        # Only fixed Git/version commands are called; do not read configs, environment or credentials.
        return {"exit_code":result.returncode, "stdout":result.stdout.strip()[:16000], "stderr":result.stderr.strip()[:2000]}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"exit_code":None, "stdout":"", "stderr":str(exc)}


def godot_executable() -> str | None:
    chosen = os.environ.get("GODOT_BIN")
    if chosen:
        # A path with spaces is one executable, never split or passed through a shell.
        return chosen
    for name in ["godot", "godot4"]:
        found = shutil.which(name)
        if found:
            return found
    mac = Path("/Applications/Godot.app/Contents/MacOS/Godot")
    return str(mac) if mac.is_file() else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path, help="Actual local YCoding checkout path.")
    parser.add_argument("--require-godot", action="store_true", help="Fail when Godot is unavailable, rather than reporting a pending setup check.")
    args = parser.parse_args()
    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        print(f"Repository directory does not exist: {repo}")
        return 1
    if not shutil.which("git"):
        print("git is unavailable.")
        return 1
    root = run(["git", "rev-parse", "--show-toplevel"], repo)
    if root["exit_code"] != 0:
        print("The supplied directory is not an accessible Git checkout.")
        return 1
    actual = Path(root["stdout"])
    engine = godot_executable()
    tools = {}
    for name in ["bun", "ffmpeg", "podman"]:
        executable = shutil.which(name)
        option = "-version" if name == "ffmpeg" else "--version"
        result = run([executable, option]) if executable else None
        tools[name] = {"path":executable, "version":result["stdout"].splitlines()[0] if result and result["stdout"] else None,
                       "exit_code":result["exit_code"] if result else None}
    engine_result = run([engine, "--version"]) if engine else None
    package_manager = None
    package_file = actual / "package.json"
    if package_file.is_file():
        try:
            package_manager = json.loads(package_file.read_text(encoding="utf8")).get("packageManager")
        except (OSError, ValueError):
            package_manager = "unreadable package.json; inspect locally"
    report = {"scope":"read-only local inventory; not a runtime or visual test", "os":platform.system(), "architecture":platform.machine(),
              "repository_root":str(actual), "head":run(["git","rev-parse","HEAD"],actual),
              "branch":run(["git","branch","--show-current"],actual),
              "working_tree":run(["git","-c","core.fsmonitor=false","status","--short"],actual),
              "declared_package_manager":package_manager,
              "godot":{"path":engine,"version_check":engine_result}, "other_tools":tools,
              "notes":["No dependencies installed; no changes staged/committed; no service/model requests sent.",
                       "Missing optional ffmpeg/podman is not a blocker for the core native client.",
                       "Record local results privately; review paths before sharing this report."]}
    print(json.dumps(report, indent=2))
    if args.require_godot and (not engine_result or engine_result["exit_code"] != 0):
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
