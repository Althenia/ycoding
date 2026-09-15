# godot-office — durable implementation memory

Feature: native Godot desktop client at `apps/office/` (`docs/okf` + root guides reference it).
Memo ID chosen from the user's explicit request to persist implementation memory for this feature.

## Environment (verified)
- Pinned engine: `4.7.2.stable.official.ed1daf0bf` at `/Applications/Godot.app/Contents/MacOS/Godot` (same binary as `/opt/homebrew/bin/godot`).
- `project.godot` uses `config_version=5` and `GL Compatibility`; window `1280x720`, `canvas_items` stretch, `default_texture_filter=0` (nearest).
- Export templates are NOT installed; TASK-044 stays blocked until installed (environment change → needs approval).

## Godot 4.7 GDScript gotchas (each cost a real failure)
- Unused-parameter/untyped-inference warnings are treated as ERRORS. `var x := dict.get(...)` fails to compile; annotate explicitly (`var x: Variant = ...`).
- An `Array` return type erases element typing, so `for x in typed_fn()` makes `x` Variant and any `x.property` access fails. Return `Array[T]` and annotate loop locals.
- A `Dictionary` value access is Variant. Assign through `as T` before calling methods (`var n := actors.get(id) as OfficeActor`).
- Every script referenced by a typed `var`/parameter needs an explicit `class_name`, including UI `Control` scripts and the composition root.
- `Image.save_png` rejects relative paths. Pass an absolute path from the shell.
- Godot MCP is installed: prefer `run_interactive` + `game_state`/`get_runtime_errors`/`game_screenshot` over shell sleeps. `run_project`/`run_and_capture` for non-interactive checks.

## Run/verify commands
- Tests: `/Applications/Godot.app/Contents/MacOS/Godot --headless --path apps/office --script res://tests/run_tests.gd` (exit 1 on failure; proven by injecting a deliberate assertion).
- Import/class cache: `... --headless --path apps/office --editor --quit` (writes `.godot/`). `.godot/` is now git-ignored.
- Capture: `... --path apps/office --resolution WxH --script res://tools/capture_scene.gd -- --out=<abs path> --frames=N`.
- Only ONE Godot process at a time: a concurrent run on the same project causes an import-lock hang past 300s.

## Wire contract (verified locally)
- Real event vocabulary is in `contracts/wire-audit.json` → `actual_event_vocabulary`. The five fixture labels (`connection.changed`, `session.observed`, `activity.changed`, `interaction.created`, `session.settled`) DO NOT exist on the wire; `FixtureTranslator` converts them before `OfficeStore`.
- Durable replay EXISTS: `GET /api/experimental/session/:sessionID/log?after=<exclusive Event.Seq>&follow=<bool>` with a `log.synced` marker. Global `/api/event` remains volatile with no replay.
- That log route is `HttpApiSchema.StreamSse` (`packages/protocol/src/groups/session.ts:948`) — read it through the streaming path, never as a JSON request.
- Snapshot is returned TOP LEVEL (`sourceEpoch`/`session`/`messages`/`watermark`) and is NOT wrapped in `data`; list/active/message routes DO use a `data` envelope. Mixing these up silently breaks transcript reads.
- `/api/session/active` lists only sessions with a foreground drain owned by the process. A created-but-unprompted session is absent; admitting a prompt makes it active. Status literal is `running`; the separate ephemeral `session.status` event carries `idle`/`busy`/`retry`.
- SSE frames are `data: <json>\n\n` with `: keep-alive` heartbeats and no `id:`/`event:`/`retry:` (`packages/server/src/event-feed.ts:36`), so the feed is not resumable by Last-Event-ID.
- Auth is optional HTTP Basic, fixed username `ycoding`; 401 carries `Basic realm="Secure Area"`.
- Routes/shapes are pinned as names-only constants in `apps/office/integration/gateway_contract.gd` with unit tests in `tests/suites/test_gateway_contract.gd`.
- Prompt retry identity requires matching session + prompt + delivery and identical data JSON.

## Art
- Original in-house family, no third-party license. Regenerate with `python3 apps/office/tools/generate_art.py`.
- 32px tiles, 32x48 character frames, feet-origin, 2px contact shadow. Character rows: idle(2), walk(6), sit(2), type(2), read(2), talk(2); direction columns down/up/left/right.

## State
- Pack fixes applied (wire audit, F-11 gate disambiguation, storyboard duration, TEST-037/F-08, TASK-044 blocker).
- M0 boundary change applied across README/AGENTS/product-direction/architecture/CONTRIBUTING/specs/tui-package/docs/README + injected agent prompt and its test.
- M1, M2 and M3 transport complete. Ledger: 25/48 tasks done (`tracking/tasks.json` is the authority).
- `apps/office/tools/verify.sh` (import + unit + flow, fails on any engine error): 1004 assertions, 18 flow checks.
- `apps/office/tools/verify-integration.sh` (starts the fixture server, runs live checks, stops it): 21/21 pass.
- M2 fidelity rubric self-scored 13/18, below the ≥15 target. TASK-024 stays `in_review` pending real user visual acceptance; the user rejected the first M2 capture and the matte/light-floor iteration followed.

## Test-harness gotchas (each cost a real failure)
- The harness API is `t.check(condition, message)` only — there is no `t.eq`.
- `SceneTree` already defines `_get`, so a suite helper of that name fails to parse. Use another name.
- `HttpTransport.request` requires a `Dictionary` body; pass `{}` for GET rather than null.
- The fixture server has no session until one is created; assert `active` only after admitting a prompt.
- Godot prints `SCRIPT ERROR` and can still exit 0, so verification scripts grep the log instead of trusting the exit code.

## Subagent routing (measured)
- `openrouter/deepseek-v4.1-flash` accepts variants `low`, `high`, `max` only; `medium` is rejected.
- One lane = one file. Lanes handed three files at once timed out at 3600s producing nothing; every single-file lane delivered.
- A lane still running with an unchanged revision for ~30+ min is stuck. Cancel it and finish the artifact directly rather than waiting for the timeout.

## Git
- Stage explicit paths. `git add -A <dir>` while a subagent is mid-write swept an in-progress file into an unrelated commit.

## Godot export (installed, verified)
- Templates installed at `~/Library/Application Support/Godot/export_templates/4.7.2.stable`, SHA-512 matched the official `SHA512-SUMS.txt`.
- macOS templates ship `.universal` only — set `binary_format/architecture="universal"`, not `arm64`.
- Export also requires `textures/vram_compression/import_etc2_astc=true` and `application/bundle_identifier`.
- Export: `Godot --headless --path apps/office --export-release "macOS" <abs>.zip` → 59.7 MB `.app`, launches without the editor. Codesign/notarize intentionally off.
- `dist/` is git-ignored, so export artifacts and captures never enter the repo.

