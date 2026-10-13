# Hosted remote contract

Canonical application messages, operation IDs, roles, scopes, settlement, constraints and wire limits are generated from `protocol/ycoding/v5/*.proto`. Both socket legs use the public sans-IO `Connection` from `packages/protocol/src/v5/connection`. The relay imports no backend execution code and never resolves a browser-selected filesystem Location.

## Sockets and authority

| Surface                               | Authentication                                                   | Authenticated peer role |
| ------------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| `GET /ws/v5/client?device=<deviceID>` | Same-origin browser session cookie and selected device ownership | `REMOTE_CLIENT` (2)     |
| `GET /ws/v5/agent`                    | Device bearer access credential                                  | `AGENT` (4)             |

The relay endpoint role is `RELAY` (3). Every other socket path returns 404, including versionless and other-version paths. Text messages fail closed. Each binary WebSocket message contains one strictly validated Frame; there is no alternate codec or revision negotiation.

Hello proposes canonical receive windows and carries revision, contract digest and role, without an established epoch or ledger. The relay validates the claimed role against authenticated upgrade metadata and produces Ready with a fresh connection epoch and relay process source epoch. The initiator confirms Ready receipt before application delivery. The generated Connection owns the five-second handshake deadline and established epoch/ordinal validation.

The HTTP router strips all supplied `x-ycoding-*` routing headers and selects one Durable Object by authenticated owner/device. The object enforces that identity again. Browser authority is read freshly for every request, cancellation and notice operation; agent authority is checked before forwarding or applying agent delivery. Expiry is checked before and after awaited authority reads. Event/control recipient authority may be reused for at most five seconds. Backend Session placement, managed-child restrictions and pending approval/form ownership remain backend dispatcher responsibilities. Starting the connector grants its owner access to every existing and future Session on that backend.

## Requests, results and settlement

Only generated remote-role operations are admitted. Notice operations are relay-local; all other supported RPCs go to the same authenticated device's agent. Request IDs are connection-local monotonic decimal strings. The relay maps them in bounded state while retaining the original browser ID. Scope and encoded domain payload bytes pass unchanged; only the small request/result/transfer routing wrappers are re-encoded.

`event.unsubscribe` is relay-local after validating that the authenticated client owns the supplied accepted identity at the outer Session scope. It removes only that client's interest; the connector releases a shared observer when its last client leaves.

Reads do not wait for mutation authorization lanes. Mutations use one arrival-order lane per Session, or per connection when sessionless. Notices use one lane per browser connection. Each typed bulk transfer has its own ordered forwarding lane, with transfer identity installed before awaited work. Results on unrelated requests are not queued behind admission lanes.

Typed-message bulk is forwarded as validated Start/Piece/End frames without relay reassembly. The endpoint owns exact byte/count validation, typed decoding and bounded reassembly release. Every forwarded frame retains an upstream receipt obligation until the downstream receiver consumes it. A fanout source is consumed only after all recipient obligations release.

Asset reads forward nonterminal `Result.asset_metadata` and raw ASSET Start/Piece/End frames without relay reassembly. The connector builds the declaration with `encodeAssetMetadata` using the operation's canonical typed Result. Metadata does not settle the request; successful BulkEnd returns that same typed Result and a `bulkComplete` carrying the raw bytes. `takeAsset(connection, delivery, owner)` reserves the endpoint consumer's raw-body, metadata backing-buffer and wrapper ownership before `releaseBulk`. A failed reservation leaves the connection owner intact; the returned consumer releases its charge once after use. Cancellation releases incomplete metadata/body owners without reporting partial success.

## Subscriptions and events

The relay sends an immutable full `SubscriptionSnapshot` for each authenticated client before forwarding its EVENTS admission and after subscription changes or disconnect. Snapshot client identity comes from the trusted connection, not browser input. The connector applies `updateRelayInterests`, subscribes the backend for new union members, then calls `registerRelayInterest` with the backend-accepted identity and canonical source epoch. Repeated clients share that observer; an empty snapshot calls `releaseRelayClient`, and the connector releases removed backend observers.

After backend acceptance of a new Session union member, AGENT sends scoped `Control.resyncRequired { scope, sourceEpoch }` with the actual canonical backend epoch before the first successful EVENTS Result. Additional clients reuse that advertisement and accepted observer without emitting another invalidation. This existing-wire marker is not a canonical projection and does not replace the client's snapshot read. The relay registers both receive and send identities with the Result's subscription ID and that explicit epoch. Missing epoch advertisements reconstruct the affected client with 1012 rather than substituting Ready or EventBatch values. A subsequent scoped invalidation or changed advertised epoch reconstructs affected clients; a mismatched incoming batch fails closed.

The relay forwards each accepted complete batch with `forwardEventBatch`, preserving subscription identity, Session scope, source epoch, event IDs, order and payload bytes. Each downstream ticket retains the upstream receipt and aggregate charge until `eventBatchReleased`, including queued teardown and disconnection. SERVER, AGENT and RELAY can send finite StreamEnd; clients cannot. Finite completion follows prior event responsibility and retains its upstream receipt until the downstream marker is consumed. Endpoint projection, subscribe-before-snapshot hydration and canonical reconciliation remain client responsibilities.

