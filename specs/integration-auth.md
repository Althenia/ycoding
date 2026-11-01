# Integration authorization

An OAuth connection begins with `integration.oauth.connect` and returns an attempt ID, authorization URL, instructions, mode, and expiry. `auto` attempts run their provider callback in the background and expose pending, complete, failed, or expired status through `integration.oauth.status`. `code` attempts await `integration.oauth.complete` with an authorization code. Cancelling either attempt releases its resources; a completed attempt stores one integration credential.

An automatic attempt advertises `manualCode: true` only when its provider can accept a pasted authorization code while automatic browser authorization is pending. The client can submit that code through the existing `integration.oauth.complete` request. Submission feeds the same running attempt; a successful submission does not mean authentication has completed. Continue polling status until the automatic callback settles and the credential is stored. One attempt accepts at most one manual submission; an empty code or duplicate is rejected, a submission failure fails the attempt, and cancelled, failed, expired, or completed attempts cannot submit a code. Attempts without this capability do not offer manual entry.

The terminal's automatic OAuth dialog shows manual entry only for an advertised capable attempt. Opening its code prompt retains the attempt and its status polling. Closing the dialog cancels the pending attempt; successful settlement does not cancel it.

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
