# @ycoding-ai/client

TypeScript clients for YCoding's HTTP API and revision-5 binary local wire.

## Entrypoints

- `@ycoding-ai/client`: zero-Effect Promise client using `fetch`.
- `@ycoding-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.
- `@ycoding-ai/client/v5`: local binary revision-5 client with the Promise method surface, exact contract handshake, typed errors, bulk results, and bounded event/log iterators.

## Binary local client

Construct `YCoding.make({ endpoint, location })` from authenticated discovery data, or supply `discover: async () => endpoint`. An endpoint contains the advertised HTTP base URL and optional Basic authentication. Optional `wireRevision` and `contractDigest` discovery fields must match the current contract. The adapter opens only `/ws/v5/local` and verifies Hello/Ready before application requests. Basic credentials remain upgrade headers, not URL parameters or model-visible diagnostics.

`client.transport.ready()` waits for Ready. `client.transport.reconnect()` replaces the socket owner and invokes discovery again; it does not resend requests. A lost transmitted result rejects with `V5ClientError.status === "unknown"`; work cancelled before transmission is `"unsent"`. Domain rejections retain their decoded typed error objects. `RequestOptions.signal` cancels connection-owned delivery, not Session execution or mutation admission. Use `session.interrupt` explicitly for interruption. Call `client.transport.close()` to release timers, sockets, pending work, and stream buffers.

Location operations use an explicit request selector, directory/workspace headers, the configured client Location, or the client process working directory. Session scopes use backend-owned Session placement. Session-owned Forms identify their owning Session; Forms with `sessionID: "global"` use the existing `globalForm` scope with the selected directory and optional workspace identity. All Form methods, including reply and cancel, use that same scope. Supply `x-ycoding-directory` (URI-encoded) and optional `x-ycoding-workspace` request headers to override the configured client Location. The runtime rejects a Form from another Location or owner; a global Form is not a globally addressable Form ID.

`YCODING_TEST_RUST_RUNTIME="$PWD/rust/target/debug/ycoding-runtime" bun test --cwd packages/client ./test-integration/v5-forms-rust.integration.test.ts` launches a disposable production runtime and verifies global Form reply/cancel, Location and owner rejection, and reconnect without provider execution.

`event.subscribe()` delivers a client-local `server.connected` notification derived from Ready before decoded `PublicEvent` values. The wire carries no `server.connected` event. `session.log()` delivers decoded `SessionLogItem` values and succeeds only after StreamEnd; disconnect is incomplete. Iterator return stops application delivery, releases buffered projection values and sends `event.unsubscribe`. The accepted wire identity remains owned until the canonical StreamEnd or connection shutdown. Late batches during that closing interval are discarded with consumption credit, without allocating projection buffers; the unsubscribe Result alone is not the stream terminal. Queue exhaustion and source-epoch changes fail explicitly, requiring canonical reconciliation. Snapshot watermark, paging, and projection reconciliation remain consumer-owned.

`YCODING_TEST_RUST_RUNTIME="$PWD/rust/target/debug/ycoding-runtime" bun test --cwd packages/client ./test-integration/v5-snapshot-rust.integration.test.ts` verifies subscription return followed by inline and large skill-content snapshots on the same real-runtime connection, without provider execution.

Result decoding preserves HTTP JSON absence: an `UndefinedOr` wire `none` branch is `undefined` and its containing object field is omitted; a `NullOr` `clear` branch is `null`. Missing optional fields and unwrapped missing result-path fields remain absent or `undefined`; present empty strings, collections and objects, `false`, zero, and explicit null values retain their values.

Raw asset methods require terminal typed metadata from the connection API; missing metadata rejects as unsupported rather than fabricating MIME or content. Attachments convert completed bytes into the existing client result, while file reads return raw bytes. Specialized PTY and browser bridge protocols remain outside the application socket.

The protocol machine consumes asset metadata, BulkStart, each BulkPiece, and BulkEnd after transferring them to its bounded asset owner. The socket adapter consumes ordinary inline Results only, resolves raw asset content at terminal success, and releases the completed transfer. Empty bodies, exact 64 KiB pieces, final short pieces and transfers beyond the bulk window preserve the same connection for later requests.

Local `session.prompt` and `session.command` accept file references in `files: [{ uri: pathToFileURL(absolutePath).href, name? }]`. The `file:` URI identifies a path readable on the backend machine; local attachments need not be inside the Session directory. Use `node:url`'s `pathToFileURL` to preserve spaces, percent signs and fragment characters; do not base64-inline large files or percent-encode path separators. The backend reads and materializes the attachment during admission: retain the source file until admission is confirmed, and reconcile an unknown outcome before deleting it. Image admission preserves bytes within configured image limits and normalizes or rejects larger images according to configuration. The inline request budget stays unchanged, and operation 5023's upload references belong to remote peers, not this local path.

Run `bun run generate:v5` to derive method bindings, result-envelope selection, and lossless enum associations from the operation manifest and current Promise types. The binary runtime imports neither the HTTP implementation nor Core/Server. Both transports remain independently selected entrypoints during the coordinated client cutover; the binary entrypoint has no HTTP/SSE fallback.

Run the client test scope with `bun test --cwd packages/client ./test` and the typecheck with `bun run --cwd packages/client typecheck`. The v5 tests in `test` use an in-memory protocol peer. Run the listening native WebSocket suite separately with `bun run --cwd packages/client test:integration`.

Run Rust interoperability with `bun run --cwd packages/client test:integration:rust`. This command requires `YCODING_V5_TEST_URL` and fails immediately when it is unset. Start a disposable Rust runtime socket test server with ready Core and the standard dispatcher, then run `YCODING_V5_TEST_URL="$URL" bun run --cwd packages/client test:integration:rust`. Supply `YCODING_V5_TEST_PASSWORD` through the environment when local authentication is enabled. The suite verifies handshake, bootstrap results, and a typed missing-Session rejection without executing provider work or writing Session data.

`YCODING_TEST_RUST_RUNTIME="$PWD/rust/target/debug/ycoding-runtime" bun test --cwd packages/client ./test-integration/v5-attachments-rust.integration.test.ts` launches disposable production runtimes and verifies managed attachment admission, a large image referenced outside its Session directory, exact read bytes, bulk-window progress, repeated transfer release and same-connection follow-up RPCs. It admits prompts with `resume: false` and runs no provider work.

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
