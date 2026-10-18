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

The local dispatcher allows at most four concurrent requests per app and sixteen in total. Each request is limited by the remaining registration lifetime and a 15-second deadline. Its local body bounds are 256 KiB request and 2 MiB response. The MCP exchange further limits decoded request bodies to 64 KiB and decoded response bodies to 1 MiB, within the MCP envelope limits.

Status, content types, binary bytes, cache validators, range metadata, and permitted content-disposition values are retained. Decompressed response length is recalculated. HEAD retains a valid unencoded representation length without sending a body. Hop-by-hop headers, server credentials, authentication challenges, and app cookies are not forwarded. The verified preview Origin and Referer translate only to the registered upstream origin.

Redirects are never followed by the local dispatcher. A redirect can return to the same registered origin only if its destination and effective method remain permitted. External origins, other ports, and paths outside registration are rejected. Existing application CSP and X-Frame-Options are preserved; frame restrictions can make an app incompatible with embedding.

WebSocket upgrades and live SSE are unsupported and rejected. The connector's own WebSocket is not an application WebSocket tunnel. Cookie-based app sessions, upstream login flows, service workers, and external resource origins are outside this HTTP-only presentation contract. The app wrapper does not recreate application-specific data or UI.

## Embedded presentation

Only `local_app_open` links `ui://ycoding/local-http-app/v1.html` through `_meta.ui.resourceUri`. The resource is `text/html;profile=mcp-app`. It contains the shared MCP Apps bridge and a trusted status wrapper, not the upstream application's HTML.

The wrapper receives model-visible view state separately from private `_meta.localApp` bootstrap metadata. It accepts only a declared exact preview origin and its bounded bootstrap URL. It embeds the app in a sandboxed frame with scripts, same-origin behavior, and forms; it grants no popup or top-navigation capability and does not forward the app's messages to the MCP host. A manual status refresh uses only `local_app_status`. Expiry, revocation, or an invalid result removes the frame. A frame-load event is not proof that the application worked.

The gateway redeems a single-use bootstrap ticket for a distinct, short-lived `__Host-ycoding-preview` cookie with Secure, HttpOnly, SameSite=None, and Partitioned attributes. It then redirects to the clean entry path. OAuth and device credentials remain on the server. Every app HTTP request checks the lease and its grant again; state-changing requests require the exact preview Origin. A browser that cannot retain the required cookie fails closed without a persistent URL-token fallback.

The gateway adds a restrictive same-origin CSP and intersects it with application policy. It does not remove an application's framing prohibition. The wrapper's `frameDomains` contains only configured exact preview origins; its connection and resource-domain lists are empty.

## Deployment prerequisites

The checked-in deployment configures `ycoding.althenia.app` and disables Worker preview URLs. It does not configure or prove ownership of an isolated local-app preview namespace. The main authentication origin is not an acceptable host for arbitrary app HTML.

A live deployment needs all of the following:

1. Owned, HTTPS preview origins that isolate every registration from the authentication site and from other registrations. Do not reuse an origin after a registration or process restart. Sibling subdomains alone do not prevent parent-domain cookie injection; establish an effective public-suffix boundary or separate registrable sites and verify browser isolation.
2. DNS and TLS for those exact origins, plus host-scoped routing to the authenticated preview gateway. Do not route arbitrary hosts or expose an upstream loopback listener directly. Preview responses need their own scoped frame policy rather than the main site's default X-Frame-Options denial.
3. A configured trusted preview issuer and exact resource `frameDomains`, with the actual host's iframe justification and review where required. MCP resource reads and template preloading must receive the matching policy.
4. Verification of bootstrap-cookie acceptance, nested-frame policy, app navigation, assets, API calls, expiry, and revocation inside the intended chat client.

Source fixtures exercise the registry, MCP exchange, gateway, and wrapper without enabling these external routes. No public origin, persistent access, or live chat rendering follows from those fixtures. See the [official host UI policy](https://developers.openai.com/plugins/build/chatgpt-ui) and [iframe guidelines](https://developers.openai.com/plugins/plugin-guidelines#iframes-and-embedded-pages).

## Verification

- `packages/cli/test/remote-local-app.test.ts` checks registration, containment, headers, cancellation, and limits.
- `packages/cli/test-integration/remote-local-app.test.ts` checks disposable real HTTP services and binary assets.
- `packages/cli/test/remote-mcp-apps.test.ts` checks tool, lease, resource, and private-metadata behavior.
- `packages/cli/test/remote-mcp-app-flow.test.ts` checks the composed MCP and HTTP gateway flow.
- `packages/remote/test/app-preview.test.ts` checks bootstrap, cookie, grant, origin, and CSP boundaries.
- `packages/cli/script/local-http-app/verify.mjs` checks rendering in a simulated host. It does not establish actual ChatGPT support.
