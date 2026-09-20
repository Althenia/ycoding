# Delivery integration — local explicit merge only

`additions/` contains complete new utility files, tests, optional Taskfile and an Office CI workflow. `replacements/` contains reviewed text for the existing Pages workflow and loopback verification script. `tools/merge_delivery.py` transforms the existing release workflow using exact inspected markers and Git blob hashes from BASELINE.json; it does not ship a competing publisher.

Run preview first, review file changes and source drift, then explicitly apply. An existing addition destination or changed baseline refuses the operation. No force option; reconcile with current code and tests. A backup outside the repo is created on apply. The tool never commits, stages, tags or publishes.

The scripts implement task wrapping, archive checks, checksum validation, additive website generation, a pinned editor setup and a Windows per-user installer. They are not a replacement for repairing the current app. Readiness is deliberately false until real native/provider/project/settings/statistics checks and the protected release review succeed. No passing application evidence or release credentials are included.

After merging, from the checkout:

```sh
python3 script/office_tasks.py doctor
python3 script/office_tasks.py run
python3 script/office_tasks.py verify
python3 script/office_tasks.py build --version 0.0.0-rc.1 --target darwin-universal --outdir dist/office/candidate-01
# A preview, not an install:
python3 script/office_tasks.py install-release --version 0.0.0-rc.1
```

The sample version is illustrative; use your actual release version. A build needs installed Godot and matching templates; macOS DMG requires macOS. The GUI must be tested with the matching CLI/service. Run owner build/typecheck/tests from the current repository. Do not use root `bun test`, which the inspected root intentionally rejects.
