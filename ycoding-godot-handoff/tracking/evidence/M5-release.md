# M5 — release readiness evidence

Task: TASK-041–048 · Date: 2026-09-15

## Room audit — every zone earns its footprint

A room is only kept if something actually sends an actor there. This audit is why
the plan lost a library, an archive, a kitchen and a meeting room.

| Zone | Driver | Verified |
| --- | --- | --- |
| Desks (13 seats) | `execution.started` → `ACTION_WORK` | `test_navigation.gd` |
| Reception | shift change: entry and exit | `test_shift_change.gd` |
| Play | idle presence | `test_shift_change.gd` |
| Focus | `session.compaction.started` → COMPACTING | `test_shift_change.gd` |
| Huddle | `CHANGE_QUESTION_ASKED` | `test_shift_change.gd` |
| CEO office | `CHANGE_COMPLETED` report | `test_shift_change.gd` |

`test_every_station_exists_in_the_world` proves every station the store can name
resolves to a real anchor, so an agent can never be sent nowhere.

## TASK-044 — native export

Export templates for 4.7.2 were installed and the archive's SHA-512 was checked
against the official `SHA512-SUMS.txt`.

```
Godot --headless --path apps/office --export-release "macOS" <abs>.zip
-> exit 0, dist/office/export/ycoding-office.zip (59,896,802 bytes)
```

The bundle was unzipped and launched:

| Check | Result |
| --- | --- |
| Bundle identifier | `ai.ycoding.office` |
| Launches without the editor | yes — the process runs with no Godot editor process present |
| Closes cleanly | yes |

**Limitations:** the build is unsigned and not notarized, so first launch on
another machine needs the usual Gatekeeper bypass. macOS templates ship
`.universal` only, so the preset must use `universal`, not `arm64`. The export is
not committed: `dist/` is git-ignored, so it is reproducible rather than shipped.

## TASK-041 — reconnect, restart, overflow, long sessions

See M4-runtime.md for the reconnect model. Additionally:

- A restarted service has a new `sourceEpoch`; the transport requests a reload and
  the store adopts the new epoch rather than continuing on the old one.
- The global feed overflows by contract at 4096 queued events per connection and
  fails the stream; that is why recovery is a canonical reload, not a resume.

## TASK-042 — rendering and resource limits

- The world renders at **zoom 1.0 (native pixel scale)** at 1600x900, so no
  resampling is applied to the pixel art.
- The office region is sized to the world's aspect (41:23 = 1.783), which fills
  99.7% of a 16:9 window with no letterbox inside the viewport.
- `TEXTURE_FILTER_NEAREST` everywhere; depth sorting via one Y-sorted layer.

## TASK-043 — keyboard, motion, theme

- Every focusable control carries a focus ring that differs from its resting state
  by colour, weight and an outward margin (`test_focus_visibility.gd`), and the
  caret is accented.
- Arrow keys and WASD pan the view.
- One theme module owns panel, button and label styling, including the focus ring.

**Not covered:** reduced-motion is **not** implemented. No OS reduced-motion
preference is read and no animation honours one. This is a real gap and is
reported rather than claimed.

## TASK-045 — service lifecycle

- The office attaches to an existing service and does not start or stop one. The
  address is read from the local service registration the CLI already writes; the
  read is best-effort and never fatal.
- No auto-start exists, so no arbitrary shell string is ever executed.
- Health is probed before the office claims to be live, so a wrong address or
  password fails loudly instead of showing an empty office that looks like a
  working session with no agents.

## TASK-046 — asset rights, secrets, dangerous actions

- All art is generated in-house by `apps/office/tools/generate_art.py`. No
  third-party assets, fonts or downloads.
- Secret scan over the tree found no credentials, tokens, private keys or PII.
  The fixture server takes its password as a CLI flag and reads no environment or
  files; it binds loopback only.
- DEMO performs no mutations and the store exposes no mutation method in that
  mode. LIVE cannot be entered except by an explicit request, and the mode row
  states which direction it toggles.

## TASK-047 — final suites and real product capture

| Check | Result |
| --- | --- |
| `apps/office/tools/verify.sh` | import / tests / flow all exit 0, **0 engine errors**, `VERIFY: PASSED` |
| Unit + scene suite | **4966 passed, 0 failed** |
| End-to-end flow | **18 checks, 0 failures** |
| Live transport | **21 contract + 14 live-attach**, 0 engine errors |
| Real captures | `dist/office/captures/` at 1600x900 and 1024x768 |

## TASK-048 — reproducible handoff

`tracking/HANDOFF.md` records the state, the ledger is authoritative at
`tracking/tasks.json`, and the pack validator passes. Verification commands are
documented in `apps/office/AGENTS.md`.

## Open at release

| Item | Status |
| --- | --- |
| TASK-024 — fidelity acceptance | **in_review**, user-owned |
| TASK-040 — four-role MVP acceptance | **open**, user-owned |
| TASK-031 — question and permission replies | **done** (diagnostic terminal TASK-031) |
| Reduced motion | **not implemented** |
| Live prompt submission | **not wired** |

Live prompt submission remains the one functional gap: the composer is a DEMO
preview and does not issue a prompt to a live service. The transport and the
contract for it are implemented and verified, but the call is not wired. This is
reported rather than claimed complete.

Reduced motion is also unimplemented: no OS preference is read and no animation
honours one.