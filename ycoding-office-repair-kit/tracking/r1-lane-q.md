# R1 Lane Q — root README reconciliation

Status: README corrected; release note left as historical; one occurrence left for the owner of that file.

## 1. README.md (owned, edited)

Path: `README.md`, line 43.

Before:

> The client is a presentation surface: it needs a running `ycoding` service for live sessions and works offline with synthetic playback otherwise.

After:

> The client is a presentation surface: it needs a running `ycoding` service for live sessions, and a launch without a reachable service states the missing registration instead of substituting synthetic work.

Smallest change: the false clause ("works offline with synthetic playback otherwise") was replaced; the "presentation surface" framing and the "needs a running `ycoding` service for live sessions" clause were preserved.

### Code evidence (`apps/office/app/main.gd`)

Production boot path, verified by reading the file:

- `_ready()` — wires signals, applies regions, then calls `_boot_live()`. Its own comment: "Synthetic playback is never the default, and this path cannot reach it: DEMO is entered only by the user's own mode action."
- `_boot_live()` — calls `_boot_with(_read_service_registration())`; reads the local service registration only.
- `_boot_with(registration)` — if the registration dictionary is empty, calls `_enter_disconnected_live(NO_SERVICE_MESSAGE)`; otherwise calls `start_live(url, password)` and calls `_enter_disconnected_live(error)` if that attach fails.
- `_enter_disconnected_live(message)` — sets mode LIVE, sets `connection_state` DISCONNECTED, sets `last_error` to the supplied message (falling back to `NO_SERVICE_MESSAGE`), disables the composer model control, refreshes the UI. It also discards any prior synthetic projection via `_reset_projection()`.
- `NO_SERVICE_MESSAGE` — "No local service registration found (service.json). Start it with `ycoding service start`, then retry." Names both the registration file and the start command, matching the README wording "states the missing registration".
- `_start_demo()` — "Enter synthetic playback. Reachable ONLY through the explicit demo action." Its two callers are the user mode action path: `_on_mode_toggle()` and `start_demo_mode()`.
- `_retry_connection()` — re-runs `_boot_with(_read_service_registration())` for the Retry affordance; `sidebar.retry_connection_requested` is wired to it.

Conclusion: a launch with no reachable service renders a disconnected LIVE office that names the missing registration and the command that creates one; synthetic playback is only reachable by an explicit mode action. The corrected sentence states that.

Post-edit re-read (lines 33-46): the surrounding clauses remain true — install/notarization/Windows paragraphs are untouched, and the edited sentence sits between the notarization paragraph and the Windows paragraph exactly as before.

## 2. docs/releases/v0.2.5.md (NOT edited)

Line 8:

> The desktop client attaches to a running `ycoding` service for live sessions with a reference composer and reload, and works offline with synthetic playback otherwise. Blocked-session, model, and drawer workflows run against the live session and model-catalog contracts.

Decision: LEAVE. The file is a release note under `docs/releases/`, headed `# YCoding v0.2.5` and organised as Added / Fixed / Changed for that shipped version. Its subject is what v0.2.5 shipped, not the product's current behaviour; the sentence appears inside the v0.2.5 "Added" list describing the client as newly shipped in that release. Release notes are historical records by convention, so an overstatement that was accurate for that release is not a stale claim about current behaviour. Writing the current boot contract into it would falsify the record of what v0.2.5 did. No edit made.

## 3. Other passages checked (not owned, not edited)

Grep of `README.md` for `synthetic|offline|playback|demo|DEMO`:

- Only line 43 matched. No other README passage claims synthetic/offline playback is the desktop fallback.

Grep of `docs/` for `synthetic playback|offline|playback|works offline`:

- `docs/runtime.md:621` — "**DEMO** is synthetic playback from a fixture, reachable only by an explicit ..." — already accurate under the current contract; no change needed.
- `docs/releases/v0.2.5.md:8` — as decided above, historical.

No other stale passage found.
