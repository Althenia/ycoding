# Revision 5 platform operations

`protocol/ycoding/v5/platform.proto` defines 53 baseline typed operations and local device enrollment, covering the browser, isolatedBrowser, keepAwake, fs, vcs, projectCopy, pty, shell, health, server, debug and remote Protocol groups. The baseline and two excluded native upgrade endpoints retain the 55-member manifest slice. Service declarations describe binary WebSocket operation descriptors, not gRPC servers. Generated messages and descriptors do not implement dispatch, authorization or domain conversion.

## Operation IDs and dispositions

IDs are explicit, permanent allocations from the platform range 3000–3999. No other IDs are allocated or reserved by this contract.

| Group           | Typed operation ID table                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| browser         | action=3000; close=3001; control=3002; forget=3003; observe=3004; open=3005; release=3006; start=3007; status=3008; stop=3009; tabs=3010 |
| debug           | location=3011; location.evict=3012                                                                                                       |
| fs              | find=3013; list=3014; read=3015                                                                                                          |
| health          | get=3016; stop=3017                                                                                                                      |
| isolatedBrowser | action=3018; control=3019; observe=3020; start=3021; status=3022; stop=3023; tabs=3024                                                   |
| keepAwake       | get=3025; set=3026                                                                                                                       |
| projectCopy     | create=3027; refresh=3028; remove=3029                                                                                                   |
| pty             | connectToken=3030; control=3031; create=3032; get=3033; list=3034; remove=3035; update=3036                                              |
| remote          | get=3037; set=3038; enroll=3053                                                                                                          |
| server          | get=3039                                                                                                                                 |
| shell           | create=3040; get=3041; list=3042; output=3043; remove=3044; timeout=3045                                                                 |
| telemetry       | append=3046; consent.get=3047; consent.set=3048; list=3049                                                                               |
| vcs             | branch=3050; diff=3051; status=3052                                                                                                      |

`browser.connect` and `pty.connect` have EXTERNAL disposition and no application operation ID. Their Chrome-origin first-frame authentication and single-use ticketed PTY WebSocket contracts remain native external boundaries. `pty.connectToken` is a typed issuance operation; its request retains the source's `x-ycoding-ticket: "1"` marker as a closed `headers.x_ycoding_ticket` field, alongside Location, ownership, generation, access and fence inputs.

`fs.read` has STREAM disposition with `ASSET_BULK` delivery. Its explicit `params.path` comes from the `/api/fs/read/*` wildcard and names the Protocol source owner as a domain obligation. The Location query remains explicit. Its canonical typed result contains `mime` and `byteCount`. Nonterminal `Result.asset_metadata` declares that metadata Result plus matching MIME and exact length before a correlated raw BulkStart/BulkPiece/BulkEnd body. Only exact BulkEnd settles success, including zero bytes with zero pieces.

`ycoding-protocol::Asset<FsReadResult>` owns the validated metadata and bounded exact bytes. The runtime's typed asset registration is:

```rust
dispatcher.handle_asset::<FsReadRequest, FsReadResult, _, _>("fs.read", handler)
```

The asynchronous handler returns `Result<Asset<FsReadResult>, Failure>` and owns read/aggregate reservations before materialization. The additional authenticated browser HTTP asset surface is backend-owned; it does not replace this typed operation.

`health.get`, `health.stop` and `server.get` preserve their live Protocol shapes. The authenticated `GET /health` bootstrap/readiness contract is a separate backend-owned HTTP surface, not an additional operation in this manifest slice. Shutdown retains the exact target instance identity from `ServiceStatus.StopRequest`.

## Shapes, delivery and validation

Requests retain distinct params, query, payload and explicitly declared header messages. Named successes retain their source declaration association; anonymous results retain their source fields and Location envelopes. Empty successes use explicit messages. Optional collections use optional wrapper messages so absent and present-empty remain distinct. Unrestricted strings and map keys use LosslessString. Deliberately open shell metadata values use Value; typed requests, results and errors are not JSON encoded in bytes.

Integer fields use int64 or uint64 according to the source's numeric domain, including JavaScript safe-integer and source bounds. Finite-number fields preserve fractional values as double, including shell timestamps and exit values; they are not coerced to integers. Browser document generations, observation revisions, PTY generation/control fences, output byte offsets and input bounds retain their source constraints. Every descriptor includes endpoint-declared errors plus middleware-inherited UnauthorizedError and InvalidRequestError from `shared.proto`.

