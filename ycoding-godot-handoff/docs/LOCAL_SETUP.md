# Local setup and agent workflow

## Required versus optional

Required for implementation: the correct YCoding checkout, its existing toolchain/dependencies, a native Godot 4.x stable editor, an agent capable of editing local text files and running commands, and Python 3.10+ for this handoff's utility scripts. Choose typed GDScript; the .NET editor is unnecessary unless that choice is deliberately changed.

Record the exact installed Godot version, executable path, renderer and target OS/architecture in M0; use matching export templates. Do not auto-upgrade a working backend, Bun lockfile or Godot project. The inspected repository declares Bun 1.4.2, but the local checkout's `packageManager` remains authoritative [R4].

Optional: Godot MCP for editor/scene inspection; FFmpeg for MP4 conversion; a sprite editor/asset authoring tool; a pinned test addon when the minimal runner no longer suffices. MCP is a development aid, not a runtime dependency. A working command-line/editor workflow must remain available when MCP is unavailable. A regular IDE is optional for an agent-edited workflow.

Podman can run optional isolated backend/fixture services when useful. It is not required for the Godot native GUI, and this plan does not require Docker/Kubernetes or running the desktop inside a container. Do not pass model credentials to containers for a purely synthetic scene test.

## Place the handoff safely

Extract to a new sibling folder, for example a directory named `ycoding-godot-handoff` next to the checkout. Open the checkout in the local agent and provide this folder as context. Do not copy this pack's root `AGENTS.md` over the existing one. Later, documentation may be moved under a deliberate `docs/office/` location while preserving relative links.

From the handoff directory:

```sh
python3 tools/validate_pack.py --integrity
python3 tools/doctor.py --repo /absolute/path/to/ycoding
```

The doctor runs read-only Git/version checks, reports missing tools, and does not install, connect, mutate or read credentials. It reports the local checkout, not an assertion that it equals the remote snapshot.

## Establish the Godot executable

Use a `GODOT_BIN` environment variable pointing to the actual executable. On macOS, a common bundle executable is shown below; verify it exists rather than assuming installation [G8].

```sh
export GODOT_BIN="/Applications/Godot.app/Contents/MacOS/Godot"
"$GODOT_BIN" --version
"$GODOT_BIN" --help
```

On Linux/Windows use the installed native binary path. Do not claim those platforms are validated until their exports run. The local agent records the result in the M0 evidence file and pins it in the eventual project docs/config.

## Commands after the app exists

These commands are **planned validation commands**, not commands run by this handoff. `apps/office/project.godot` and the named test script are M1 deliverables.

```sh
# Run from the actual YCoding repository root.
"$GODOT_BIN" --headless --path apps/office --editor --import
"$GODOT_BIN" --headless --path apps/office --script res://tests/run_tests.gd
"$GODOT_BIN" --path apps/office
```

Inspect logs for script/resource/import errors in addition to the exit code. The test runner must explicitly fail its process on failed assertions. A headless import does not render or validate the user-facing scene [G8].

Inspect backend scripts before executing checks. The observed root workspace has `bun run check:ycoding-workspace`, `bun run typecheck`, `bun run lint`, and `bun run lint:effect-patterns`. Its root `bun test` intentionally fails; choose affected-package test commands. Run only relevant suites plus the documented cross-package checks. Record pre-existing failures separately from regressions.

## Live service connection

Prefer the already running local service for the first live test. M0 must verify how the current CLI starts/discovers it and how credentials/location scope are supplied. Do not hardcode a port, copy a stale `ycoding serve` command as proven, source all of a shell profile, or print registration files containing secrets. The Godot app should provide a clear “service not running” message while attach-only is supported.

Live model requests and paid services require explicit user permission. Mock playback, parser tests and art validation do not. Keep a synthetic DEMO mode usable without internet or provider keys.

## Native export

Create a named macOS preset for the actual target architecture in M5, with no credentials in `export_presets.cfg`; install matching templates. Only after that preset exists:

```sh
mkdir -p dist/office
"$GODOT_BIN" --headless --path apps/office \
  --export-release "macOS" "$(pwd)/dist/office/ycoding-office.zip"
```

The preset name is a proposed name; use the actual configured name if different. Test the artifact, not just successful export logs. Verify launch without the editor and service ownership on close. Public signing/notarization is not silently claimed; local packaging limitations must be documented without disabling OS security features.

## Genuine Godot demo capture

After the demo user-argument parser and fixture runner are implemented:

```sh
mkdir -p dist/office/captures
"$GODOT_BIN" --path apps/office \
  --write-movie "$(pwd)/dist/office/captures/office.avi" \
  --fixed-fps 60 --quit-after 5400 -- --demo=oauth-workplace
```

`--demo=oauth-workplace` is our **proposed application argument**, not a built-in Godot flag. Godot's Movie Maker captures engine-rendered output; output mode/renderer availability must be verified on the pinned version [G9]. Do not use a dummy headless renderer to claim visual fidelity. An actual interactive live-path recording is separate evidence from deterministic DEMO capture.

Optional conversion after capture:

```sh
ffmpeg -i dist/office/captures/office.avi \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart \
  dist/office/captures/office.mp4
```

Record screenshots/video at normal speed, with app build and mode visible. Do not add movie-only effects that make evidence appear better than the real product.
