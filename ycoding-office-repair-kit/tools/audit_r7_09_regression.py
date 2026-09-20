#!/usr/bin/env python3
"""Prove the R7-09 regression tests catch the canonical-read defect.

The defect: a session's own log never carries `session.created`, so a client that replayed
logs alone showed an empty office. Each mutation removes part of the fix, and the suite must
fail on it.

Trust rules, because a mutation harness that lies is worse than none:
- The suite runs through the repository's Godot lock so concurrent repair lanes do not fight
  over the same project import, and every run has a finite timeout.
- A run is only evidence when the suite printed a nonempty assertion summary, the engine
  reported no error, and the exit matches the result (0 for pass, 1 for failed assertions).
  Missing/empty summaries, timeouts, engine errors and other exits are UNVERIFIED.
- Before sweeping, the unmutated suite must itself pass cleanly. Otherwise every mutation
  reports CAUGHT for the wrong reason.
- Source files are restored byte-for-byte even when the sweep crashes.
"""
import pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
LOCK = str(pathlib.Path(__file__).resolve().parent / "godot_lock.sh")
PROBE = str(pathlib.Path(__file__).resolve().parent / "r5_single_suite.gd")
SUITE = "res://tests/suites/test_live_transport.gd"
BOOT_SUITE = "res://tests/suites/test_production_boot.gd"
LIVE = pathlib.Path("apps/office/integration/live_transport.gd")
MAIN = pathlib.Path("apps/office/app/main.gd")
TIMEOUT_SECONDS = 180
ENGINE_ERROR = re.compile(r"^\s*(?:SCRIPT ERROR:|ERROR:)|Leaked instance|ObjectDB instances leaked", re.MULTILINE)

MUTATIONS = [
    ("the session list publishes nothing",
     LIVE, 'for value in _pending_sessions:\n\t\tif not value is Dictionary:\n\t\t\tcontinue',
     'for value in ([] if true else _pending_sessions):\n\t\tif not value is Dictionary:\n\t\t\tcontinue'),
    ("a published event is not a session.created",
     LIVE, '"type": Wire.SESSION_CREATED,\n\t\t\t"sessionID": session_id,',
     '"type": Wire.SESSION_STATUS,\n\t\t\t"sessionID": session_id,'),
    ("the published event loses its session id",
     LIVE, '"type": Wire.SESSION_CREATED,\n\t\t\t"sessionID": session_id,',
     '"type": Wire.SESSION_CREATED,\n\t\t\t"sessionID": "",'),
    ("the first attach never reads the canonical state",
     MAIN, 'if state == OfficeStore.CONNECTION_LIVE and not _reloaded_once:',
     'if false:'),
    ("a reconnect does not re-arm the read",
     MAIN, 'func _rearm_canonical_read() -> void:\n\t_reloaded_once = false',
     'func _rearm_canonical_read() -> void:\n\tpass'),
]


class RunResult:
    """One suite run's parsed evidence."""

    def __init__(self, output, exit_code, timed_out):
        self.output = output
        self.exit_code = exit_code
        self.timed_out = timed_out
        match = re.search(r"passed=(\d+) failed=(\d+)", output)
        self.passed = int(match.group(1)) if match else None
        self.failed = int(match.group(2)) if match else None
        self.failures = re.findall(r"SINGLE FAIL: (.*)", output)

    @property
    def engine_error(self):
        return ENGINE_ERROR.search(self.output) is not None

    @property
    def clean(self):
        """The suite ran to a clean, trustworthy result: no failures, no engine error."""
        return self.verdict() == "NOT CAUGHT"

    def verdict(self):
        if self.timed_out or self.failed is None or self.engine_error:
            return "UNVERIFIED"
        if self.passed + self.failed == 0:
            return "UNVERIFIED"
        if self.exit_code != (1 if self.failed > 0 else 0):
            return "UNVERIFIED"
        if self.failed > 0:
            return "CAUGHT"
        return "NOT CAUGHT"

    def describe(self):
        if self.timed_out:
            return "TIMEOUT"
        if self.failed is None:
            return "NO SUMMARY"
        if self.passed + self.failed == 0:
            return "NO ASSERTIONS"
        if self.engine_error:
            return "ENGINE ERROR"
        if self.exit_code != (1 if self.failed > 0 else 0):
            return "UNEXPECTED EXIT %s" % self.exit_code
        return "%d/%s failures" % (self.failed, self.passed)


def run(suite=SUITE, popen=subprocess.Popen):
    log = pathlib.Path("/tmp/r7_09_reg.log")
    with open(log, "w") as fh:
        proc = popen(
            [LOCK, GODOT, "--headless", "--path", "apps/office", "--script", PROBE, "--", suite],
            stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT),
        )
        try:
            exit_code = proc.wait(timeout=TIMEOUT_SECONDS)
            timed_out = False
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            exit_code = None
            timed_out = True
    return RunResult(log.read_text(), exit_code, timed_out)


def apply_mutation(path, old, new):
    original = path.read_bytes()
    if old.encode() not in original:
        return None
    path.write_bytes(original.replace(old.encode(), new.encode(), 1))
    return original


def restore(path, original):
    path.write_bytes(original)
    return path.read_bytes() == original


def main(mutations=MUTATIONS, run_suite=run) -> int:
    suites = dict.fromkeys(BOOT_SUITE if path == MAIN else SUITE for _, path, _, _ in mutations)
    for suite in suites:
        baseline = run_suite(suite)
        if not baseline.clean:
            print("BASELINE %s not clean (%s); sweep not run" % (suite, baseline.describe()))
            return 1

    missed = 0
    drifted = []
    for label, path, old, new in mutations:
        original = apply_mutation(path, old, new)
        if original is None:
            print("%-52s COULD NOT MUTATE" % label)
            missed += 1
            continue
        try:
            result = run_suite(BOOT_SUITE if path == MAIN else SUITE)
            verdict = result.verdict()
            detail = result.failures[0][:36] if result.failures else ""
            print("%-52s passed=%-4s failed=%-3s %-13s %s" % (
                label,
                result.passed if result.passed is not None else "-",
                result.failed if result.failed is not None else "-",
                verdict,
                detail))
        finally:
            if not restore(path, original):
                drifted.append(str(path))
        if verdict != "CAUGHT":
            missed += 1

    if drifted:
        print("RESTORE FAILED (source left mutated): %s" % ", ".join(drifted))
        return 1
    print("restored: all mutated sources byte-identical")
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