Browser and isolated-browser controls use Session scope. Machine state, health, server URLs, telemetry and connector controls use Machine scope. Filesystem, VCS, project-copy, PTY, shell and location eviction use Location scope; `debug.location` lists loaded locations at Machine scope. Keep-awake, telemetry, filesystem search and shell output permit REMOTE_CLIENT and RELAY only through the closed [connector allowlist](./wire-connector.md); every other platform descriptor is LOCAL_CLIENT-only. Results settle at COMPLETED. `telemetry.list` uses CURSOR for its opaque `before` token; `shell.output` uses OFFSET for its numeric byte cursor and limit; all other operations are UNPAGED. Typed bodies use TYPED_BULK, except the filesystem asset operation's ASSET_BULK.

`fs.find`, `shell.output` and `telemetry.{append,list}` also permit the exact closed remote roles. Role-specific scopes retain local Location defaults but constrain remote filesystem search to verified Session or advertised workspace Scope and remote shell output to its owning Session. Remote handlers reject Location-bearing input. Filesystem entries append optional URI at tag 3, preserving path/type tags 1/2; remote matches require that URI. The local Location result fields of `fs.find` and `shell.output` are optional on the wire and absent remotely; local handlers still supply them. Remote query limits, containment, owned-shell checks and stale-shell errors remain admission obligations, not a wider filesystem/shell authority.

Structural metadata enforces integer, text-unit and repeated-count bounds. Domain obligations retain the source identities of patterns, filters, transformations and refinements. They are not certified as enforced by structural decoding. Wire-to-domain conversion must validate those obligations before any handler executes and reject through the validation-error boundary. Conformance tests exclude that domain implementation, native browser/PTY protocols and live backend execution.

## Rust browser dispatch and composition

The local runtime registers all eleven `browser` operations and all seven `isolatedBrowser` operations. Handlers validate Session scope against the request, resolve known Sessions through Core, decode branded identifiers and semantic actions through Schema, and forward to the Core browser services. Responses retain semantic observation order, lossless strings, query-free page metadata, ownership leases, all generation fences, capture data, scripted-input labels, and exact-call settlement identity. Ownership failures map to `ForbiddenError`, stale fences and busy operations to `ConflictError`, malformed inputs to `InvalidRequestError`, and unavailable services to `ServiceUnavailableError` with `browser-extension` or `isolated-browser` service identity where that error is declared.

`Core.browser` accepts the backend-wide paired Chrome coordinator. `Core.isolated_browser` accepts a resolver from the stored Session's `Location.Ref` to the owning Location's isolated browser service. The handler never accepts a browser-supplied Location or constructs a second service graph. Uncomposed services return declared typed-unavailable outcomes; status and tabs descriptors retain their narrower declared errors. Composition owns the shared mode admission service, active-Session/Location ownership checks, the external extension transport, Session lifecycle cleanup, and shutdown. The browser and computer tool boundaries retain `skipReview`; deny decisions still block dispatch.

`rust/crates/runtime/tests/browser.rs` uses a scripted extension transport and an injected isolated executor, never installed Chrome. It proves input-to-wire-to-Core flows for each operation, error mapping, isolation fences, exact-call retries, pause/resume, pairing/stop/forget, and validation before dispatch. Core's browser lifecycle, concurrency, cancellation, and guardrail tests remain separate from the real-Chrome integration suite.

## Coverage and generation

`packages/protocol/test/platform-coverage.test.ts` compares the live Effect endpoint slice and the baseline manifest from `script/rust-parity/manifest.ts`, asserts exactly two EXTERNAL exclusions, verifies every field/type/presence/enum/error/descriptor association, and invokes requireConstraintCoverage for checked source fields. It verifies shared declaration reuse, asset wildcard/metadata boundaries, explicit ticket headers, paging and scopes. A source-order permutation must preserve canonical bytes and IDs.

