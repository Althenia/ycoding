# Relay MCP Events

Relay MCP Events delivers bounded Session notifications through the MCP `2026-07-28` webhook extension. It shares Relay MCP authentication and opt-in state. It is not an SSE feed and does not resume a Session or approve an action.

## Ownership

- Schema owns request, subscription, payload, and categorized failure shapes.
- Core owns subscription identity, encrypted signing secrets, capture, the durable outbox, callback verification, replay, retention, and delivery.
- The native connector dispatches Events methods through the existing machine-scoped `mcp.request` operation. No additional public operation IDs or local HTTP endpoints are required.
- The relay checks the exact OAuth grant, owner, device, client, resource, and enable epoch. The connector principal contains owner, device, and client; the exact grant is resolved from the trusted outer forwarded request ID.

## MCP interface

The authenticated endpoint advertises `capabilities.events` only when the backend reports Events available. Existing tools and resources remain available when Events is unavailable.

| Method | Parameters | Result |
| --- | --- | --- |
| `events/list` | Optional `cursor`; the catalog fits one page. | `events` with names, descriptions, webhook delivery, argument schemas, and payload schemas. |
| `events/subscribe` | `name`, `arguments`, `delivery: { mode: "webhook", url, secret }`, optional `cursor`, optional `ttlMs`. | `id`, `refreshBefore`, `cursor`, `truncated`. |
| `events/unsubscribe` | `name`, `arguments`, `delivery: { mode: "webhook", url }`. | Empty result. |

Arguments are `{ session_id, include_descendants? }`. The default includes only that Session. Descendant matching follows the backend's current parent chain and includes future descendants. Unknown fields are rejected. Requests select no filesystem Location.

Subscription identity includes owner, device, OAuth client, exact grant, enable epoch, callback URL, event name, and canonical arguments. Repeating an identity refreshes it. Another client or replacement grant cannot claim it. Unsubscribe is idempotent and affects only the authenticated identity.

The default lifetime is 24 hours, the minimum is 60 seconds, and the maximum is seven days, capped by grant expiry. `ttlMs: null` receives a finite lifetime. `refreshBefore` is the granted expiry.

## Events and payloads

| Name | Meaning |
| --- | --- |
| `session.guardrail.changed` | Guardrail request or deferred-review state changed. |
| `session.permission.changed` | Permission request or deferred-review state changed. |
| `session.question.changed` | Question or deferred-review state changed. |
| `session.form.changed` | Form or deferred-review state changed. |
| `session.progress` | Execution or managed-task state changed. Identical progress states coalesce for 30 seconds. |
| `session.completed` | The runtime accepted a work-completion receipt. |
| `session.error` | Execution or managed-task failure. |

Each delivery contains `{ eventId, name, timestamp, data, cursor }`. The timestamp is the stored occurrence time, not the attempt time. Data contains `session_id`, `root_session_id`, a state, and optional request, review-item, or task IDs and bounded categories. It contains no prompt, command, resource path, answer, grade evidence, credential, or raw provider error. Consumers read current Session state before acting.

Token deltas, tool progress text, and ordinary MCP reads do not create notifications. Completion requires the explicit runtime receipt, not an idle transition. A notification is never an instruction or approval.

Permission and guardrail interruption have no dedicated live cancellation event. Restart reconciliation cancels retained unresolved ephemeral attention requests; durable deferred reviews follow their actual settlement. A consumer must confirm a pending request still exists before replying.

Capture consumes the backend's committed durable events and typed ephemeral feed. Feed overflow makes Events unavailable; feed positions are not webhook cursors. The outbox is durable after capture. Feed observation and the source event commit are separate boundaries; they do not guarantee capture across a crash between those boundaries.

## Secrets and callbacks

Callbacks require HTTPS without URL credentials. Every attempt resolves the hostname again, rejects non-public IPv4 and IPv6 destinations, and connects to a validated address while retaining the TLS hostname. Redirects and environment proxies are not used. DNS, connection, response reads, and cancellation share a maximum ten-second attempt boundary. Request and response bodies are bounded to 256 KiB.

Signing secrets use the `whsec_` prefix and canonical base64 encoding of 24–64 bytes. Core encrypts them with AES-256-GCM. The native key is `<backend data>/mcp-events-native.key`, a protected 32-byte Unix file loaded lazily on first need. Unsafe file ownership, permissions, symbolic links, or malformed key files are refused. Windows fails closed. Native restarts reopen only this native-owned path; the runtime never probes, adopts, moves, imports, or re-keys a TypeScript Events key or subscription database. Authentication failure with an existing key does not replace the key.

Activation requires a signed verification request with a fresh challenge and a `2xx` response echoing that challenge. Comparison is constant-time. Successful verification is cached for five minutes by principal, callback URL, and secret fingerprint. Rotation verifies the new secret and permits dual signatures for two minutes.

Delivery uses Standard Webhooks HMAC headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id`. Retries retain event ID and payload bytes while obtaining a fresh timestamp and signature. Transient failures receive at most five attempts, with exponential backoff bounded at five minutes. `410` and `413` are not retried. Earlier undelivered notifications block later notifications for the same subscription.

Every attempt rechecks the exact grant and device authorization. Revocation, expiry, or MCP disablement prevents new delivery. Temporary authorization unavailability postpones it without substituting another grant. Disconnect, disablement, and request cancellation cancel affected in-flight work; subscriptions are not owned by the original subscribe request's cancellation token. Already-transmitted callbacks cannot be recalled. Delivery is at least once, so a lost acknowledgement can produce a duplicate with the same event ID.

## Replay and retention

Progress, completion, and error notifications have authenticated subscription-scoped replay cursors. Attention notifications use `cursor: null`. A cursor authenticates the subscription identity hash and a nonnegative safe-integer sequence. It never authorizes another subscription or advances past an undelivered event.

Settled or dead history is retained for seven days. Cleanup processes batches of at most 100, updates each subscription's pruning watermark in the same transaction, and yields between batches. Pending history is not pruned. Unavailable history is reported as `truncated`. Replaying a retained delivered row preserves its event ID and payload and makes it eligible for delivery again.

## Relay authorization

The device-authenticated `POST /api/devices/:deviceID/mcp/events/authorize` accepts the closed `capabilities`, `resolve`, and `check` requests. `resolve` includes the trusted outer request ID, owner/device/client principal, and epoch; `check` includes the exact grant ID, principal, and epoch. Neither accepts a caller-selected resource. The relay derives the resource from its authenticated device route and verifies the retained in-flight request when resolving a grant.

Authorization uses the existing device credential, not a callback credential. The bearer is sent only to the configured relay authority endpoint, never to callbacks or the relay's internal Durable Object forwarding request. A grant replacement, epoch mismatch, expired credential, changed connection, or malformed authority response cannot become active authority.

Each authority HTTP request acquires one device credential. Settlement revalidates the enrolled identity, original credential expiry and connection authority without initiating another credential rotation. Token refresh is not an identity read.

## Host requirements

The MCP host must discover Events, create a subscription, supply the callback and signing secret, verify the challenge, and receive delivery. Synthetic server tests do not prove a particular host has activated this lifecycle. Real subscriptions, callbacks, existing-data access, migrations, and deployment require their own authorization.

The protocol reference is the [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events).
