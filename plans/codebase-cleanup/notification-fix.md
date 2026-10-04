# Guardrail notification latency triage

## Scope and evidence labels

- **Reported:** TUI attention sound fired for a guardrail review; an iPhone OS alert eventually arrived, estimated roughly3–5 minutes later. Estimate is uncertain. Browser alert arrival remains unknown. Screenshot command is evidence only; never execute it, approve it or alter review policy.
- **Confirmed local source:** inspected fresh `.worktrees/codebase-cleanup` at `2becb348`, not the former SL checkout. Other writers have dirty web, dependency/configuration and runtime-documentation files; preserve them. Deployment, installed CLI/backend/web/SW versions and any regression window are **unknown**.
- **Unknown actor/configuration:** exact review creation time, relay receipt/notice time, push request/response time, OS arrival time, phone OS/browser version, standalone versus tab state, foreground/background/network/Focus state, notification permission, stored System-category switch and subscription state, connector reconnect/status-read errors. No live push, service restart, deployment, credential access, permission mutation or external write is authorized.
- Mutable source scope after confirmed RED is CLI remote notification paths, relay/push and focused tests; Core policy and approvals are forbidden. Parent owns Git/root documentation. Web source ownership was not requested because no web change is justified.

## Confirmed initiating input to delivery boundaries

1. `packages/core/src/session/guardrail.ts`: review admission stores the pending request under the root lock, then publishes `Guardrail.Event.Asked`; execution waits on Deferred for a human decision. Generic `Event.publish` in `packages/core/src/event.ts` stamps envelope `created` from DateTime.now. The ephemeral Schema and Server EventFeed encoding retain that creation time in the public event; the request data itself has no separate timestamp. It measures publication, not the start of evaluation or tool admission. Hard-review policy is unchanged. This is source evidence, not a reenactment of the user's unsafe command.
2. `packages/cli/src/remote-bridge.ts`: `guardrail.*` invalidates cached attention and schedules status. Pending review is carried by status `requestAttention`/`requestNeeds`, with `need:review`. `reportBlock` emits a blocked frame only for decision `deny`; a pending review is not a denial.
3. `packages/cli/src/remote-operations.ts`: status reads aggregate outstanding/running roots and pending guardrail reviews for running families, deriving every Location from backend inventory. Permission→Form→review precedence remains intact. A failed status read never emits a partial frame.
4. `infra/cloudflare/src/relay/core.ts` and `relay/notice-store.ts`: a newly attentive root yields one unread attention notice, an in-app `notice.added` frame, and a push candidate. Initial status without a saved prior status is a silent baseline; unread attention repeat rules are separate from push dispatch rate.
5. `infra/cloudflare/src/push/send.ts`: account-owned subscriptions and enabled categories select targets; actual payload encryption precedes outbound fetch. `approval-requested` already uses **urgency high**, **TTL3600 seconds**, a32-character hash topic of device/notice/category, and a **10-second request deadline**. HTTP2xx is push-service acceptance, not device display. Clearing a transient failure counter likewise proves no OS display.
6. `infra/cloudflare/src/relay/durable-object.ts`: adapter invokes native fetch through an arrow wrapper and awaits `settleDeliveries`. Accepted subscriptions leave presentation to the service worker. Non-accepted outcomes, including timeout/unreachable, present once in an authorized earliest-connected open tab for that browser. No open tab means no page fallback; a later tab does not replay it.
7. `apps/web/src/remote/notifications.ts`: page System presentation requires System preference and granted permission, and uses service-worker registration. Local guardrail-block entries and `notice.added` are not independent System-alert senders. `apps/web/src/service-worker.ts`: on a push event, await `showNotification`; current worker does not suppress it for a visible/focused workspace. These calls are not observed delivery on the user's iPhone.

## Configured timing versus measured timing

| Boundary | Verified configured value / meaning | User's actual timing |
| --- | --- | --- |
| Connector status coalescing |250ms; not a user-visible notification SLO | unknown |
| Connector scheduler |25ms frame spacing; control frames precede event/bulk queues | unknown |
| Local API read |30s per request default; status may await multiple request groups | unknown |
| Status/event read retry | exponential1s→30s; failures retain last complete state | unknown |
| Relay reconnect | exponential1s→30s default | unknown |
| Notice repeat |10min minimum for an unchanged unread need on re-entry; new needs handled by current notice rules | unknown prior notice/state |
| Push budget |20 events/device/minute, overflow summary by category; not a3–5min timer | unknown |
| Outbound push fetch |10s abandonment deadline; no automatic retry | unknown |
| Accepted-push retention |TTL3600s; retention limit, not actual delivery latency | unknown |
| APNs/FCM queue, worker wake, OS presentation | not measured by sender acceptance | reported iPhone arrival roughly3–5min; uncertain |

