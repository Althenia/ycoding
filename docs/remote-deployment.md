# Remote relay deployment and operations

Operator reference for the `ycoding-cloud` Worker in `infra/cloudflare`. It covers the deployment inputs, the logging surfaces and their privacy limits, and the backup, migration, and recovery procedures for the D1 metadata store.

The relay wire contract is specified in [`packages/remote/CONTRACT.md`](../packages/remote/CONTRACT.md); local CLI usage and relay configuration are in [`configuration.md`](./configuration.md#remote-access).

## Deployment inputs

`infra/cloudflare/wrangler.jsonc` is the committed deployment definition:

| Input          | Value                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Worker         | `ycoding-cloud`                                                                                                                        |
| Custom domain  | `ycoding.althenia.app`                                                                                                                 |
| Durable Object | `DEVICE_RELAY`, class `DeviceRelay`, SQLite storage, one instance per `userId:deviceId`                                                |
| D1 binding     | `DB` → database `ycoding-prod-db` (`database_id` `3384fc56-42d6-40a1-af04-5a75bd391132`)                                               |
| Static assets  | `ASSETS` from `apps/web/dist`, `not_found_handling: single-page-application`                                                           |
| Cron trigger   | `17 * * * *`, the bounded cleanup sweep                                                                                                |
| Secrets        | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAILS`, `ADMIN_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, set with `wrangler secret put` and never stored in the repository |

`apps/web/public/_headers` serves every content-hashed file under `/assets/` with `Cache-Control: public, max-age=31536000, immutable`. HTML pages, the service worker, the manifest, and other unhashed files keep Cloudflare's default `public, max-age=0, must-revalidate`, so a deployment takes effect on the next load; API and relay responses are `no-store`. `_headers` rules apply only to responses the asset layer serves directly; `/`, `/docs`, `/changelog`, and `/remote` pass through the Worker's `run_worker_first` routes, which return the asset layer's default caching headers with the Worker's security headers. A browser revalidates HTML with `If-None-Match` only while the response keeps its `ETag`; Cloudflare removes the `ETag` from HTML when a feature that rewrites HTML, such as Email Obfuscation or Automatic HTTPS Rewrites, is enabled on the zone.

`GOOGLE_ALLOWED_EMAILS` fails closed: a missing or empty value denies every Google sign-in, and the value is never returned to a client or logged.

Generate a separate operator key locally with `openssl rand -base64 48` and store it in `YCODING_ADMIN_API_KEY` outside the repository. Set `ADMIN_API_KEY` as a Worker secret; a missing value or one shorter than 32 characters makes every `/api/admin/*` route return `404`. Never place the key in a URL, source file, shell history, logs, or a public page. The admin API uses `Authorization: Bearer $YCODING_ADMIN_API_KEY` and never a browser cookie.

```sh
printf '%s' "$YCODING_ADMIN_API_KEY" | bunx wrangler secret put ADMIN_API_KEY --config infra/cloudflare/wrangler.jsonc
```

After applying `0003_invite.sql` through the procedure below, create an invite with a label, inspect its non-secret metadata, and delete it by ID when access must end. Creation returns a one-use URL with the secret only in its fragment; hand it directly to the recipient and do not retain the response. Deletion closes the account's device sockets and removes the account.

```sh
curl -fsS -X POST 'https://ycoding.althenia.app/api/admin/invites' -H "Authorization: Bearer $YCODING_ADMIN_API_KEY" -H 'Content-Type: application/json' -d '{"label":"Recipient"}'
curl -fsS 'https://ycoding.althenia.app/api/admin/invites' -H "Authorization: Bearer $YCODING_ADMIN_API_KEY"
curl -fsS -X DELETE 'https://ycoding.althenia.app/api/admin/invites/<invite-id>' -H "Authorization: Bearer $YCODING_ADMIN_API_KEY"
```

Web Push uses one VAPID key pair. Generate it locally with `bun infra/cloudflare/script/vapid-keys.ts`, keep the private value private, and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (an operator-owned `mailto:` or `https:` URI) as Worker secrets. While any of them is missing or invalid, `GET /api/push/key` answers `503`, browsers report push as unavailable, and the relay sends no pushes. Rotating the pair invalidates existing browser subscriptions until each browser subscribes again. Apply `0002_push.sql` and `0004_push_categories.sql` with the migration procedure below before deploying a Worker that stores subscriptions; the release workflow builds and deploys but does not apply D1 migrations. `0004_push_categories.sql` adds each subscription's System categories and last test-alert time; it keeps every existing row and enables all three categories on it until that browser next registers its own choices.

### Operator push test

`POST /api/admin/push/test` accepts exactly `{ "accountID": "<existing-account-id>", "endpoint": "<registered-push-endpoint>" }` with the admin Bearer credential. Browser cookies do not authorize it. The target must already be registered to that account; the request supplies no keys, payload, or category overrides and never broadcasts to other subscriptions.

Use the account ID returned as `user.id` by that user's authenticated `/api/me` response. Retrieve the exact endpoint from the browser's push subscription or an authorized private lookup of `push_subscription` filtered by `account_id`. A subscription identifies a browser installation, not an enrolled backend machine. Do not query or expose its encryption keys.

Keep the request body in a restricted file outside the repository, represented below as `target.json`. Disable shell tracing and keep the endpoint and admin credential out of command arguments, logs, and diagnostic artifacts.

```sh
printf 'header = "Authorization: Bearer %s"\n' "$YCODING_ADMIN_API_KEY" |
  curl --config - --silent --show-error --fail-with-body \
    --request POST 'https://ycoding.althenia.app/api/admin/push/test' \
    --header 'Content-Type: application/json' \
    --data-binary @target.json
```

HTTP `200` returns `{ "outcome": "accepted" | "rejected" | "expired" | "unreachable", "status"?: <push-service HTTP status> }`. `accepted` confirms push-service acceptance, not OS display. `expired` removes the expired stored subscription; `unreachable` omits the status. A subscription can be tested once per 60 seconds, including unsuccessful delivery attempts. Route errors are `400` for invalid input, `401` for missing or invalid Bearer authentication, `404` for a missing account/subscription pair or disabled admin configuration, `405` for the wrong method, `429` for a rate limit, and `503` for unavailable Web Push configuration. Responses are not cached.

Commands below run from the repository root and target the committed configuration with `--config infra/cloudflare/wrangler.jsonc`. Wrangler is pinned to 4.133.0; `bunx wrangler` resolves that local version.

### WebSocket v4 cutover

The relay accepts WebSockets only at `/ws/v4/client` and `/ws/v4/agent`. Missing-version, v1, v2, v3, and unknown-version relay paths return `404` before a WebSocket upgrade; there are no aliases or protocol fallbacks. The v4 operation set uses native Forms for remote human input. Enrollment records, device identities, and browser sign-in data remain valid, so this cutover requires no credential or data migration.

Perform a coordinated release in this order: stop existing `ycoding remote connect` processes; upgrade every installed connector to a build that uses `/ws/v4/agent` and ensure its managed local server runs that same release before reconnecting; deploy the Worker and web assets from the same release; refresh open browser tabs so they use `/ws/v4/client`; then restart each connector and reconnect the existing enrolled identity. If an update leaves an older local server running because Sessions are active, wait for them to finish before restarting the service; an intentional forced restart interrupts running work. The connector requires the local server's `lost` Session-status field and rejects an older backend's status read rather than broadcasting partial status. A v3 connector cannot connect after the Worker cutover, and a v3 browser tab must be refreshed. Existing device enrollment remains valid. Back up the local database before upgrading or rolling back the additive shell ledger; do not downgrade while shell rows still need reconciliation by the newer runtime.

### Notification protocol cutover

Deploy the Worker and web assets together. Save unsent drafts and reload every open remote tab and installed web app before using remote controls or notifications after the deployment. A new service worker does not replace JavaScript already running in a page. Notification ownership requires the current client and its `notice.present` frame; unsupported clients can reject that frame and reconnect until reloaded. There is no old-client compatibility path. Browser sign-in and enrolled device credentials remain valid.

The browser-owned push registration schema requires `0005_push_browser_owner.sql`. This migration recreates only `push_subscription`, resetting its registrations and requiring a verified browser-session owner for every new row. It does not change Sessions, authentication, device enrollment, browser category preferences, or unread notices in Durable Object storage.

After source validation, use the approved migration procedure below to record a recovery bookmark, verify that only the reviewed migration is unapplied, and apply it before the gated release deployment. The release workflow does not apply it. Push registration remains unavailable to the older Worker between migration and deployment; a delayed or failed deployment extends that pause. Other remote controls remain available. After deployment, each browser or installed web app must reopen. An existing subscription re-registers automatically when notification permission is granted; otherwise the user checks **Settings → Notifications → Push to this device** and restores it if needed. Background push resumes when that browser registers again.

A Worker rollback alone neither restores cleared registrations nor makes an older registration writer compatible with the required ownership column. Prefer a compatible roll-forward. A database restore requires separate approval and consideration of every intervening metadata write, not just push registrations.

## Stored metadata and retention

D1 stores authentication and device metadata and Web Push subscriptions only. It never stores transcripts, message projections, streaming deltas, tool output, Session contents, or file contents; Session data stays on the user's machine and crosses the relay as live WebSocket frames.

Authenticated `GET /api/devices` and `GET /api/me` return each retained device with `online: boolean`. The Worker reads that value from the owner/device Durable Object's current authenticated agent connection; a revoked device and any failed presence read report `false`. `status`, `lastSeenAt`, and enrollment alone never mark a device online. Offline devices remain in these Settings-facing lists, and revoked devices remain until the owner removes them from Settings, while a connectable-device picker must select only `status: "active"` entries whose `online` value is `true`.

| Table                            | Contents                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `user`, `identity`               | Account identity: internal user ID and the provider plus provider subject.                                     |
| `browser_session`                | Browser sign-in sessions; the row ID is the SHA-256 digest of the `yc_session` cookie token.                   |
| `device`                         | Device ID, owner, name, public JWK, algorithm, and timestamps. The device private key never leaves the device. |
| `device_credential`              | Hashed access and refresh credentials with expiry and revocation markers.                                      |
| `enrollment`, `device_challenge` | Short-lived, single-use enrollment and challenge rows.                                                         |
| `oauth_transaction`              | Google OIDC transaction state, nonce, code verifier, and redirect target.                                      |
| `push_subscription`              | Web Push endpoint, owning account and verified browser-session identity, the browser's P-256 and auth keys, creation time, a failure count, the three System category choices, and the last test-alert time. |
| `invite`                         | Invite ID, optional label, dates, user ID after redemption, and SHA-256 hashes of the invite token and access key; neither secret is stored. |

Single-use rows contain plaintext values required by the protocol: `oauth_transaction.nonce` and `code_verifier` (10-minute lifetime) and `device_challenge.nonce` (2-minute lifetime). The OAuth nonce travels in the Google authorization redirect; the verifier stays server-side. The device challenge nonce is returned to the enrolling agent. Do not log these values.

The bounded sweep deletes expired rows from `oauth_transaction`, `device_challenge`, `enrollment`, `browser_session`, and `device_credential` seven days after expiry, at most 500 rows per table per pass. It runs hourly by cron and at most once per hour per isolate during request handling. Invites never expire and are not swept. Google accounts have no deletion path here; revoking a device closes its sockets but retains its account identity. Deleting an invite removes its invited account, associated OAuth transactions, browser sessions, identity, devices, credentials, enrollments, and push subscriptions. An account keeps at most 10 push subscriptions; subscribing again evicts the oldest. A subscription is deleted when the browser unsubscribes, when its push service answers `404` or `410`, after five other consecutive delivery failures, or with its account. No other retention period is promised.

No user-facing privacy policy is published from this repository. The durable data-handling contract is the header of [`0001_auth.sql`](../infra/cloudflare/migrations/0001_auth.sql) and the comments in [`env.ts`](../infra/cloudflare/src/env.ts); a public privacy notice is a web-lane product artifact.

## Observability and logging

Current application capability:

- Push delivery emits sanitized `web-push` outcome records; other request paths have no custom diagnostic logging.
- Web latency batches are forwarded through the authenticated device relay to local SQLite. The Worker does not store or log their sample bodies, and D1 has no latency table.
- `GET /health` is the only observability endpoint. It runs `SELECT 1` against D1 and returns `{"status":"ok"}` with `200`, or `{"status":"error"}` with `503`. It deliberately omits provider and database detail.

Platform log surfaces:

- Real-time logs (`wrangler tail`, dashboard **Logs → Live**) stream invocation events, custom logs, errors, and uncaught exceptions without storing them. An event carries the request method, URL, and request/response headers. High traffic can force sampling, which drops messages.
- Workers Logs persists invocation and custom logs when the Worker's `observability` setting is enabled. `wrangler.jsonc` does not set `observability`, so persistence follows the account default for this Worker. The provider caps retention at 7 days on Workers Paid and 3 days on Workers Free. Push sends log `web-push` outcomes with event category, push-service host, subscription count, and HTTP status or fixed error class; no endpoint path, keys, account, device, or Session identifier is logged.

Verify the account's logging settings before relying on persistence or retention.

The local connector diagnostic records the relay close code and reason. A `1008`
with `Agent message rate exceeded` means more than 500 agent frames arrived in
ten seconds; after upgrading the connector, verify a busy Session runs and stops
without another such close. Confirm the browser remains subscribed, then run a
Session to completion and separately create one unresolved human approval: each
should yield one fixed-copy push per subscribed device when the browser is closed.
Check only aggregate subscription/failure counts and locally observed notification
delivery; a successful push-service response is not proof of device display.

Use the sanitized `web-push` outcomes in a private live tail to distinguish
no attempt, a failed attempt, and an accepted request; retain only category,
service host, target count, status, and fixed error class. An accepted response
still requires a browser-side notification check.

### Privacy rules for logging

- Never log, copy into diagnostic artifacts, or retain the Google client secret, the `GOOGLE_ALLOWED_EMAILS` value, `ADMIN_API_KEY`, invite tokens, access keys, `yc_session` or `yc_oauth` cookie tokens, enrollment codes, challenge nonces, device access or refresh credentials, the VAPID private key, push subscription endpoints or keys, or D1 export contents. The one-time invite URL and access-key response are handed only to the intended recipient; that recipient may use the explicit Copy action to store the key safely.
- Do not add request-body logging to `/api/auth/*` or `/api/devices/*`.
- Real-time log events can contain `cookie` and `authorization` request headers and full query strings. Treat raw tail output as sensitive: do not paste it into Git, an issue, a chat, or a CI artifact. Keep only the method, an allowlisted route path without query strings, and outcome; omit headers and credentials from every excerpt.

### Minimum sanitized health check

Read-only; request the liveness probe and retain only its outcome. The tail can include other successful GET invocations, so view it only in a private operator terminal and never capture its raw output.

```sh
# Terminal 1: stream only successful GET invocations as JSON.
bunx wrangler tail ycoding-cloud --config infra/cloudflare/wrangler.jsonc --format json --method GET --status ok

# Terminal 2: request the liveness probe.
curl -sS -o /dev/null -w '%{http_code}\n' https://ycoding.althenia.app/health
```

Expected: the curl prints `200` and the tail shows a `GET /health` event with `outcome: "ok"`. Retain only that fact; close the tail and do not keep the raw event. A `503` reports a database failure without exposing detail; investigate through the D1 surfaces below.

## Backup, migration, and recovery

Recovery mechanisms available for the metadata store:

- D1 Time Travel is always on and requires no enablement. It restores a database to any minute in the last 30 days on Workers Paid, or 7 days on Workers Free; bookmarks outside that window are invalid. A restore overwrites the database in place, cancels in-flight queries, and returns the previous bookmark so the restore itself can be undone.
- `wrangler d1 migrations apply` captures a backup after confirmation, and confirmation is skipped without losing the backup in a non-interactive run. If a migration fails, that migration is rolled back and the previously applied migration remains.
- `wrangler d1 export` produces a SQL file from a remote database on demand. Exports are operator-managed, are not scheduled, and are not a repository artifact.

No other retention or backup guarantee exists. The Time Travel window and the Workers Logs window are provider limits, not commitments of this repository.

### Ordered change procedure

1. Confirm the operator session with `bunx wrangler whoami` and identify the production database binding in `infra/cloudflare/wrangler.jsonc`.
2. Record the pre-change recovery point:

   ```sh
   bunx wrangler d1 info ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --json
   bunx wrangler d1 time-travel info ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --json
   ```

   Confirm the returned database `uuid` and `name` match the production `DB` binding in `infra/cloudflare/wrangler.jsonc`. Use `--remote` for migration commands and save the returned Time Travel `bookmark`. The bookmark is a recovery coordinate, not a credential.

3. List unapplied migrations (read-only):

   ```sh
   bunx wrangler d1 migrations list ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --remote
   ```

   Review every listed file under `infra/cloudflare/migrations/` and obtain explicit approval for the complete pending set. Stop if it differs from the reviewed set.

4. Optional durable copy, only with explicit approval and only for a stated reason: `bunx wrangler d1 export ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --remote --output <path outside the repository>`. Use `--no-data` for a schema-only file. Never write an export inside the checkout: `.gitignore` covers `.wrangler/` and `.dev.vars*`, not export files. Never commit, log, or attach an export.
5. Apply the migration to production, after approval:

   ```sh
   bunx wrangler d1 migrations apply ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --remote
   ```

6. Validate: `migrations list --remote` reports nothing unapplied, `GET /health` returns `200`, and the affected route's checks in the next section pass.
7. Record the post-change bookmark (`time-travel info`) and a summary of the apply output: command, migration count, and outcome. Do not retain row contents.

### Failure recovery

- A failed migration is rolled back by `migrations apply`; the previously applied migration remains. Re-run `migrations list --remote`, correct the migration file, and re-apply after review. Do not hand-edit production rows to force the expected state.
- For a wrong or destructive change, stop writes, obtain explicit approval, then restore to the pre-change bookmark:

  ```sh
  bunx wrangler d1 time-travel restore ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --bookmark <pre-change bookmark>
  ```

  Restore overwrites the database in place and cancels in-flight queries. Save the previous bookmark the command returns so the restore can itself be undone.

- Do not rehearse a restore against production. The non-destructive checks below do not prove restoration; a recovery rehearsal requires a separate approved database.

### Approval gates

- Production schema change (`d1 migrations apply --remote`): explicit approval.
- Time Travel restore or any point-in-time recovery: explicit approval; it is destructive and in place.
- Production database export: explicit approval; keep the file outside Git and out of logs, issues, and CI.
- Deployment, secret updates, settings changes, and deleting a database are separate operator actions and are not part of these procedures.

## Repository checks

These are non-destructive and do not touch the deployed relay:

```sh
bun run build:cloudflare      # wrangler deploy --dry-run; builds and validates the Worker without uploading
bun run test:cloudflare       # router, authentication, and relay unit tests
bun run typecheck:cloudflare  # generated bindings are current plus a Worker typecheck
bun run test:integration:remote  # local Worker/D1/Durable Object flow
bun infra/cloudflare/test/smoke.ts <origin>  # read-only, credential-free auth-boundary checks
```

The smoke command exercises the supplied origin's unauthenticated boundaries. The other commands run locally. None proves authenticated production relay traffic, a production migration, or a restore.
