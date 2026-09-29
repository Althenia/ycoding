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
| `POST` | `/api/auth/invite` | one-use invite token | same-origin required | Redeem once; return one access key and set the browser session cookie |
| `POST` | `/api/auth/key` | access key | same-origin required | Sign the invited owner in with a 30-day browser session cookie |
| `POST` | `/api/admin/invites` | admin bearer | not required | Create an invite and return its fragment-only URL once |
| `GET` | `/api/admin/invites` | admin bearer | not required | List invite metadata without secrets |
| `DELETE` | `/api/admin/invites/:id` | admin bearer | not required | Close devices and delete the invite and its account |
| `POST` | `/api/auth/session/refresh` | browser session | same-origin required | Rotate the browser session cookie once past half life |
| `POST` | `/api/auth/logout` | browser session | same-origin required | Revoke the browser session and close its relay sockets |
| `GET` | `/api/me` | browser session | not required | Owner, session expiry, and device list (read-only, no `Set-Cookie`) |
| `GET` | `/api/devices` | browser session | not required | `{ devices: RemoteDeviceInfo[] }` (pinned `DevicesResponse`) |
| `GET` | `/api/push/key` | browser session | not required | `{ publicKey }`; `503` if VAPID is unavailable |
| `POST` | `/api/push/subscriptions` | browser session | same-origin required | Upsert `{ endpoint, keys: { p256dh, auth } }` for this account |
| `DELETE` | `/api/push/subscriptions` | browser session | same-origin required | Remove `{ endpoint }` for this account |
| `POST` | `/api/devices/enrollments` | browser session | same-origin required | Mint a one-use enrollment code |
| `POST` | `/api/devices/enroll` | enrollment code | none (native agent) | Register a device public key |
| `POST` | `/api/devices/challenge` | none (rate limited) | none (native agent) | Mint a one-use device challenge |
| `POST` | `/api/devices/token` | challenge signature | none (native agent) | Issue access + refresh credentials |
| `POST` | `/api/devices/refresh` | refresh credential | none (native agent) | Rotate credentials |
| `POST` | `/api/devices/:deviceID/revoke` | browser session | same-origin required | Revoke a device, its credentials, and its live sockets |
| `DELETE` | `/api/devices/:deviceID` | browser session | same-origin required | Remove one revoked device record of this account; `409` for an active device |
| `DELETE` | `/api/devices/revoked` | browser session | same-origin required | Remove every revoked device record of this account |
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
  `POST /api/auth/invite`, `POST /api/auth/key`,
  `POST /api/devices/:deviceID/revoke`, `DELETE /api/devices/:deviceID`,
  `DELETE /api/devices/revoked`) require a present, exactly matching
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
URL sent to the server. A one-use invite token is carried only in the fragment
of `/remote/invite#<token>`; the page removes the fragment from browser history
before redemption. Fragments are never transmitted in HTTP requests or Referer.
The agent token travels in `Authorization: Bearer`, the browser credential in
a cookie, and the `?device=` query carries an opaque device identifier that is
always re-checked for ownership.

### 2.1a Invite and access-key sign-in

An operator whose `ADMIN_API_KEY` has at least 32 characters authenticates to
`/api/admin/*` with a timing-safely checked bearer value. Missing configuration
returns `404`; missing or wrong credentials return `401`, and failed attempts are
rate-limited per client address. Admin routes use no cookies or CORS. Creation
accepts an optional trimmed 1–64-character label and returns `{ id, url, label,
createdAt }` once. Listing returns newest-first `{ invites: [{ id, label,
createdAt, redeemedAt }] }` without secrets; pending `redeemedAt` is `null`.

The invite token is 32 random bytes encoded as base64url. The recipient opens
`/remote/invite#<token>` and presses **Accept invite** to redeem; loading the
page never redeems. The Worker atomically creates a separate owner, consumes the
token, stores a hash of the 20-byte access key, and creates a 30-day browser
session. It returns the grouped access key exactly once; unknown, used, or
deleted invites return a generic `404`. The owner can sign in from another
device with the 32-character Crockford base32 key, formatted as eight groups of
four. Input is uppercased, whitespace and hyphens are removed, and `O` maps to
`0` while `I` and `L` map to `1`; malformed or deleted keys return `401`.
Both browser routes require same-origin requests, are rate-limited per client
address, and revoke a presented prior browser session before setting the new
cookie. Every response uses `Cache-Control: no-store`. Only SHA-256 hashes of
invite tokens, access keys, and browser session tokens are stored.