Do not sum these values into a fabricated end-to-end deadline or attribute the estimate to APNs/OS. A reconnect, failed local read or provider queue is a hypothesis, not an observed cause.

## Smallest safe local flow reproduction

Executed an inline `bun -` harness from the current CLI package, with8192 MiB process-tree cap and30s timeout. Reused real `RemoteAgent`, `createRelay`, SQLite `createNoticeStore`, `createNoticeStorage`, and `sendPushToOwner`. Mock only Core local-server methods, authenticated connection ports and push-service fetch. Generate ephemeral receiver/VAPID keys in memory; never print them. Fake Apple-host fetch returns201; no external request or OS notification occurs. Start one synthetic running Session, await initial empty-attention status and event-stream registration, inject one pending hard-review `guardrail.asked`, and await actual relay/push settlement.

Observable assertions: outgoing frames parse with the real Agent parser; status carries one root with need `review`; one durable notice row exists; fake push outcome is accepted; there is no page `notice.present` for that accepted browser; the synthetic review stays pending. Exit0. No approval or screenshot command was executed.

| Measured stage | Milliseconds after injected asked event |
| --- | ---: |
| initiating guardrail.asked |0.001 |
| local outstanding read |251.336 |
| local pending-review read |251.383 |
| connector status send |251.667 |
| relay status admission |251.688 |
| notice.added |252.063 |
| push dispatch |252.202 |
| encrypted fake push request |256.329 |
| fake201 acceptance |256.352 |

Fake request observed urgency high, TTL3600, topic length32. This is one local correctness trace, not a statistically measured production benchmark or an iPhone/APNs delivery result. The reported multi-minute delay was **not reproduced**.

## Focused existing checks before edits

Every test command used one test process,8192 MiB cap, finite timeout. No full package/root suite or live provider:

- `bun test --cwd packages/cli test/remote-bridge.test.ts --test-name-pattern='guardrail block|request event during|early refresh|status' --timeout 30000 --only-failures`: exit0;9 pass,42 filtered;2.85s.
- `bun test --cwd packages/cli test/remote-operations.test.ts --test-name-pattern='status names|family-wide guardrail' --timeout 30000 --only-failures`: exit0;3 pass,87 filtered;170ms.
- `bun test --cwd infra/cloudflare test/relay-core.test.ts --test-name-pattern='guardrail block|needs attention again|attention detail|push outcome|deadline|status frame' --timeout 30000 --only-failures`: exit0;6 pass,115 filtered;14ms.
- `bun test --cwd infra/cloudflare test/push-send.test.ts --timeout 30000 --only-failures`: exit0;9 pass;10.07s, including the real10s abort signal with fake fetch, exact browser ownership/outcomes, high urgency/TTL/topics, encrypted payload and redacted diagnostics.
- `bun test --cwd apps/web src/service-worker.push.test.ts --timeout 30000 --only-failures`: exit0;1 pass,37 assertions;13ms. Actual worker module, mocked browser/OS APIs; verifies review copy and focused/background handler presentation calls, not physical OS display.
- `bun test --cwd apps/web src/remote/notifications.test.ts --timeout 30000 --only-failures`: exit0;36 pass;21ms. Presentation preferences and owner/fallback handling, not physical browser delivery.

## Separate confirmed RED: stale workerd fixture assertion

`WRANGLER_SEND_METRICS=false bun infra/cloudflare/test/integration/push-binding-local.ts` (180s timeout,8192 MiB cap) initially exited1 at line127. Actual local workerd+D1+encrypted fake-push result was `{pushed:[laptop-third,phone],laptop:1,phone:1}`. Fresh source expected laptop0/phone1: laptop-third's fetch hangs; phone returns403. Earlier provisional parent report incorrectly described the expected phone value; corrected against live input.

Parent verified existing intended behavior from main `ad1be144`, current push-send test, relay non-accepted outcome branch and docs/runtime: timed-out push→one authorized open-tab fallback. Stale remote CONTRACT wording belongs to parent. This RED is an outdated test assertion, **not a reproduced production latency defect**.

Authorized correction only: `infra/cloudflare/test/integration/push-binding-local.ts` expected laptop fallback0→1 for the timed-out browser, plus truthful assertion/PASS text. Preserve phone1, every other ownership/renewal/restart/expiry assertion and the existing≥10s deadline assertion. No production notification condition, policy, schema, API, dependency, migration or telemetry change.

