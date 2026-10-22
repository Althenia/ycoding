# Registered local HTTP apps

The local-app facility presents explicitly registered HTTP services through a trusted MCP App wrapper. It is not a URL proxy, an agent-eval data adapter, or a way to publish arbitrary machine ports.

## Registration and authority

Every tool requires a backend Session ID and the authenticated Relay MCP context. Registration binds the app to the owner, device, Session, OAuth client, exact grant, and enable epoch. Session placement is resolved from the backend inventory.

| Tool | Input | Result |
| --- | --- | --- |
| `local_app_register` | `sessionID`, `input: { host, port, entryPath, routes, ttlMs? }` | Safe registration metadata, opaque app ID, and generation. |
| `local_app_list` | `sessionID` | The current client's registrations for that Session. |
| `local_app_revoke` | `sessionID`, `input: { id }` | Revoked view state; active app requests are cancelled. |
| `local_app_open` | `sessionID`, `input: { id, generation }` | View state and private bootstrap metadata when a preview issuer is configured. |
| `local_app_status` | `sessionID`, `input: { id }` | View state without extending its lifetime. |
| `local_app_http` | `sessionID`, `input: { id, generation, method, path, headers?, body? }` | HTTP status, permitted response headers, and canonical base64 body. |

The corresponding closed operations are `local.app.register`, `.list`, `.revoke`, `.open`, `.status`, and `.http`. HTTP requests execute only through the MCP-bound app context; ordinary remote frames do not supply that authority.

`host` is exactly `127.0.0.1` or `[::1]`; `port` is an integer from 1 through 65535. Registration accepts no hostname, full destination URL, LAN address, or metadata-service address. Each route has `{ path, match: "exact" | "prefix", methods }`. Prefix matching respects path-segment boundaries. Methods are explicitly selected from GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS. There are no wildcard routes. The entry path must permit GET.

Registration lasts 15 minutes by default and at most one hour. Limits are 16 apps per Session, 64 apps per registry, and 64 routes per app. Registration alone does not create a public preview. Publication binds one exact client/grant scope; another scope cannot adopt it. Explicit revocation, registry closure, expiry, MCP disablement, and connector disconnection end access. Reconnection requires new registration rather than restoring exposure.

## HTTP behavior

Requests select only a route within the registered origin. Encoded separators, traversal, malformed escapes, backslashes, fragments, scheme-relative paths, and extra input fields are rejected. The dispatcher rechecks authority before contact and after response consumption. It performs no automatic replay.

Every tool call resolves the forwarded request's grant at the relay, and each app request checks it again. A relay authorization answer of HTTP 429 fails the call with `rate_limited` and reason `rate_limited`. A relay 5xx or other unexpected status, a timeout, a network failure, an unreadable answer, or an explicit relay `unavailable` rejection fails it with `agent_unavailable` and reason `authorization_unavailable`. These two outcomes are temporary and leave the registration and grant unchanged. Every other authorization failure, including HTTP 401 or 403, a revoked or expired grant, an unknown forwarded request, a local Relay MCP disable or epoch change, and any failure without a relay answer, fails with `forbidden` and reason `access_unavailable`.

The local dispatcher allows at most four concurrent requests per app and sixteen in total. Each request is limited by the remaining registration lifetime and a 15-second deadline. Its local body bounds are 256 KiB request and 2 MiB response. The MCP exchange further limits decoded request bodies to 64 KiB and decoded response bodies to 1 MiB, within the MCP envelope limits.

Status, content types, binary bytes, cache validators, range metadata, and permitted content-disposition values are retained. Decompressed response length is recalculated. HEAD retains a valid unencoded representation length without sending a body. Hop-by-hop headers, server credentials, authentication challenges, and app cookies are not forwarded. The verified preview Origin and Referer translate only to the registered upstream origin.

Redirects are never followed by the local dispatcher. A redirect can return to the same registered origin only if its destination and effective method remain permitted. External origins, other ports, and paths outside registration are rejected. Existing application CSP and X-Frame-Options are preserved; frame restrictions can make an app incompatible with embedding.

WebSocket upgrades and live SSE are unsupported and rejected. The connector's own WebSocket is not an application WebSocket tunnel. Cookie-based app sessions, upstream login flows, service workers, and external resource origins are outside this HTTP-only presentation contract. The app wrapper does not recreate application-specific data or UI.

## Embedded presentation

Only `local_app_open` links `ui://ycoding/local-http-app/v1.html` through `_meta.ui.resourceUri`. The resource is `text/html;profile=mcp-app`. It contains the shared MCP Apps bridge and a trusted status wrapper, not the upstream application's HTML.

