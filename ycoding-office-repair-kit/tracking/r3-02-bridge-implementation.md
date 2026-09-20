# R3-02 — validated config owner bridge (implementation)

Status: **core + protocol + server + generated client complete and verified.** Native Godot client
consumption is the parent-owned next stage; R3-02 is not claimed done on API-only proof.

Worktree `/Users/viadz/Workspace/Project/ycoding.worktrees/office`, branch `office`.
User approved extending Schema/Core/Protocol/Server and regenerating the public client (2026-09-20).

## Contract decision

`@ycoding/v2/Config` stays the single owner. No second store, no parallel reader, no client-side
merge, no path input.

| Method | Path                  | Purpose                                            |
| ------ | --------------------- | -------------------------------------------------- |
| `GET`  | `/api/config`         | Effective values + provenance + redaction.         |
| `POST` | `/api/config/preview` | Validate a patch; return changes and revisions.    |
| `PUT`  | `/api/config`         | Commit a validated patch; return the settled read. |

- `Config.Patch` = `{ patch, scope: "global" | "project", expectedRevision? }`. **No path field and
  no `session` scope**, so a client cannot choose a filesystem target and session overrides stay in
  the session contract.
- `Config.Read` = `{ values, sources[] }`; each source carries `path`, `scope`
  (`global`/`project`/`virtual`), `keys`, `revision` (SHA-256 of raw bytes **before** `{env:}` /
  `{file:}` substitution, so token edits change the revision).
- `Config.Preview` = `{ scope, path, revision, result, changes[] }`. `revision` is what the caller
  must pass back as `expectedRevision`; `result` is the revision the write would produce.
- `Config.Commit` = `{ scope, path, revision, changes[], unsettled[], read }`. `unsettled` lists
  patched keys whose effective value is still owned by another document after the write.
- `ConfigInvalidError` (HTTP 400) carries an actionable `message`, an optional `path`, and drops the
  core `issues` payload.

Rejections before any write: removed keys (`server`, `permission`, legacy `mcp` map, …), `Info`
schema violations including unknown top-level keys, stale `expectedRevision`, and a scope with no
writable document.

Preservation/atomicity: `jsonc-parser` `modify` + `applyEdits` on the existing text (comments,
formatting, unknown unrelated fields, substitution tokens survive); temp file + `rename` in the same
directory; existing restrictive file mode preserved; then `discover()` + `loadPolicies` +
`config.updated`.

Redaction: provider `headers`, MCP `environment`, and credential field names (`apiKey`,
`client_secret`, `access_token`, `password`, `token`, …) become `Config.REDACTED`. Keys stay visible.

## Paths changed

Owner files:
- `packages/schema/src/config.ts` — `Source`, `Read`, `Change`, `Preview`, `Commit`, `Patch`,
  `Scope`, `WriteScope`, `REDACTED`.
- `packages/core/src/config.ts` — `document()`, `scopeOf()`, `writable()`, `redact()`; `Interface`
  gains `read` / `preview` / `commit`; `plan()` / `preview` / `commit` in the Location layer.
- `packages/core/src/config/error.ts` — `InvalidErrorType` alias for error-channel annotation.
- `packages/protocol/src/groups/config.ts` (new), `packages/protocol/src/api.ts` (group + Location
  middleware + `LocationGroups`), `packages/protocol/src/client.ts` (`groupNames`), `errors.ts`
  (`ConfigInvalidError`).
- `packages/server/src/handlers/config.ts` (new), `packages/server/src/handlers.ts` (registration).
- `packages/client/src/{promise,effect}/generated/*`, `src/effect/api/api.ts` — regenerated via the
  owning command `bun run --cwd packages/client generate`.
- `specs/v2/configuration-api.md` (new).

Tests:
- `packages/core/test/config/write.test.ts` (12 tests, real temp-file persistence).
- `packages/core/test/fixture/config.ts` (new) — `stubConfig` for read-only `Config.Service` doubles.
- `packages/protocol/test/config.test.ts` (4 tests).
- `packages/server/test/config-handler.test.ts` (5 tests, assembled public route + Location middleware).
- `packages/client/test/promise.test.ts` — group list and `config` operation assertions.
- 22 existing core/simulation files updated from `Config.Service.of(...)` to `stubConfig(...)` because
  the service interface gained required members. Write paths `Effect.die` in those doubles.

## Evidence

| Check                                          | Command                                                                                    | Result                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| Core config write suite                        | `cd packages/core && bun test test/config/write.test.ts`                                    | 12 pass / 0 fail          |
| Core affected suites                           | `cd packages/core && bun test test/config test/filesystem/watcher.test.ts test/instruction-discovery.test.ts test/mcp.test.ts test/plugin/skill.test.ts test/tool-*.test.ts test/session-*.test.ts` | 432 pass / 0 fail |
| Core full unit                                 | `cd packages/core && bun test --path-ignore-patterns=test-integration`                       | 2486 pass / 8 skip / 2 fail (both pre-existing, see below) |
| Protocol suite                                 | `cd packages/protocol && bun test`                                                          | 30 pass / 0 fail          |
| Server unit                                    | `cd packages/server && bun test --path-ignore-patterns=test-integration`                     | 46 pass / 0 fail          |
| Schema suite                                   | `cd packages/schema && bun test`                                                            | 78 pass / 0 fail          |
| Client suite                                   | `cd packages/client && bun test`                                                            | 59 pass / 0 fail          |
| Root typecheck                                 | `bun run typecheck`                                                                         | 16/16 tasks successful    |
| Effect-pattern lint                            | `bun run lint:effect-patterns`                                                              | 0 errors                  |
| Root lint                                      | `bun run lint`                                                                              | 0 errors, 2664 pre-existing warnings |
| Client generation idempotence                  | `bun run --cwd packages/client generate` twice + sha256 compare                              | identical                 |

Generation was verified idempotent by hashing the four generated files before and after a second
run. `check:generated` reports the expected uncommitted diff because the regenerated output is not
yet committed; it is not a generation failure.

### Pre-existing failures (reproduced with my changes stashed)

- `LocationServiceMap > isolates catalog state by location` (`packages/core/test/location-layer.test.ts`)
  — tool-list mismatch (`+1` received entry).
- `SessionV2.create > switches the selected model through the durable Session event`
  (`packages/core/test/session-create.test.ts`) — `SessionRunnerModel.ModelUnavailableError` for
  `anthropic/sonnet`.
- `simulation > YCoding brand sources match the Penpot geometry and palette` — brand geometry.

None touches configuration read/write.

## Boundary honesty

- **Not done:** the native Godot client consuming these routes (parent-owned next stage), any
  settings UI, any session-scoped override surface.
- **Not done:** a per-key editable source revision. Config has no per-key provenance today; provenance
  is whole-document, and `unsettled` reports when another document still owns a patched key.
- **Not done:** cross-scope transactional writes. A commit writes exactly one document; no partial
  multi-scope write exists because the payload has no multi-scope form.
- **Not edited (other owners):** `apps/office`, `docs/configuration.md`, `docs/runtime.md`.
- **Not touched:** `tasks.json`, `evidence.json`, `milestones.json`, or any ledger.
- No dependency, lockfile, schema-migration, or CI change. `bun install --frozen-lockfile` was
  required to materialise `node_modules` in this worktree; `bun.lock` is unmodified.

## Follow-ups for the parent stage

1. Client consumption: the generated `config` group exposes `get` / `preview` / `commit`; Godot's
   `HttpTransport` has never issued `PUT`, so the write path adds a transport capability to exercise.
2. Decide whether a future revision should expose per-key source attribution, which needs new
   discovery metadata rather than a change to this API.
