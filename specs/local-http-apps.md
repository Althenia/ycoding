# Preview wire boundary

The generic Preview extension connects an authenticated agent, the relay, `PreviewDirectory`, and the isolated preview Worker. Its frame shapes, limits, and errors are specified in [Remote access contract, section 3.4b](../packages/remote/CONTRACT.md#34b-local-app-preview).

## Authority and lifecycle

Only an enrolled agent connection can advertise `preview.state`; browser relay frames cannot carry preview controls. The relay enables that capability only when the advertised exact HTTPS origins equal its configured `PREVIEW_ORIGINS` set. Owner and device identity come from the authenticated connection, not frame input. Native Dots access is independent of this extension.

`preview.allocate` permanently binds a never-used configured origin to one owner, device, and registration digest. `preview.lease` associates that live binding with a one-use ticket digest, lease tag, and expiry. Expiry, revocation, agent close or replacement, and device revocation never free an origin for another registration.

The Worker redeems a bootstrap ticket on its bound origin, requires the agent's redirect into `/_r/<lease tag>/`, and binds the returned preview-cookie digest to that lease. Later requests require that prefix and exactly one cookie bound to its origin and lease. Invalid, expired, or mismatched credentials fail before device contact. These checks do not use an MCP OAuth grant.

Only bounded GET and HEAD requests cross `preview.http`; bodies, upgrades, arbitrary URLs, and unlisted headers are rejected. The Worker forwards only the allowed response headers and bounded base64 body. A valid lease is routing authority, not a generic local-network proxy or evidence that an upstream application rendered.

## Functional limits

The current CLI has no registration, lease-issuance, capability-advertisement, or preview HTTP-dispatch producer. Its `remote.json` schema contains no preview settings. The browser client offers no local-app preview surface. There is no current command that publishes a local service through this wire boundary; deploying the Workers alone does not supply one.

The retained wire types, lease directory, relay, preview Worker, and preview gateway helpers do not establish an end-to-end application integration or external host interoperability. WebSocket/SSE application tunnels, cookie-based upstream login, and arbitrary local-port exposure are not provided by this boundary.

## Deployment prerequisites

Both checked-in Wrangler configurations leave `PREVIEW_ORIGINS` empty. The preview Worker has no checked-in host routes, and release deployment is gated by `YCODING_APP_PREVIEW_DEPLOY`. Infrastructure configuration requires approval of isolated owned HTTPS origins, DNS/TLS and exact host routing, and matching origin lists in the relay and preview Worker. Each origin serves at most one registration ever; sibling subdomains alone do not establish cookie isolation. The authentication site's origin is not a preview origin.

An authenticated advertising agent must independently implement the contract before valid allocations, leases, bootstrap responses, or HTTP responses can exist. No replacement producer is defined here. See [Remote relay deployment](../docs/remote-deployment.md#app-preview-worker) for the retained infrastructure inputs and rejection-only checks.

## Verification

- [`packages/remote/test/preview.test.ts`](../packages/remote/test/preview.test.ts) covers frame parsing, exact origins, request headers, and result bounds.
- [`packages/remote/test/app-preview.test.ts`](../packages/remote/test/app-preview.test.ts) covers retained gateway helpers; it does not prove a current CLI producer.
- [`infra/cloudflare/test/preview-directory.test.ts`](../infra/cloudflare/test/preview-directory.test.ts), [`preview-relay.test.ts`](../infra/cloudflare/test/preview-relay.test.ts), and [`preview-worker.test.ts`](../infra/cloudflare/test/preview-worker.test.ts) cover allocation, permanent origin binding, ticket/cookie/lease checks, authenticated device routing, expiry, revocation, and HTTP limits with synthetic producers.

These source checks establish no deployed preview origin or live external-host rendering.