Deleting an invite closes every client and agent socket on its owner's devices,
then atomically removes the invite and user. User deletion cascades to browser
sessions, identity, devices, device credentials, enrollments, and push
subscriptions; associated OAuth transactions are removed as well. Access is
invalid everywhere afterward. Another invite creates a new independent owner.

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
6. `DELETE /api/devices/:deviceID` (browser owner only) removes that revoked
   device record in one batch with its credentials, challenges, and linked
   enrollment records, and answers `204`. The caller's own active device answers
   `409` (revoke it first); an unknown, foreign, or already removed device answers
   `204` without a change. `DELETE /api/devices/revoked` removes every revoked
   device record of the owner the same way.

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
| `status` | agent → relay → clients | `{ type:"status", running:[rootSessionID,...], attention:[rootSessionID,...], outstanding?:[rootSessionID,...] }` |
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
  rereading the Session groups and the selected group's first `session.list` page.
  The agent sends it for membership and list-metadata changes, not for activity
  that only advances a Session's updated time.
- `status` reports running root families, roots needing human attention, and
  optional `outstanding` roots with non-executing work. An absent `outstanding`
  means none. It includes admitted inputs, background shell notices, active
  subagent tasks or undelivered parent notices, and active goals, excluding roots
  already in `running`. Attention includes pending human requests and the latest
  failed execution in a family until any member starts another execution.
  Each list contains unique Session IDs and at
  most 500 entries. The agent sends it on connection and coalesces changed
  execution/request/work state to at most one later frame per 250 ms. The relay
  validates and broadcasts it unchanged to each device client; a new client
  receives the latest frame from the live agent. Execution-only changes read
  process activity and one aggregate outstanding-work read without rescanning
  pending requests; request transitions and inventory changes refresh the
  pending-request set before publishing. The connector reads persisted failed
  state on connect and updates it from execution start/failure events afterward.

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
- The agent serializes all outbound frames at least 25 ms apart, leaving room
  under the relay's 500-message-per-10-second window for heartbeats and control
  traffic. A burst of up to 4,096 live events waits in the agent's bounded
  authorization queue; if that bound is exceeded, the agent reconnects for
  client snapshot and history reconciliation. Status changes are sent separately
  from that event queue and a failed status send remains eligible for the next read.
- In-flight requests per client are capped; a client disconnect drops its pending
  requests, and the client must treat those outcomes as unknown.

