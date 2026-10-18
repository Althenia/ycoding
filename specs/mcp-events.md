# Relay MCP Events

Relay MCP Events delivers bounded Session notifications through the MCP `2026-07-28` webhook extension. It shares Relay MCP authentication and opt-in state. It is not an SSE feed and does not itself resume a Session or approve an action.

## Ownership

- Schema owns request, subscription, payload, and categorized failure shapes.
- Core owns subscriptions, encrypted signing secrets, the durable outbox, callback verification, and delivery.
- Protocol and Server expose global authenticated operations under `/api/remote/mcp/events`.
- CLI registers the SDK extension methods and supplies the connected device's authorization driver.
- The relay checks the exact OAuth grant, account, device, resource, and enable epoch. Existing connector frame shapes are unchanged.

## MCP interface

The authenticated endpoint advertises `capabilities.events` only when its local backend reports Events available.

| Method | Parameters | Result |
| --- | --- | --- |
| `events/list` | Optional `cursor`; the catalog fits one page. | `events` with names, descriptions, webhook delivery, argument schemas, and payload schemas. |
| `events/subscribe` | `name`, `arguments`, `delivery: { mode: "webhook", url, secret }`, optional `cursor`, optional `ttlMs`. | `id`, `refreshBefore`, `cursor`, `truncated`. |
| `events/unsubscribe` | `name`, `arguments`, `delivery: { mode: "webhook", url }`. | Empty result. |

Arguments are `{ session_id, include_descendants? }`. The default includes only that Session. Descendant matching follows the backend's current parent chain and includes future descendants. Unknown fields are rejected.

Subscription identity includes owner, device, OAuth client, exact grant, enable epoch, callback URL, event name, and canonical arguments. Repeating the same subscription refreshes it. Another client or a replacement grant cannot claim the prior identity. Unsubscribe is idempotent and affects only the authenticated identity.

The default lifetime is 24 hours, the minimum is 60 seconds, and the maximum is seven days, capped by grant expiry. `ttlMs: null` receives a finite lifetime. `refreshBefore` is the granted expiry.

## Events and payloads

| Name | Meaning |
| --- | --- |
| `session.guardrail.changed` | Guardrail request or deferred-review state changed. |
| `session.permission.changed` | Permission request or deferred-review state changed. |
| `session.question.changed` | Question or deferred-review state changed. |
| `session.form.changed` | Form or deferred-review state changed. |
| `session.progress` | Execution or managed-task state changed. Repeated identical progress states coalesce for 30 seconds. |
| `session.completed` | The runtime accepted a work-completion receipt. |
| `session.error` | Execution or managed-task failure. |

Each delivery contains `{ eventId, name, timestamp, data, cursor }`. `timestamp` is the occurrence time, not the attempt time. `data` contains `session_id`, `root_session_id`, a state, and optional request, review-item, or task IDs and bounded categories. It contains no prompt, command, resource path, answer, grade evidence, credential, or raw provider error. Consumers read current Session state before acting on a notification.

Token deltas, tool progress text, and ordinary MCP reads do not create notifications. Completion means the explicit runtime receipt, not an idle transition. An event is a notification, never an instruction or approval.

Permission and guardrail interruption do not publish a dedicated live cancellation event. Restart reconciliation cancels retained, unresolved ephemeral requests; durable deferred reviews remain governed by their actual settlement. Consumers must confirm a pending request still exists before replying.

## Callback security and delivery

Callbacks require HTTPS without URL credentials. Every connection resolves the hostname again, rejects non-public IPv4 and IPv6 destinations, and connects to a validated address while retaining the original TLS hostname. Redirects are not followed. DNS resolution, connection, response reads, and cancellation share the ten-second attempt boundary. Bodies are bounded to 256 KiB.

The signing secret uses the `whsec_` prefix and canonical base64 encoding of 24–64 bytes. Core stores it encrypted with AES-256-GCM. The local key is `mcp-events.key` in the global data directory, restricted to mode `0600`; symbolic links and unsafe permissions are refused. Secure key storage is unavailable on Windows, so Events fails closed there.

Before activation, a signed verification request carries a fresh challenge. A successful callback must return the same challenge in a `2xx` response; comparison is constant-time. Successful verification is cached for five minutes by principal, URL, and secret fingerprint. Secret rotation verifies the new key and permits dual signatures for two minutes.

Deliveries use Standard Webhooks HMAC headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id`. Retries retain the event ID and exact serialized payload while obtaining a fresh timestamp and signature. Transient delivery failures receive at most five attempts, with exponential backoff bounded at five minutes. `410` and `413` are not retried. Earlier undelivered notifications block later notifications for the same subscription.

Every delivery rechecks the exact grant and device authorization. Revocation, expiry, or MCP disablement stops delivery. Temporary authorization unavailability postpones it without substituting another grant. Local disconnect and disable signals cancel in-flight attempts. Delivery is at least once: a lost acknowledgement can produce a duplicate event with the same ID.

Progress, completion, and error notifications have scoped replay cursors. Attention notifications use `cursor: null`. Settled outbox history is retained for seven days; unavailable replay history is reported with `truncated`. A cursor never authorizes another subscription or advances past an undelivered event.

## Local and relay operations

| Operation | HTTP boundary |
| --- | --- |
| `mcpEvents.status` | `GET /api/remote/mcp/events/status` |
| `mcpEvents.list` | `GET /api/remote/mcp/events/catalog` |
| `mcpEvents.subscribe` | `POST /api/remote/mcp/events/subscribe` |
| `mcpEvents.unsubscribe` | `POST /api/remote/mcp/events/unsubscribe` |

Mutation payloads contain `{ context, subscription }`. The connector supplies `context` from the authenticated forwarded request, including its outer request ID. These global endpoints accept no caller-selected Location. Schema-rejection logs and responses omit submitted callback and signing material.

The device-authenticated `POST /api/devices/:deviceID/mcp/events/authorize` supports capability discovery, resolution of a currently forwarded MCP request to its exact grant, and subsequent grant checks. It uses the already-minted device credential; it neither rotates credentials nor forwards a bearer to the callback or MCP client.

## Host requirements

ChatGPT documents webhook Events for supported Work/Cloud chats and dots. The host must discover the extension, create a subscription, supply the callback and signing secret, verify the challenge, and receive delivery. Server tests do not establish that a particular chat supports or has activated this lifecycle. Live subscriptions and callbacks require explicit host setup and authorization.

## Verification

- `packages/schema/test/mcp-events.test.ts` checks public shapes.
- `packages/core/test/mcp-events*.test.ts` checks storage, signing, containment, retry, ordering, authorization, and event capture.
- `packages/core/test/remote-mcp-events-transport.test.ts` checks SDK wire behavior.
- `packages/server/test/mcp-events*.test.ts` checks authenticated local dispatch and safe failures.
- `packages/remote/test/mcp-events.test.ts` and `infra/cloudflare/test/mcp-events-authorize.test.ts` check device/grant boundaries.
- `packages/cli/test/remote-mcp-events.test.ts` checks connector composition.

The protocol reference is the [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events).
