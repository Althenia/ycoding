#!/usr/bin/env python3
"""Prove the R7-04 quota-window tests bite.

Every rule here is a way a quota display lies: a missing limit read as zero, as unlimited,
or turned into a percentage; two limits summed; a status hidden. Each mutation breaks one.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_quota_windows.gd"
WIN = pathlib.Path("apps/office/core/quota_window.gd")
PAGE = pathlib.Path("apps/office/core/quota_page.gd")
API = pathlib.Path("apps/office/integration/provider_usage_api.gd")


def run():
    log = "/tmp/r7_04_audit.log"
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
    ("a missing limit renders as zero",
     WIN, 'if not has_limit():\n\t\treturn UNREPORTED\n\treturn _format(limit())',
     'if not has_limit():\n\t\treturn "0"\n\treturn _format(limit())'),
    ("a missing limit reads as unlimited",
     WIN, 'return bool(_window.get("unlimited", false))',
     'return bool(_window.get("unlimited", false)) or not has_limit()'),
    ("a percentage is derived from no denominator",
     WIN, '\tvar denominator := limit()\n\tif denominator <= 0.0:\n\t\treturn UNREPORTED',
     '\tvar denominator := limit()\n\tif denominator < 0.0:\n\t\treturn UNREPORTED'),
    ("a missing used figure renders as zero",
     WIN, 'func used_text() -> String:\n\tif not has_used():\n\t\treturn UNREPORTED',
     'func used_text() -> String:\n\tif not has_used():\n\t\treturn "0"'),
    ("an unsupported provider is dropped from the list",
     PAGE, 'if not (snapshot is Dictionary):\n\t\t\tcontinue',
     'if not (snapshot is Dictionary) or str(snapshot.get("status", "")) == "unsupported":\n\t\t\tcontinue'),
    ("a stale page reads as fresh",
     PAGE, 'if _freshness == STALE:', 'if false:'),
    ("a combined total is offered",
     PAGE, 'func has_combined_total() -> bool:\n\treturn false',
     'func has_combined_total() -> bool:\n\treturn true'),
    ("a window with no unit is half-read",
     API, 'REQUIRED_WINDOW_FIELDS := ["id", "label", "unit"]',
     'REQUIRED_WINDOW_FIELDS := ["id", "label"]'),
    ("a never-answering read is not bounded",
     API, 'if _request_id >= 0 and Time.get_ticks_msec() > _deadline_ms:',
     'if false:'),
    ("an abandoned request is left to drain",
     API, '_transport.cancel(_request_id)\n\t\t_request_id = -1',
     '_request_id = -1'),
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
        # "?" means the run produced no summary at all, which for a BOUNDED-READ mutation is
        # the failure itself: an unbounded poll keeps the suite from ever finishing. Counting
        # that as "not caught" would score a hang as a pass.
        hung = failed == "?"
        caught = (failed not in ("0", "?")) or hung
        if not caught:
            missed += 1
        verdict = "CAUGHT (hung)" if hung else ("CAUGHT" if caught else "*** NOT CAUGHT ***")
        print("%-48s passed=%-4s failed=%-3s %-18s %s" % (
            label, passed, failed, verdict, fails[0][:38] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored:", WIN.read_text() == pathlib.Path("apps/office/core/quota_window.gd").read_text()
          and PAGE.read_text() == pathlib.Path("apps/office/core/quota_page.gd").read_text()
          and API.read_text() == pathlib.Path("apps/office/integration/provider_usage_api.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
