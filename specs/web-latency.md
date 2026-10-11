# Machine-local Web latency

## Consent and local storage

Telemetry is stored only in the user's local SQLite database; YCoding does not export these samples or provider-request latency to an outside telemetry service. OTLP export configured through `OTEL_EXPORTER_OTLP_*` is a separate, unchanged opt-in.

One machine-global consent row governs ingestion and provider-request latency recording. An absent row is undecided and disabled. `Telemetry.CurrentNoticeVersion` is `1`, and `Telemetry.NoticeVersion` accepts only `1`. `Telemetry.Consent` contains `enabled`, `noticeVersion`, and non-negative epoch-millisecond `decidedAt`. `Telemetry.ConsentState` contains the server's current `noticeVersion` and optional `consent`; undecided consent is omitted, not encoded as null or undefined.

The local Server exposes authenticated `GET /api/server/telemetry/consent` (`telemetry.consent.get`) returning `ConsentState`, and authenticated `PUT /api/server/telemetry/consent` (`telemetry.consent.set`) accepting `{ enabled, noticeVersion }` and returning `Consent`. Unknown fields and notice versions other than the current version are rejected. These endpoints use the same local authorization as the existing telemetry endpoints and have no Session or Location input. Consent persists across server restarts. Disabling collection does not erase retained data.

`POST /api/server/web-latency` refuses an otherwise valid batch with HTTP 403 `{ "_tag": "TelemetryDisabled" }` while consent is disabled or undecided. Consent validation and insertion share the SQLite transaction, and refusal stores no samples.

## Client samples

`Telemetry.ClientSample` joins request and long-task samples in `Telemetry.Sample`: `{ kind: "client", at, surface, metric, durationMs }`. `surface` is `tui` or `web`, including the responsive mobile web client. `metric` is one of:

- `prompt.admit`: client send to durable admission acknowledged.
- `stream.delay`: server event timestamp to client receipt for a live Session event.
- `transcript.load`: request start to complete transcript rendered.

Client durations are integer milliseconds from 0 through 600,000. Timestamps use canonical UTC millisecond strings. Unknown fields are rejected; no message content or identity is accepted. Cross-machine clock skew can affect `stream.delay`; it is not an isolated network or provider duration.

## Ingestion and reads

The remote Web client records a tab-local ring of at most 60 timing samples. A request sample contains a canonical UTC timestamp, fixed operation name, outcome, local queue duration, optional send-attempt-to-settlement duration, and total duration. A browser long-task sample contains only timestamp and duration. Web client samples cover `prompt.admit`, `stream.delay` only for live events carrying a server timestamp, and `transcript.load` after a current snapshot is applied. The account HTTP read, relay-local notice operations, and telemetry consent/latency operations remain tab-local because they have no selected-machine attribution or would record telemetry writes themselves. Sampled request input, response data, paths, URLs, Session/device/account identifiers, raw errors, and long-task attribution never enter the report or ingestion body. `settlementMs` includes relay, network, local backend, and response assembly or time until an unknown outcome; it is not model or screen-paint latency.

The local Server exposes machine-global consent through `GET /api/server/telemetry/consent` and `PUT /api/server/telemetry/consent`. The closed relay operations `machine.telemetry.consent.get` and `machine.telemetry.consent.set` forward to those endpoints without a Session identifier; the write accepts exactly `{ enabled, noticeVersion: 1 }`. An undecided machine shows a non-blocking notice; Agree and Not now persist a decision. An older connector's unsupported operation hides the notice and is treated as disabled.

An authenticated browser uses the selected device's versioned relay socket to send `machine.latency.append` with `{ samples }` of 1–20 rows. The relay enforces ownership of that device and the closed operation/input shape, forwards the bounded frame to its authenticated local connector, and retains no sample. The connector validates the complete batch and calls the local Server's authenticated `POST /api/server/web-latency`; it never accepts a caller-selected URL, method, Session, Location, or device ID. The local `Telemetry.Batch` Schema rejects unknown fields and non-finite, negative, or over-600,000 ms durations. Long tasks require at least 50 ms. `account.read`, relay notices, and all consent/latency operations are not persisted as samples. A successful append returns `{ accepted }`; the SQLite write is atomic.

The browser sends automatically only while the selected machine has enabled consent, at most one batch each ten seconds. Off or undecided consent sends nothing. A 403 `TelemetryDisabled` append stops uploads and refreshes consent. An unconfirmed mutation is not replayed; unsent work can wait for the same machine's reconnect while consent remains enabled. The Diagnostics toggle is labeled **Save telemetry on this machine** and states that saving requires consent. The Settings status distinguishes a confirmed save, pending work, unknown settlement, failure, and unsupported machine. Clear empties the tab-local ring and drops queued unsent rows, but cannot revoke an in-flight or already saved batch; local SQLite rows remain until their retention boundary.

The machine-global SQLite sample store stamps `receivedAt` on admission, filters samples older than 30 days by that local clock from every read, and retains no more than 10,000 recent rows. It prunes expired rows at startup, on reads and accepted writes, and hourly while running; a stopped server cannot physically prune until its next start. Its authenticated `GET /api/server/web-latency` and relayed `machine.latency.list` return at most 200 rows per page, default 60, newest first, as `{ data: [{ receivedAt, sample }], cursor: { next? } }`. Reads remain available with consent disabled. The cursor is opaque and cannot select a Session or another machine. The browser reads the selected machine on explicit Settings action and can page older rows; a replaced connection's result is discarded. Browser and machine clocks are not treated as one clock. SQLite holds no account, device, Session, URL, or payload identifier in these rows. Consent and the durable provider-request usage ledger have separate lifetimes from this bounded sample store.