**Revised GREEN:** `WRANGLER_SEND_METRICS=false bun infra/cloudflare/test/integration/push-binding-local.ts` exited0 (180s timeout,8192 MiB cap). Real local workerd+D1 encrypted fake-push flow preserves two-browser ownership, renewal/replacement and restart behavior; timeout and rejected browser each get one fallback after the existing≥10s assertion; expired/missing registrations still present once. `node_modules/.bin/oxlint infra/cloudflare/test/integration/push-binding-local.ts` exited0,0 warnings/0 errors. `git diff --check -- infra/cloudflare/test/integration/push-binding-local.ts` exited0. Final diff is2 lines changed (assertion/diagnostic and PASS summary), no production change.

No production mutation probe is justified or authorized for this read-only latency investigation; existing real-component sender/relay/worker checks remain intact. No independent package/root typecheck or `check:cloudflare` was run by this child: the only changed file is a standalone integration script, outside infra/cloudflare/tsconfig.json's `src/**/*.ts` and generated Worker-type inputs. Root Cloudflare validation is handed to parent under shared-check/resource ownership; it is not claimed passed here. No Git mutation or commit.

## Still-open delivery boundary and minimum next diagnostic

No cause or regression window has been established for the reported iPhone delay. Most discriminating privacy-safe evidence: same review's approximate initiating time, relay notice `createdAt`/first in-app appearance, and OS alert arrival time on iPhone. If the in-app/notice time was already prompt, investigate accepted-push→APNs/device/SW/OS presentation; if the notice itself was late, inspect connector status/reconnect/local-read intervals before attributing anything downstream. The notice timestamp is relay admission time, not Core request creation time.

Parent is collecting device/browser timing and owns any live approval path. Current CLI/backend/web/worker versions, phone foreground/background/Focus/network state and System/subscription state remain unknown. Ask no user to supply raw endpoints, credentials, authorization headers, keys, cookies, review resources, commands or private Session titles. No new live push/test alert or OS permission change without native approval.

Stable handoff: local fast path and browser handler calls are confirmed; user-reported3–5min estimate and cause remain unresolved. Correlate the existing source event `created`, relay notice `createdAt`, first in-app appearance and observed OS arrival for the **same** review, accounting for unsynchronized clocks and estimate precision. No new event/telemetry field is needed for that first diagnostic. Physical service-worker push arrival and OS presentation on the user's phone were not observed. The fixture correction is not a notification-latency fix.

## Withdrawn/uncertain bell-center report — completed read-only observations only

- **Reported then withdrawn/uncertain:** user said OS notification appeared but its entry was absent from the in-app bell; latest reply was not sure and maybe the OS notification was tapped. Parent stopped new bell-fix scope. No further user question, web edit, producer change or reproduction is pursued for it.
- **Source-confirmed conditional path, not proof of the user's action:** service worker `notificationclick` carries valid Session/device/notice IDs to the workspace by message or URL hash. In `apps/web/src/remote/ui/shell.tsx`, when connected to the matching active device, that target calls `readNotification(noticeID)` once. Store sends `notice.read`; the relay removes the stored unread row and broadcasts `notice.removed`. This code is consistent with a tapped stored-notice alert becoming read, but the user's tap, exact alert payload, selected device, response success and actual deletion were not observed. Do not state that tapping fully explains this report.
- Opening the bell itself only opens the panel and does not mark entries read. Opening a center row, dismissing it or Read all explicitly invokes the read path.
- OS presentation alone does not prove a corresponding stored row: existing relay storage-failure fallback can send an alert without a notice ID; overflow/outage payloads have different identities. Ordinary stored-notice pushes carry notice ID; their log belongs to the emitting device. The browser subscribes/lists the selected device's notice log, reloads on connection open/reopen, applies In app category preferences, and distinguishes loading/error/hidden settings from an empty unread log. Title lookup updates retained entries independently; it is not a reason to suppress a row.
- Web source/UI/tests remain exclusively owned by the web child. The already-run worker/notification unit checks prove controlled handler calls only, not the user's bell state or physical OS delivery. No bell defect or latency cause was reproduced.

Final authorized changed source remains only the two-line stale workerd-fixture assertion/summary correction. Original-root evidence is uncommitted. Parent owns Git, CONTRACT/root documentation and pending `check:cloudflare`; no new source/Git/external action is requested by this handoff.
