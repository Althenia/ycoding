#!/usr/bin/env python3
"""Prove the R7-05 advisory-budget tests bite.

The acceptance's core rule is that a local budget is NEVER presented as a provider-side
limit and never stops work. Each mutation breaks one of those guarantees, so the suite
failing on it is what makes the guarantee real rather than a comment.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_quota_budget.gd"
BUDGET = pathlib.Path("apps/office/core/quota_budget.gd")
VERDICT = pathlib.Path("apps/office/core/quota_budget_verdict.gd")
STORE = pathlib.Path("apps/office/ui/shell/quota_budget_store.gd")


def run():
    log = "/tmp/r7_05_audit.log"
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
    ("the budget claims to be enforced",
     BUDGET, 'func is_enforced() -> bool:\n\treturn false',
     'func is_enforced() -> bool:\n\treturn true'),
    ("the budget is no longer advisory",
     BUDGET, 'func is_advisory() -> bool:\n\treturn true',
     'func is_advisory() -> bool:\n\treturn false'),
    ("the label claims to be a provider limit",
     BUDGET, 'return "Your advisory %s budget%s" % [where, money]',
     'return "Provider limit %s%s" % [where, money]'),
    ("unknown spend passes the comparison",
     VERDICT, 'func is_known() -> bool:\n\treturn known',
     'func is_known() -> bool:\n\treturn true'),
    ("a partial comparison reports it is under budget",
     VERDICT, 'if not known:\n\t\treturn "%s: spend is %s, so no comparison is made." % [scope_label, UNREPORTED]',
     'if not known:\n\t\treturn "%s: within the budget." % scope_label'),
    ("a dismissed budget still warns",
     VERDICT, 'if not known or dismissed:\n\t\treturn false',
     'if not known:\n\t\treturn false'),
    ("over the limit is not recognised",
     VERDICT, 'return known and spend >= limit', 'return false'),
    ("an unsupported scope is accepted",
     BUDGET, 'if not is_supported_scope(scope):', 'if false:'),
    ("a negative limit is accepted",
     BUDGET, 'if not is_finite(limit) or limit <= 0.0:', 'if false:'),
    # The REACHABLE guard is from_fields, which is where a caller's dictionary enters. The
    # store receives an already-filtered object, so mutating the store proved nothing.
    ("an undeclared field survives construction",
     BUDGET, '\tfor key in STORED_FIELDS:\n\t\tif fields.has(key):\n\t\t\tout._fields[key] = fields[key]',
     '\tout._fields = fields.duplicate()'),
    ("an unknown schema version is adopted",
     STORE, 'if version != SCHEMA_VERSION:', 'if false:'),
    ("the write skips its staging path",
     STORE, '\tvar temp := temp_path(target)\n\tvar error := config.save(temp)',
     '\tvar temp := target\n\tvar error := config.save(temp)'),
]


def main() -> int:
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").write_text(
        pathlib.Path("ycoding-office-repair-kit/tools/r5_single_suite.gd").read_text())
    missed = 0
    for label, path, old, new in MUTATIONS:
        pristine = path.read_text()
        if old not in pristine:
            print("%-48s COULD NOT MUTATE" % label)
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
        print("%-48s passed=%-4s failed=%-3s %-18s %s" % (
            label, passed, failed, verdict, fails[0][:36] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored:",
          BUDGET.read_text() == pathlib.Path("apps/office/core/quota_budget.gd").read_text()
          and VERDICT.read_text() == pathlib.Path("apps/office/core/quota_budget_verdict.gd").read_text()
          and STORE.read_text() == pathlib.Path("apps/office/ui/shell/quota_budget_store.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