Queued cancellation is unsent. Transmitted unresolved work is unknown, not rolled back. Disconnect, replacement and Durable Object reconstruction clear volatile ownership; reconstruction closes sockets with 1012 and requires fresh epochs. No transmitted request is automatically replayed. Late settled results and orphan cancelled bulk pieces use the generated counted-drop behavior. A live agent conflict closes the newcomer with 4409.

## Accounting and limits

The generated Connection enforces complete encoded frame caps (128 KiB from client/relay-to-agent and 1 MiB from agent), 16 KiB handshake messages, 32 KiB retained handshake reservation, separate normal/event/bulk/tiny windows, queue bounds, rolling frame rates, pending-request limits and consumption deadlines. Queued/prepared frames carry conservative reservations. Socket-handed frames carry exact encoded byte charges, including results and derived controls. Native send does not release them; cumulative consumption Credit or the specified tiny receipt boundary does.

Each owner/device object has a shared 32 MiB application reservation and at most 64 browser peers. The reservation covers admitted buffers, decode/encode copies, retained forwarding metadata, cached status bytes, queued and handed delivery responsibility and bounded notice materialization. Reservations are taken before application-controlled decoding, copying or asynchronous retention. Exhaustion fails closed; it does not truncate, silently defer or replay controls. Cached status is volatile; persistent notice state uses the existing SQLite/KV store.

Cloudflare's native WebSocket receive ceiling is a separate 32 MiB platform limit. Native receipt/allocation precedes the application callback. The smaller application frame checks cannot prove native pre-receipt rejection, native socket drain, total JavaScript heap size, allocator overhead or whole-Worker memory usage.

## Notices

`notice.subscribe`, `notice.list`, `notice.read` and `notice.readAll` are `REMOTE_CLIENT`-only Machine-scoped generated RPCs (5039–5042). They never reach the agent. Subscribe/list return `ConnectorNoticePage`; read/readAll return `ConnectorNoticeSettlement`. List's generated `before` field uses an empty LosslessString for the initial page. Notice controls use foundation `Notice`, with bounded added/removed/presentation batches.

The existing notice, notice-sync, attention-alert and completion KV records remain authoritative. Completion baseline pages are silent; subsequent newer receipts append once per Session watermark. Reads do not reset completion deduplication. Attention notices coalesce per unread Session and repeated alerts use the stored ten-minute/changed-need rule. Titles and attention needs remain bounded presentation data; they are not notice identity. A browser receives one fallback presentation per alert only when its own push registration did not accept delivery. Push admission is bounded to twenty alerts per minute plus category overflow summaries.

Completion sequences and timestamps exceeding the existing store's safe integer range fail with LIMIT rather than undergoing a lossy conversion. Supporting a larger stored range requires an approved storage transition.

## HTTP surfaces

HTTP auth/device/push bodies remain JSON. Google OIDC, invite/key sign-in, browser session refresh/logout, owner device listing/revocation/deletion, one-use device enrollment/challenge/token/refresh, push registration/renewal/removal, admin push testing and health remain on their existing `/api/*` and `/health` routes with their existing authentication, origin, validation and credential-retention rules. Secrets remain in request bodies or authorization headers, never socket URLs.

Static public assets remain under the existing `ASSETS` binding. Worker-first `/api`, `/ws` and `/health` prefixes cannot fall through to the SPA shell.

Authenticated message/attachment HTTP reads require a separate live-connection scoped HTTP bulk-credit owner and return 503 while that adapter boundary is unavailable. Binary attachment reads use the asset contract above. Neither boundary uses a JSON stream or alternate socket protocol.

## Verification

The `beta` Wrangler environment selects Worker `ycoding-cloud-beta` on custom domain `beta.ycoding.althenia.app`, with D1 `ycoding-beta-db` and same-Worker `DeviceRelay` bindings. A binding without `script_name` refers to its current Worker, so beta does not bind to production's Durable Object namespaces. Assets and declarative SQLite exports inherit unchanged from the top-level configuration. The beta database ID is an explicit placeholder and must be replaced before deployment. Beta secrets and auth/provider configuration must be supplied for that named environment; production credentials are not a beta configuration source.

After approval for external provisioning and deployment, an operator creates the database with `wrangler d1 create ycoding-beta-db --config infra/cloudflare/wrangler.jsonc`, places its returned ID in `env.beta.d1_databases[0].database_id`, applies the existing migrations with `wrangler d1 migrations apply ycoding-beta-db --remote --env beta --config infra/cloudflare/wrangler.jsonc`, then deploys matched built assets with `wrangler deploy --env beta --config infra/cloudflare/wrangler.jsonc`. These commands are operator actions, not local verification.

`bun infra/cloudflare/test/integration/relay-local.ts` runs isolated local workerd, existing local D1 migrations, real Durable Objects and protocol-conformant agent/browser Connection peers. Its fixture directory, credentials and provider stand-in are local to that run and cleaned afterwards. This checks the relay boundary; it does not prove live Rust connector or browser-rendered behavior.

`bun run test:remote` checks codecs, role/operation conformance, HTTP input contracts and the binary binding. `bun run check:cloudflare` checks Worker unit tests, generated Worker types and the dry-run build. The latter requires the web owner's built static assets. A matched hosted/local/browser release and live Rust connector acceptance are separate integration requirements.
