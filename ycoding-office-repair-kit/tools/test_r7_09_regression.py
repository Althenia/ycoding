"""Behavioral tests for the R7-09 mutation harness.

The Godot boundary is stubbed: these tests exercise the harness's own handling of parsed
output, exit status, timeout, missing/zero summaries, engine errors, a real assertion
failure, byte-identical source restoration on exceptions, and mutation detection. They
never run Godot and never touch repository source files.
"""
import contextlib, io, pathlib, subprocess, sys, tempfile, unittest, unittest.mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import audit_r7_09_regression as audit

CLEAN = "SINGLE passed=5 failed=0\n"
BROKEN = "SINGLE passed=3 failed=2\n  SINGLE FAIL: canonical read missing\n"
LEAKY = ("SINGLE passed=5 failed=0\n"
         "ERROR: 1 resources still in use at exit.\n"
         "ObjectDB instances leaked at exit (run with --verbose for details).\n")


def clean_result():
    return audit.RunResult(CLEAN, 0, False)


class StubProcess:
    def __init__(self, output="", exit_code=0, first_wait_times_out=False):
        self.output = output
        self.exit_code = exit_code
        self.first_wait_times_out = first_wait_times_out
        self.sink = None
        self.killed = False
        self.waits = []

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if len(self.waits) == 1:
            self.sink.write(self.output)
            self.sink.flush()
            if self.first_wait_times_out:
                raise subprocess.TimeoutExpired(cmd="godot", timeout=timeout)
            return self.exit_code
        return 0

    def kill(self):
        self.killed = True


def spawn(process, calls):
    def _spawn(cmd, **kwargs):
        calls.append((cmd, kwargs))
        process.sink = kwargs["stdout"]
        return process
    return _spawn


class RunResultTests(unittest.TestCase):
    def test_assertion_failure_is_caught(self):
        result = audit.RunResult(BROKEN, 1, False)
        self.assertEqual((result.passed, result.failed), (3, 2))
        self.assertEqual(result.failures, ["canonical read missing"])
        self.assertEqual(result.verdict(), "CAUGHT")
        self.assertFalse(result.clean)

    def test_zero_failures_is_not_caught(self):
        result = audit.RunResult(CLEAN, 0, False)
        self.assertEqual(result.verdict(), "NOT CAUGHT")
        self.assertTrue(result.clean)

    def test_missing_summary_is_unverified(self):
        result = audit.RunResult("Godot Engine v4.4\n", 0, False)
        self.assertIsNone(result.failed)
        self.assertEqual(result.verdict(), "UNVERIFIED")
        self.assertIn("NO SUMMARY", result.describe())

    def test_engine_error_rejects_a_zero_failure_summary(self):
        result = audit.RunResult(LEAKY, 0, False)
        self.assertEqual(result.verdict(), "UNVERIFIED")
        self.assertFalse(result.clean)
        self.assertEqual(result.describe(), "ENGINE ERROR")

    def test_timeout_is_unverified(self):
        result = audit.RunResult(CLEAN, None, True)
        self.assertEqual(result.verdict(), "UNVERIFIED")
        self.assertEqual(result.describe(), "TIMEOUT")
        self.assertFalse(result.clean)

    def test_script_error_invalidates_even_assertion_failures(self):
        result = audit.RunResult("SCRIPT ERROR: Invalid call\n" + BROKEN, 1, False)
        self.assertEqual(result.verdict(), "UNVERIFIED")
        self.assertFalse(result.clean)

    def test_zero_assertions_cannot_establish_a_baseline(self):
        result = audit.RunResult("SINGLE passed=0 failed=0\n", 0, False)
        self.assertFalse(result.clean)
        self.assertEqual(result.verdict(), "UNVERIFIED")

    def test_exit_status_must_agree_with_assertion_result(self):
        for output, status in [(BROKEN, -9), (BROKEN, 0), (CLEAN, 1), (CLEAN, None)]:
            with self.subTest(output=output, status=status):
                result = audit.RunResult(output, status, False)
                self.assertEqual(result.verdict(), "UNVERIFIED")
                self.assertFalse(result.clean)


