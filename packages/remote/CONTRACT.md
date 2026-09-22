# Remote access contract (`@ycoding-ai/remote` + `infra/cloudflare`)

This document specifies the current behaviour of the Cloudflare relay and its two
WebSocket peers. Authoritative code: `packages/remote/src/index.ts` (envelope,
parsers, limits, close codes, operation allowlist, auth request/response shapes)
and `infra/cloudflare/src` (relay, authentication, routing). The authoritative
local session API is `packages/protocol` (`specs/v2`).

Consumers: the local agent transport in `packages/cli`, the remote client in
`apps/web`, and this worker. Any change to the envelope, operation names, or error
vocabulary changes the contract for all three at once.

## 1. Endpoints

| Method | Path | Auth | Origin | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/auth/google/start` | none | not required (navigation) | Begin Google OIDC; sets the one-use transaction cookie and redirects |
| `GET` | `/api/auth/google/callback` | transaction cookie | not required (provider redirect) | Complete OIDC; sets the browser session cookie |
| `POST` | `/api/auth/session/refresh` | browser session | same-origin required | Rotate the browser session cookie once past half life |
| `POST` | `/api/auth/logout` | browser session | same-origin required | Revoke the browser session and close its relay sockets |
| `GET` | `/api/me` | browser session | not required | Owner, session expiry, and device list (read-only, no `Set-Cookie`) |
| `GET` | `/api/devices` | browser session | not required | `{ devices: RemoteDeviceInfo[] }` (pinned `DevicesResponse`) |
| `POST` | `/api/devices/enrollments` | browser session | same-origin required | Mint a one-use enrollment code |
| `POST` | `/api/devices/enroll` | enrollment code | none (native agent) | Register a device public key |
| `POST` | `/api/devices/challenge` | none (rate limited) | none (native agent) | Mint a one-use device challenge |
| `POST` | `/api/devices/token` | challenge signature | none (native agent) | Issue access + refresh credentials |
| `POST` | `/api/devices/refresh` | refresh credential | none (native agent) | Rotate credentials |
| `POST` | `/api/devices/:deviceID/revoke` | browser session | same-origin required | Revoke a device, its credentials, and its live sockets |
| `GET` | `/ws/v3/client` | browser session cookie | same-origin required | Browser/phone relay connection |
| `GET` | `/ws/v3/agent` | device access token | not required | Local agent relay connection |
| `GET` | `/health` | none | not required | Database liveness probe |

There is no unauthenticated relay path and no legacy/smoke compatibility route.
Every WebSocket connection is authenticated.

Static assets are served from the web lane's build (`apps/web/dist`) through the
`ASSETS` binding with `not_found_handling: single-page-application`. Routing is
explicit, not navigation-header dependent:

- `run_worker_first` covers `/api`, `/api/*`, `/ws`, `/ws/*`, `/health`, `/`,
  `/remote`, `/remote/*`, `/docs`, `/docs/*`, `/changelog`, and `/changelog/*`, so
  the worker always sees relay and HTML entry routes first. API, auth, and relay
  routes can therefore never be replaced by the SPA fallback, including for a
  top-level browser navigation to an API path.
- Every path under the `/api`, `/ws`, and `/health` prefixes belongs to the worker,
  matched or not: an unmatched one returns a JSON `404` (never the SPA shell), so a
  client that expects JSON never receives HTML.
- The worker delegates every path it does not own to `ASSETS`, and the asset layer
  rewrites an unmatched path to `/index.html` (`200`), which is what makes public
  deep links such as `/remote/session/<id>` work. Hashed assets under `/assets/`
  are not in `run_worker_first` and are served directly by the asset layer.
- Hashed assets under `/assets/` are not in `run_worker_first` and are served
  directly by the asset layer, without a Worker invocation.

Every response the worker generates or delegates carries baseline security
headers: `x-content-type-options: nosniff`, `referrer-policy:
strict-origin-when-cross-origin`, `x-frame-options: DENY`,
`cross-origin-opener-policy: same-origin`, `permissions-policy: camera=(),
microphone=(), geolocation=()`, and
`strict-transport-security: max-age=31536000; includeSubDomains`. Existing origin
headers (content type, cache control, ETag) are preserved, and the relay upgrade
response is returned untouched. A `Content-Security-Policy` for the SPA itself is
the web lane's call, because it depends on the app's inline styles, fonts, and
connect targets; if that lane adds one it belongs in a `_headers` file next to the
built assets (the current build has none).

Origin policy (browsers omit `Origin` on ordinary same-origin `GET`, and
JavaScript cannot set it):

- Read-only `GET /api/*` routes **never** require `Origin` and never mutate state.
- Mutating cookie-authenticated routes (`POST /api/auth/session/refresh`,
  `POST /api/auth/logout`, `POST /api/devices/enrollments`,
  `POST /api/devices/:deviceID/revoke`) require a present, exactly matching
  `Origin` (`https://<host>` for `https`, `http://<host>` on localhost
  development) and additionally reject `Sec-Fetch-Site: cross-site`.
- Browser WebSocket upgrade `/ws/v3/client` requires the same exact same-origin
  `Origin`; a missing `Origin` is rejected.
- `/api/auth/google/start` and `/api/auth/google/callback` are navigations and
  require no `Origin`; they are protected by the one-use transaction cookie,
  `state`, PKCE, and the ID token binding.
- Agent routes (`POST /api/devices/enroll|challenge|token|refresh`, `/ws/v3/agent`)
  carry no browser cookie and never require an `Origin`; they are rate limited.

`GET /api/*` responses are `Cache-Control: no-store`. No `GET` route writes
cookies: browser session rotation is only `POST /api/auth/session/refresh`.

## 2. Authentication

### 2.1 Browser (Google OIDC, authorization code + PKCE)

1. `GET /api/auth/google/start` generates `state`, `nonce`, and a PKCE verifier,
   stores them in `oauth_transaction` keyed by the SHA-256 hash of a random
   `yc_oauth` cookie value, and redirects to Google with
   `response_type=code`, `code_challenge_method=S256`, `scope=openid email profile`.
   `redirect_after` must be a same-origin path beginning with `/remote`; anything
   else falls back to `/remote/`.
2. `GET /api/auth/google/callback` requires the `yc_oauth` cookie and consumes the
   transaction exactly once. A `state` mismatch also consumes the transaction, so
   state cannot be guessed repeatedly. It exchanges the code with the verifier and
   validates the returned `id_token`:

   - `alg` is `RS256` and the `kid` resolves through the bounded Google JWKS cache.
   - Signature verifies against the JWKS key.
   - `iss` is `accounts.google.com` or `https://accounts.google.com`.
   - `aud` equals the configured client ID; `azp`, when present, also equals it.
   - `exp` is present and strictly in the future; `iat` is present and not in the
     future beyond clock skew; `nbf` when present is not in the future.
   - `nonce` equals the value bound to the transaction.
   - `sub` is a non-empty string.

   - The account is admitted only when the normalized `email` claim exactly
     matches an entry in the server-only `GOOGLE_ALLOWED_EMAILS` allowlist and the
     token asserts `email_verified === true`. A missing or empty allowlist denies
     every account. Matching is `trim()` + lowercase, exact: no wildcards, no
     domain suffixes, no substring matches. Ownership is still the issuer/subject
     pair; the email is only an admission check and is never stored as identity.

   Failures, including an unapproved or unverified account, redirect to
   `/remote/?auth=error` with no provider detail, and no configured address is
   ever returned, logged, or emitted. Success mints a browser session and sets the
   `yc_session` cookie.
3. Browser sessions are opaque 32-byte tokens; only the SHA-256 hash is stored.
   They expire after 30 days and are revoked on logout. Rotation past half life
   happens only on `POST /api/auth/session/refresh`; `GET /api/me` stays
   read-only so a `GET` cannot write a cookie.
4. `POST /api/auth/logout`, session expiry, and device revocation all close the
   affected live relay sockets, including a socket that is only receiving session
   events. Expiry is enforced proactively by a Durable Object alarm scheduled at
   the earliest credential expiry, not only when the next command arrives.

Cookie attributes: `HttpOnly; Secure; SameSite=Lax; Path=/` (`yc_session`) and
`HttpOnly; Secure; SameSite=Lax; Path=/api/auth` (`yc_oauth`). Cookies carry
bearer-equivalent authority; never log or echo them. No credential appears in a
URL: the agent token travels in `Authorization: Bearer`, the browser credential in
a cookie, and the `?device=` query carries an opaque device identifier that is
always re-checked for ownership.

### 2.2 Device enrollment (one use)

1. An authenticated browser calls `POST /api/devices/enrollments` and receives
   `{ enrollmentID, code, expiresAt }`. `code` is shown once, is stored only as a
   SHA-256 hash, and expires after 10 minutes.
2. The local agent generates an ECDSA P-256 keypair, keeps the private key on the
   device, and calls `POST /api/devices/enroll` with
   `{ enrollmentID, code, name, publicKey }` where `publicKey` is
   `{ kty: "EC", crv: "P-256", x, y }` (unpadded base64url, 32-byte coordinates).
3. Consumption atomically updates `enrollment` where `consumed_at IS NULL AND
   expires_at > now`; a second attempt with the same code fails. A wrong code does
   not consume the enrollment, and the endpoint is rate limited.

### 2.3 Device credentials (challenge signing, rotated)

1. `POST /api/devices/challenge` with `{ deviceID }` returns
   `{ challengeID, nonce, expiresAt }`. Challenges are one-use and expire after 2
   minutes. Unknown and revoked devices return the same generic failure so the
   endpoint does not disclose device existence.
2. The device signs `deviceSignaturePayload(challengeID, nonce)` —
   exactly `"ycoding-device-v1\n<challengeID>\n<nonce>"` — with ECDSA P-256 /
   SHA-256 and sends `POST /api/devices/token` with
   `{ deviceID, challengeID, signature }`. The signature is the raw
   `r || s` 64-byte ECDSA value in unpadded base64url.
3. Success consumes the challenge, validates the signature against the stored
   public key, records `last_seen_at`, and returns
   `{ accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }` (access 10
   minutes, refresh 30 days; both stored as hashes only). A replay of the same
   challenge or signature fails because the challenge is consumed.
4. `POST /api/devices/refresh` rotates: the presented refresh credential is
   revoked atomically with issuing the new pair. A revoked device, revoked
   credential, expired credential, or a non-refresh credential all fail.
5. `POST /api/devices/:deviceID/revoke` (browser owner only) marks the device
   revoked, revokes its credentials, and notifies the device's Durable Object to
   close the agent and client sockets.

### 2.4 Authorization invariant

Every relay command path requires an authenticated owner, an authenticated device
owned by that account, a non-revoked device, and a live browser session. The local
agent resolves scoped Session IDs against its backend before execution. The relay
re-checks session expiry and device revocation from D1 on each command rather than
trusting the connection's upgrade state.

## 3. Relay transport

### 3.1 Connections

- `GET /ws/v3/client?device=<deviceID>` requires a valid browser session cookie, a
  present same-origin `Origin`, and a device the owner owns and has not revoked. It
  connects to the Durable Object named `<ownerID>:<deviceID>`.
- `GET /ws/v3/agent` requires `Authorization: Bearer <accessToken>`. The token must be
  an unexpired, unrevoked `access` credential whose device is not revoked. The same
  `<ownerID>:<deviceID>` Durable Object is used.
- The worker strips every inbound `x-ycoding-*` header and re-derives trusted relay
  headers itself. Browser-supplied internal headers are never honored.
- `/ws/v3/client` never accepts a bearer token, and `/ws/v3/agent` never accepts the
  browser cookie, so one role cannot impersonate the other.
- One agent connection is authoritative per device. A newer agent connection closes
  the previous one with `1012`.
- Browser-session logout and rotation, and device revocation, push a close to every
  Durable Object the owner may hold sockets in; logout and rotation notify each
  owned device object, not a single one.
- Revocation is also fail-closed without the push: a restored connection re-validates
  authority when the object wakes, and every event delivery re-validates the
  recipient's session and device at most once per `5s` window before the frame is
  sent. A revoked or expired recipient is closed (`4401`) and never receives the
  event. A refusal never suppresses the close.

### 3.2 Envelope

One JSON object per WebSocket frame, discriminated by `type`.

| `type` | Direction | Shape |
| --- | --- | --- |
| `request` | client → relay → agent | `{ type:"request", id, operation, sessionID?, input? }` |
| `response` | agent → relay → client | `{ type:"response", id, ok:true, value, chunk? }` or `{ type:"response", id, ok:false, error:{ code, message } }` |
| `event` | agent → relay → clients | `{ type:"event", sessionID, event }` |
| `sessions` | agent → relay → clients | `{ type:"sessions" }` |
| `subscriptions` | relay → agent | `{ type:"subscriptions", clientID, sessionIDs:[...] }` |
| `ping` | either direction | `{ type:"ping" }` |
| `pong` | either direction | `{ type:"pong" }` |

`id` is a client-generated correlation ID matching `^[A-Za-z0-9_-]{1,64}$`.
`operation` is one of the fixed operations in section 3.4. `sessionID` matches
`^ses[A-Za-z0-9_-]+$` (≤128 chars). `input`, when present, is a JSON object; the
relay forwards it verbatim and does not interpret it. `event` is forwarded
verbatim as the local `packages/protocol` event payload.

Relay rules:

- **Correlation IDs are translated.** Two clients may legitimately use the same
  `id`. The relay rewrites each client request to a fresh, relay-generated ID
  before forwarding, and rewrites the matching agent response back to the
  originating client's ID. Agents therefore never see colliding IDs, and a
  response is delivered only to the client that issued the corresponding request.
  Unknown or already-settled IDs are dropped.
- `event` frames are delivered only to clients subscribed to that `sessionID`.
- `sessions` is a bounded invalidation, never an inventory. The client responds by
  paging `session.list` until its cursor is exhausted.
- The client's registered subscription is updated when a `session.subscribe` or
  `session.unsubscribe` response succeeds.
- The relay is the only per-client subscription authority. After each successful
  subscription settlement it sends that client's complete bounded snapshot to the
  agent. An empty snapshot deletes the client from the agent's derived index.
- Agent attach sends one snapshot for every live authorized browser client,
  including clients restored from Durable Object attachments. Browser attach sends
  its current snapshot when an agent is already present. Detach, expiry, logout,
  and revocation send an empty snapshot before removing the client. A response that
  arrives after detach has no pending correlation and cannot recreate interest.
- Hibernation restoration completes before new upgrades or messages are admitted.
  It restores the surviving agent first, then sends an empty snapshot for every
  restored browser rejected for expiry, authorization, or invalid subscriptions.
- The agent parses `subscriptions` only on its relay-control surface; the browser
  parser rejects the frame. It clears the derived per-client index whenever the
  relay connection closes or opens, then forwards an event only when the union of
  current snapshots contains that Session. Subscribe and unsubscribe operations
  validate backend Session access but do not mutate an independent local refcount.
- In-flight requests per client are capped; a client disconnect drops its pending
  requests, and the client must treat those outcomes as unknown.

Frames from one connection are processed strictly in arrival order. A frame that
awaits an authority check cannot let a later frame from the same peer overtake it,
so a client's requests reach the agent in the order they were sent (each carrying
its own relay-generated id) and a client's responses and events arrive in the
order the relay emitted them. Each connection owns its queue: queues drain
independently, a queue entry lives only as long as its queued frames, and a frame
that fails does not block the frames behind it. Ordering is per connection only —
nothing is promised across connections, between the two roles, or between a
response and unrelated events.

### 3.3 Bounded responses (no silent truncation)

A response whose JSON text exceeds the agent frame bound must be sent as ordered
chunks instead of being truncated or dropped:

```json
{"type":"response","id":"a","ok":true,"value":"<slice of the JSON text>","chunk":{"index":0,"last":false}}
```

`value` is a UTF-16 slice of the JSON text of the complete response value;
concatenating the slices in `index` order reproduces the exact text, which the
client parses once `last` is true. The relay enforces: at most
`maxChunksPerResponse` (64) chunks per response, indices starting at 0 and
increasing by exactly 1, no frame after `last`, and no chunk marker on a failed
response. A violation closes the agent with `1008`. `packages/remote` exports
`parseChunkedValue` for the client side.

Large `session.messages` results are the expected case: the Projection API
(`v2.message.list`, `GET /api/session/:sessionID/message`) is a single unpaginated
response, so the local agent chunks it. `session.log` (`v2.session.log`) remains
the incremental/paginated read via `after`, and `session.snapshot`
(`v2.session.snapshot`) provides messages plus a watermark in one response.

### 3.4 Operations (closed operation set)

The relay rejects anything outside this list with `unknown_operation`. `input`
field names below are the local Protocol names; the agent maps them onto the
corresponding route.

| Remote operation | Session-scoped | Local Protocol identifier | Local route | `input` fields |
| --- | --- | --- | --- | --- |
| `session.list` | no | `v2.session.list` | `GET /api/session` | `limit?`, `order?`, `search?`, `parentID?`, `cursor?` |
| `session.active` | no | `v2.session.active` | `GET /api/session/active` | — |
| `session.get` | yes | `v2.session.get` | `GET /api/session/:sessionID` | — |
| `session.messages` | yes | `v2.message.list` | `GET /api/session/:sessionID/message` | — |
| `session.snapshot` | yes | `v2.session.snapshot` | `GET /api/session/:sessionID/snapshot` | — |
| `session.log` | yes | `v2.session.log` | `GET /api/experimental/session/:sessionID/log` | `after?` |
| `session.subscribe` | yes | `v2.event.subscribe` | `GET /api/event` (SSE) | — |
| `session.unsubscribe` | yes | — (tears down the agent's `v2.event.subscribe` stream for that session) | — | — |
| `session.prompt` | yes | `v2.session.prompt` | `POST /api/session/:sessionID/prompt` | `id?`, `text`, `files?`, `agents?`, `delivery?`, `resume?` |
| `session.interrupt` | yes | `v2.session.interrupt` | `POST /api/session/:sessionID/interrupt` | — |
| `session.permission.list` | yes | `v2.session.permission.list` | `GET /api/session/:sessionID/permission` | — |
| `session.permission.reply` | yes | `v2.session.permission.reply` | `POST /api/session/:sessionID/permission/:requestID/reply` | `requestID`, `reply`, `message?` |
| `session.guardrail.status` | yes | `v2.session.guardrail.status` | `GET /api/session/:sessionID/guardrail` | — |
| `session.guardrail.request.list` | yes | `v2.session.guardrail.request.list` | `GET /api/session/:sessionID/guardrail/request` | — |
| `session.guardrail.reply` | yes | `v2.session.guardrail.request.reply` | `POST /api/session/:sessionID/guardrail/request/:requestID/reply` | `requestID`, `reply` |
| `session.form.list` | yes | `v2.session.form.list` | `GET /api/session/:sessionID/form` | — |
| `session.form.reply` | yes | `v2.session.form.reply` | `POST /api/session/:sessionID/form/:formID/reply` | `formID`, `answer` |
| `session.form.cancel` | yes | `v2.session.form.cancel` | `POST /api/session/:sessionID/form/:formID/cancel` | `formID` |
| `session.fileChange.list` | yes | `v2.session.file-change.list` | `GET /api/session/:sessionID/file-change` | — |
| `session.autonomy.get` | yes | `v2.session.autonomy.get` | `GET /api/session/:sessionID/autonomy` | — |
| `session.autonomy.set` | yes | `v2.session.autonomy.set` | `PUT /api/session/:sessionID/autonomy` | `yolo`, `maxNoProgress?` |
| `session.goal.set` | yes | `v2.session.autonomy.set` | `PUT /api/session/:sessionID/autonomy` | `goal` (non-empty string), `maxNoProgress?` |
| `session.goal.stop` | yes | `v2.session.autonomy.set` | `PUT /api/session/:sessionID/autonomy` | `goal: null` |

Response `value` is the local route's HTTP JSON body **verbatim**: no reshaping, no
field renaming, and no second schema. A `204 NoContent` response becomes
`{"ok":true,"value":null}`. A local error response becomes
`{"ok":false,"error":{"code":...,"message":...}}` with a stable contract code.
Required reconnect reads — `session.snapshot` (the Protocol `SessionProjection`
value), `session.active` (running state for the initial view and after
reconnect), `session.permission.list`, `session.guardrail.status`,
`session.guardrail.request.list`, `session.form.list`,
`session.fileChange.list`, and `session.autonomy.get` — exist so the browser can
rebuild running state, pending approvals, and autonomy state after a reconnect
instead of relying on ephemeral events.

`session.list` pages every Session in the connected backend, and `session.active`
reports running state for that same inventory. The authenticated enrolled-device
owner is the authorization boundary. The wire name for captured file changes is
`session.fileChange.list`; the Protocol endpoint identifier is
`v2.session.file-change.list` (`GET /api/session/:sessionID/file-change`).

`session.permission.reply` and `session.guardrail.reply` map a `requestID` path
parameter. `session.form.reply` and `session.form.cancel` map a `formID` path
parameter. The corresponding identifier is therefore explicit in each mutation's
`input`.

### 3.5 Idempotency and indeterminate outcomes

Only `session.prompt` accepts a durable idempotency key: `input.id` is the
`SessionMessage.ID`, and the local server reconciles an exact retry only when the
session, prompt, and delivery mode match (`v2.session.prompt` documents this). A
client retrying an indeterminate `session.prompt` must reuse the same `input.id`.

The reply operations carry **no** idempotency key: `PermissionV2.Reply` and
`Guardrail.Reply` are `"once" | "always" | "reject"`, and `QuestionV2.Reply` is
`{ answers }`. A retried reply is therefore a new decision, not a reconciliation.
Clients must never automatically replay any request that failed with
`outcome_unknown` (`session.prompt`, `session.interrupt`, and every reply
included); they surface the outcome as unknown and let the user decide.

### 3.6 Session discovery and authorization

The authenticated owner of an enrolled device may access all existing and future
Sessions in that device's backend. The agent resolves every scoped Session ID by
paging the backend's global list without a page-count cap, derives the current
Location from that record, and verifies the Session there before executing the
operation. Deleted and unknown IDs fail with `session_not_allowed`; moved Sessions
use their new backend-derived Location. No remote field selects a folder or URL.

The agent sends `{ "type": "sessions" }` after connect and on Session creation,
movement, or deletion. The relay broadcasts that small frame without persisting an
inventory or treating it as authorization. A connected client pages `session.list`
using the existing cursor until exhausted and fences publication by connection and
list generation.

### 3.7 Bounds and close codes

| Bound | Value |
| --- | --- |
| Client frame | 32,768 chars (`message_too_large`) |
| Agent frame | 262,144 chars (`message_too_large`) |
| Chunks per response | 64 |
| In-flight requests per client | 32 |
| Client request rate | 30 per 10 s → close `1008` |
| Agent message rate | 500 per 10 s → close `1008` |
| Session-list page | 200 |
| Subscriptions per client | 64 |
| Heartbeats | `{"type":"ping"}` is answered with `{"type":"pong"}` without waking the object |

| Close code | Meaning |
| --- | --- |
| `1000` | normal |
| `1003` | frame kind invalid for this connection's role or unparseable |
| `1008` | rate limit, chunk policy violation, or repeated policy violation |
| `1009` | frame exceeds the size bound |
| `1012` | replaced by a newer agent connection |
| `4401` | credential expired, revoked, or invalid on an active path |
| `4403` | authenticated but not permitted (wrong owner, revoked device, role mismatch) |

### 3.8 Error codes

`invalid_message`, `message_too_large`, `unknown_operation`, `session_required`,
`session_not_allowed`, `not_subscribed`, `rate_limited`, `agent_unavailable`,
`outcome_unknown`, `forbidden`, `unauthorized`, `internal_error`.

`agent_unavailable` means no agent is connected; nothing was sent.
`outcome_unknown` means the request was already in flight when the agent
disconnected; the command may or may not have executed.

## 4. Storage

D1 stores authentication and device metadata only: `user`, `identity`,
`browser_session`, `oauth_transaction`, `device`, `enrollment`, `device_challenge`,
`device_credential`. Migration: `infra/cloudflare/migrations/0001_auth.sql`.

D1 never stores transcripts, message projections, streaming deltas, tool output,
session contents, or file contents. Session data stays on the user's machine and
crosses the relay only as live WebSocket frames.

Device private keys never leave the device. Stored as SHA-256 hashes: browser
session IDs (`yc_session` cookie tokens), enrollment codes, and device credential
IDs (access and refresh tokens). Stored in plaintext in this database because the
protocol needs them: the OAuth transaction's `nonce` and PKCE `code_verifier`
(10-minute lifetime) and the device challenge `nonce` (2-minute lifetime). Neither
is ever returned to a browser or logged; both live in single-use rows that are
consumed once and expire.

Retention: expired or consumed `oauth_transaction`, `device_challenge`, and
`enrollment` rows, and expired `browser_session` and `device_credential` rows, are
deleted `7` days after expiry (enough to answer a recent-activity question) by a
bounded sweep: at most `500` rows per table, run at most once per hour per isolate
on request handling and hourly by the Worker's `scheduled` cron trigger. Both
triggers call the same sweep. `CLEANUP_INTERVAL_MS` optionally overrides the
request-path cadence; values outside `10000`–`86400000` ms fall back to the
one-hour default. Revoked
rows follow the same expiry-based retention; a revoked credential is still refused
immediately through its `revoked_at` marker long before deletion.

## 5. Configuration

Configuration:
- `GOOGLE_CLIENT_ID` — non-secret OAuth client ID.
- `GOOGLE_CLIENT_SECRET` — secret (`wrangler secret put`), never committed.
- `GOOGLE_ALLOWED_EMAILS` — secret, server-only sign-in allowlist: comma,
  whitespace, or newline separated Google addresses (`wrangler secret put
  GOOGLE_ALLOWED_EMAILS`). Missing or empty denies every sign-in, so a deployment
  that forgets it accepts nobody. Never add real addresses to this repository.
- Optional overrides used by local integration tests only: `GOOGLE_ISSUER`,
  `GOOGLE_AUTHORIZATION_ENDPOINT`, `GOOGLE_TOKEN_ENDPOINT`, `GOOGLE_JWKS_URI`.
- Cron trigger `17 * * * *` runs the retention sweep.
- Static assets use the `ASSETS` binding and the routing rules in section 1.
  Regenerate worker types after any change to that block. The web build output
  must exist before bundling, because the asset directory is read at build time.

## 6. Composed verification

`infra/cloudflare/test/integration/real-flow.ts` composes real components: an
isolated YCoding server process, the local agent bridge with its production
WebSocket transport, the credential module's own file-backed credential
orchestrator (reached through a package-anchored require), key generation,
signing, and enrollment, the remote client's store, transport, and http modules,
and this relay under the local Wrangler dev server with real D1, the real Durable
Object, the built assets, and a local Google OIDC stand-in. It asserts enrolled
device connection, complete backend Session discovery, backend-derived Location,
one admitted row per prompt message id with
exact-retry reconciliation, one real SessionRunner step executed against a local
provider stand-in with its streamed text reaching the client and its final
assistant content persisted canonically, a streamed durable session event,
reconnect reads with no mutation or execution replay, a real pending permission
request answered remotely with reject and then approve (each verified by whether
the shell command actually ran, with unauthorized replies refused and the request
left pending), ordinary and hard guardrail reviews raised by custom rules and
answered remotely, interrupt stopping a running step, and logout closing the client socket.

Verification limits, stated so they are not mistaken for covered behaviour:

- The model boundary is a stand-in: an OpenAI-compatible SSE endpoint on localhost
  with scripted text and tool calls. Provider identity, quotas, retries, rate
  limits, and vendor payload differences are not exercised.
- Approval coverage is the shell tool's ordinary permission request: a remote
  `reject` denies the tool and a remote `once` runs it, with an unknown request id
  shown to leave the request pending.
- Guardrail coverage uses custom configurable rules: an ordinary (`ask`) review
  resolved with `once`, and hard (`hard_review`) reviews where `once` runs the
  command and `reject` prohibits it. A hard review answered with `always` is
  accepted and consumed as a rejection (`infra/cloudflare/src` reports the
  decision, `packages/core` coerces the reply), the command never runs, and the
  same action afterwards raises a fresh review, so a hard review can never become
  a reusable approval. No guardrail review is auto-answered anywhere in the
  harness. The standard catastrophic `deny` ruleset, guardrail counters, and
  non-shell guardrail actions are not exercised.
- The credential orchestrator runs its challenge branch and persists the returned
  refresh token; the refresh-rotation branch is not exercised because the access
  credential never nears expiry within a run.
- No browser rendering participates: the client store and transport are driven
  in-process with injected cookie and origin headers.
- Durable-evidence limits: the harness asserts canonical reads through the relay
  and the local adapter, not D1 row contents other than the one-use enrollment,
  challenge, rotation, and retention checks in the companion suite.

## 7. Non-goals for this contract

- No second execution runtime: the relay routes frames and never runs sessions,
  models, tools, or permissions logic.
- No arbitrary proxy: the operation allowlist is closed, and the relay does not
  accept a URL, path, or method from a client.
- No transcript, event, or delta persistence anywhere in D1.
- No browser credentials on `/ws/v3/agent` and no device credentials on `/ws/v3/client`.
