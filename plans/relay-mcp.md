# Relay MCP design proposal

## Scope and boundaries

Expose the enrolled device's local remote-operation handlers through an opt-in MCP resource. Keep OAuth and device admission in the relay, MCP protocol handling in the machine's server process, and Session execution and decisions in the existing local runtime. Keep `ycoding mcp serve` and its task namespace unchanged.

Starting Remote grants its enrolled owner access to every existing and future backend Session. Relay MCP requires a second persisted switch and an explicit OAuth grant for each client and device. One scope, `ycoding:remote`, grants the complete tool set below, including persistent approvals where supported and autonomy changes. Hard-review restrictions and other runtime validation still apply.

Only the MCP directory-creation tool may select an unrecorded directory. The web retains its recorded-workspace creation rule. Other tools resolve Session Locations from backend records.

### Verified implementation seams

- `packages/cli/src/remote-operations.ts`: `executeRemoteOperation` validates input, resolves Sessions, calls the local adapter, and creates bounded response frames. `createRootSession` reconciles a client Session ID against its root placement.
- `packages/cli/src/remote-bridge.ts`: inbound operations execute concurrently. Existing relay mutation lanes order admission, not completion of local effects.
- `infra/cloudflare/src/relay/core.ts`: reads bypass lanes; mutation lanes currently include the browser connection ID and optional Session ID. New MCP requests need a device-wide MCP Session lane rather than one lane per HTTP request.
- `packages/cli/src/remote-host.ts`: the server owns Remote preference, startup, shutdown, retry, and visible state. `packages/server/src/remote-connection.ts` supplies its Protocol-facing service.
- `packages/core/src/task-mcp/transport.ts`: the installed `@modelcontextprotocol/server` 2.3.1 supplies `Server` and `createMcpHandler`. Reuse that SDK pattern without importing task tools or task approval policy.
- `infra/cloudflare/src/auth/{google,jwks,crypto,allowlist}.ts`: existing Google OIDC verification, bounded JWKS lookup, random credentials, hashing, and allowlist checks are reusable. Browser-session authentication is not MCP authentication.

## Public HTTP surface