The wrapper receives model-visible view state separately from private `_meta.localApp` bootstrap metadata. It accepts only a declared exact preview origin and its bounded bootstrap URL. It embeds the app in a sandboxed frame with scripts, same-origin behavior, and forms; it grants no popup or top-navigation capability and does not forward the app's messages to the MCP host. A manual status refresh uses only `local_app_status`. Expiry, revocation, or an invalid result removes the frame. A frame-load event is not proof that the application worked.

The gateway redeems a single-use bootstrap ticket for a distinct, short-lived `__Host-ycoding-preview` cookie with Secure, HttpOnly, SameSite=None, and Partitioned attributes. It then redirects to the entry path under `/_r/<lease tag>/`. OAuth and device credentials remain on the server. Every app HTTP request checks the lease and its grant again; state-changing requests require the exact preview Origin. A browser that cannot retain the required cookie fails closed without a persistent URL-token fallback.

The gateway adds a restrictive same-origin CSP and intersects it with application policy. Its `frame-ancestors` lists the connector's `appPreview.frameAncestors`, or `'none'` when that list is empty. It does not remove an application's framing prohibition. The wrapper's `frameDomains` contains only configured exact preview origins; its connection and resource-domain lists are empty.

## Preview deployment

The gateway runs in the connector. A dedicated Worker, `ycoding-preview` (`infra/cloudflare/wrangler.preview.jsonc`), serves the configured preview origins and routes each browser request by credential, never by host or path guess:

1. Preview origins are single-use. The relay and the preview Worker read the same exact list, `PREVIEW_ORIGINS`; an empty list, or a list with any wildcard, non-HTTPS, path-bearing, or repeated entry, disables preview. Before `local_app_open` issues a lease, the connector asks the relay for an origin for its registration. The global `PreviewDirectory` binds the first never-bound origin to that owner, device, and registration and keeps the binding permanently. The same live registration receives the same origin again; no other registration ever receives a bound origin, whether the first one expired, was revoked, its connector disconnected, or either process restarted. When every listed origin is bound, `local_app_open` fails closed with `preview_exhausted`.
2. The connector then issues the lease and sends the relay the origin, the SHA-256 digest of the bootstrap ticket, a random 16-hex-character lease tag, the registration digest, and the expiry, and returns the bootstrap URL only after the relay accepts them. The relay records them with the owner and device of the authenticated agent connection, never from frame content.
3. The Worker answers only on a listed origin whose binding is current. It redeems the ticket digest once, forwards the bootstrap to that device, requires the gateway's redirect into `/_r/<lease tag>/`, and binds the digest of the returned `__Host-ycoding-preview` cookie to that lease.
4. Every later request must be under `/_r/<lease tag>/` and carry exactly one preview cookie whose lease has that tag, origin, owner, and device. The connector strips the prefix before dispatching and rejects a prefix that is not its current lease for that origin.

The lease path and cookie binding is misrouting rejection: a request with a stale path, a stale cookie, or a cookie from another lease is never dispatched. It does not isolate apps from one another; isolation comes only from never reusing an origin. Apps must use relative URLs, which stay under the lease prefix; an absolute-path URL leaves it and fails closed with `404`. The gateway rewrites same-origin redirects into the prefix.