Web Push subscribes only through cookie-authenticated, same-origin HTTP writes.
Endpoints must use HTTPS on `fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `web.push.apple.com`, a subdomain of
`push.apple.com`, or a subdomain of `notify.windows.com`; URL credentials,
nonstandard ports, and fragments are rejected. `p256dh` is an uncompressed
65-byte P-256 public point and `auth` is 16 bytes, both unpadded base64url.
An account retains at most ten subscriptions; a new one evicts the oldest.
The relay stores only endpoint, browser encryption keys, account owner,
created time, and consecutive failures. It deletes a 404/410 endpoint or one
that reaches five other failed deliveries.

The first `status` frame after agent connect or Durable Object restore is a
silent push baseline. Later newly attentive roots emit `approval-requested`;
roots leaving the union of `running` and `outstanding` emit `agent-completed`
only if they are not attentive. Attention wins over completion. The web bell
applies the same transition rule. The push plaintext has
only `{ category, sessionID, deviceID }`, encrypted using RFC 8291
`aes128gcm` and authenticated using RFC 8292 ES256 VAPID. The JWT audience is
the endpoint origin and expires within twelve hours. Approval uses TTL 3600
and high urgency; stopped-work uses TTL 600 and normal urgency. A Topic of at
most 32 base64url characters derived from Session ID and category collapses
repeats. The relay drops pushes beyond twenty events per device per minute and
never waits for delivery before forwarding status frames.

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

Large `session.messages` results are chunked through the relay. `session.log`
(`v2.session.log`) remains the incremental read via `after`.
`session.snapshot` reads the full projection when no window is requested, or
returns newest-first pages requested with `limit` (1–200) and an opaque `before`
cursor (at most 256 characters) in ascending message order. Each page includes
Session metadata, `sourceEpoch`, and a watermark read atomically with its
messages. The agent retries a window at smaller limits until its encoded
response fits 64 chunks; one message that cannot fit returns
`message_too_large`.

### 3.4 Operations (closed operation set)

The relay rejects anything outside this list with `unknown_operation`. The agent
validates the listed `input` fields and maps them onto local operations; workspace
grouping and Session-list filters are derived from backend metadata.

| Remote operation | Session-scoped | Local Protocol identifier | Local route | `input` fields |
| --- | --- | --- | --- | --- |
| `workspace.list` | no | `v2.session.list`, `v2.project.list`, `v2.project.directories` | `GET /api/session`, `GET /api/project`, `GET /api/project/:projectID/directories` | `sessionsOnly?` |
| `workspace.catalog` | no | Location-scoped catalog reads | `GET /api/agent`, `/api/model`, `/api/model/default`, `/api/provider`, `/api/command`, `/api/skill`, `/api/reference`, `/api/mcp/resource` | `workspace` |
| `workspace.file.find` | no | `v2.fs.find` | `GET /api/fs/find` | `workspace`, `query`, `limit?` |
| `session.list` | no | `v2.session.list`, `v2.session.active` | `GET /api/session`, `GET /api/session/active` | `limit?`, `order?`, `search?`, `searchFields?`, `workspace?`, `status?`, `parentID?`, `cursor?` |
| `session.active` | no | `v2.session.active` | `GET /api/session/active` | — |
| `usage.providers` | no | `v2.providerUsage.list` | `GET /api/provider/usage` | `refresh?` boolean |
| `usage.summary` | no | `v2.usage.get` | `GET /api/usage` | — |
| `usage.report` | no | `v2.usage.report` | `GET /api/usage/report` | `group`, `timeZone?`, `from?`, `to?`, `offset?`, `limit?`, `sort?`, `order?` |
| `session.status` | no | `v2.session.active`, `v2.session.outstanding`, pending Session permission/form/guardrail reads | Local active, outstanding-work, and pending-request GET routes | — |
| `session.get` | yes | `v2.session.get` | `GET /api/session/:sessionID` | — |
| `session.messages` | yes | `v2.message.list` | `GET /api/session/:sessionID/message` | — |
| `session.capturedChanges.list` | yes | `v2.message.list`, `v2.session.subagent.list`, `v2.session.file-change.list` | Verified root and completed direct-child reads at their backend Locations | `cursor?` (opaque, at most 256 chars) |
| `session.compaction.list` | yes | `v2.message.list` | `GET /api/session/:sessionID/message` at the verified Session Location | — |
| `session.snapshot` | yes | `v2.session.snapshot` | `GET /api/session/:sessionID/snapshot` | `limit?` (1–200), `before?` (requires limit; at most 256 chars) |
| `session.attachment.read` | yes | `v2.session.attachment.read` | `GET /api/session/:sessionID/attachment/:digest` | `digest` (64 lowercase hex) |
| `session.message.stream` | yes | `v2.session.message` | `GET /api/session/:sessionID/message/:messageID` | `messageID` (HTTP stream relay-internal request) |
| `session.todo.list` | yes | `v2.session.todo.list` | `GET /api/session/:sessionID/todo` | — |
| `session.catalog` | yes | Location-scoped catalog reads | Same routes as `workspace.catalog` at the verified Session Location | — |
| `session.file.find` | yes | `v2.fs.find` | `GET /api/fs/find` at the verified Session Location | `query`, `limit?` |
| `session.subagent.list` | yes | `v2.session.subagent.list` | `GET /api/session/:parentID/subagent` | `cursor?` |
| `session.subagent.cancel` | yes | `v2.session.subagent.cancel` | `POST /api/session/:parentID/subagent/:childID/cancel` | `childID` |
| `session.subagent.answer` | yes | `v2.session.subagent.answer` | `POST /api/session/:parentID/subagent/:childID/question/:questionID/answer` | `childID`, `questionID`, `text` |
| `session.team.economics` | yes | `v2.session.get`, `v2.session.diagnostics` | Bounded child reads at each recorded Location | `sessionIDs` (1–15 unique direct managed children) |
| `session.team.shell.list` | yes | `v2.shell.list` | `GET /api/shell` at up to 16 verified family Locations | — |
| `session.team.shell.kill` | yes | `v2.shell.get`, `v2.shell.remove` | `GET`, `DELETE /api/shell/:id` at the verified owner Location | `shellID` |
| `session.side-chat.list` | yes | `v2.session.list` | `GET /api/session?parentID=:rootID` | `cursor?` |
| `session.side-chat.create` | yes | `v2.session.create`, `v2.session.snapshot`, `v2.session.synthetic` | `POST /api/session`, `GET /api/session/:rootID/snapshot`, `POST /api/session/:id/synthetic` | `id` |
| `session.family.activity` | yes | `v2.session.active`, `v2.session.snapshot` | `GET /api/session/active`, bounded `GET /api/session/:sessionID/snapshot` for executing members only | `sessionIDs` (zero to 15 unique direct child IDs) |
| `session.log` | yes | `v2.session.log` | `GET /api/experimental/session/:sessionID/log` | `after?` |
| `session.subscribe` | yes | `v2.event.subscribe` | `GET /api/event` (SSE) | — |
| `session.unsubscribe` | yes | — (tears down the agent's `v2.event.subscribe` stream for that session) | — | — |
| `session.prompt` | yes | `v2.session.prompt` | `POST /api/session/:sessionID/prompt` | `id?`, `text`, `files?`, `agents?`, `delivery?`, `resume?` |
| `session.attachment.upload` | yes | local agent upload buffer | none | `uploadID`, `index`, `last`, `data` |
| `session.command` | yes | `v2.session.command` | `POST /api/session/:sessionID/command` | `id?`, `command`, `arguments?`, `files?`, `agents?`, `delivery?` |
| `session.skill` | yes | `v2.session.skill` | `POST /api/session/:sessionID/skill` | `id?`, `skill`, `resume?` |
| `session.switchModel` | yes | `v2.session.switchModel` | `POST /api/session/:sessionID/model` | `model` |
| `session.switchAgent` | yes | `v2.session.switchAgent` | `POST /api/session/:sessionID/agent` | `agent` |
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
| `session.create` | no | `v2.session.create`, `v2.project.current` | `POST /api/session`, `GET /api/project/current` | `id`, `workspace`, `agent?`, `model?` |

`session.compaction.list` returns `{ data, truncated, completedBefore, completedCount, totalSavedTokens }`. `data` contains the latest 100 job-backed compaction messages in chronological order, each with `jobID`, `trigger`, `status`, `created` (milliseconds), and completed `metrics` or failure `code` where applicable. `truncated` marks omitted older jobs; `completedBefore` counts completed jobs omitted from `data`. `completedCount` and `totalSavedTokens` cover all completed jobs, including omitted ones; savings is the sum of `inputTokens - retainedTokens`. The connector verifies the Session against its recorded Location, excludes message content and error text, and accepts no caller-selected path, cursor, or Location.

`workspace.list` returns `{ data: RemoteWorkspaceInfo[] }`, where each item is
`{ id, projectID, directory, workspaceID?, name? }`. Without `sessionsOnly: true`,
the backend builds the creation inventory from existing Session Locations,
persisted ProjectDirectories, and non-global Project worktrees, then omits
directories that are unavailable. With `sessionsOnly: true`, it returns groups
from recorded Session Locations in the connector's inventory when their
directories exist. Both reads exclude the global project and directories inside
system temporary locations after realpath resolution: `os.tmpdir()`, `/tmp`,
`/private/tmp`, `/var/tmp`, and the per-user `var/folders/.../T` directories.
Every item has the project name when reported or the directory basename.
A Session group is not permission to create a Session in an unavailable directory.
`id` is a deterministic, domain-separated SHA-256 identifier over the exact
project ID, directory, and optional Location workspace ID tuple; clients treat
it as opaque and backend-specific. The global Project's worktree is never a
workspace choice; non-Git directories come from recorded directories and Sessions.

`session.list` applies filters before cursor pagination. `workspace` selects the
opaque ID of one backend-derived Session group; it never supplies an execution
Location. `search` matches titles by default; `searchFields: "summary"` also
matches agent and `provider/model#variant` labels. `status: "running" | "idle"`
uses current backend activity: a root Session is running while any Session in
its family runs, and a child Session by its own activity; archived Sessions are
not idle. Omitted status
includes all states. `order` accepts `"asc"`, `"desc"` (default), `"pinned"`, or `"active"`.
Session list/get data carries the optional `time.active` of the latest terminal Step or execution event. The connector forwards the event's `created` millisecond time to the browser for live activity display; list ordering and cursors continue to use `time.updated`.
Pinned order lists pins by ascending pin time, then unpinned Sessions by descending
update time and ID. Its opaque cursors include the pin sort key and support both
directions. Active order places running root families first, then pins by
descending pin time, then Sessions by descending update time and ID. Its cursors
carry the running, pin, update, and ID sort keys in both directions; running
membership is evaluated on each request. `limit` defaults to 50 and is capped
at 200. Search, group, status,
and order changes start a new cursor traversal.

