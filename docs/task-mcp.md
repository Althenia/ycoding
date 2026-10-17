# Task MCP gateway

`ycoding mcp serve` exposes task and interaction MCP tools for one approved owner and one Git repository. It connects to the existing local YCoding service. Task execution, permissions, guardrails, history, and model credentials remain in that service.

## Operator setup

Configure an external OAuth authorization server before publishing the endpoint. The gateway is a resource server, not a login or token-issuing service. It accepts RS256-signed JWT access tokens only; opaque tokens, static API keys, and Cloudflare Access assertion headers are not accepted.

1. Create an OAuth API/resource whose audience is the exact stable public MCP URL, for example `https://coding.example.com/mcp`, with the scope `ycoding:tasks`.
2. Configure authorization-code login with PKCE S256 and an approved ChatGPT client. Use the exact redirect URI supplied by the client, not a wildcard. The provider must support a preconfigured client, Client ID Metadata Documents, or dynamic client registration compatible with the client. The gateway does not implement client registration.
3. Restrict application access at the provider to the intended account. Obtain that account's immutable `sub` claim and the exact issuer and trusted JWKS URL. The gateway checks that same issuer and subject on every authenticated request, even if the provider permits other people to sign in. An email domain or successful login alone grants no access.
4. Issue short-lived access tokens with `iss`, `sub`, `aud`, `exp`, and `scope`. Audience must contain the exact MCP URL, subject must match `--subject`, and scope must contain `ycoding:tasks`. Optional `nbf` is enforced. Provider-side revocation of a session does not immediately invalidate an already-issued JWT; use short expirations and stop the gateway for immediate access removal.
5. Configure YCoding's provider/model and normal local permissions. Choose a Git repository with a committed HEAD. Every task gets a separate worktree from that HEAD; uncommitted source changes are not copied.

Start locally, substituting your own non-secret configuration:

```sh
ycoding mcp serve \
  --directory /absolute/path/to/repository \
  --workspace-root /absolute/path/to/task-worktrees \
  --resource https://coding.example.com/mcp \
  --issuer https://identity.example.com/ \
  --jwks-url https://identity.example.com/.well-known/jwks.json \
  --subject YOUR_IMMUTABLE_ACCOUNT_SUBJECT
```

The listener uses Node-compatible HTTP APIs in both Bun and the Node executable and binds only `127.0.0.1`, on port 4097 by default. SSE responses stream without buffering; disconnecting a client aborts its pending HTTP request, and shutdown closes open streams. MCP request bodies are limited to 128 KiB by the protocol transport. Optional `--port`, `--max-concurrent` (1–16, default 4), `--agent`, and `--model` select local policy; remote tool arguments cannot choose an arbitrary path, agent, model, shell command, or permission mode. `--model` uses the normal `[profile#]provider/model[#variant]` format.

The owner/repository/resource/model configuration selects a private durable admission index under YCoding's state directory. It is bound to the worktree root and protected by a process lock. Do not move or delete that index while its gateway is running. Do not move gateway Sessions or their worktrees while they are in use: placement is checked before each operation, but the existing runtime API does not atomically fence a concurrent local move. Changing the issuer, subject, resource URL, agent, model, or repository selects a separate task namespace. One gateway accepts one subject. Run separate gateway configurations and ports for different owners; this is not a shared multi-user execution sandbox.

## Cloudflare Tunnel

Use a named tunnel and stable HTTPS hostname. Route that hostname to `http://127.0.0.1:4097`, not to YCoding's main API port. Both `/mcp` and `/.well-known/oauth-protected-resource/mcp` must reach this listener. The latter serves public OAuth discovery metadata; task tools always require authorization. Preserve the `Authorization` header. The gateway rejects foreign browser Origins and unknown request hosts.

For an existing named tunnel, the relevant ingress shape is:

```yaml
ingress:
  - hostname: coding.example.com
    service: http://127.0.0.1:4097
  - service: http_status:404
```

Configure and run the tunnel yourself. Keep its credentials local. Quick Tunnels rotate hostname and do not support SSE, so they are unsuitable for this endpoint's SDK-managed Streamable HTTP compatibility transport.

An ordinary Cloudflare Access browser-login wall is not an MCP OAuth flow. Cloudflare Managed OAuth is a separate option with its own opaque-token-to-`Cf-Access-Jwt-Assertion` contract; it is not a drop-in replacement for this gateway's bearer-JWT verification. Do not remove gateway authentication to work around that difference.

## ChatGPT connection

Use ChatGPT's custom MCP/app connection flow, select OAuth, and enter the stable `https://coding.example.com/mcp` URL. Complete login with the approved account. Availability of custom MCP and write tools depends on plan and workspace policy. The protected-resource challenge advertises the configured issuer; that provider must publish the authorization-server metadata and support the chosen client-registration method.

