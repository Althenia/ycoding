# Revision 5 resource operations

`protocol/ycoding/v5/resources.proto` defines 60 baseline operations and three frontend-boundary operations in the Protocol agent, command, config, credential, model, provider, providerUsage, usage, integration, projectArtifact, skill, reference, plugin, mcp, location, project and frontendPackage groups. Explicit operation IDs occupy 2000–2062. Service declarations are descriptor inputs, not gRPC services. Generated codecs and descriptors do not implement dispatch or authorization.

Requests retain distinct params, query and payload messages. Results retain the source response shape, including Location envelopes. Empty successes are explicit messages. Required undefined-valued results use a required none/value union; optional fields use presence, and optional collections use wrapper messages. Unrestricted strings and dynamic keys use LosslessString. Deliberately open values use Value rather than encoded JSON.

Schema integers retain signed or nonnegative 64-bit representation and their JavaScript safe-integer and source range bounds. Schema.Number fields use finite double without integer coercion: finite fractional timestamps cross the current Effect JSON transport, while nonfinite values encode as null and fail numeric decoding. Offset pagination uses Paging.OFFSET; opaque project inventory cursors use Paging.CURSOR.

`shared.proto` contains middleware-inherited UnauthorizedError and InvalidRequestError, and the transitive declaration set referenced by endpoints outside these resource groups. Every resource descriptor includes the two middleware errors and its declared endpoint errors. `providerUsage.list`, `usage.get` and `usage.report` additionally permit REMOTE_CLIENT and RELAY through the closed [connector allowlist](./wire-connector.md); other resource descriptors permit LOCAL_CLIENT only. Provider usage uses Machine scope for remote roles, with backend-resolved default placement and the same normalized quota result, preserving source/stability labels and absent unreported values.

Structural field metadata enforces integer, source-unit text and collection bounds. Domain obligations name live source schema owners for patterns, filters and refinements. Obligations are not wire enforcement. Wire-to-domain conversion must enforce them before handler execution and surface rejection through the validation-error boundary.

The field-coverage owner is `packages/protocol/test/resources-coverage.test.ts`. It introspects the live Effect schemas and the baseline operation manifest from `script/rust-parity/manifest.ts`, checks exact operation membership, request/result/error fields and presence, enum literals, shared reachability, descriptor associations, structural metadata and source-bound obligations through requireConstraintCoverage. The source projection command `bun run --cwd packages/protocol test/resources-materialize.ts` is read-only; it must not rewrite canonical tags or IDs when TypeScript contracts drift. Generate bindings with `bun run --cwd packages/protocol generate:v5`; generate digest-bearing vectors with `python3 protocol/ycoding/v5/testdata/generate.py`.

`packages/remote/test/resources-conformance.test.ts` and `rust/crates/protocol/tests/wire_resources.rs` share independent binary corpora for optional-empty/lone UTF16 model references, required-empty provider records, permission and error enums, fractional attempt timestamps, explicit undefined-result branches and safe-integer artifact revisions. Domain-obligation enforcement is outside these structural codec tests.

## Backend-owned configuration and frontend packages

| Operation                 | ID   | Request                                                                               | Success                                    |
| ------------------------- | ---- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `provider.configure`      | 2060 | `query: LocationQuery`; `payload: { providerID, scope, endpoint, catalog?, models? }` | `data: { providerID, target, registered }` |
| `mcp.configure`           | 2061 | `query: LocationQuery`; `payload: { name, scope, config }`                            | `data: { name, target, reloaded }`         |
| `frontendPackage.resolve` | 2062 | `query: LocationQuery`; `payload: { spec }`                                           | `data: FrontendPackageDescriptor`          |

All three operations permit **LOCAL_CLIENT only**. REMOTE_CLIENT, RELAY, AGENT and SERVER cannot originate them. Scope is LOCATION, mutation class MUTATION, settlement COMPLETED, paging UNPAGED and delivery TYPED_BULK. The Location is backend-owned placement; configuration scope independently chooses the permitted `global` or `project` target. Clients cannot supply a filename. The backend authorizes the scope, chooses the target, serializes writes to that target, preserves unrelated JSONC entries, writes atomically and reloads its own resource state. Global writes do not inherit project permission merely because the request has a Location.

`ConfigurationScope` ordinals are global=1 and project=2. `ConfigurationTarget` contains required `scope` and required backend `path` (1–8192 UTF-16 units). A successful configuration result means the write and reload completed; `registered` and `reloaded` must be true. A written file whose reload or provider registration failed returns `ConfigurationPartialFailure`, not success. Pre-write failures return `ConfigurationWriteError` and must not modify the configuration. Cancellation or transport loss after dispatch can leave an uncertain outcome; clients never automatically replay a mutation. Repeating an explicitly retried identical configuration preserves unrelated entries and settles registration again rather than creating duplicate registrations.

### Provider configuration

`providerID` is required and bounded to 1–128 UTF-16 units. `endpoint` is a required closed union:

- `openai` (tag 1): `{ baseURL, api }`, with api chat=1 or responses=2;
- `runpod` (tag 2): `{ baseURL, worker }`, with worker ollama=1 or vllm=2.