`packages/protocol/test/wire-contract.ts` owns the shared live-AST projection used by resource and platform coverage. `platform-materialize.ts` performs an exact read-only canonical source check. Its explicit `--write-new` initialization refuses an existing canonical file; contract drift fails rather than rewriting IDs or field tags. Canonical files end in exactly one newline. Both generators reject message/enum name collisions after prost Rust case normalization or Buf TypeScript nested-name flattening, including schema export names. The explicit wrapper-name overrides are `browser.action` → `browser_action_Reply` and `isolatedBrowser.action` → `isolatedBrowser_action_Reply`; their domain ActionResult declarations retain their source names. Override coverage requires each override to resolve a real codec collision. Generate Rust/TS bindings through their owning generators and run `bun run --cwd packages/protocol generate:v5`; regenerate digest-bearing foundation vectors last through `python3 protocol/ycoding/v5/testdata/generate.py`.

`packages/remote/test/platform-conformance.test.ts` and `rust/crates/protocol/tests/wire_platform.rs` share independent binary corpora covering safe-integer browser fences, lone UTF-16 strings and map keys, absent versus empty PTY input collections, deliberately open fractional metadata values, typed-error enums, asset metadata and PTY viewport bounds. Digest-bearing negative vectors must retain their named rejection reasons in both languages; other foundation vectors remain byte-identical.

## Backend-owned device enrollment

`remote.enroll` (3053) permits **LOCAL_CLIENT only**, with Machine scope, MUTATION, COMPLETED, UNPAGED and TYPED_BULK. REMOTE_CLIENT, RELAY, AGENT and SERVER cannot originate it. The request is `payload: { relayOrigin, enrollmentID, code, name?, replace? }`. Origin is 1–2048 UTF-16 units; enrollment ID, code and optional name are 1–128 units. `replace` absent means false. The enrollment ID and optional name/replacement are required consumer refinements: `packages/cli/src/commands/remote.ts` declares them, and `commands/handlers/remote/enroll.ts:29–49` forwards the ID/name and explicitly creates or replaces the stored identity.

The backend validates and normalizes the relay origin, validates the relay's enrollment-code format, supplies a machine name when omitted, rejects an existing enrollment unless replacement is explicit, generates device keys, enrolls and stores the identity privately. Private-file, symlink/owner, origin binding, refresh/signing, deadline and revocation policy belong to the backend. The client never chooses a credential filename, generates keys or stores refresh material. Enrollment does not enable remote Session access: `remote.set` remains the explicit enable/disable operation.

Success is `data: RemoteDevice`, with required `deviceID`, `name`, `relayOrigin`, `enrolledAt`, `credentialState`, and optional `credentialExpiresAt`. Device ID/name are 1–128 units; origin is 1–2048. Times are nonnegative JavaScript-safe uint64 milliseconds. Credential state is a closed enum: not_authenticated=1, valid=2, expired=3, revoked=4. Expiry is absent when unreported; no private/public key, refresh token, access token, credential file, account email or raw relay response is returned. `remote_get_Result_data` appends optional `device` at tag 3 for CLI status without frontend credential-file reads; the existing state/message fields and `remote.set` semantics are unchanged.

Enrollment declares the closed error union `RemoteEnrollmentError`, `RemoteEnrollmentPartialFailure`, `ServiceUnavailableError`, `UnauthorizedError`, `InvalidRequestError`. `RemoteEnrollmentError { _tag: RemoteEnrollmentError, code }` codes are invalid_origin=1, invalid_code=2, already_enrolled=3, relay_rejected=4, relay_unavailable=5, key_failed=6, store_failed=7. `RemoteEnrollmentPartialFailure { _tag: RemoteEnrollmentPartialFailure, device }` means the relay enrolled the device but local persistence failed; its redacted device identifies the remote side effect. Store failure before enrollment uses store_failed. Errors contain no enrollment code, keys, tokens, file contents or raw relay text.

The one-use code is SECRET, explicitly marked `payload.code`; the operation is SECRET. Foundation request-byte/field limits and typed-result bulk/credit limits apply. A lost response or cancellation after dispatch can leave enrollment outcome unknown; clients never automatically replay enrollment or replace an existing identity. Explicit replacement does not promise revocation of the old relay device; owner revocation remains a relay/account action. No credential-removal operation is allocated: `commands/handlers/remote/disconnect.ts:19` uses `remote.set({ enabled: false })`, and the CLI remote command inventory has no removal command.

Frontend-boundary TS/Rust round-trip tests and generated client tests cover these shapes, errors and local-only admission. They do not implement enrollment, persistence, key generation or relay authorization.