Test discovery and login first, then start one small task and poll its status/result. A valid login by another account must still fail. Never paste access tokens, client secrets, or tunnel credentials into prompts. This setup needs a real provider/client/tunnel round trip; local protocol tests do not establish that deployment is connected.

## Tools and lifecycle

- `list_tasks({cursor?, limit?})`: gateway-owned tasks only; default 20 and maximum 50 per page.
- `start_task({requestId, prompt})`: returns promptly with a task ID while worktree preparation and durable prompt admission continue. A request ID is 1–128 ASCII letters, digits, underscores, or hyphens. Repeating the same ID and exact prompt returns the same task. A changed prompt with that ID fails. Prompt size is at most 64 KiB UTF-8.
- `get_status({taskId})`: reports `queued`, `running`, `waiting`, `completed`, `failed`, `interrupted`, `cancelling`, or `cancelled`.
- `get_result({taskId})`: includes status, the worktree, and at most 32 KiB of the latest assistant's text from the newest 20 messages, with an explicit truncation flag. Results can be partial. Reasoning and raw tool logs are excluded.
- `cancel_task({taskId})`: prevents admission when cancellation arrives during preparation and interrupts that task's active Session. It never removes the worktree or rolls back completed file changes.

- `list_interactions({taskId})`: polls pending root-Session Forms, questions, permissions, and human-reviewable guardrails. Each entry includes its stable `interactionId`, exact revision digest, complete bounded request details/options, permitted response actions, and whether it is actionable. Unsupported or oversized requests require local attention; their shortened descriptions cannot be approved remotely.
- `respond_interaction({taskId, interactionId, revision, response})`: submits one explicit response to that exact pending request. For Forms use `{action: "form", answer: {...}}`; for legacy questions use `{action: "question", answers: [[...]]}`. An approvable action accepts `{action: "once"}` or `{action: "reject"}`; supported questions also accept `{action: "cancel"}`. There is no implicit approval, `always` permission, or policy override.

When a task is `waiting`, the client can poll `list_interactions`, show the actual request and choices to the owner, then submit the owner's response. Permission requests and review prompts are untrusted task data, not instructions authorizing the assistant to approve them. The assistant must obtain the required user decision; delegated routine choices require an explicit, bounded user authorization. A generic task prompt or successful OAuth login does not authorize every future action. Hard-denied actions have no approval route. Unsupported review types and child-Session interactions remain local-only.

Replies are tied to this owner, task, native request, and revision. Stale, duplicate, cancelled-task, and mismatched replies are rejected. Before forwarding a response, the gateway saves its request/revision digest (not the answer) in the durable index. A lost response or restart therefore never silently replays an approval. If a response is uncertain, inspect and resolve it locally rather than retrying blindly. Confirmed pre-submit validation failures permit correction; timeouts and unknown outcomes do not. Each task retains at most 256 consumed reply attempts. Live permission rejection uses the new request-scoped permission endpoint; it never calls the legacy reject-all operation. An older local service without that endpoint returns an error and requires an upgrade or local attention. There is no fallback that could reject other pending permissions.

This is a polling interface, not a push notification service. It does not wake ChatGPT or guarantee an unsolicited message after a disconnected client stops polling. It does not enable YOLO or auto-answer. A successful execution outcome is a runtime result, not independent verification that the requested coding goal was achieved.

Cancellation is cooperative and targets the root Session’s current execution. It does not recursively cancel durable background child tasks; outstanding child work keeps the task unresolved. The existing Session API cannot discard an idle durable pending prompt. Such a task stays `cancelling` until local attention resolves it, rather than claiming successful cancellation. A local manual resume can consume retained input; review it before continuing. Do not start a replacement task merely because a cancellation request was accepted.

A gateway restart never replays preparation or uncertain prompt admission. Already-admitted Sessions continue in the local service. If that service restarts, its existing root-Session recovery rules apply: root work is not automatically replayed. Inspect the Session before deciding whether to continue locally or submit a new request ID. Gateway shutdown does not cancel accepted tasks.

Concurrent tasks use distinct Git worktrees and Session IDs. Worktrees prevent ordinary checkout collisions; they do not isolate the OS, network, shared Git metadata, credentials, or external side effects. Existing YCoding permission and guardrail policies still apply. Worktrees and task records are retained for review, with a 1000-record registry bound; cleanup is an operator action, not an MCP tool. Session retention can remove old runtime history, in which case the gateway reports interruption/unavailability rather than inventing results.

## References

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Cloudflare Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