An unlisted or never-bound origin answers `404`; an ended or expired binding, an expired lease, or a dead lease tag answers `410`; an unknown, used, or revoked credential answers `401`; a cookie whose live lease has a different tag answers `409`. None of these contacts a device. The Worker accepts only GET and HEAD (`405` otherwise), rejects upgrades (`426`) and request bodies, enforces the gateway's 64 KiB request and 1 MiB response bounds, forwards only the gateway's allowlisted request and response headers, drops app cookies, adds `cache-control: no-store`, and logs no ticket, cookie, query string, or body; Workers Logs are disabled for it. Revoking an app ends its binding; connector disconnection, MCP disablement, and device revocation end every binding of the device. Each also deletes the affected leases, and none frees an origin. The relay protocol is specified in [`packages/remote/CONTRACT.md`](../packages/remote/CONTRACT.md#34b-local-app-preview).

A connector serves previews only when `appPreview` in its `remote.json` lists exactly the relay's origins and at least one loopback port, and the relay acknowledges that list on the current connection. Only registrations on an allowlisted port receive an origin; other registrations stay usable through `local_app_http`, but `local_app_open` fails. The connector answers `404` for a relayed path that is not already in normalized form, so encoded or literal dot segments never reach the gateway's route check. See [Remote access configuration](../docs/configuration.md#relay-mcp).

## Deployment prerequisites

Live preview is disabled. `PREVIEW_ORIGINS` is empty in both checked-in Wrangler files, the release workflow deploys the preview Worker only when the `YCODING_APP_PREVIEW_DEPLOY` repository variable is `true`, and connectors have no `appPreview` entry. The checked-in deployment configures no preview host and does not configure or prove ownership of an isolated local-app preview namespace. The main authentication origin is not an acceptable host for arbitrary app HTML. Enabling preview needs owner approval and all of the following:

1. Owned, HTTPS preview origins that isolate every registration from the authentication site and from other registrations: an owned isolated domain with one provisioned exact host per future registration. Do not reuse an origin after a registration, revocation, disconnection, or restart; the directory enforces this, so the pool size is the total number of previews the deployment can ever serve. Sibling subdomains alone do not prevent parent-domain cookie injection; establish an effective public-suffix boundary or separate registrable sites and verify browser isolation.
2. DNS and TLS for those exact origins, plus host-scoped routing of only those hosts to the preview Worker. Do not route arbitrary hosts or expose an upstream loopback listener directly. Preview responses need their own scoped frame policy rather than the main site's default X-Frame-Options denial.
3. The same exact origin list in the relay's and the preview Worker's `PREVIEW_ORIGINS` and in each connector's `appPreview.origins`, and exact resource `frameDomains`, with the actual host's iframe justification and review where required. MCP resource reads and template preloading receive the configured list.
4. Verification of bootstrap-cookie acceptance, nested-frame policy (`appPreview.frameAncestors` must list every ancestor origin of the embedded frame), app navigation, assets, API calls, expiry, and revocation inside the intended chat client.

A single `workers.dev` hostname is one origin, so it can serve at most one preview ever under this rule. A `workers.dev` hostname of the relay's own account can also set cookies for the relay Worker's `workers.dev` alias while `workers_dev` is `true` in `infra/cloudflare/wrangler.jsonc`; such a host additionally requires setting that to `false`. Enabling also requires connectors at v0.10.22 or later; an older connector never advertises the capability and receives no preview request. Operator steps are in [Remote relay deployment](../docs/remote-deployment.md#app-preview-worker).

Source tests exercise the Worker, directory, relay, connector, gateway, and a disposable loopback app without a deployed origin. No public origin, persistent access, or live chat rendering follows from them. See the [official host UI policy](https://developers.openai.com/plugins/build/chatgpt-ui) and [iframe guidelines](https://developers.openai.com/plugins/plugin-guidelines#iframes-and-embedded-pages).

## Verification

- `packages/cli/test/remote-local-app.test.ts` checks registration, containment, headers, cancellation, and limits.
- `packages/cli/test-integration/remote-local-app.test.ts` checks disposable real HTTP services and binary assets.
- `packages/cli/test/remote-mcp-apps.test.ts` checks tool, lease, resource, and private-metadata behavior.
- `packages/cli/test/remote-bridge.test.ts` checks how relay authorization failures during grant resolution and app requests are classified.
- `packages/cli/test/remote-mcp-app-flow.test.ts` checks the composed MCP and HTTP gateway flow.
- `packages/remote/test/app-preview.test.ts` checks bootstrap, cookie, grant, origin binding, lease prefix, and CSP boundaries.
- `packages/remote/test/preview.test.ts` checks the preview relay frames, origin lists, request headers, and result bounds.
- `infra/cloudflare/test/preview-directory.test.ts`, `preview-relay.test.ts`, and `preview-worker.test.ts` check single-use origin allocation and persistence, pool exhaustion, single-use tickets, lease-bound cookies and paths, misrouting rejection, expiry, revocation, device isolation, capability gating, methods, upgrades, header allowlists, and size bounds.
- `packages/cli/test/remote-app-preview.test.ts` checks disabled defaults, relay acknowledgment, the port allowlist, digest-only frames, distinct origins per registration, burned origins across revocation and restart, and `preview_exhausted`.
- `packages/cli/test-integration/remote-app-preview.test.ts` checks the composed Worker, relay, connector, gateway, and disposable loopback app flow, including relative navigation under the lease prefix, absolute-path failure, traversal, SSRF, method, upgrade, header, size, and grant boundaries.
- `packages/cli/script/local-http-app/verify.mjs` checks rendering in a simulated host. It does not establish actual ChatGPT support.
