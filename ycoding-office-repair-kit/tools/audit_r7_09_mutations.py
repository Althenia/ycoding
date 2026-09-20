#!/usr/bin/env python3
"""Prove the R7-09 analytics-verification tests bite.

The safety clause is "quota failure cannot break normal coding". A test that only observes
today's wiring would not catch a future prompt path that waits on a quota read, so the
mutations include making the prompting path reference one.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_analytics_verification.gd"
MAIN = pathlib.Path("apps/office/app/main.gd")
USAGE = pathlib.Path("apps/office/core/session_usage.gd")
PAGE = pathlib.Path("apps/office/core/quota_page.gd")
API = pathlib.Path("apps/office/integration/provider_usage_api.gd")
STORE = pathlib.Path("apps/office/core/office_store.gd")
PAGE_OBJ = pathlib.Path("apps/office/core/statistics_page.gd")


def run():
    log = "/tmp/r7_09_audit.log"
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
    ("the prompting path waits on the quota read",
     MAIN, 'func _on_prompt_submitted(text: String) -> void:',
     'func _on_prompt_submitted(text: String) -> void:\n\tif provider_usage_api != null:\n\t\tprovider_usage_api.poll()'),
    ("the prompting path waits on the usage read",
     MAIN, 'func _on_prompt_submitted(text: String) -> void:',
     'func _on_prompt_submitted(text: String) -> void:\n\tif usage_api != null:\n\t\tusage_api.poll()'),
    ("an estimate is labelled as billed",
     USAGE, 'if provenance == "current_catalog":\n\t\t\t\treturn "estimated"',
     'if provenance == "current_catalog":\n\t\t\t\treturn "recorded"'),
    ("a stale quota reads as fresh",
     PAGE, 'if _freshness == STALE:', 'if false:'),
    ("an errored quota reads as fresh",
     PAGE, 'if _freshness == ERROR:', 'if false:'),
    ("a bounded quota read is unbounded",
     API, 'if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:',
     'if false:'),
    # Source verification lives on the STORE's limit rows, which is what the assertion reads.
    # Mutating session_usage was a different surface entirely.
    # Anchored on the LIMIT row's own neighbours: four rows carry `source_verified`, and a
    # bare anchor edits whichever comes first rather than the one the assertion reads.
    ("a recorded failure loses its source verification",
     STORE, '"context_limit": context_limit,\n\t\t"source_verified": true,',
     '"context_limit": context_limit,\n\t\t"source_verified": false,'),
    ("the page stops naming its source session",
     PAGE_OBJ, 'return "Source: %s" % _session_id', 'return "Source: unknown"'),
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
            label, passed, failed, verdict, fails[0][:34] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored:", MAIN.read_text() == pathlib.Path("apps/office/app/main.gd").read_text()
          and USAGE.read_text() == pathlib.Path("apps/office/core/session_usage.gd").read_text()
          and PAGE.read_text() == pathlib.Path("apps/office/core/quota_page.gd").read_text()
          and API.read_text() == pathlib.Path("apps/office/integration/provider_usage_api.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