`R` denotes the enrolled relay's canonical HTTPS origin. `D` is the stable enrolled device ID. Reconnects do not change either identifier.

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/api/mcp/devices/D` | MCP resource; exact audience `R/api/mcp/devices/D`; relay bearer authentication on every request |
| GET | `/.well-known/oauth-protected-resource/api/mcp/devices/D` | Public resource metadata; resource, relay issuer `R`, scope `ycoding:remote`, header bearer method |
| GET | `/.well-known/oauth-authorization-server` | Relay OAuth metadata |
| POST | `/api/mcp/oauth/register` | Public-client DCR; bounded registration metadata; returns client ID, no client secret |
| GET | `/api/mcp/oauth/authorize` | Validate client, redirect URI, resource, scope, response type and S256 challenge; show client/device authority before Google navigation |
| POST | `/api/mcp/oauth/login` | CSRF-protected explicit continuation to Google for this authorization transaction |
| GET | `/api/mcp/oauth/google/callback` | Consume bound Google transaction; verify OIDC, allowlist and device ownership; show final consent |
| POST | `/api/mcp/oauth/consent` | CSRF-protected Allow or Deny for the exact client/device/resource/redirect binding |
| POST | `/api/mcp/oauth/token` | Authorization-code exchange or rotating refresh; require matching resource and client |
| POST | `/api/mcp/oauth/revoke` | RFC 7009-style revocation; unknown credentials return success without disclosing existence |

All OAuth and MCP responses use `Cache-Control: no-store`. Missing, expired, foreign-resource, or revoked access credentials return 401 with `WWW-Authenticate: Bearer resource_metadata="R/.well-known/oauth-protected-resource/api/mcp/devices/D", scope="ycoding:remote"`. Insufficient scope returns 403. An unavailable enabled machine returns a bounded unavailable error without forwarding.

The resource accepts POST only; unsupported methods return 405. Unknown paths in the MCP and well-known namespaces return JSON 404, including navigation requests. Existing public-site routes remain unchanged. Add `/.well-known` and `/.well-known/*` to `assets.run_worker_first`; `/api/*` already reaches the Worker. No new binding is needed.

Metadata advertises authorization code and refresh grants, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, and `authorization_response_iss_parameter_supported: true`. Every authorization redirect, including a denial/error redirect to a previously validated URI, contains the exact issuer. Never redirect an invalid client or redirect URI.

## OAuth identities and state

### Client registration

Support CIMD and DCR as explicitly distinct registration methods. Public clients use PKCE without client secrets. Reject unsupported authentication methods rather than silently changing them. For CIMD, accept the advertised plural methods list when present and require its intersection with relay methods to contain `none`; otherwise require the singular method to be `none`.

CIMD fetches use HTTPS, an absolute URL with a non-root path, no credentials or fragment, no IP literal or local/private hostname, no redirects, a five-second deadline, and a 32 KiB streamed response cap. Validate required metadata, exact `client_id` equality, bounded name, at most ten redirect URIs, authorization-code response support, and public-client authentication. Keep a bounded cache of at most 128 documents, honoring `no-store` and cache lifetimes with a five-minute ceiling. Do not fetch logos, client links, JWKS, or arbitrary referenced documents. Test the actual workerd fetch boundary; do not claim DNS-rebinding protection from hostname syntax alone.

Redirect URIs use HTTPS or explicit loopback HTTP. Reject fragments, credentials, wildcards, duplicate parameters in authorization requests, and malformed or oversized values. Match the entire registered redirect string exactly, including port and query. Show a warning for loopback redirects. DCR registration never grants device access and never creates a browser login.

Apply the router's existing per-address 30-per-minute limiter pattern separately to registration, authorization/login/callback/consent, token and revocation routes. Bound bodies before parsing and return OAuth errors without echoing secrets.

### Consent and Google sign-in

1. Bind the validated request to a random, ten-minute, HttpOnly/Secure/SameSite=Lax transaction cookie. Store its hash and the immutable client, redirect, device, resource, scope, client state, and PKCE challenge.
2. Present the client name, redirect hostname, resource URL, and complete authority. Do not disclose the device name before owner authentication. A CSRF-protected explicit Continue action precedes forwarding to Google's static OAuth client.
3. Run a fresh Google authorization-code + S256 flow using the existing endpoint configuration and verification helpers. Bind state and nonce to this transaction; consume the Google callback once. Never accept an invite/browser cookie as proof of this step.
4. Require a verified allowlisted email, resolve the stable Google provider subject to the existing relay owner, and verify that owner owns the active enrolled device. Do not retain the email or Google's tokens. Check the device's current MCP epoch and availability again.
5. Present Allow and Deny for the same client/device binding. Consent is required on every new authorization flow; an old Google login or grant never auto-approves a new client. POST requires the transaction cookie, a one-use CSRF value, and exact same-origin checks. Reject stale or already-consumed consent.
6. On Allow, atomically consume the transaction and issue a one-use code. On Deny, return `access_denied`, original client state and relay issuer only to the validated redirect URI.

Consent states that access covers every Session, creating Sessions in existing directories strictly below home, prompting and interrupting execution, questions/forms, once/Always/reject decisions where available, YOLO and goal changes, and the remaining workspace capabilities in the mapping, including provider connections, shell controls, and usage reads. Treat client names, device names and redirect text as escaped untrusted display data.

### Token format and claims

Use separate opaque, cryptographically random 32-byte base64url values for codes, access tokens, and refresh tokens. Persist only SHA-256 digests. Access lifetime is five minutes; code lifetime is one minute; refresh-family absolute lifetime is 30 days. Refresh rotation never extends that absolute lifetime.

The stored claims are `issuer`, `subject` (relay owner ID), `client_id`, `device_id`, `resource` (exact MCP URL), `scope`, `grant_id`, `enable_epoch`, `issued_at`, and `expires_at`. Token kind is explicit. No bearer claim comes from an HTTP body or forwarded tool argument. Opaque tokens need no new signing key or relay JWKS endpoint.

Code exchange checks client ID, exact redirect URI, resource, scope binding, S256 verifier, expiry, and current grant/device epoch in one atomic consume-and-issue operation. A concurrent second exchange receives `invalid_grant` and creates no token. Refresh atomically consumes the presented token and inserts the replacement access/refresh pair under the same current grant. Reuse rejects and revokes that refresh family. Revocation invalidates the associated grant and tokens; access-token revocation does not broaden authority.

MCP requests carry access tokens only in `Authorization`. Token and revocation request bodies carry their own code/verifier/refresh values. Never forward the bearer or Google tokens to the machine; forward only verified owner, device and client identity. Never log credentials, authorization query strings, bodies, tool inputs or results. Authorization codes use only the standard one-use OAuth callback exchange; access and refresh tokens never appear in URLs.

## Proposed D1 migration

Add `infra/cloudflare/migrations/0006_relay_mcp.sql` only after approval. Use the existing `DB` binding. Proposed tables:

| Table | Authentication metadata |
| --- | --- |
| `mcp_device` | `device_id` PK/FK, enabled flag, current `enable_epoch`, update time; device deletion cascades |
| `mcp_client` | opaque DCR ID or CIMD URL PK, registration kind, bounded name, redirect URI JSON, public auth method, creation time and first-authorized time; no tools or content |
| `mcp_authorization` | hashed cookie ID PK, client/device FKs, resource/scope/redirect/client state/challenge, Google state hash/nonce/verifier, CSRF hash, verified owner FK, stage, created/expiry/consumed times, enable epoch |
| `mcp_grant` | opaque grant ID PK, client/device/owner FKs, exact resource/scope/enable epoch, consent time, absolute expiry; owner/device deletion cascades |
| `mcp_code` | code hash PK, grant FK, exact redirect and S256 challenge, created/expiry/consumed times |
| `mcp_token` | token hash PK, grant FK, access/refresh kind, created/expiry/consumed/revoked times, rotated-to hash |

Index owner/device/client grant lookup, grant-token lookup and expiry sweeps. Store the short-lived Google nonce and PKCE verifier under the existing OAuth transaction exception: the upstream exchange requires them. Store downstream codes, CSRF secrets, cookie tokens and issued credentials only as hashes. Store no email, Google token, prompt, tool argument, Session ID or result.

Use conditional D1 batch statements with per-attempt consumption nonces for code consumption, refresh rotation, and grant issuance; insert replacements only when the same transaction wins consumption and the grant/device/epoch remains valid. MCP off and device revocation delete device grants and cascade their codes/tokens. Delete account-owned authorization rows on account deletion. Preserve ever-authorized clients across grant revocation. Bound never-authorized DCR and CIMD registrations together to 10,000 and sweep expired unused registrations after the authorization lifetime and retention window without deleting active authorizations or grants. Sweep expired metadata in bounded 500-row batches using the existing scheduled/request maintenance owner.

Local workerd tests apply migrations only to isolated local D1 storage. Production migration application, backup and deployment remain operator actions and are not part of implementation.

## MCP transport and tools

Use the installed SDK's Streamable HTTP handler in a new Core transport module accepting tool definitions and a callback. The CLI owns the concrete mapping and calls `executeRemoteOperation` for every tool; Core imports neither CLI nor Server. Host the handler inside the connector's server process, without a public listener or an arbitrary HTTP proxy. Keep task MCP modules untouched.

The shared remote contract owns the MCP transport vocabulary. The relay forwards only the fixed `mcp.request` operation; it does not parse tool arguments, validate domain inputs, inspect Session state, or execute decisions. Local SDK handling and connector validation remain mandatory. A browser frame cannot select the MCP-only ingress or folder operation.

Forward a named MCP request containing only a bounded HTTP-body representation, allowlisted protocol headers, verified principal, and current enable epoch. Never accept target URL, local path, local HTTP method, bearer header, cookie or caller-authored principal. Dispatch only to the local MCP handler's fixed resource. The local adapter verifies method/name/routing agreement before executing any callback.

Use the SDK's `responseMode: "json"` and `legacy: "reject"` for MCP revision 2026-07-28. Forward HTTP status, JSON content type, and complete bounded response bytes through ordered relay response chunks. Limit total bytes and chunk count, cancel on HTTP disconnect, release all request resources on close, and surface overflow explicitly. The existing 32,768-character client-frame bound and 64-response-chunk bound remain authoritative; reject overhead-inclusive oversized MCP requests before forwarding. Large tool responses must either arrive complete or fail with `message_too_large`.

The relay reserves one device admission queue before any asynchronous restore or authority read and releases it immediately after sending, never after waiting for a result. The connector assigns mutation queues by backend Session ID in received-request order, not by HTTP connection or OAuth client, before asynchronous SDK handling or Session lookup. Hold each mutation lane through connector response settlement. Use the create input's Session ID for both creation tools. Unscoped mutations use a separate MCP device lane. Reads and protocol discovery bypass mutation lanes; pending MCP requests never occupy browser read lanes. Recheck live authority and enable epoch immediately before forwarding and before local dispatch. Interrupt joins the same Session lane; a preceding compaction or goal calculation can delay it up to that operation's existing five-minute timeout. Do not silently reorder an interrupt or alter local goal semantics.

Return `outcome_unknown` as an MCP tool error with an explicit inspect-before-retry message. Quarantine the affected local mutation lane for the connector instance when its local outcome is unknown; refuse queued and later mutations in that lane while preserving reads and other Sessions. After local inspection, an explicit Remote disconnect/connect replaces that connector; automatic socket recovery does not clear the quarantine. Never replay a dispatched request automatically. Return an actionable machine-update error for `unknown_operation` from an older connector. Protocol-level invalid requests remain SDK errors, not fabricated tool success.

### Input and output contract

Each ordinary tool accepts `{ sessionID, input }` for Session-scoped operations and `{ input }` otherwise, omitting `input` for parameterless operations. Nested fields, required properties, numeric/string bounds, enum values and unknown-field rejection follow the connector validator. Provider-auth tools retain their existing `input.target` union rather than introducing top-level placement. `usage_forecast` requires `sessionID` with `input.localScope: "location"` and forbids it with `"backend"`. Incident guidance tools preserve their existing optional Session scope; when supplied, resolve its Location through the connector. Derive mutation lane keys from these declared routing fields, including provider-auth `input.target.sessionID`, without resolving a Location in the relay. Publish full input schemas, not untyped arbitrary objects. `session_create` and `session_prompt` require client-generated `input.id`; do not manufacture IDs on behalf of an MCP client.

Results contain the complete connector value as `structuredContent` and matching JSON text. Tool failures set `isError: true` and preserve safe error category/message. Never silently shorten result content. Tool descriptions distinguish persistent approvals and autonomy changes from ordinary reads; hints do not grant permission.

### Exact tool mapping

The mapping is closed, deterministic and tested against `remoteOperations`. Names normalize camelCase to snake_case and replace dots/hyphens with underscores. The eight excluded operations below are not tool registrations. The directory tool is an additional MCP-only operation, not an overload of browser `session.create`.

| MCP tool | Remote operation |
| --- | --- |
| `provider_auth_list` | `provider.auth.list` |
| `provider_auth_key` | `provider.auth.key` |
| `provider_auth_begin` | `provider.auth.begin` |
| `provider_auth_status` | `provider.auth.status` |
| `provider_auth_complete` | `provider.auth.complete` |
| `provider_auth_cancel` | `provider.auth.cancel` |
| `workspace_list` | `workspace.list` |
| `workspace_catalog` | `workspace.catalog` |
| `workspace_file_find` | `workspace.file.find` |
| `session_list` | `session.list` |
| `session_active` | `session.active` |
| `session_get` | `session.get` |
| `session_messages` | `session.messages` |
| `session_captured_changes_list` | `session.capturedChanges.list` |
| `session_compaction_list` | `session.compaction.list` |
| `session_compact` | `session.compact` |
| `session_snapshot` | `session.snapshot` |
| `session_pending_list` | `session.pending.list` |
| `session_attachment_read` | `session.attachment.read` |
| `session_todo_list` | `session.todo.list` |
| `session_subagent_list` | `session.subagent.list` |
| `session_pin` | `session.pin` |
| `session_unpin` | `session.unpin` |
| `session_subagent_cancel` | `session.subagent.cancel` |
| `session_subagent_answer` | `session.subagent.answer` |
| `session_team_economics` | `session.team.economics` |
| `session_team_shell_list` | `session.team.shell.list` |
| `session_team_shell_kill` | `session.team.shell.kill` |
| `session_side_chat_list` | `session.side-chat.list` |
| `session_side_chat_create` | `session.side-chat.create` |
| `session_family_activity` | `session.family.activity` |
| `session_log` | `session.log` |
| `session_prompt` | `session.prompt` |
| `session_interrupt` | `session.interrupt` |
| `session_prediction` | `session.prediction` |
| `session_prompt_generate` | `session.promptGenerate` |
| `session_permission_list` | `session.permission.list` |
| `session_permission_reply` | `session.permission.reply` |
| `session_guardrail_status` | `session.guardrail.status` |
| `session_guardrail_request_list` | `session.guardrail.request.list` |
| `session_guardrail_reply` | `session.guardrail.reply` |
| `session_review_list` | `session.review.list` |
| `session_review_decide` | `session.review.decide` |
| `session_form_list` | `session.form.list` |
| `session_form_reply` | `session.form.reply` |
| `session_form_cancel` | `session.form.cancel` |
| `session_shell_output` | `session.shell.output` |
| `session_autonomy_get` | `session.autonomy.get` |
| `session_autonomy_set` | `session.autonomy.set` |
| `session_goal_set` | `session.goal.set` |
| `session_goal_stop` | `session.goal.stop` |
| `session_create` | `session.create` |
| `session_status` | `session.status` |
| `session_catalog` | `session.catalog` |
| `session_file_find` | `session.file.find` |
| `session_switch_model` | `session.switchModel` |
| `session_switch_agent` | `session.switchAgent` |
| `session_command` | `session.command` |
| `session_skill` | `session.skill` |
| `usage_providers` | `usage.providers` |
| `usage_summary` | `usage.summary` |
| `usage_report` | `usage.report` |
| `session_usage_report` | `session.usageReport` |
| `session_prompt_costs` | `session.promptCosts` |
| `session_task_costs` | `session.taskCosts` |
| `usage_forecast` | `usage.forecast` |
| `incident_report` | `incident.report` |
| `incident_recent` | `incident.recent` |
| `incident_guidance` | `incident.guidance` |
| `incident_guidance_clear` | `incident.guidance.clear` |
| `machine_keep_awake_get` | `machine.keepAwake.get` |
| `machine_keep_awake_set` | `machine.keepAwake.set` |
| `session_create_in_directory` | MCP-only `session.createInDirectory` |

Excluded: `session.subscribe`, `session.unsubscribe`, `session.message.stream`, `session.attachment.upload`, `machine.telemetry.consent.get`, `machine.telemetry.consent.set`, `machine.latency.append`, `machine.latency.list`. Clients poll snapshots, pending interactions and status. No third-party MCP server is exported.

### Directory creation

`session_create_in_directory` accepts `{ input: { id, directory, agent?, model? } }`. Require an absolute path to an existing directory. Resolve both the owner's home and the candidate with `realpath`, then require a nonempty relative path that is neither absolute nor `..` nor starts with `..` plus the platform separator. Reject an escaped canonical target before touching the Session API. Do not create directories, expand caller environment variables, or accept `~` as a substitute for an absolute path.

Validate the resulting project and root placement, use the existing ID reconciliation, add the returned Session to the connector registry, and verify its backend-reported Location. Reuse the existing creation path's agent/model validation. Missing paths, home itself, foreign paths and symlinks escaping home fail before any Session creation. Other operations use the created Session ID and its backend Location, never another caller directory. The existing local runtime does not provide a filesystem handle that atomically fences concurrent local directory replacement; validate immediately before admission and do not claim protection against a malicious local filesystem owner.

## Toggle and lifecycle

Add authenticated server-global `GET` and `PUT /api/remote/mcp`, identifiers `remote.mcp.get` and `remote.mcp.set`, with PUT `{ enabled: boolean }`. Return `{ data: { state: "off" | "connecting" | "on" | "error", message?, url? } }`. Schema owns the status shape; Protocol owns the endpoint; Server delegates to the hosted connector. No Schema reply-attribution change is needed.

Persist a separate private `remote-mcp.json` preference under the server state directory, with enabled preference and a random enable epoch. Missing preference means off. A restart restores MCP only when both saved switches permit it; a Remote start alone never enables MCP. Server transitions serialize and fence superseded callbacks like the current Remote host.

The agent advertises its MCP state and epoch on every connection through a dedicated authenticated control frame; the relay acknowledges after updating authority metadata and the current agent socket attachment. Keep the gate closed until acknowledgment. Hibernation may restore that current attachment's gate only after revalidating the matching D1 enabled epoch. The relay accepts controls only from its current authenticated agent and rejects late controls from replaced sockets. A matching epoch preserves grants through ordinary reconnect; changing the epoch deletes old grants before opening the gate.

Disabling closes the local admission gate first, persists off and a retired epoch, tells the relay to close its MCP gate and delete grants, then reports acknowledged off. Remote disable performs the same retirement before closing the socket. If relay acknowledgment cannot be confirmed, retain the retirement durably, close the connector, and report the unconfirmed revocation rather than claiming remote revocation succeeded. Reconnection must settle retirement before advertising any new enabled epoch. No network protocol can retroactively undo a request already dispatched before the disable boundary; queued requests are rechecked and refused.

Transient Remote connection loss closes relay forwarding immediately without deleting otherwise-valid grants. Server shutdown preserves enabled preferences but closes all in-memory requests. Explicit off, device revocation and account deletion remove grants. Turning on after explicit off requires fresh consent. Do not cancel already-admitted local Sessions or replay their inputs during any toggle transition.

CLI: `ycoding remote mcp on`, `off`, and `status`, using the same authenticated server endpoints as the TUI. Enabling while Remote is off returns an error naming `ycoding remote connect`; missing enrollment names `ycoding remote enroll`. Status prints the reported state, message, and stable MCP URL when available.

TUI: one `Relay MCP` palette toggle with `● off`, `● connecting`, `● on`, or `● error`; use the existing Remote status roles and stale-reply fences. Enable from off, disable from other states. Enabling shows the authority notice. Status adds a `Relay MCP` row with state, actionable error, and wrapped URL when on. Reuse existing list, toast, detail and palette components; add no new color or animation.

Consent: server-rendered HTML under the relay auth namespace, with no third-party assets or inline script. Reuse web semantic colors, Geist font stacks, standard button/focus treatment, spacing and narrow reading measure. Use semantic headings, a visible authority list, and keyboard-operable primary Allow/Continue and secondary Deny controls with 44px targets. Add the consent anatomy to `apps/web/DESIGN.md` and the MCP row/toggle to `packages/tui/DESIGN.md` before implementation. Verify light/dark, 320px reflow, focus, error/expired states and escaped long client/device names.

## Validation plan

Write boundary tests before implementation and establish expected failures. Do not weaken existing remote web or task MCP tests. Use synthetic accounts, keys, directories, local provider stand-ins, isolated state/XDG directories, and `GOOGLE_*` endpoint overrides. No live credentials or model calls are needed.

| Boundary | Required evidence |
| --- | --- |
| OAuth routing in workerd | 401 challenge; protected-resource/AS metadata; S256/issuer advertisement; JSON 404; method checks; rate limits |
| Registration and consent | CIMD and DCR; exact redirect match; oversized/timeout/redirect metadata failures; pre-Google client notice; escaped name/host/device/authority; CSRF and transaction replay refusals |
| Issuance | allowlisted owner succeeds; non-allowlisted, invite-only, foreign owner, plain/missing PKCE, wrong verifier/resource/redirect, expired/reused code fail; simultaneous exchanges yield one pair |
| Refresh and revocation | one-use rotation, reused family revoked, exact audience, expired access refused; off/on, device revoke and account delete invalidate old credentials |
| Forwarding gate | no frames for unauthorized, off, disconnected or revoked resources; replaced socket/epoch cannot reopen gate; no bearer forwarded |
| MCP wire | real SDK discovery/list/call, exact 73-tool inventory, invalid method/schema/version/header metadata, unsupported connector update error, bounded JSON and cancellation |
| Local composed flow | recorded-workspace create, idempotent retry, prompt/admission retry, snapshot, permission Always, guardrail reply, YOLO 2 and interrupt through real local server |
| Folder boundary | existing home descendant succeeds; home/missing/outside/traversal/escaping symlink fails without Session or directory creation; web inventory rule unchanged |
| Ordering and bounds | stalled first same-Session mutation cannot be overtaken; another Session/read can proceed; browser `session.list` completes while MCP waits; multiframe response complete or explicit failure |
| Persistence/privacy | server restart retains preference; explicit Remote off clears MCP; local D1 scan of every text column finds zero synthetic prompt-marker rows |
| UI/CLI | palette and Status render all states, URL and authority notice; off dependency error names command; CLI and palette operate on one state |

Run focused checks at feature checkpoints. At integration run sequentially:

```sh
bun run build:web
bun run check:cloudflare
bun run test:remote
bun infra/cloudflare/test/integration/relay-local.ts
bun run test:integration:remote
bun infra/cloudflare/test/integration/mcp-flow.ts
bun run --cwd packages/core test
bun run --cwd packages/server test
bun run --cwd packages/cli test
bun run --cwd packages/tui test
bun run test:web
bun run --cwd packages/schema typecheck
bun run --cwd packages/remote typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client typecheck
bun run --cwd packages/cli typecheck
bun run --cwd packages/tui typecheck
bun run --cwd apps/web typecheck
bun run --cwd packages/client generate
bun run typecheck
bun run lint
bun run lint:effect-patterns
```

Run the named new feature and rendered-consent checks, affected Protocol/Client tests, design-drift tests, and strict design-file lint. Limit typecheck processes to 6144 MiB and the full CLI suite to 12288 MiB. Serialize all builds, package suites and typechecks across workers. Root typecheck uses the approved `--concurrency=1` adjustment. Generation must produce the intended first diff, then a second generation must leave those generated bytes unchanged; an empty diff against main is not expected after adding endpoints.

Review every changed file and preserve unrelated main-branch changes. Commit the complete feature once, rebase onto current main, and integrate by fast-forward. Do not push, tag, deploy, set Cloudflare secrets, or apply production migrations. Deployment, real Google consent and a ChatGPT connection round trip remain explicitly unrun.

## Approvals and operator provisioning

| Action | Decision |
| --- | --- |
| Create branch/worktree `relay-mcp` from main; commit the complete feature and integrate by fast-forward | Authorized |
| Add six-table D1 migration `0006_relay_mcp.sql`; apply to isolated local test databases only | Approved |
| Add or change dependency versions | Not proposed; reuse installed SDK and standard APIs |
| Populate worktree dependencies with frozen lockfile and no version/lock changes | Approved |
| Add Wrangler binding or secret | Not proposed; reuse `DB`, `DEVICE_RELAY`, existing Google settings |
| Add well-known route patterns to Wrangler assets routing | Within the MCP route implementation; no binding or secret |
| Make root `typecheck` run packages serially (`--concurrency=1`) | Approved |
| Deploy, configure live Google/Cloudflare, apply production D1 migration | Excluded |

Operators must apply the approved D1 migration during their deployment, retain the existing Google client and allowlist configuration, register the exact additional Google callback `R/api/mcp/oauth/google/callback`, deploy updated relay assets and machine software, enroll/connect the device, then enable Relay MCP locally. No relay token signing secret, extra D1 database, Cloudflare Tunnel, or third-party MCP configuration is required by this design.

Update `AGENTS.md`, `packages/remote/CONTRACT.md`, `docs/product-direction.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/runtime.md`, `docs/remote-deployment.md`, `README.md`, and `apps/web/src/content/docs/pages/use.ts` together after implementation. Describe the surface, home-directory exception, granted authority, switches and appropriate operator setup in each owning context. Keep public docs user-facing and engineering details out of the web build.

## External contract evidence

- MCP authorization, registration and security requirements: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization and its `client-registration` and `security-considerations` pages.
- OpenAI authentication guide: https://developers.openai.com/plugins/build/auth. It documents CIMD preference, retained DCR support, exact callback matching, issuer responses and public-client `none` authentication.
- ChatGPT's published https://chatgpt.com/oauth/client.json advertises `none` and `private_key_jwt` in its supported-methods list, authorization-code and refresh grants, and its stable callback URI. Metadata inspection is not a live connection test.
