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
| Secrets        | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAILS`, set with `wrangler secret put` and never stored in the repository |

`GOOGLE_ALLOWED_EMAILS` fails closed: a missing or empty value denies every Google sign-in, and the value is never returned to a client or logged.

Commands below run from the repository root and target the committed configuration with `--config infra/cloudflare/wrangler.jsonc`. Wrangler is pinned to 4.133.0; `bunx wrangler` resolves that local version.

### WebSocket v2 cutover

The current relay accepts WebSockets only at `/ws/v2/client` and `/ws/v2/agent`. Missing-version, v1, and unknown-version relay paths return `404` before a WebSocket upgrade; there are no aliases or protocol fallbacks. Enrollment records, device identities, and browser sign-in data remain valid, so this cutover requires no credential or data migration.

Perform a coordinated release in this order: stop existing `ycoding remote connect` processes; upgrade every installed connector to a build that uses `/ws/v2/agent`; deploy the Worker and web assets from the same release; refresh open browser tabs so they use `/ws/v2/client`; then restart each connector and reconnect the existing enrolled identity. An old connector cannot connect after the Worker cutover, and an old browser tab must be refreshed. Do not re-enroll a device unless its existing credential is independently invalid.

## Stored metadata and retention

D1 stores authentication and device metadata only. It never stores transcripts, message projections, streaming deltas, tool output, Session contents, or file contents; Session data stays on the user's machine and crosses the relay as live WebSocket frames.

Authenticated `GET /api/devices` and `GET /api/me` return each retained device with `online: boolean`. The Worker reads that value from the owner/device Durable Object's current authenticated agent connection; a revoked device and any failed presence read report `false`. `status`, `lastSeenAt`, and enrollment alone never mark a device online. Revoked and offline devices remain in these Settings-facing lists, while a connectable-device picker must select only `status: "active"` entries whose `online` value is `true`.

| Table                            | Contents                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `user`, `identity`               | Account identity: internal user ID and the provider plus provider subject.                                     |
| `browser_session`                | Browser sign-in sessions; the row ID is the SHA-256 digest of the `yc_session` cookie token.                   |
| `device`                         | Device ID, owner, name, public JWK, algorithm, and timestamps. The device private key never leaves the device. |
| `device_credential`              | Hashed access and refresh credentials with expiry and revocation markers.                                      |
| `enrollment`, `device_challenge` | Short-lived, single-use enrollment and challenge rows.                                                         |
| `oauth_transaction`              | Google OIDC transaction state, nonce, code verifier, and redirect target.                                      |

Single-use rows contain plaintext values required by the protocol: `oauth_transaction.nonce` and `code_verifier` (10-minute lifetime) and `device_challenge.nonce` (2-minute lifetime). The OAuth nonce travels in the Google authorization redirect; the verifier stays server-side. The device challenge nonce is returned to the enrolling agent. Do not log these values.

The bounded sweep deletes expired rows from `oauth_transaction`, `device_challenge`, `enrollment`, `browser_session`, and `device_credential` seven days after expiry, at most 500 rows per table per pass. It runs hourly by cron and at most once per hour per isolate during request handling. `user`, `identity`, and `device` rows have no deletion path: revoking a device revokes its credentials and closes its sockets but does not remove the stored identity, and there is no in-product account-deletion operation. No other retention period is promised.

No user-facing privacy policy is published from this repository. The durable data-handling contract is the header of [`0001_auth.sql`](../infra/cloudflare/migrations/0001_auth.sql) and the comments in [`env.ts`](../infra/cloudflare/src/env.ts); a public privacy notice is a web-lane product artifact.

## Observability and logging

Current application capability:

- `infra/cloudflare/src` emits no custom `console.*` output, so there are no custom log messages to search.
- `GET /health` is the only observability endpoint. It runs `SELECT 1` against D1 and returns `{"status":"ok"}` with `200`, or `{"status":"error"}` with `503`. It deliberately omits provider and database detail.

Platform log surfaces:

- Real-time logs (`wrangler tail`, dashboard **Logs → Live**) stream invocation events, custom logs, errors, and uncaught exceptions without storing them. An event carries the request method, URL, and request/response headers. High traffic can force sampling, which drops messages.
- Workers Logs persists invocation and custom logs when the Worker's `observability` setting is enabled. `wrangler.jsonc` does not set `observability`, so persistence follows the account default for this Worker. The provider caps retention at 7 days on Workers Paid and 3 days on Workers Free. With no custom `console` calls, only invocation logs can appear.

Verify the account's logging settings before relying on persistence or retention.

### Privacy rules for logging

- Never log, copy, or retain the Google client secret, the `GOOGLE_ALLOWED_EMAILS` value, `yc_session` or `yc_oauth` cookie tokens, enrollment codes, challenge nonces, device access or refresh credentials, or D1 export contents.
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

1. Confirm the operator session and review the pending migration: `bunx wrangler whoami`, then read the new file under `infra/cloudflare/migrations/`. Obtain explicit approval before any production schema change.
2. Record the pre-change recovery point:

   ```sh
   bunx wrangler d1 info ycoding-prod-db --config infra/cloudflare/wrangler.jsonc
   bunx wrangler d1 time-travel info ycoding-prod-db --config infra/cloudflare/wrangler.jsonc
   ```

   Confirm the database reports `version: production` and save the returned bookmark. The bookmark is a recovery coordinate, not a credential.

3. List unapplied migrations (read-only):

   ```sh
   bunx wrangler d1 migrations list ycoding-prod-db --config infra/cloudflare/wrangler.jsonc --remote
   ```

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
