# Domain string and JSON codec

`browser::ActionResult` exposes call identity, tab fences, settlement status, and
optional message, capture, and group ID. It does not expose an input-transport
field; decoding an extra `input` property discards it, matching the TypeScript
public Schema. The v5 browser result follows the same field set.

`LosslessString` stores scalar-valid text as UTF-8 and text containing an unpaired surrogate as the entire UTF-16 code-unit sequence. `from_utf16` selects the canonical representation. `code_units`, equality, ordering, hashing, and `len` operate on original UTF-16 code units. `as_str` returns `None` for non-scalar text; `to_utf8` and `String::try_from` reject it. No replacement or Unicode normalization occurs.

`JsonValue` represents null, booleans, binary64 numbers, lossless strings, arrays, and `JsonObject`. Objects retain unique keys in JavaScript enumeration order: array-index names from `0` through `4294967294` sort numerically, followed by other names in insertion order. Replacing a duplicate key retains its original position. Keys such as `01`, `-0`, and `4294967295` are not array indices.

`parse_json` consumes a complete UTF-8 JSON document, decoding every `\uXXXX` escape to its exact code unit. `JsonError` reports a typed failure and byte offset. The parser and serializer use explicit traversal stacks. `stringify_json` follows `JSON.stringify`: compact output, well-formed lowercase escapes for lone surrogates, raw scalar Unicode, binary64 shortest decimal output with JavaScript exponent thresholds, negative zero as `0`, and nonfinite numbers as `null`. JSON input overflow is retained as signed infinity, as with `JSON.parse`.

This codec does not define Protobuf presence, finite-number field constraints, or stricter identifier/path rules. Apply those contracts at their owning boundary. Do not decode unrestricted domain JSON through `serde_json::Value` or convert strings or keys lossily. Optional field absence is represented by an absent object entry, distinct from `JsonValue::Null`.

## Parity fixtures and checks

Regenerate the deterministic input corpus and independently Bun-produced expected serializations from the repository root:

```sh
bun rust/crates/schema/tests/generate-domain-json.ts
```

The generator includes binary64 bit-pattern samples rendered to 21 significant decimal digits, independently generated decimal tokens, exponent boundaries, key ordering and duplicate cases, and randomized UTF-16 strings/keys. Fixtures are UTF-8 JSON arrays of JSON document strings, so the fixture envelope remains scalar-valid even when its contained documents represent lone surrogates. Generation prints its Bun version and vector count.

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-schema
cargo clippy --locked --manifest-path rust/Cargo.toml -p ycoding-schema --all-targets -- -D warnings
```

## Typed domain contract and lane conventions

Use one public module per TS filename, replacing hyphens with underscores; use Rust PascalCase (`ID` → `Id`, `USD` → `Usd`). Request `lib.rs` registrations from the parent. Keep transport, persistence, clock/random IO, and lossless-codec edits out of domain ports.

Implement `DomainDecode::decode_at(&JsonValue, &JsonPath)` and `DomainEncode::encode() -> JsonValue`. `decode` starts at `$`; propagate typed `DecodeErrorKind` and lossless key/index paths. Keep constrained scalars private with validated constructors so encoding is infallible. Use serde only for scalar-valid fixture envelopes, never domain values.

Use `ObjectDecoder::field` for required keys, `optional`/`Option<T>` for absence, `Nullable<T>` for required null-or-value, and `presence`/`Presence<T>` for absent/null/value. Null requires an accepting inner type. Encode through `ObjectEncoder` in **TS schema declaration order**, omitting absent keys; `JsonObject` owns JS numeric-key ordering. Discard unknown struct keys; preserve open metadata as `JsonObject`, Unknown as `JsonValue`, and JSON as `domain::Json` (rejects nested nonfinite numbers). Associated methods replace `statics`.

Reuse `domain::{branded_string, bounded_string, finite_number, integer_range, number_range, literal, literal_enum}` and `ObjectDecoder::{literal, tag}`. Prefixes/length use UTF-16 units: Session/Workspace validators accept `ses`/`wrk`, message/event IDs require `msg_`/`evt_`, and path brands are unrestricted. Integers are JS-safe; `integer_range` and integer encoding retain negative zero while `get()` returns `i64`. Literals return the declared value. Money is signed finite binary64. DateTime applies Date TimeClip (±8,640,000,000,000,000 milliseconds, truncation toward zero).

Implement `EventType` and, for durable events, `DurableEventType`. Typed payloads encode id, created, metadata, sourceEpoch, type, durable (if applicable), location, data. Durable decoding requires the declared version; encoding emits it. Ephemeral decoding ignores extra durable keys. Immutable definition-reference slices replace inventories; `latest`/`durable_map` preserve order and identity/duplicate rules without registry/dispatch.

Share one owner-serialized `identifier::Generator` across ID brands. Supply timestamps and 14 cryptographically random bytes from the runtime; never use per-ID generators or test entropy in production. Generation preserves TS timestamp/counter and prefix/suffix semantics.

### Ported source ownership

All paths below are relative to `packages/schema/src`; these are primitive/support ports, not large domain ports.

| TypeScript source       | Rust module / principal types                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.ts`             | `schema`: `PositiveInt`, `NonNegativeInt`, `Int`, `Finite`, `RelativePath`, `AbsolutePath`, `DateTimeUtcFromMillis`; optional/static equivalents above |
| `money.ts`              | `money`: `Usd`, `UsdPerMillionTokens`                                                                                                                  |
| `identifier.ts`         | `identifier`: `Generator`                                                                                                                              |
| `session-id.ts`         | `session_id`: `SessionId`                                                                                                                              |
| `project-id.ts`         | `project_id`: `ProjectId`                                                                                                                              |
| `workspace-id.ts`       | `workspace_id`: `WorkspaceId`                                                                                                                          |
| `session-message-id.ts` | `session_message_id`: `Id`                                                                                                                             |
| `integration-id.ts`     | `integration_id`: `IntegrationId`, `IntegrationMethodId`                                                                                               |
| `token-usage.ts`        | `token_usage`: `Info`, `Cache`                                                                                                                         |
| `location.ts`           | `location`: `Ref`, `Info`, `Project`, `Response<T>`                                                                                                    |
| `snapshot.ts`           | `snapshot`: `Id`                                                                                                                                       |
| `event.ts`              | `event`: `Id`, `Seq`, `Version`, `DurableEnvelope`, typed payloads, definitions and versioning helpers                                                 |
| `source-epoch.ts`       | `source_epoch`: `SourceEpoch` (required by event envelopes)                                                                                            |

