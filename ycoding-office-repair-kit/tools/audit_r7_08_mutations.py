#!/usr/bin/env python3
"""Prove the R7-08 accounting-edge tests bite.

These are the arithmetic rules the kit names, each hand-calculated. Each mutation breaks one
of them, so a rule no test can catch is decoration.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_accounting_edges.gd"
USAGE = pathlib.Path("apps/office/core/session_usage.gd")
ROLLUP = pathlib.Path("apps/office/core/usage_rollup.gd")


def run():
    log = "/tmp/r7_08_audit.log"
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
    ("attempts are reported as steps",
     USAGE, 'return int(_summary.get("physical", 0))',
     'return int(_summary.get("logical", 0))'),
    ("an unknown price counts as free",
     USAGE, 'return model_groups().size() - priced_groups()', 'return 0'),
    ("the completeness counter drops its denominator",
     USAGE, 'return "%d of %d" % [priced_groups(), model_groups().size()]', 'return "all"'),
    ("helpers are folded into the steps",
     USAGE, 'return int(_summary.get("helpers", 0))',
     'return int(_summary.get("helpers", 0)) * 0'),
    # The reachable guard is the DEDUPED list, which is what the coverage pass consumes.
    # Mutating the by_session key alone was a no-op: `order` still held one entry, so the
    # mutation created a key the dedupe never read.
    ("a duplicate session is summed rather than superseded",
     ROLLUP, '\tvar deduped: Array[Dictionary] = []\n\tfor session_id in order:\n\t\tdeduped.append(by_session[session_id])',
     '\tvar deduped: Array[Dictionary] = []\n\tfor row in rows:\n\t\tdeduped.append(row)'),
    ("a covered child is summed into the root",
     ROLLUP, 'if covered.has(session_id):\n\t\t\trollup._skipped.append(session_id)\n\t\t\tcontinue',
     'if false:\n\t\t\trollup._skipped.append(session_id)\n\t\t\tcontinue'),
    ("a project filter returns every session",
     ROLLUP, 'return str(row.get("project_id", "")) == project_id',
     'return true'),
    ("an estimate is labelled as recorded billing",
     USAGE, 'if provenance == "current_catalog":\n\t\t\t\treturn "estimated"',
     'if provenance == "current_catalog":\n\t\t\t\treturn "recorded"'),
    ("an absent cost renders as a zero amount",
     USAGE, 'if not has_cost():\n\t\treturn UNREPORTED',
     'if not has_cost():\n\t\treturn "$0.00"'),
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
    print("restored:", USAGE.read_text() == pathlib.Path("apps/office/core/session_usage.gd").read_text()
          and ROLLUP.read_text() == pathlib.Path("apps/office/core/usage_rollup.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
