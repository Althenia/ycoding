#!/usr/bin/env python3
"""Prove the no-database boundary guards bite.

R7-01's acceptance includes "no Godot DB access". Two guards in
`apps/office/tests/suites/test_asset_provenance.gd` hold that boundary; this script breaks
it four ways and requires each break to be reported as a failure.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_asset_provenance.gd"
FOLDER = pathlib.Path("apps/office/core/folder_target.gd")
SIDE = pathlib.Path("apps/office/ui/conversation/conversation_panel.gd")


def run() -> tuple[str, str, list[str]]:
    """One suite run. Bounded so a hang is a reported failure rather than a wait."""
    log = "/tmp/r7_01_audit.log"
    with open(log, "w") as fh:
        proc = subprocess.Popen(
            [GODOT, "--headless", "--path", "apps/office", "--script", PROBE, "--", SUITE],
            stdout=fh, stderr=subprocess.STDOUT,
        )
        for _ in range(150):
            time.sleep(1)
            if proc.poll() is not None:
                break
        else:
            proc.kill()
    out = pathlib.Path(log).read_text()
    m = re.search(r"passed=(\d+) failed=(\d+)", out)
    return (m.group(1), m.group(2)) if m else ("?", "?"), re.findall(r"SINGLE FAIL: (.*)", out)


MUTATIONS = [
    ("a shipped module OPENS a runtime database", FOLDER,
     'var pointer := FileAccess.open(root + "/.git", FileAccess.READ)',
     'var pointer := FileAccess.open(root + "/ycoding.db", FileAccess.READ)'),
    ("a shipped module NAMES a runtime database", FOLDER,
     'if DirAccess.dir_exists_absolute(root + "/.git"):',
     'if DirAccess.dir_exists_absolute(root + "/storage.db"):'),
    ("a shipped module opens an extension it does not own", FOLDER,
     'var pointer := FileAccess.open(root + "/.git", FileAccess.READ)',
     'var pointer := FileAccess.open(root + "/payload.bin", FileAccess.READ)'),
    ("a shipped module opens a sqlite file", SIDE,
     'func _open_source(row_id: String) -> void:',
     'func _open_source(row_id: String) -> void:\n\tvar probe := FileAccess.open("res://core/things.sqlite", FileAccess.READ)'),
]


def main() -> int:
    # The probe is a kit tool; copy it in so the suite has a driver.
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").write_text(
        pathlib.Path("ycoding-office-repair-kit/tools/r5_single_suite.gd").read_text())
    missed = 0
    for label, path, old, new in MUTATIONS:
        pristine = path.read_text()
        if old not in pristine:
            print("%-52s COULD NOT MUTATE" % label)
            missed += 1
            continue
        path.write_text(pristine.replace(old, new, 1))
        (passed, failed), fails = run()
        path.write_text(pristine)
        caught = failed not in ("0", "?")
        if not caught:
            missed += 1
        print("%-52s passed=%-4s failed=%-3s %-18s %s" % (
            label, passed, failed, "CAUGHT" if caught else "*** NOT CAUGHT ***",
            fails[0][:44] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored source:",
          FOLDER.read_text() == pathlib.Path("apps/office/core/folder_target.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