### Ported domain modules

All paths below are relative to `packages/schema/src`.

| TypeScript source              | Rust module / principal types                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.ts`                  | `provider`: `Id`, `IntegrationRef`, `Settings`, `Request`                                                                                                                                             |
| `connection.ts`                | `connection`: `CredentialInfo`, `EnvInfo`, `Info`                                                                                                                                                     |
| `credential.ts`                | `credential`: `Id`, `OAuth`, `Key`, `Value`                                                                                                                                                           |
| `integration.ts`               | `integration`: `When`, `TextPrompt`, `SelectOption`, `SelectPrompt`                                                                                                                                   |
| `provider-usage.ts`            | `provider_usage`: `Window`, `Snapshot`, `Observation`                                                                                                                                                 |
| `models-dev.ts`                | `models_dev`: `Refreshed`                                                                                                                                                                             |
| `llm.ts`                       | `llm`: `ProviderMetadata`, `ToolTextContent`, `ToolFileContent`, `ToolContent`                                                                                                                        |
| `prompt.ts`                    | `prompt`: `Mention`, `ManagedAttachmentContent`, `FileAttachment`, `AgentAttachment`                                                                                                                  |
| `prompt-input.ts`              | `prompt_input`: `FileAttachment`, `Prompt`                                                                                                                                                            |
| `catalog.ts`                   | `catalog`: `Updated`                                                                                                                                                                                  |
| `config.ts`                    | `config`: `DiagnosticReason`, `Diagnostic`, `Updated`                                                                                                                                                 |
| `model.ts`                     | `model`: `Daybreak`, `Api`, `ProfileName`, `Ref`                                                                                                                                                      |
| `permission.ts`                | `permission`: `Reply`, `Effect`, `Source`, `Request`                                                                                                                                                  |
| `permission-saved.ts`          | `permission_saved`: `Id`, `Info`                                                                                                                                                                      |
| `agent.ts`                     | `agent`: `Color`, `Info`, `Updated`                                                                                                                                                                   |
| `command.ts`                   | `command`: `Info`, `Updated`                                                                                                                                                                          |
| `provider-request.ts`          | `provider_request`: `Timing`, `Speed`, `ReportInput`, `Record`                                                                                                                                        |
| `session-cache-diagnostics.ts` | `session_cache_diagnostics`: `Mechanism`, `ProviderCache`, `ContextBreakdown`, `GenerationSpeed`                                                                                                      |
| `session-captured-changes.ts`  | `session_captured_changes`: `Input`, `Page`                                                                                                                                                           |
| `session-delivery.ts`          | `session_delivery`: `Delivery`                                                                                                                                                                        |
| `session-error.ts`             | `session_error`: `Error`                                                                                                                                                                              |
| `remote.ts`                    | `remote`: `State`, `Status`                                                                                                                                                                           |
| `keep-awake.ts`                | `keep_awake`: `State`, `Status`                                                                                                                                                                       |
| `file-diff.ts`                 | `file_diff`: `Info`, `LegacyInfo`                                                                                                                                                                     |
| `vcs.ts`                       | `vcs`: `Mode`, `FileStatus`, `Branch`                                                                                                                                                                 |
| `vcs-event.ts`                 | `vcs_event`: `BranchUpdated`                                                                                                                                                                          |
| `instruction.ts`               | `instruction`: `Key`, `Hash`, `Values`, `Removed`, `Delta`                                                                                                                                            |
| `instruction-entry.ts`         | `instruction_entry`: `Key`, `Info`, `ValueTooLargeError`                                                                                                                                              |
| `event-log.ts`                 | `event_log`: `Synced`                                                                                                                                                                                 |
| `workspace.ts`                 | `workspace`: `ID`                                                                                                                                                                                     |
| `workspace-event.ts`           | `workspace_event`: `ConnectionStatus`, `Ready`, `Failed`, `Status`                                                                                                                                    |
| `worktree-event.ts`            | `worktree_event`: `Ready`, `Failed`                                                                                                                                                                   |
| `server-event.ts`              | `server_event`: `Connected`, `Disposed`                                                                                                                                                               |
| `lsp-event.ts`                 | `lsp_event`: `Updated`                                                                                                                                                                                |
| `installation-event.ts`        | `installation_event`: `Updated`, `UpdateAvailable`                                                                                                                                                    |
| `session-todo.ts`              | `session_todo`: `Status`, `Priority`, `Info`, `Event`                                                                                                                                                 |
| `session-status-event.ts`      | `session_status_event`: `Info`, `Status`, `Idle`                                                                                                                                                      |
| `session-compaction-event.ts`  | `session_compaction_event`: `Compacted`                                                                                                                                                               |
| `tui-event.ts`                 | `tui_event`: `PromptAppend`, `CommandExecute`, `ToastShow`, `SessionSelect`                                                                                                                           |
| `skill.ts`                     | `skill`: `ID`, `Name`, `Conflicts`, `DirectorySource`, `UrlSource`, `Info`, `Source`                                                                                                                  |
| `reference.ts`                 | `reference`: `LocalSource`, `GitSource`, `Source`, `Info`                                                                                                                                             |
| `plugin.ts`                    | `plugin`: `ID`, `Info`, `Event`                                                                                                                                                                       |
| `project.ts`                   | `project`: `Vcs`, `Current`, `Directory`, `InventoryEntry`, `Info`                                                                                                                                    |
| `project-directories.ts`       | `project_directories`: `Event`                                                                                                                                                                        |
| `project-copy.ts`              | `project_copy`: `StrategyID`, `CreateInput`, `RemoveInput`, `Copy`                                                                                                                                    |
| `session-compaction.ts`        | `session_compaction`: `ID`, `Trigger`, `FailureCode`, `Boundary`, `Metrics`, `Pressure`, `Admission`, `Result`, `HistoryJob`, `History`                                                               |
| `session-message.ts`           | `session_message`: `Info`, `AgentSelected`, `ModelSelected`, `User`, `Synthetic`, `System`, `Skill`, `Shell`, `Assistant`, `Compaction`, `AssistantContent`, `ToolState`                              |
| `session-revert.ts`            | `session_revert`: `Revert`                                                                                                                                                                            |
| `session-pending.ts`           | `session_pending`: `UserData`, `SyntheticData`, `Message`, `Info`, `LegacyInfo`                                                                                                                       |
| `session-orchestration.ts`     | `session_orchestration`: `Task`, `Control`, `Report`, `Change`, `Page`, `TeamView`                                                                                                                    |
| `session-skill-status.ts`      | `session_skill_status`: `State`, `Conflict`, `Info`                                                                                                                                                   |
| `session-work-completion.ts`   | `session_work_completion`: `Receipt`, `Page`                                                                                                                                                          |
| `telemetry.ts`                 | `telemetry`: `Consent`, `ConsentState`, `Operation`, `RequestSample`, `LongTaskSample`, `ClientSample`, `Batch`, `Page`                                                                               |
| `filesystem.ts`                | `filesystem`: `Entry`, `Submatch`, `Match`, `FindInput`, `Event`                                                                                                                                      |
| `form.ts`                      | `form`: `ID`, `Field`, `Fields`, `Info`, `Answer`, `State`, `Reply`, `Event`                                                                                                                          |
| `question.ts`                  | `question`: `ID`, `Info`, `Prompt`, `Tool`, `Request`, `Answer`, `Reply`, `Event`                                                                                                                     |
| `guardrail.ts`                 | `guardrail`: `RequestID`, `Rule`, `Risk`, `Request`, `Reply`, `Counter`, `Status`, `Event`                                                                                                            |
| `shell.ts`                     | `shell`: `ID`, `Status`, `MemoryLimitMb`, `Time`, `Info`, `CreateInput`, `OutputInput`, `Output`, `Event`                                                                                             |
| `pty.ts`                       | `pty`: `ID`, `Generation`, `Offset`, `Size`, `Actor`, `ControlOwner`, `Access`, `Info`, `CreateInput`, `UpdateInput`, `OwnerInput`, `ControlInput`, `ConnectInput`, `Event`                           |
| `pty-ticket.ts`                | `pty_ticket`: `ConnectToken`                                                                                                                                                                          |
| `mcp.ts`                       | `mcp`: `TimeoutConfig`, `LocalConfig`, `OAuthConfig`, `RemoteConfig`, `ServerConfig`, `Status`, `Server`, `Resource`, `ResourceTemplate`, `ResourceCatalog`, `ResourceContentPart`, `ResourceContent` |
| `mcp-skill.ts`                 | `mcp_skill`: `Digest`, `ResourceEntry`, `Entry`, `Capability`, `File`, `Reason`                                                                                                                       |
| `mcp-event.ts`                 | `mcp_event`: `ToolsChanged`, `ResourcesChanged`, `BrowserOpenFailed`, `StatusChanged`                                                                                                                 |
| `browser.ts`                   | `browser`: `TabID`, `Generation`, `DocumentGeneration`, `Page`, `Tab`, `Status`, `Observation`, `Action`, `ActionInput`, `CaptureOutput`, `ActionResult`                                              |
| `isolated-browser.ts`          | `isolated_browser`: `InstanceID`, `State`, `Status`, `StartInput`, `StartPayload`, `ObserveInput`, `ActionInput`, `Observation`, `ActionResult`                                                       |
| `session-event.ts`             | `session_event`: event source, artifact provenance, event definition inventories and durable definitions                                                                                              |
| `durable-event-manifest.ts`    | `durable_event_manifest`: versioned durable Session event manifest                                                                                                                                    |
| `session.ts`                   | `session`: `ID`, `Info`, `ListAnchor`, `ModelSwitchBlocked`, Session event and cache diagnostic contracts                                                                                             |
| `project-artifact.ts`          | `project_artifact`: artifact IDs, bounded content, lifecycle and validation contracts                                                                                                                 |
| `event-manifest.ts`            | `event_manifest`: Server and complete event type manifests                                                                                                                                            |

### Effect conformance corpus

Run `bun rust/crates/schema/tests/generate-domain-types.ts`. Add actual Effect schemas and valid/invalid JSON document strings to exported `corpus` (`Corpus`/`goldens` are reusable), then register typed Rust round trips in `tests/domain_types.rs`. Decode rejection produces null output; encoding exceptions fail generation. Fixture envelopes contain JSON document strings to preserve lone units. Assert exact encoded bytes, presence/order, numeric boundaries, and encoded negative-zero paths, not unordered object equality alone.

`domain-support.json` covers real identifier generation and event inventory/version helpers. Only external crypto entropy is replaced and restored; the generator also checks explicit-undefined omission. Regenerate twice and compare fixture bytes; never hand-edit fixtures.

Run per-crate checks with a 4096 MiB process limit. Set an ignored lane-specific `CARGO_TARGET_DIR` if another lane holds Cargo's shared target lock; do not change manifests or lockfiles to resolve it.
