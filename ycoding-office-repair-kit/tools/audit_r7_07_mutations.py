#!/usr/bin/env python3
"""Prove the R7-07 export tests bite.

The acceptance's clauses are security-relevant, and a clause no test can catch is decoration.
Each mutation opens one of the four harms the acceptance names.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_export.gd"
EXPORT = pathlib.Path("apps/office/core/export_builder.gd")


def run():
    log = "/tmp/r7_07_audit.log"
    with open(log, "w") as fh:
        proc = subprocess.Popen(
            [GODOT, "--headless", "--path", "apps/office", "--script", PROBE, "--", SUITE],
            stdout=fh, stderr=subprocess.STDOUT,
        )
        for _ in range(120):
            time.sleep(1)
            if proc.poll() is not None:
                break
        else:
            proc.kill()
    out = pathlib.Path(log).read_text()
    m = re.search(r"passed=(\d+) failed=(\d+)", out)
    return (m.group(1), m.group(2)) if m else ("?", "?"), re.findall(r"SINGLE FAIL: (.*)", out)


MUTATIONS = [
    ("a formula-leading text cell is not guarded",
     EXPORT, 'if _needs_guard(sanitized):\n\t\tguarded = TEXT_GUARD + sanitized', 'pass'),
    ("only '=' is treated as a trigger",
     EXPORT, 'const FORMULA_TRIGGERS := ["=", "+", "-", "@", "\\t", "\\r"]',
     'const FORMULA_TRIGGERS := ["="]'),
    ("secrets are not redacted at all",
     EXPORT, 'for pattern in SECRET_PATTERNS:\n\t\tout = _replace_all(out, pattern)', 'pass'),
    ("private paths are not redacted",
     EXPORT, 'for pattern in PATH_PATTERNS:\n\t\tout = _replace_all(out, pattern)', 'pass'),
    ("the JSON carries secrets the CSV redacts",
     EXPORT, '"value": _sanitize(str(row.get("value", ""))),',
     '"value": str(row.get("value", "")),'),
    ("the header names no columns",
     EXPORT, 'lines.append(_join_text(COLUMNS))', 'lines.append("")'),
    ("an embedded quote is not doubled",
     EXPORT, 'return "\\"" + value.replace("\\"", "\\"\\"") + "\\""',
     'return "\\"" + value + "\\""'),
    ("a newline inside a cell breaks the record",
     EXPORT, 'if not (value.contains("\\"") or value.contains(",") or value.contains("\\n") or value.contains("\\r")):',
     'if not (value.contains("\\"")):'),
    # Writes the SAME path the test names, so the absence check catches it. An occupied path
    # would turn this mutation into a no-op rather than a caught defect.
    ("composing an export writes the file immediately",
     EXPORT, 'func text() -> String:\n\tvar lines: Array[String] = []',
     'func text() -> String:\n\tvar lines: Array[String] = []\n\tvar probe := FileAccess.open("user://test_r707_unasked.csv", FileAccess.WRITE)\n\tif probe != null:\n\t\tprobe.close()'),
    ("a negative number is escaped into text",
     EXPORT, 'func _number_cell(value: Variant) -> String:\n\tif value is int:\n\t\treturn str(value)',
     'func _number_cell(value: Variant) -> String:\n\tif value is int:\n\t\treturn "\'" + str(value)'),
]


def main() -> int:
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").write_text(
        pathlib.Path("ycoding-office-repair-kit/tools/r5_single_suite.gd").read_text())
    missed = 0
    for label, path, old, new in MUTATIONS:
        pristine = path.read_text()
        if old not in pristine:
            print("%-50s COULD NOT MUTATE" % label)
            missed += 1
            continue
        path.write_text(pristine.replace(old, new, 1))
        (passed, failed), fails = run()
        path.write_text(pristine)
        hung = failed == "?"
        caught = (failed not in ("0", "?")) or hung
        if not caught:
            missed += 1
        verdict = "CAUGHT (hung)" if hung else ("CAUGHT" if caught else "*** NOT CAUGHT ***")
        print("%-50s passed=%-4s failed=%-3s %-18s %s" % (
            label, passed, failed, verdict, fails[0][:34] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    # A mutation that wrote the unasked file must not leave it behind.
    pathlib.Path("apps/office/../userdata").unlink(missing_ok=True)
    print("restored:", EXPORT.read_text() == pathlib.Path("apps/office/core/export_builder.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