`session.subagent.list` reads one existing Protocol task page (at most 10 direct
children) for the verified parent Session at its backend Location. The optional
opaque `cursor` continues that parent's page; no browser-selected Location,
larger limit, mutation, or child subscription is accepted. The response keeps
the Protocol `{ data, summary, cursor }` shape and is chunked if needed. An
agent without this operation replies `unknown_operation`, which is an
unsupported team read rather than an empty team.

`session.capturedChanges.list` is a read-only Session-scoped captured-diff summary. The connector reads the addressed Session's resident post-compaction transcript and, for a root, all completed direct-child transcripts after verifying each child's current backend Location and direct ownership. It returns `mode: "transcript"` with the last completed assistant message ID and first-seen per-path groups of completed `edit`/`patch` diffs; if no assistant has completed after compaction, `mode: "recovery"` uses the durable ledger's latest parseable patches and the completed compaction message ID. Otherwise `mode: "none"` returns no files. Counts describe the displayed patches, including every grouped diff. Each response carries at most 100 file groups with at most 512,000 serialized characters of group data before transport framing; an opaque Session-bound digest cursor continues the same summary, and a changed summary rejects that cursor. A file group too large for one page is labeled `unavailable`, with no patch or counted lines, rather than cut silently. The caller cannot supply a child ID, directory, workspace, or arbitrary limit. An older connector answers `unknown_operation`; the browser omits the card without an error.

