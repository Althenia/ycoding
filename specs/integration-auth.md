# Integration authorization

An OAuth connection begins with `integration.oauth.connect` and returns an attempt ID, authorization URL, instructions, mode, and expiry. `auto` attempts run their provider callback in the background and expose pending, complete, failed, or expired status through `integration.oauth.status`. `code` attempts await `integration.oauth.complete` with an authorization code. Cancelling either attempt releases its resources; a completed attempt stores one integration credential.

An automatic attempt advertises `manualCode: true` only when its provider can accept a pasted authorization code while automatic browser authorization is pending. The client can submit that code through the existing `integration.oauth.complete` request. Submission feeds the same running attempt; a successful submission does not mean authentication has completed. Continue polling status until the automatic callback settles and the credential is stored. One attempt accepts at most one manual submission; an empty code or duplicate is rejected, a submission failure fails the attempt, and cancelled, failed, expired, or completed attempts cannot submit a code. Attempts without this capability do not offer manual entry.

The terminal's automatic OAuth dialog shows manual entry only for an advertised capable attempt. Opening its code prompt retains the attempt and its status polling. Closing the dialog cancels the pending attempt; successful settlement does not cancel it.

## Reconnect, key replacement, and refresh

`integration.oauth.connect` and `integration.connect.key` accept an optional `credentialID` naming an existing stored profile of the same integration. An unknown credential or one belonging to another integration fails with `400` (`integration_authorization`) before any authorization starts or any credential changes.

- **Reconnect**: an OAuth attempt with `credentialID` runs the full flow. Only a successful settlement replaces that credential's value in place: the credential ID and label are kept and the profile becomes active. Cancellation, expiry, or a failed callback leaves the stored credential unchanged. If the target is removed while the attempt is pending, the attempt fails and no new profile is created.
- **Key replacement**: a key connection with `credentialID` replaces that credential's value with the new key in place, keeps its ID and label, and makes it active. Without `credentialID`, the key is stored under `label` (default `default`); reusing a label updates that profile.
- **Refresh**: `credential.refresh` (`POST /api/credential/:credentialID/refresh`, Location-scoped) forces a token refresh with the stored refresh token, regardless of expiry, and returns `Integration.RefreshResult`: `{ status: "refreshed", expires }` with the new expiry, or `{ status: "failed", message }`. Failure messages cover an unknown credential, a key credential (`API keys do not refresh; replace the key instead`), an OAuth method without refresh support (`<integration> sign-in cannot be refreshed; reconnect instead`), a credential changed concurrently, or the exact error text of the provider refresh. A failed refresh leaves the stored value unchanged. A successful refresh publishes `integration.connection.updated` and `integration.updated`.

Secrets entered or stored through these paths are never returned in responses or connection projections.

## Connection status

`integration.list` and `integration.get` report a `status` on every stored-credential connection:

- `refresh_failed` with `message` set to the exact failure text, when the last refresh of that credential in the current server process failed and no later refresh succeeded and its value was not replaced or removed;
- otherwise `expired` for an OAuth credential whose expiry has passed;
- otherwise `connected`, including every key credential.

Environment connections carry no status. An integration with no connections is not connected. Refresh failures are kept in server memory only and reset when the server restarts.

## Account connector skills discovery

The Location-scoped read endpoint `GET /api/integration/:integrationID/account-skills` (`integration.accountSkills.read`) inspects available ChatGPT connector skills using an established integration credential without mutating account data or performing new authentication.

### Caller provenance and validation
- **Route and parameters**: `integrationID` must be `"openai"`. Query accepts `sessionID` (required), optional `location` (`directory` and `workspace`), optional `agent`, optional `profile`, and optional skill `id`.
- **Session and Location binding**: The referenced Session must exist and belong to the request's authenticated Location (`directory` and `workspaceID`). The referenced Session must have a configured agent, and if an optional query `agent` is provided, it must match that configured agent.
- **Authorization and configuration**: When server configuration requires authentication, the caller must authenticate via HTTP Basic auth (`401` on failure). ChatGPT account connectors must be enabled in configuration. If a `profile` is requested, it must match the effective profile of the Session's configured connector pins or active connection; conflicting profiles fail closed with `400`.
- **Permission requirement**: Dispatches require the `chatgpt_account_skills_read` permission. If permission is denied, the request fails closed with `400` before dispatching any upstream fetch.

### Execution and bounded results
- **Read sequence**: Reads the upstream skills list. If a specific `id` was requested, it must appear in the returned list; unlisted IDs fail closed with `400` before any detail fetch. If no `id` is specified, the reader fetches detail for the first listed ID (`list.ids[0]`). If the list is empty, no detail fetch is performed.
- **Bounded output**: Returns `location` metadata and a sanitized `data` proof: `status` (HTTP status), top-level response `keys`, item `count`, pagination flags (`hasNext`, `paginationKeys`), and optional `detail` containing only its HTTP `status` and property `keys`. Raw response bodies, skill instructions, tool schemas, and credentials are never exposed.
- **Failure handling**: Upstream `401` and `403` responses, validation failures, or transport errors are sanitized to HTTP `400` with generic error codes (`InvalidRequestError`) to prevent leaking upstream error payloads or authorization state.
