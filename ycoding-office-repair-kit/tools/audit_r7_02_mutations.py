#!/usr/bin/env python3
"""Prove the R7-02 usage aggregate tests bite.

The accounting rules are the whole point of R7-02, and a rule that no test can catch is
decoration. Each mutation breaks one rule the acceptance names.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_session_usage.gd"
USAGE = pathlib.Path("apps/office/core/session_usage.gd")
ROLLUP = pathlib.Path("apps/office/core/usage_rollup.gd")
API = pathlib.Path("apps/office/integration/usage_api.gd")


def run():
    log = "/tmp/r7_02_audit.log"
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
    ("attempts are added to steps",
     USAGE, 'return int(_summary.get("physical", 0))',
     'return int(_summary.get("physical", 0)) + int(_summary.get("logical", 0))'),
    ("an unpriced group is counted as priced",
     USAGE, 'return model_groups().size() - priced_groups()', 'return 0'),
    ("an absent cost renders as a zero amount",
     USAGE, 'return UNREPORTED\n\treturn "$%.2f" % cost()',
     'return "$0.00"\n\treturn "$%.2f" % cost()'),
    ("an estimate is labelled as recorded billing",
     USAGE, 'if provenance == "current_catalog":\n\t\t\t\treturn "estimated"',
     'if provenance == "current_catalog":\n\t\t\t\treturn "recorded"'),
    ("helpers are folded into the steps",
     USAGE, 'return int(_summary.get("helpers", 0))', 'return 0'),
    ("a covered child is counted again",
     ROLLUP, 'if covered.has(session_id):\n\t\t\trollup._skipped.append(session_id)\n\t\t\tcontinue',
     'if false:\n\t\t\trollup._skipped.append(session_id)\n\t\t\tcontinue'),
    ("a provider filter matches every session",
     ROLLUP, 'return _uses_provider(row, provider_id)',
     'return true'),
    # Targeted by the function body, not by a bare `return false`: the first such line in
    # the file belongs to a DIFFERENT function, and an ambiguous anchor reports a clean
    # pass for a rule that was never broken.
    ("a day breakdown is invented",
     ROLLUP, 'func supports_day_breakdown() -> bool:\n\treturn false',
     'func supports_day_breakdown() -> bool:\n\treturn true'),
    ("a day grouping returns one mislabelled bucket",
     ROLLUP, 'return []', 'return [{"day": "all", "sessions": _sessions.size()}]'),
    # The reader's wire contract.
    ("a summary is attributed to another session",
     API, '_session_id = settled_session', '_session_id = "ses_someone_else"'),
    ("a refused read is reported as a clean one",
     API, 'if not _is_success(int(entry.get("status", 0))):',
     'if false:'),
    ("a failed read claims nothing was spent",
     API, '\t\t\t_reported = false\n\t\t\t_last_error = reason if not reason.is_empty() else "The usage request failed."',
     '\t\t\t_reported = true\n\t\t\t_last_error = reason if not reason.is_empty() else "The usage request failed."'),
    ("the reader reads a route the service does not serve",
     API, 'Gateway.usage(session_id)', '"/api/session/usage"'),
]


def main() -> int:
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
            fails[0][:42] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored:", USAGE.read_text() == pathlib.Path("apps/office/core/session_usage.gd").read_text()
          and ROLLUP.read_text() == pathlib.Path("apps/office/core/usage_rollup.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