Team operations address a verified root Session; the connector verifies each
child at its recorded Location immediately before a child operation. Cancel and
answer require a direct managed child (not a BTW side chat) and return its
durable task. Answer accepts a pending question ID and nonempty text of at most
8,192 characters. An unrelated or moved child is never controlled through a
browser-selected Location. `session.team.economics` accepts 1–15 distinct direct
managed child IDs, verifies the entire batch before any diagnostic read, and
returns reported cost, token counts, context usage and cache read/write/hit
fields. Unreported cache fields stay absent.

`session.team.shell.list` reads running shells from at most 16 distinct verified
root-family Locations, returns at most 50 rows with `{ id, ownerID, command,
status, startedAt, completedAt? }`, and reports truncation. Only shells whose
metadata identifies a current root or direct child at that shell's Location are
visible. Kill locates the shell under those family Locations and re-verifies its
metadata owner before removal; missing or unrelated ownership cannot authorize
output or removal. Output paging uses `session.shell.output` addressed to the
verified shell owner. No shell Location comes from the browser.

`session.side-chat.list` pages direct child Sessions at 50 per local page and
returns BTW rows only, retaining the backend cursor. `session.side-chat.create`
uses the caller's Session ID to adopt an exact retry under the root with agent
`btw`, then admits one deterministic-ID synthetic parent-history snapshot with
`resume: false`. The browser sends a separate prompt to that child. A partially
settled create is reported as unknown; it is not retried automatically.

`session.family.activity` addresses the verified root Session, and `sessionIDs`
names at most 15 direct children in the current backend inventory. The local
agent rejects unrelated IDs, reads process-local execution ownership once, and
returns `{ data: [{ sessionID, executing, activity? }] }` in requested order,
root first. `executing` is per Session, not the family's running indicator.
Only executing members have a bounded eight-message snapshot read at their own
recorded Location. Their optional `activity` has `kind` (`tool`, `thinking`, or
`replying`), `room` (`research`, `qa`, `meeting`, `developer`, or `hold`), and a
sanitized, at-most-80-character `text` summary. Raw input, transcript, tool
output, paths outside the basename, and reasoning text are not forwarded.
Idle members have no activity and require no Location message read. A connector
without this operation yields `unknown_operation`; the browser reports activity
as unsupported, never as inferred work.

Managed child Sessions (`parentID` set, agent other than `btw`) reject
`session.prompt`, `session.command`, `session.skill`, attachment upload, model and
agent switches, autonomy changes, and goal changes with `subagent_read_only`.
BTW child Sessions remain promptable. Reads, interruption, permission/form/
guardrail replies, and the owner's root Session are unaffected.

