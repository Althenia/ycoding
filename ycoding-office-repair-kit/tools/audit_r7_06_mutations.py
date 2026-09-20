#!/usr/bin/env python3
"""Prove the R7-06 limit-semantics tests bite.

The acceptance requires four limit kinds to stay DISTINCT and no enforced control to be
exposed. Each mutation collapses a distinction or claims an enforcement that does not exist.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_limit_semantics.gd"
LIMIT = pathlib.Path("apps/office/core/limit_event.gd")
STORE = pathlib.Path("apps/office/core/office_store.gd")
WIRE = pathlib.Path("apps/office/core/wire.gd")


def run():
    log = "/tmp/r7_06_audit.log"
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
    ("a context overflow is classified as a quota",
     LIMIT, '"context.limit": KIND_CONTEXT,', '"context.limit": KIND_QUOTA,'),
    ("a rate limit is classified as a quota",
     LIMIT, '"provider.rate-limit": KIND_RATE_LIMIT,', '"provider.rate-limit": KIND_QUOTA,'),
    ("two kinds share one label",
     LIMIT, 'KIND_CONTEXT: "Model context limit",', 'KIND_CONTEXT: "Provider quota exhausted",'),
    ("every kind claims to be enforced",
     LIMIT, 'static func is_enforced(_kind: String) -> bool:\n\treturn false',
     'static func is_enforced(_kind: String) -> bool:\n\treturn true'),
    ("a failed step is applied by no arm",
     STORE, '\t\tWire.STEP_FAILED:\n\t\t\treturn apply_step_failure(session_id, data)',
     '\t\tWire.STEP_FAILED:\n\t\t\treturn true'),
    ("a failed execution discards its error",
     STORE, 'Wire.EXECUTION_FAILED:\n\t\t\treturn apply_execution_failure(session_id, data)',
     'Wire.EXECUTION_FAILED:\n\t\t\treturn apply_settled(session_id, "failed")'),
    ("the context limit figure is not read",
     STORE, 'read_context_limit(session_id, data)\n\tvar context_limit := context_limit_for(session_id)',
     'var context_limit := context_limit_for(session_id)'),
    ("an unknown failure is dropped",
     LIMIT, 'return KIND_UNCLASSIFIED\n\n\n## Whether a message names', 'return ""\n\n\n## Whether a message names'),
    ("an unknown failure is guessed into the context kind",
     LIMIT, '\tif error_type == "provider.invalid-request":\n\t\treturn KIND_CONTEXT if _names_context_window(str(error.get("message", ""))) else KIND_UNCLASSIFIED',
     '\tif error_type == "provider.invalid-request":\n\t\treturn KIND_CONTEXT'),
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
        hung = failed == "?"
        caught = (failed not in ("0", "?")) or hung
        if not caught:
            missed += 1
        verdict = "CAUGHT (hung)" if hung else ("CAUGHT" if caught else "*** NOT CAUGHT ***")
        print("%-52s passed=%-4s failed=%-3s %-18s %s" % (
            label, passed, failed, verdict, fails[0][:34] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored:",
          LIMIT.read_text() == pathlib.Path("apps/office/core/limit_event.gd").read_text()
          and STORE.read_text() == pathlib.Path("apps/office/core/office_store.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