class RunTests(unittest.TestCase):
    def test_run_serializes_and_uses_a_finite_timeout(self):
        process = StubProcess(CLEAN, 0)
        calls = []
        result = audit.run(audit.SUITE, popen=spawn(process, calls))
        cmd, kwargs = calls[0]
        self.assertEqual(cmd[0], audit.LOCK)
        self.assertEqual(cmd[1], audit.GODOT)
        self.assertEqual(cmd[cmd.index("--script") + 1], audit.PROBE)
        self.assertEqual(cmd[-1], audit.SUITE)
        self.assertEqual(kwargs["cwd"], str(audit.ROOT))
        self.assertEqual(process.waits, [audit.TIMEOUT_SECONDS])
        self.assertGreater(audit.TIMEOUT_SECONDS, 0)
        self.assertEqual(result.verdict(), "NOT CAUGHT")

    def test_run_kills_and_reaps_on_timeout(self):
        process = StubProcess(CLEAN, None, first_wait_times_out=True)
        calls = []
        result = audit.run(audit.SUITE, popen=spawn(process, calls))
        self.assertTrue(result.timed_out)
        self.assertEqual(result.verdict(), "UNVERIFIED")
        self.assertTrue(process.killed)
        self.assertEqual(process.waits, [audit.TIMEOUT_SECONDS, None])

    def test_run_reads_parsed_output_and_exit_code(self):
        process = StubProcess(BROKEN, 1)
        calls = []
        result = audit.run(audit.SUITE, popen=spawn(process, calls))
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.failures, ["canonical read missing"])
        self.assertEqual(result.verdict(), "CAUGHT")


class MainTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.source = pathlib.Path(self.dir.name) / "sample.gd"
        self.pristine = b"func f():\n\tdo old thing\n\treturn\n"
        self.source.write_bytes(self.pristine)
        self.mutations = [("the sample mutation", self.source, "\tdo old thing", "\tdo new thing")]

    def test_main_mutates_then_detects_and_restores(self):
        seen = []

        def run_suite(suite):
            seen.append(self.source.read_bytes())
            if len(seen) <= 1:
                return clean_result()
            return audit.RunResult(BROKEN, 1, False)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = audit.main(self.mutations, run_suite=run_suite)
        self.assertEqual(code, 0)
        self.assertEqual(seen[1], self.pristine.replace(b"\tdo old thing", b"\tdo new thing"))
        self.assertEqual(self.source.read_bytes(), self.pristine)
        self.assertIn("CAUGHT", out.getvalue())

    def test_main_restores_when_a_mutation_run_raises(self):
        seen = []

        def run_suite(suite):
            seen.append(self.source.read_bytes())
            if len(seen) <= 1:
                return clean_result()
            raise RuntimeError("godot blew up")

        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                audit.main(self.mutations, run_suite=run_suite)
        self.assertNotEqual(seen[1], self.pristine)
        self.assertEqual(self.source.read_bytes(), self.pristine)

    def test_main_counts_unverified_as_missed(self):
        seen = []

        def run_suite(suite):
            seen.append(suite)
            if len(seen) <= 1:
                return clean_result()
            return audit.RunResult(LEAKY, 0, False)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = audit.main(self.mutations, run_suite=run_suite)
        self.assertEqual(code, 1)
        self.assertEqual(self.source.read_bytes(), self.pristine)
        self.assertIn("UNVERIFIED", out.getvalue())

    def test_main_refuses_to_sweep_on_a_dirty_baseline(self):
        def run_suite(suite):
            return audit.RunResult(BROKEN, 1, False)

        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = audit.main(self.mutations, run_suite=run_suite)
        self.assertEqual(code, 1)
        self.assertIn("BASELINE", out.getvalue())
        self.assertEqual(self.source.read_bytes(), self.pristine)

    def test_boot_suite_baseline_failure_prevents_any_mutation(self):
        seen = []

        def run_suite(suite):
            seen.append(suite)
            self.assertEqual(self.source.read_bytes(), self.pristine)
            return audit.RunResult(BROKEN, 1, False) if suite == audit.BOOT_SUITE else clean_result()

        with unittest.mock.patch.object(audit, "MAIN", self.source):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                code = audit.main(self.mutations, run_suite=run_suite)
        self.assertEqual(code, 1)
        self.assertIn(audit.BOOT_SUITE, seen)
        self.assertIn("BASELINE", out.getvalue())
        self.assertEqual(self.source.read_bytes(), self.pristine)

    def test_main_reports_a_missing_anchor(self):
        mutations = [("absent anchor", self.source, "not present", "x")]

        def run_suite(suite):
            return clean_result()

        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = audit.main(mutations, run_suite=run_suite)
        self.assertEqual(code, 1)
        self.assertIn("COULD NOT MUTATE", out.getvalue())
        self.assertEqual(self.source.read_bytes(), self.pristine)

    def test_main_detects_restore_drift(self):
        original = pathlib.Path.write_bytes

        def sabotage(path, data, *args, **kwargs):
            # Swallow only the byte-identical restore write; the mutation write still lands.
            if path == self.source and bytes(data) == self.pristine:
                return 0
            return original(path, data, *args, **kwargs)

        def run_suite(suite):
            return clean_result()

        with unittest.mock.patch.object(pathlib.Path, "write_bytes", sabotage):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                code = audit.main(self.mutations, run_suite=run_suite)
        self.assertEqual(code, 1)
        self.assertIn("RESTORE FAILED", out.getvalue())


if __name__ == "__main__":
    unittest.main()