`session.create` accepts `{ id, workspace, agent?, model? }`. `id` is a client-generated
Session ID; `workspace` must match an ID in a freshly rederived backend inventory.
Before creation, the backend checks that the directory exists and that
`project.current` reports the inventory's project ID. A mismatch or unavailable
workspace is rejected with `invalid_message` and refresh/reopen guidance. The
Location is derived only from the matched backend inventory; no browser path,
parent, title, URL, method, or header is accepted. `agent` is an explicit choice;
omitting it uses the runtime configured default. `model` is a validated
`{ providerID, id, variant? }` reference; omitting it uses the runtime default.
Creation does not prompt or wake a model. A retry adopts an existing
root Session only when its project and exact Location match; mismatched placement
is rejected with `invalid_message`. The returned and re-read Session must match
the requested ID, project, Location, and root status before success is returned.

Catalog reads use only Location-scoped local reads and fail rather than return
partial data when a source fails. Output lists are capped at 100 agents, 500
models, 200 commands, 200 skills, 200 references, and 200 MCP resources;
source providers and each model's variant list are capped at 500 and 50;
oversized lists fail with `message_too_large`. Models belong to connected,
enabled providers. The Catalog includes agent ID/name/mode/hidden/description/
model, model provider ID/name/model ID/name/variant IDs, an available default
model reference, command name/description, skill ID/name/description/slash,
reference name/file URI/description, and resource name/URI/description. It
contains no credentials, provider headers, or raw provider payloads. The local
API does not expose a configured default agent or model default variant, so
neither field appears.

The three global usage reads expose the local Protocol responses without raw
provider credentials or account data. `usage.providers` uses the backend's
default Location and accepts only an optional boolean `refresh`; its response
is `{ data: ProviderUsage.Snapshot[] }` with the Location wrapper removed and
each normalized snapshot unchanged. `usage.summary`
returns `{ data: ProviderRequest.Summary }`. `usage.report` accepts the
`ProviderRequest.ReportInput` groups `model`, `hour`, `day`, `month`, `session`,
`project`, or `agent`, optional nonnegative UTC epoch-millisecond `from`/`to` with `from < to`,
optional validated IANA `timeZone` for local hour/day/month buckets (omission groups in UTC),
nonnegative `offset`, `limit` 1–200, and the Protocol sort/order values. It
returns `{ data: ProviderRequest.Report }`; no browser-selected Location is
accepted.

File search accepts a nonempty query of at most 200 characters and a limit 1–50
(default 20). It returns `{ files: [{ path, uri, kind }] }` with Location-relative
forward-slash paths, file URLs, and file/directory kinds. Prompt and command
attachments use `{ uri, name?, description?, mention? }` when a file URL
resolves inside the Session Location after realpath, exactly matches a current
reference/resource Catalog URI, or names a completed upload for that Session.
The browser sends a local file in ordered `session.attachment.upload` requests:
`uploadID` is a random UUIDv4, `index` starts at zero, `last` marks the final
chunk, and `data` is canonical base64 of at most 28,000 characters. Each chunk
receives a response before the next is sent, respecting the client request-rate
window. The final response supplies `ycoding-upload://<uploadID>` for a prompt
or command `files[].uri`. The agent resolves only complete same-Session uploads
into canonical `data:application/octet-stream;base64,...` input for the local
Protocol; clients cannot submit a data URL directly or select a filesystem
Location. The agent retains at most 20 MiB decoded per file, 40 MiB decoded
and 64 upload IDs per connection; an upload expires 10 minutes after its latest chunk or use,
and every agent disconnect clears the buffer. Invalid, out-of-order, duplicate,
expired, oversized, or foreign-Session references fail before a local mutation.
`session.attachment.read` serves only a digest referenced by the verified
Session's managed user files, in a projected user message or in an admitted
prompt awaiting promotion, through the local attachment store. Its
response is `{ mime, bytes, data }` with base64 `data`; reads are capped at 10
MiB. An unreferenced, missing, damaged, or invalid stored file returns `not_found`
with a bounded local warning for store failures; a malformed digest
returns `invalid_message`, and an oversized file returns `message_too_large`.
Tool-result file URIs are not attachment-store references; inline `data:` image
content stays in the projected message.