`baseURL` is bounded to 1–8192 UTF-16 units. The backend validates an absolute HTTP(S) endpoint, rejects URL credentials and secret-bearing endpoint parameters, validates Runpod Jobs origins/paths as `https://api.runpod.ai/v2/<ENDPOINT_ID>`, and selects the provider implementation itself. Clients cannot select a backend package or send arbitrary settings, headers, keys or profiles in this request. Provider collision validation rejects replacing an existing provider owned by a different implementation.

Optional `catalog` has one value, openai-models=1, and applies only to the OpenAI endpoint branch. Optional `models` preserves absent versus present-empty and contains at most 256 entries. Each entry has required `id` (1–128 units), optional `modelID` (1–256), `name` (1–256), `family` (1–128), `api` (chat/responses), `disabled` and `tools`. The backend rejects duplicate IDs and invalid provider/model identifiers and applies only supplied model fields; omitted fields do not erase unrelated model configuration. Explicit false values are retained. Credentials remain separate requests on `integration.connect.key` and `credential.activate`; configure neither accepts nor returns a key. The result identifies the provider and written target and confirms registration; it does not activate a credential.

### Persistent MCP configuration

`name` is required and bounded to 1–128 UTF-16 units. `config` reuses `mcp_add_Request_payload_config`, the existing closed ServerConfig union of `Mcp_LocalConfig` and `Mcp_RemoteConfig`. Command, environment, cwd, headers, OAuth, timeouts, disabled and codemode retain their existing shapes. The backend validates the name/config, selects its own global or project JSON/JSONC target, preserves unrelated entries, persists the named definition and reloads it. A reload is not a promise that an external server connected successfully. `mcp.add` retains its live-only semantics and ID 2036.

`mcp.configure` is SECRET with `payload.config` explicitly SECRET. Results and configuration errors contain no config, environment, headers, OAuth secret, subprocess output or raw error text. `ConfigurationTarget.path` is backend display metadata, not a new filesystem authority.

### Presentation package resolution

`spec` is required and bounded to 1–2048 UTF-16 units. The backend validates an npm registry package selector, guards installation under its permission and package policy, resolves the package's TUI presentation entrypoint, and reuses a verified installed cache where appropriate. Local file imports remain a client presentation concern; this operation does not grant a backend extension/plugin host capability or execute terminal JSX in Rust. Remote package loading and asset transfer are not granted by this local-only descriptor.

`FrontendPackageDescriptor` has required `name` (1–256), exact `version` (1–128), `digest` (64), backend-local absolute `root` (1–8192), and `entrypoint: { path, digest }`; optional `assets` distinguishes absent from empty and has at most 1024 descriptors with the same `{ path, digest }` shape. Paths are bounded to 1–8192 units and are root-relative, normalized, contained paths, not arbitrary backend filenames. Digests are lowercase SHA-256 hex: package `digest` identifies the verified npm distribution archive; entrypoint and asset digests identify exact file bytes. The backend rejects traversal, escaping links, missing entrypoints and integrity mismatches before reporting success. A same-host TUI may load the verified presentation entrypoint under `root`; neither a remote browser nor a client on a different host may import that backend path.

### Closed errors and budgets

Each operation declares `ServiceUnavailableError`, `UnauthorizedError` and `InvalidRequestError`. Config operations additionally declare:

- `ConfigurationWriteError { _tag: ConfigurationWriteError, code }`: invalid_config=1, scope_not_allowed=2, provider_collision=3, write_failed=4; provider_collision applies to provider configuration only;
- `ConfigurationPartialFailure { _tag: ConfigurationPartialFailure, target, stage }`: reload=1 or registration=2; MCP uses reload only. The file was written, and the target identifies the side effect even though settlement failed.

Package resolution additionally declares `FrontendPackageError { _tag: FrontendPackageError, code }`: invalid_package=1, permission_denied=2, install_failed=3, entrypoint_missing=4, integrity_failed=5. Error tag enums have a single ordinal 1; no raw exception payload or open error union is allowed.

Requests remain subject to the foundation 65,536-byte inline-body limit even when individual text/count maxima would permit a larger aggregate. Results use bounded typed bulk when needed, with foundation transfer, byte, field and delivery-credit limits; no npm logs or package bytes are embedded in the result.

### Backend-owned projection metadata

`Location_Info` appends optional `backendPaths` at tag 4. When present it contains required `home`, `state`, `worktree` and `config` paths from backend roots. Local Location projections can provide it for backend path displays; remote projections omit it. It is not a client preference/theme root and must not cause frontend filesystem initialization.

`Skill_Info` appends optional `scope: ConfigurationScope` at tag 9. Discovery supplies project/global scope from its owning source instead of asking clients to classify backend paths against their own home/config roots. Built-in or otherwise unclassified sources omit the field. This is source metadata, not a second authority for Session skill activation.

`packages/protocol/test/frontend-boundary.test.ts`, `packages/client/test/v5-frontend-boundary.test.ts` and `rust/crates/protocol/tests/frontend_boundary.rs` cover descriptor roles, request/result/error round trips, presence, enum and size boundaries, redacted shapes and generated client dispatch. Existing live-source coverage retains exact baseline fields and operations, with the named additive metadata independently checked. These contract tests exclude handlers, filesystem writes, installation, relay traffic and live authorization services.
