#!/usr/bin/env python3
"""Prove the R7-03 statistics page tests bite.

The page's whole value is saying the right thing in the right state. A state that can be
collapsed into another, or a chart drawn from nothing, is the defect this proves absent.

Run from anywhere: it pins the repository root itself.
"""
import os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
os.chdir(ROOT)
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
PROBE = "res://r5_single_suite_tmp.gd"
SUITE = "res://tests/suites/test_statistics_page.gd"
PAGE = pathlib.Path("apps/office/core/statistics_page.gd")


def run():
    log = "/tmp/r7_03_audit.log"
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
    ("an unread page reads as empty",
     PAGE, 'var _state := LOADING', 'var _state := EMPTY'),
    ("a failed read reads as empty",
     PAGE, 'if _state == EMPTY:\n\t\treturn EMPTY_MESSAGE',
     'if _state == EMPTY or _state == ERROR:\n\t\treturn EMPTY_MESSAGE'),
    ("a daily chart is drawn from nothing",
     PAGE, 'func has_daily_chart() -> bool:\n\treturn false',
     'func has_daily_chart() -> bool:\n\treturn true'),
    ("the calendar is drawn from nothing",
     PAGE, 'func has_calendar() -> bool:\n\treturn false',
     'func has_calendar() -> bool:\n\treturn true'),
    ("attempts are shown as steps",
     PAGE, '"physical_attempts": str(usage.physical_attempts()),',
     '"physical_attempts": str(usage.logical_steps()),'),
    ("an unreported token becomes zero",
     PAGE, 'return UNREPORTED\n\treturn str(value)',
     'return "0"\n\treturn str(value)'),
    ("a provider row invents a share",
     PAGE, '"provider": provider, "requests": 0, "priced": true, "models": 0,',
     '"provider": provider, "requests": 0, "priced": true, "models": 0, "share": 0.5,'),
    ("the model filter does not narrow the cards",
     PAGE, 'if _model_filter.is_empty():\n\t\treturn _usage', 'if true:\n\t\treturn _usage'),
    ("the row loses its source",
     PAGE, '"source": source,', '"source": "",'),
    ("a stale read is not marked",
     PAGE, 'func mark_stale(reason: String) -> void:\n\t_stale_reason = reason',
     'func mark_stale(reason: String) -> void:\n\t_stale_reason = ""'),
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
        caught = failed not in ("0", "?")
        if not caught:
            missed += 1
        print("%-50s passed=%-4s failed=%-3s %-18s %s" % (
            label, passed, failed, "CAUGHT" if caught else "*** NOT CAUGHT ***",
            fails[0][:40] if fails else ""))
    pathlib.Path("apps/office/r5_single_suite_tmp.gd").unlink(missing_ok=True)
    pathlib.Path("apps/office/r5_single_suite_tmp.gd.uid").unlink(missing_ok=True)
    print("restored:", PAGE.read_text() == pathlib.Path("apps/office/core/statistics_page.gd").read_text())
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