For an oversized subscribed event, the agent sends
`{type:"event",sessionID,event:{type:"session.remote.oversized",id?,durable?,data:{sessionID,messageID?,truncated:true,omittedChars}}}`
instead of its payload, without closing the connection. This is a remote
invalidation, not a durable Session event; when the original event is durable,
its aggregate ID, sequence, and version are retained exactly so the browser can
advance its watermark without a false gap. `omittedChars` is the size of the
original serialized event frame; the event ID is retained when valid. The
optional message ID is taken from
the oversized event's message ID, assistant message ID, or input ID. A client
retrieves that indexed projected message with the same-origin, cookie-authenticated
`GET /api/remote/devices/:deviceID/sessions/:sessionID/messages/:messageID`.
The router verifies account/device ownership, then a per-device Durable Object
forwards one scoped `session.message.stream` read to the local agent. Bounded
WebSocket response chunks form the HTTP `application/json` body in a
`ReadableStream`; the browser makes one HTTP request, not one request per chunk.
The analogous `/attachments/:digest` route streams the bounded managed user-file
JSON result. A missing message or attachment returns HTTP 404, and an offline
agent returns 503. Cancelling the HTTP body detaches the relay request and
aborts the local read. An older connector that rejects the stream operation
returns HTTP 503 with `{error:{code:"unknown_operation"}}`; the browser offers
an update prompt, not an alternate read path. Without a message ID the browser
refreshes the Session window.
The relay Worker bundles the closed operation list; the deployed Worker must
include these operations before browser reads or uploads can reach the connector.
`session.command` returns `{ data: SessionPending.User }`;
successful `session.skill`, `session.switchModel`, and `session.switchAgent`
NoContent operations return `null`.

For operations mapped to one local route, response `value` is that route's HTTP
JSON body, except `session.compaction.list`, which projects the message list into
the bounded history above. `workspace.list` is the agent-derived inventory
described above. A `204 NoContent` response becomes
`{"ok":true,"value":null}`. A local error response becomes
`{"ok":false,"error":{"code":...,"message":...}}` with a stable contract code.
Required reconnect reads — `session.snapshot` (the Protocol `SessionProjection`
value), `session.active` (running state for the initial view and after
reconnect), `session.permission.list`, `session.guardrail.status`,
`session.guardrail.request.list`, `session.form.list`,
`session.fileChange.list`, `session.todo.list`, and `session.autonomy.get` — exist so the browser can
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

`session.create` uses its required Session ID to reconcile an exact retry at the
same root Location; another placement with that ID is rejected. Only
`session.prompt` accepts a durable prompt idempotency key: `input.id` is the
`SessionMessage.ID`. That ID belongs to one Session and input kind; its first
admission wins, including its text and delivery mode. A
client retrying an indeterminate `session.prompt` must reuse the same `input.id`.

The reply operations carry **no** idempotency key: permission and guardrail
replies use `"once" | "always" | "reject"`, and native Form replies carry typed
answer records. A retried reply is a new decision, not a reconciliation.
Clients must never automatically replay any request that failed with
`outcome_unknown` (`session.create`, `session.prompt`, `session.interrupt`, and
every Team mutation and reply included); they surface the outcome as unknown and let the user
decide.

### 3.6 Session discovery and authorization

The authenticated owner of an enrolled device may access all existing and future
Sessions in that device's backend. The agent resolves every scoped Session ID by
paging the backend's global list without a page-count cap, derives the current
Location from that record, and verifies the Session there before executing the
operation. Deleted and unknown IDs fail with `session_not_allowed`; moved Sessions
use their new backend-derived Location. No remote field selects a folder or URL.

The agent sends `{ "type": "sessions" }` after connect and when an inventory
refresh changes membership or Session metadata used for grouping, filtering, and
ordering. The relay broadcasts that small frame without persisting an inventory
or treating it as authorization. List and Session-group reads use the connector's
current inventory; they do not each trigger a full backend page sweep. Scoped
operations still verify the addressed Session at its authoritative Location.

The browser groups Sessions by workspace/repository in both the Sessions table and
the conversation sidebar. It requests 50 rows initially and fetches another cursor
page only on scroll demand. It retains at most three pages; scrolling back can
fetch an evicted page. Device, workspace, search, or filter changes invalidate the
old traversal. Connection and query-generation fences reject late results, and
only one page request is active for a traversal. Displayed counts describe loaded
rows, not an unreported backend total.

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
