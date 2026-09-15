# M3 — transport layer evidence

Task: TASK-026 · Date: 2026-09-15

## Deliverables

| File | Purpose |
|---|---|
| `apps/office/integration/sse_parser.gd` | Incremental SSE frame parser |
| `apps/office/integration/http_transport.gd` | Non-blocking HTTP client, request and stream |
| `apps/office/integration/gateway_contract.gd` | Routes, response shapes, framing names |
| `apps/office/tools/fixture_server.py` | Loopback stand-in for the real service |
| `apps/office/tests/integration/transport_contract.gd` | Live end-to-end suite |
| `apps/office/tools/verify-integration.sh` | Runs the live suite |

## Verification

- `apps/office/tools/verify.sh` → 1004 unit assertions, 18 flow checks, 0 engine errors.
- `apps/office/tools/verify-integration.sh` → 21/21 integration checks, 0 engine errors.
- The fixture server's `--selftest` passes 8/8.
- The SSE byte framing was compared with `packages/server/src/event-feed.ts:36`
  and matches: `data: <json>\n\n` plus `: keep-alive`, with no `id:`, `event:` or
  `retry:` field.

## Contract details confirmed against the live service

- The snapshot is returned top level — `sourceEpoch`, `session`, `messages`,
  `watermark` — and is **not** nested under `data`. Read routes such as the
  session list, active map and message list do use a `data` envelope.
- `/api/experimental/session/:id/log` is `HttpApiSchema.StreamSse`
  (`packages/protocol/src/groups/session.ts:948`), so it is read through the
  streaming path, not as a JSON request.
- `/api/session/active` returns only sessions with a foreground drain owned by
  the process. A created-but-unprompted session is absent; that is the contract,
  and a prompt makes it active.
- `session.active` status is `running`; the ephemeral `session.status` event
  carries the separate `idle`/`busy`/`retry` vocabulary.

## Defects found during verification

Four real defects were found and fixed in the transport by its author lane, two
of which emitted a per-frame engine error. Three test-side errors were mine:
the fixture has no session until one is created, `session.active` was asserted
against the wrong lifecycle point, and the log route was requested as JSON
rather than streamed.

## Not covered

- `follow=true` against a concurrently admitting prompt.
- Prompt retry reconciliation over the wire.
- Subagent, question, permission and guardrail reply routes.


## Deliverables

| File | Purpose |
|---|---|
| `apps/office/integration/sse_parser.gd` | Incremental byte-safe SSE parser |
| `apps/office/integration/http_transport.gd` | Non-blocking `HTTPClient` transport for JSON and SSE |
| `apps/office/tests/suites/test_sse_parser.gd` | 12 parser assertions |
| `apps/office/tests/suites/test_http_transport.gd` | 10 transport assertions |

## SSE parser — verified independently

The implementing lane reported success; the main session re-verified the behavior
on an isolated copy with its own 14-case harness, then wrote the permanent suite.
Both pass.

| Rule | Evidence |
|---|---|
| Single and split events | assertion + harness |
| Multibyte UTF-8 split across chunks | `日本語` decoded exactly |
| CRLF framing and a split between CR and LF | assertion + harness |
| Lone CR framing | assertion + harness |
| Comment/heartbeat ignored | assertion + harness |
| Multi-line `data:` joined with `\n` | assertion + harness |
| `event:` / `id:` / `retry:` parsed | assertion + harness |
| Unknown fields ignored | assertion + harness |
| EOF-incomplete event stays pending | assertion + harness |
| 1 MiB line cap reports an error and recovers | assertion + harness |

Independent harness result: `SSE: pass=14 fail=0`, exit 0.

## HTTP transport — verified against a live loopback stub

The main session started a throwaway `python3` HTTP server on an ephemeral
loopback port and drove the real transport against it:

| Observed behavior | Result |
|---|---|
| Unconfigured transport returns -1 and sets `last_error` | pass |
| Configured JSON GET settles on exactly one `response` with status 200 | pass |
| Health body decoded (`healthy == "true"`) | pass |
| Basic auth arrives on the wire as `Basic eWNvZGluZzpwdw==` | pass |
| 404 with a JSON body surfaces as a `response`, not an `error` | pass |
| A cancelled request id emits nothing afterwards | pass |

Harness result: `HTTP: pass=10 fail=0`, exit 0, zero engine errors.

## Defects the implementing lane found and fixed

Four real failures, each caught by its own harness:

1. `Not all code paths return a value` in `_drain` (a `while true:` returning `bool`).
2. A per-frame `status != STATUS_BODY` engine error: body chunks are now gated on `get_status()`.
3. A per-frame `Parse JSON failed` engine error: `JSON.parse_string` replaced with `JSON.new().parse()` so a handled parse failure is not an engine error.
4. A harness that printed `PASSED` after aborting on its first line; a zero-check guard was added.

Defect 2 and 3 matter because `verify.sh` treats any engine error as a failure, so
these would have blocked the gate even with a passing exit code.

## Full suite

`passed: 985, failed: 0, exit 0` on an isolated copy (Godot is single-instance per
project, so the main session verifies on a copy while lanes hold the real tree).

## Not verified

- HTTPS/TLS: `TLSOptions.client()` is passed for `https://`, but no TLS server was exercised. Loopback HTTP is the MVP scope.
- Timeout paths (`CONNECT_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`) need a black-holed peer.
- IPv6-literal base URLs, a non-default port in a live URL, and a 2xx with an empty body were not executed live.
- Cancellation was proven for an in-flight connect; the same guarantee holds by construction at other phases but only that phase was run.
- Nothing is wired into `app/main.gd` yet: LIVE mode, snapshot recovery, and the event-to-store cascade remain TASK-027 onward.
