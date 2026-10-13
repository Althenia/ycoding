# @ycoding-ai/client

TypeScript clients for YCoding's HTTP API and revision-5 binary local wire.

## Entrypoints

- `@ycoding-ai/client`: zero-Effect Promise client using `fetch`.
- `@ycoding-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.
- `@ycoding-ai/client/v5`: local binary revision-5 client with the Promise method surface, exact contract handshake, typed errors, bulk results, and bounded event/log iterators.

## Binary local client

Construct `YCoding.make({ endpoint, location })` from authenticated discovery data, or supply `discover: async () => endpoint`. An endpoint contains the advertised HTTP base URL and optional Basic authentication. Optional `wireRevision` and `contractDigest` discovery fields must match the current contract. The adapter opens only `/ws/v5/local` and verifies Hello/Ready before application requests. Basic credentials remain upgrade headers, not URL parameters or model-visible diagnostics.

`client.transport.ready()` waits for Ready. `client.transport.reconnect()` replaces the socket owner and invokes discovery again; it does not resend requests. A lost transmitted result rejects with `V5ClientError.status === "unknown"`; work cancelled before transmission is `"unsent"`. Domain rejections retain their decoded typed error objects. `RequestOptions.signal` cancels connection-owned delivery, not Session execution or mutation admission. Use `session.interrupt` explicitly for interruption. Call `client.transport.close()` to release timers, sockets, pending work, and stream buffers.

Location operations use an explicit request selector, directory/workspace headers, the configured client Location, or the client process working directory. Session scopes use backend-owned Session placement; Form scopes identify the owning Session. Global Form reply/cancel require the protocol's Location selector and otherwise reject explicitly as unsupported before transmission.

`event.subscribe()` delivers a client-local `server.connected` notification derived from Ready before decoded `PublicEvent` values. The wire carries no `server.connected` event. `session.log()` delivers decoded `SessionLogItem` values and succeeds only after StreamEnd; disconnect is incomplete. Iterator return releases local interest and sends `event.unsubscribe`. Queue exhaustion and source-epoch changes fail explicitly, requiring canonical reconciliation. Snapshot watermark, paging, and projection reconciliation remain consumer-owned.

Raw asset methods require terminal typed metadata from the connection API; missing metadata rejects as unsupported rather than fabricating MIME or content. Attachments convert completed bytes into the existing client result, while file reads return raw bytes. Specialized PTY and browser bridge protocols remain outside the application socket.

Run `bun run generate:v5` to derive method bindings, result-envelope selection, and lossless enum associations from the operation manifest and current Promise types. The binary runtime imports neither the HTTP implementation nor Core/Server. Both transports remain independently selected entrypoints during the coordinated client cutover; the binary entrypoint has no HTTP/SSE fallback.

Run the client test scope with `bun test --cwd packages/client ./test` and the typecheck with `bun run --cwd packages/client typecheck`. The v5 tests in `test` use an in-memory protocol peer. Run the listening native WebSocket suite separately with `bun run --cwd packages/client test:integration`.

Run Rust interoperability with `bun run --cwd packages/client test:integration:rust`. This command requires `YCODING_V5_TEST_URL` and fails immediately when it is unset. Start a disposable Rust runtime socket test server with ready Core and the standard dispatcher, then run `YCODING_V5_TEST_URL="$URL" bun run --cwd packages/client test:integration:rust`. Supply `YCODING_V5_TEST_PASSWORD` through the environment when local authentication is enabled. The suite verifies handshake, bootstrap results, and a typed missing-Session rejection without executing provider work or writing Session data.

## HTTP clients

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@ycoding-ai/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@ycoding-ai/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, YCoding, Prompt } from "@ycoding-ai/client/effect"

const client = yield * YCoding.make({ baseUrl: "https://ycoding.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```
