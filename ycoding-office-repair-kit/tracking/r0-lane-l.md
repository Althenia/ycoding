# R0 / Lane L — guardrail reply wire defect + attention route coverage + dangling citation

Repo `/Users/viadz/Workspace/Project/ycoding`, branch `main`, HEAD `a4bb99e`.
Owned paths: `apps/office/integration/gateway_contract.gd`, `apps/office/tests/suites/test_gateway_contract.gd`,
`apps/office/core/wire.gd`, `apps/office/AGENTS.md` (citation lines only).

## Step 1 — RED test written first (Defect 2)

Added `test_builds_attention_routes(t)` to `apps/office/tests/suites/test_gateway_contract.gd`,
registered in `run(t)`, pinning four exact route strings against the live protocol:

| office call | expected path | live source |
| --- | --- | --- |
| `Gateway.question_reply(ses_1, req_1)` | `/api/session/ses_1/question/req_1/reply` | `packages/protocol/src/groups/question.ts:52` |
| `Gateway.question_reject(ses_1, req_1)` | `/api/session/ses_1/question/req_1/reject` | `packages/protocol/src/groups/question.ts:68` |
| `Gateway.permission_reply(ses_1, req_1)` | `/api/session/ses_1/permission/req_1/reply` | `packages/protocol/src/groups/permission.ts:119` |
| `Gateway.guardrail_reply(ses_1, req_1)` | `/api/session/ses_1/guardrail/request/req_1/reply` | `packages/protocol/src/groups/guardrail.ts:44-45` |

Command (cwd `/Users/viadz/Workspace/Project/ycoding`):

```
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh \
  /Applications/Godot.app/Contents/MacOS/Godot --headless --path apps/office --script res://tests/run_tests.gd
```

Exit code 1. RED text (verbatim tail):

```
=== office test summary ===
passed: 6275
failed: 1
  FAIL: guardrail reply route
RESULT: FAILED
```

The guardrail assertion is the only failure; the other three attention assertions pass, which
confirms `question_reply`, `question_reject` and `permission_reply` were already correct.

## Step 2 — Defect 1 fixed: guardrail reply path

- Wrong value: `apps/office/integration/gateway_contract.gd:65` returned
  `/api/session/%s/guardrail/%s/reply` — the `request` segment was missing.
- Correct value: `/api/session/%s/guardrail/request/%s/reply`, from the live endpoint
  `HttpApiEndpoint.post("session.guardrail.request.reply", "/api/session/:sessionID/guardrail/request/:requestID/reply", ...)`
  at `packages/protocol/src/groups/guardrail.ts:44-45` (payload `Schema.Struct({ reply: Guardrail.Reply })`,
  success `HttpApiSchema.NoContent`; `:47-49`).
- Consumer: `LiveTransport.reply()` routes `AttentionQueue.KIND_GUARDRAIL` to this path
  (`apps/office/integration/live_transport.gd:364-365`) and posts the caller's body verbatim, so no body
  change was needed. Before the fix the POST matched no live route, so answering a guardrail review
  from the desktop could never succeed.
- Edit: one line in `apps/office/integration/gateway_contract.gd`.

## Step 3 — GREEN (full suite)

Command (cwd `/Users/viadz/Workspace/Project/ycoding`), same lock-wrapped invocation as Step 1.
Exit code 0:

```
passed: 6276
failed: 0
RESULT: PASSED
```

No `SCRIPT ERROR` / `Parse Error` / `Compile Error` lines in the log (`/tmp/lane-l-tests.log`).
Assertion count rose from the RED run's 6275 passed + 1 failed (6276 total) to 6276 passed, i.e. the
new attention test added 4 assertions and the only failure is now green. Suite baseline was 6272.

## Step 4 — Defect 3 fixed: dangling `contracts/wire-audit.json` citations

`find` across the checkout and the kit returns no `wire-audit.json`; the kit's `contracts/` holds only
`verification-cases.json`. Three citations named it. All three now name the live owners:

| file:line | was | now |
| --- | --- | --- |
| `apps/office/AGENTS.md:9` | `` `contracts/wire-audit.json` in the handoff pack records ... Treat it as the wire reference.`` | names `packages/schema/src/session-event.ts`, `event-manifest.ts`, other `*-event.ts` inventories, and `packages/protocol/src/groups/` |
| `apps/office/core/wire.gd:1` | `verified in contracts/wire-audit.json` | `verified against the live Schema owners ... and the live Protocol route groups` |
| `apps/office/integration/fixture_translator.gd:8` | `Verified real vocabulary: contracts/wire-audit.json -> actual_event_vocabulary` | names `packages/schema/src/session-event.ts`, `event-manifest.ts`, other `*-event.ts` inventories |

Only the comment line changed in `fixture_translator.gd`; translator behaviour, fixture labels and
`_synthetic` marking are untouched. The AGENTS.md intent is preserved: route names, event names and DTO
fields must not be invented, and client-internal fixture labels are not wire names.

## Step 5 — Final gate: `apps/office/tools/verify.sh`

Command (cwd `/Users/viadz/Workspace/Project/ycoding`):

```
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh apps/office/tools/verify.sh
```

Exit code 0, log `/tmp/lane-l-verify.log`:

```
Godot: 4.7.2.stable.official.ed1daf0bf
import         exit=0 engine_errors=0
tests          exit=0 engine_errors=0
flow           exit=0 engine_errors=0
  passed: 6276
  RESULT: PASSED
  checks: 18, failures: 0
  FLOW RESULT: PASSED
VERIFY: PASSED
```

No `SCRIPT ERROR`, `Parse Error` or `Compile Error` lines in any stage.

## Other attention paths

None wrong. All four reply/reject routes now match their live protocol literal, and the RED run proved
three were already correct before the fix. The live protocol itself is correct; no server change needed.

## Outcome

All three defects fixed with TDD evidence. No commit made; only the four owned files plus this note
were written.


