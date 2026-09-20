# R7-09 mutation evidence review

R7-09 remains open. No real Godot mutation sweep was run in this review.

## Verified Python behavior

Command from the office worktree:

```sh
python3 -B -m unittest discover -s ycoding-office-repair-kit/tools -p 'test_r7_09_regression.py' -v
```

- Saved implementation baseline: 14 tests passed, exit 0.
- Added regressions: 18 tests executed, six assertion/subtest failures, exit 1.
  Failures reproduced acceptance of script errors, empty assertion summaries,
  inconsistent process exits, and source mutation before a clean boot-suite baseline.
- Revised harness: 18 tests passed, exit 0. `git diff --check` passed.
- Each selected suite now requires its own clean baseline before any mutation.
  Script errors, leaks, missing/empty summaries, timeouts and inconsistent exits
  cannot count as caught mutations. Assertion failures require runner exit 1.
- Tests exercise real temporary-file restoration and verdict classification;
  the Godot subprocess boundary is mocked. They do not prove native behavior.

## Outstanding before a real sweep

- Hold exclusive ownership of mutated production files for the entire sweep.
  The current wrapper serializes individual Godot processes, not source mutation
  against other writers or a process already holding the lock.
- Verify timeout cleanup of the wrapper's child process. Killing/reaping the shell
  wrapper alone does not prove that its Godot child exited.
- Run the repaired sweep only after those containment gates pass and the source
  owners release the affected files. Require clean baselines and behavioral failures,
  not timeout-based detection.
- Durable prompt admission and fresh native visual acceptance are still missing.
