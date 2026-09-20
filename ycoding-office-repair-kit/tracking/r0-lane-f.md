# R0 / Lane F — Config owner bridge discovery (read-only)

Repo `/Users/viadz/Workspace/Project/ycoding`, `main`, HEAD `a4bb99e`. Read-only lane; only this file written.
Every claim carries `path:line`. Verdicts that contradict the kit are marked **[CONTRADICTS KIT]**.

Verdict in one line: **no config read/write HTTP API exists today.** Core config is read-only; the only
validated JSONC writer is CLI-local and unreachable from Server; `mcp.add` is a runtime-only override.

---

## 1. Config owner map

### Owner service

| Item | Value | Evidence |
|---|---|---|
| Tag / identifier | `"@ycoding/v2/Config"` | `packages/core/src/config.ts:197` |
| Interface | `Config.Interface` with exactly one member `entries` | `packages/core/src/config.ts:185-188` |
| Layer constructor | `Config.layer(options?)` | `packages/core/src/config.ts:199` |
| Node | `Config.configured()` / `Config.node` | `packages/core/src/config.ts:518-536` |
| Placement | Location-scoped (`makeLocationNode`) | `packages/core/src/config.ts:12,519-535`; registered in `packages/core/src/location-services.ts:69` |
| Wiring in Server | `Config.configured({project, file, content})` | `packages/server/src/routes.ts:114-121` |

Schema classes exported by the same module:

- `Info` — the full config document schema (config keys, ~50 top-level fields): `packages/core/src/config.ts:43-149`.
- `Document` — `{ type: "document", path?, info }`: `packages/core/src/config.ts:151-155`.
- `Directory` — `{ type: "directory", path }`: `packages/core/src/config.ts:157-160`.
- `File` — `{ type: "file", path }`: `packages/core/src/config.ts:162-165`.
- `AgentsDirectory` / `ClaudeDirectory`: `packages/core/src/config.ts:167-177`.
- `Entry` union: `packages/core/src/config.ts:179`.

### Methods

| Method | Signature | Reads | Writes | Read-only? |
|---|---|---|---|---|
| `entries` | `() => Effect.Effect<Entry[]>` | In-memory `configs` array (last snapshot from `discover()`), lowest→highest priority | nothing | **yes — read-only** |

Evidence: interface at `packages/core/src/config.ts:185-188`; implementation returns the captured `configs`
variable at `packages/core/src/config.ts:511-515`. There is **no** `set`, `update`, `write`, `patch`, `reload`
(exposed), or path accessor on the interface. `reload` exists but is layer-internal, invoked by watcher
subscriptions and wellknown events (`packages/core/src/config.ts:447-455, 496-508`).

There is no separate "Info service". Consumers get values through the free function
`Config.latest(entries, key)`: `packages/core/src/config.ts:179-183`, which filters `Document` entries and takes
`findLast` (highest priority wins). Consumers call it with `yield* config.entries()`:
e.g. `packages/core/src/shell.ts:256-257`, `packages/core/src/pty.ts:238`,
`packages/core/src/instruction-discovery.ts:95`, `packages/core/src/provider-usage.ts:175`,
`packages/core/src/tool/ntfy.ts:40`, `packages/core/src/session/guardrail.ts:156`,
`packages/core/src/session/instructions.ts:63`, `packages/core/src/snapshot.ts:137`.

### Precedence computation

Precedence is **array order**, not a merge function. `discover()` builds `Entry[]` from lowest to highest
priority and consumers scan from the end.

- File names searched per directory: `["ycoding.json", "ycoding.jsonc"]` — `packages/core/src/config.ts:211`.
- Upward discovery from the Location for `.ycoding`, `.claude`, `.agents`, and reversed `names`:
  `packages/core/src/config.ts:320-328` (`fs.up`, `packages/core/src/fs-util.ts:170-182`).
- Global directory is always lowest: `packages/core/src/config.ts:316`; skipped upward when Location is global
  or `project === false`: `packages/core/src/config.ts:319-322`.
- Higher-priority ordering of the returned array (`packages/core/src/config.ts:393-403`):
  claude dirs → agents dirs → global directory documents+`Directory` → explicit `options.file`
  → direct discovered files → remaining discovered directories (`supplementary.slice(1)`) flipped
  → wellknown documents → `options.content` (`YCODING_CONFIG_CONTENT`) last (highest).
- Directory contents are `[...ycoding.json, ...ycoding.jsonc, Directory]` per directory:
  `packages/core/src/config.ts:306-313`.
- Confirmed by test expectations of exact entry order: `packages/core/test/config/config.test.ts:1099-1127`.
- Env/file substitution happens **before** parse, per file: `packages/core/src/config.ts:263-270` calling
  `ConfigVariable.substitute` (`packages/core/src/config/variable.ts:26-32` for `{env:VAR}`,
  `variable.ts:35-79` for `{file:...}`). Comment lines starting with `//` are skipped for `{file:}` tokens
  (`variable.ts:47-52`).
- Unknown keys are **ignored** on decode (`onExcessProperty: "ignore"`, `packages/core/src/config.ts:213-214`),
  so unknown-but-valid extension data survives in the file and does not fail the load.
- Known-removed legacy keys cause the whole file to be ignored with a warning:
  `packages/core/src/config.ts:215-248, 251-260`.

### Validated write with revision/conflict detection?

**No.** The core config layer has no write path at all. Every write in the repository that touches a
`ycoding.json`/`ycoding.jsonc` is outside core `Config`:

- `packages/cli/src/config/config.ts` — writes `cli.json` only (path at `:29`), with `get` (`:48-50`) and
  `update` (`:52-76`); comment-preserving via `jsonc-parser` `applyEdits`/`modify` (`:61-68`); atomic via
  temp-file + `rename` (`:41-46`); serialized with a `Semaphore` (`:30, 53-54`); re-validates the resulting text
  before writing (`:69-71`). It has **no revision/hash**: last-writer-wins under the process-local semaphore.
- `packages/cli/src/commands/handlers/mcp/add.ts` — writes `mcp.servers.<name>` into a discovered
  `ycoding.json`/`ycoding.jsonc`/`.ycoding/*` (`resolveConfigPath` at `:38-57`) using `jsonc-parser`
  `modify`+`applyEdits` (`:60-67`). Non-atomic (`writeFile` directly, `:67`), no lock, no revision, no
  re-validation after edit, and it is a CLI command with no Protocol exposure.

Kit claim "the inspected desktop currently writes no runtime config" — **verified**:
`apps/office` contains only `user://motion.cfg` presentation state (`apps/office/core/motion.gd:17-18`),
and the transport has no config endpoint (`apps/office/integration/gateway_contract.gd:15-70`).

---

## 2. Existing route inventory

**No config/settings/preferences HTTP group exists.** Verified three ways:

1. `HttpApiGroup.make` appears in exactly 32 files with 32 distinct group names, and none matches
   `server.config` / `server.settings` / `server.preference`:
   `grep -rn "HttpApiGroup.make(" packages/protocol/src/groups/*.ts | wc -l` → `32`; the config grep exits 1
   (no match). Full list: agent, browser, command, credential, debug, event, form, fs, generate, guardrail,
   health, integration, isolatedBrowser, location, mcp, message, model, permission, plugin, project,
   projectArtifact, projectCopy, provider, providerUsage, pty, question, reference, server, session, shell,
   skill, vcs.
2. The assembled API adds exactly those groups: `packages/protocol/src/api.ts:156-191`.
3. The generated client group map lists exactly 32 entries and none is config:
   `packages/protocol/src/client.ts:35-68`.
4. No group or endpoint file mentions config persistence: the only `config` hits under
   `packages/protocol/src/groups/` are the MCP `config` payload (`mcp.ts:29`) and prose descriptions
   (`mcp.ts:19,69`, `provider-usage.ts:33`, `provider.ts:20,36`).

Closest read-only "what is currently effective" surfaces (all read-only, all Location-scoped):

| Route | File:line | Returns |
|---|---|---|
| `GET /api/location` | `packages/protocol/src/groups/location.ts:31` | resolved `Location.Info` (directory, workspaceID, project) |
| `GET /api/server` | `packages/protocol/src/groups/server.ts:6` | server URLs |
| `GET /api/debug/location` | `packages/protocol/src/groups/debug.ts:8` | loaded locations |
| `DELETE /api/debug/location` | `packages/protocol/src/groups/debug.ts:19` | evicts a Location's cached services (forces re-boot; closest thing to an invalidation hook) |

No route returns `Config.Info`, an effective settings view, provenance, or a revision.
No handler in `packages/server/src/handlers/` reads `Config.Service`; the only core-config import under
`packages/server/src` is the layer wiring at `packages/server/src/routes.ts:10,114-121`.

### Close equivalents table

"Mutate" = persists or changes runtime state durably or until restart. Evidence is protocol + handler/core.

| Group | Can READ | Can MUTATE | Persists to `ycoding.json(c)`? | Evidence |
|---|---|---|---|---|
| `credential` | nothing (no list here) | `PATCH /api/credential/:credentialID` **label only**; `DELETE` removes credential | no | `packages/protocol/src/groups/credential.ts:11-15,25-28`; handler `packages/server/src/handlers/credential.ts:11-22` calls `integration.connection.update(id, {label})`; interface restricts to `Partial<Pick<Credential.Info,"label">>`: `packages/core/src/integration.ts:165-183` |
| `integration` | `list`, `get`, oauth/command attempt `status` | connect by key (`:57`), oauth connect/complete/cancel (`:77,113,134`), command connect/cancel (`:149,184`), wellknown add (`:41`) | no (credential store / wellknown KV) | `packages/protocol/src/groups/integration.ts:12-192` |
| `provider` | `GET /api/provider` (`:10`), `GET /api/provider/:providerID` (`:25`) | **nothing** | no | `packages/protocol/src/groups/provider.ts:9-38` |
| `providerUsage` | `GET /api/provider/usage` (`:23`), `GET /api/provider/:providerID/usage` (`:38`) | **nothing** | no | `packages/protocol/src/groups/provider-usage.ts` |
| `model` | `GET /api/model` (`:10`), `GET /api/model/default` (`:25`) | **nothing** | no | `packages/protocol/src/groups/model.ts` |
| `mcp` | `list` (`:10`), `resource.catalog` (`:90`) | `PUT /api/mcp/:server` (`:24`), `DELETE` (`:42`), `connect` (`:58`), `disconnect` (`:74`) | **no — runtime map only** | protocol `packages/protocol/src/groups/mcp.ts`; handler `packages/server/src/handlers/mcp.ts:31-58` calls `MCP.Service.add/remove/connect/disconnect`; `add` only mutates the in-memory `runtime` Map (`packages/core/src/mcp/index.ts:599-614`), seeded once from config at `:163-190` |
| `agent` | `GET /api/agent` (`:9`) | **nothing** | no | `packages/protocol/src/groups/agent.ts` |
| `plugin` | `GET /api/plugin` (`:9`) | **nothing** | no | `packages/protocol/src/groups/plugin.ts` |
| `skill` | `GET /api/skill` (`:9`) | **nothing** (session skill activation is a different group) | no | `packages/protocol/src/groups/skill.ts`; activation is `POST /api/session/:id/skill` `packages/protocol/src/groups/session.ts:659` |
| `command` | `GET /api/command` (`:9`) | **nothing** | no | `packages/protocol/src/groups/command.ts` |
| `reference` | `GET /api/reference` (`:9`) | **nothing** | no | `packages/protocol/src/groups/reference.ts` |
| `project-artifact` | `list`, `get`, `metrics` | create/update/disable/enable/remove/restore/revert/promotion/fork/shadow/purge — all with `expectedRevision`/`expectedVersionID`/`expectedDigest` | no (artifact store, not `ycoding.json`) | `packages/protocol/src/groups/project-artifact.ts:29-33,128-282` |
| `project` | `list` (`:10`), `current` (`:21`), `directories` (`:35`) | **nothing** | no | `packages/protocol/src/groups/project.ts` |
| `projectCopy` | — | create (`:25`), remove (`:36`), refresh (`:47`) | no | `packages/protocol/src/groups/project-copy.ts` |
| `location` | `GET /api/location` (`:31`) | **nothing** | no | `packages/protocol/src/groups/location.ts` |
| `form` | request/list/get/state | create/reply/cancel (session-scoped interactive forms) | no | `packages/protocol/src/groups/form.ts:39-131` |
| `session.*` settings-adjacent | `autonomy.get` (`:361`), `todo.list` (`:513`), `skills` (`:695`) | `autonomy.set` (`:376`), `todo.update` (`:520`), `switchAgent` (`:545`), `switchModel` (`:561`), `rename` (`:578`), `move` (`:594`) | no — durable Session state, not config | `packages/protocol/src/groups/session.ts` |

**Kit claim about `credential.update` — verified**: it changes only `label`
(`packages/protocol/src/groups/credential.ts:11-13` payload `Schema.Struct({ label: Schema.String })`;
`packages/core/src/integration.ts:180-183`). It is **not** an API-key update endpoint. Key writes happen through
`integration.connect.key` (`packages/protocol/src/groups/integration.ts:57-60`, payload `{key, label?}`).

---

## 3. Write / persistence safety

| Question | Answer | Evidence |
|---|---|---|
| Does core preserve comments on write? | Core never writes. The comment-preserving writer is CLI-local `cli.json` via `jsonc-parser` `applyEdits(modify(...))`. | `packages/cli/src/config/config.ts:60-68`; test asserting a `// Keep this comment` survives: `packages/cli/test/config.test.ts:67,81` |
| Does core preserve unknown keys? | On **read** yes: `onExcessProperty: "ignore"` keeps decoding and the raw file is untouched. A writer must re-apply edits, never re-serialize decoded `Info`, or unknown keys are lost. | `packages/core/src/config.ts:213-214`; the `mcp/add` writer already follows this edit-based approach (`packages/cli/src/commands/handlers/mcp/add.ts:60-67`) |
| Does core preserve env/file substitutions on write? | Substitution is applied to a copy of the text at load (`packages/core/src/config.ts:266`, `config/variable.ts:26-79`); the file still holds `{env:VAR}`/`{file:...}`. A naive write of substituted values would bake secrets in. No existing writer guards this. | as cited |
| Atomic write? | `cli.json` writer: yes, temp + `rename` (`packages/cli/src/config/config.ts:41-46`). `mcp add`: **no**, direct `writeFile` (`packages/cli/src/commands/handlers/mcp/add.ts:67`). Core `FileMutation.write`/`writeWithDirs`: **no temp+rename** (`packages/core/src/file-mutation.ts:96-104`; `packages/core/src/fs-util.ts:131-146`). | as cited |
| Revision / hash / conflict detection? | Core `Config`: none. `cli.json` writer: none — only a process-local `Semaphore` (`packages/cli/src/config/config.ts:30,53-54`). Core `FileMutation.writeIfUnchanged` provides byte-compare-and-write under a per-path `KeyedMutex`, failing `StaleContentError` — the closest existing conflict primitive, but it is not wired to config. `ProjectArtifact` has a full revision/digest/token protocol but for artifacts, not config. | `packages/core/src/file-mutation.ts:60-63,144-155`; `packages/protocol/src/groups/project-artifact.ts:29-33` |
| External-writer corruption risk | Present. `mcp add` rewrites a user file non-atomically with no lock; a concurrent TUI `cli.json` write or an editor save can interleave. Config is re-read and watched (`packages/core/src/config.ts:419-455`), so a corrupt write degrades to "file ignored" (parse error → `undefined`, `packages/core/src/config.ts:251-261`) rather than crashing, but values silently disappear. | as cited |

---

## 4. Recommendation (exact design)

**Add group `server.config`.** No existing route can be reused: every mutating group either writes a different
store (artifacts, credentials, wellknown KV) or only changes in-memory runtime state (`mcp`). Reusing
`mcp.add` for settings is wrong because it is name-keyed to `mcp.servers` and never persists
(`packages/core/src/mcp/index.ts:599-614`).

### New core capability (per Location)

Extend the existing Location-scoped `Config` service — do not add a second config owner. The service already
has the decoded entries and a `reload()`; expose read-with-provenance and a validated write:

- `read() => { info, sources: Array<{ path, scope, keys, revision }> }`
  — effective value is `Config.latest`-style fold of the same ordered `Entry[]`
  (`packages/core/src/config.ts:179-183, 393-403`); provenance is the ordered `Document.path` list.
  `scope` derives from position (`global` = `global.config` directory `packages/core/src/config.ts:316`;
  `project`/`directory` = discovered `.ycoding`/direct files `packages/core/src/config.ts:320-328,359-370`).
- `preview(patch, expectedRevision)` — returns the JSONC edit list and a normalized diff, without writing.
- `commit(patch, expectedRevision)` — re-reads the target file, checks its hash equals `expectedRevision`,
  applies `jsonc-parser` `modify`+`applyEdits` (never re-serialize), writes atomically (temp + rename), and
  returns the effective readback plus the new revision.
- `revision` = SHA-256 of the raw file bytes (`Hash.sha256`, `packages/core/src/util/hash.ts:8-10`) or of the
  value set; must include raw text so `{env:}`/`{file:}` tokens are covered. Conflict detection is this
  compare; `FileMutation.writeIfUnchanged` (`packages/core/src/file-mutation.ts:60-63,144-155`) is the model,
  but a temp+rename variant is required because it is not atomic.

### HTTP shape

| Method + path | Request | Response | Backing |
|---|---|---|---|
| `GET /api/config` | `query: LocationQuery` | `Location.response({ info: Config.Info, sources: [{path, scope, keys, revision}] })` | `Config.read()` |
| `POST /api/config/preview` | `payload: { patch: unknown, scope: "global"\|"project"\|"directory", path?: string, expectedRevision?: string }` | `{ edits: [...], diff: [...], revision }` | `Config.preview()` |
| `PUT /api/config` | `payload: { patch: unknown, scope, path?, expectedRevision: string }` | `{ result: "applied"\|"partial"\|"conflict", info: Config.Info, sources: [...], failures: [{path, reason}] }` | `Config.commit()` |

- Validation: decode `patch` through the same `Info` schema used at load
  (`packages/core/src/config.ts:213-214`), so removed keys are rejected/ignored exactly as on read
  (`packages/core/src/config.ts:215-248`).
- Effective readback: response re-folds `Config.latest` after the write, so the client sees the settled value,
  not the patch.
- Secret redaction: `providers.<id>.settings` may hold `apiKey` and `headers` may hold bearer values
  (`packages/core/src/config/provider.ts:11` and the discovery reader at
  `packages/core/src/config/plugin/provider.ts:91-96`); MCP `environment`/`headers` likewise
  (`packages/core/src/config/mcp.ts`, `packages/core/src/mcp/client.ts:190-207`). The read/preview responses
  must redact those leaves; a patch may set them but never read them back.
- Partial failure: `PUT` is explicitly **not** transactional across scopes; it reports `partial` with a
  per-path `failures` list, matching the kit's own requirement (`ycoding-office-repair-kit/docs/ALL_SETTINGS.md:13`).
- Provenance of environment-owned settings: report the controlling `{env:VAR}` token name, never its value
  (`packages/core/src/config/variable.ts:27-30`).

Unverifiable as reachable and therefore **not** in this design: an "editable source revision" per individual
setting, and any per-key merge across scopes. Config has no per-key source metadata today; only whole-file
`Document.path` (`packages/core/src/config.ts:151-155`).

---

## 5. Files to change

| File | Change |
|---|---|
| `packages/core/src/config.ts` | Extend `Config.Interface` (`:185-188`) with `read`/`preview`/`commit`; implement in the layer beside `entries` (`:511-515`) using the existing `discover()`/`reload()` and `ConfigVariable` substitution contract |
| `packages/protocol/src/groups/config.ts` | New `ConfigGroup` (`HttpApiGroup.make("server.config")`) with the three endpoints |
| `packages/protocol/src/api.ts` | Import it, add to `LocationGroups`, `.add(ConfigGroup.middleware(locationMiddleware))` near `:168-169` |
| `packages/protocol/src/client.ts` | Add `"server.config": "config"` to `groupNames` (`:35-68`) |
| `packages/server/src/handlers/config.ts` | New handler mapping the three endpoints to `Config.Service` |
| `packages/server/src/handlers.ts` | Import + add to `Layer.mergeAll` (`:38-69`) |
| `packages/client/src/promise/generated/*`, `packages/client/src/effect/generated/*`, `packages/client/src/effect/api/*` | Regenerated (11 tracked files) |
| `packages/client/test/promise.test.ts` | Update the exact group-key list (`:6-36`) |
| `packages/core/test/config/*` + 23 stubbed files | Every `Config.Service.of({ entries })` stub must gain the new members (29 occurrences, e.g. `packages/core/test/fixture/mcp.ts:26`, `packages/core/test/session-runner-recorded.test.ts:106`) |
| `docs/configuration.md`, `specs/v2/` contract | Document the new public operation; `docs/architecture.md:95` only if ownership changes (it does not) |
| `apps/office/integration/*` (later lane) | Consume the endpoints; add `Gateway` constants |

Do **not** change `packages/cli/src/config/config.ts` (owns `cli.json`) or
`packages/cli/src/commands/handlers/mcp/add.ts` (owns the CLI `mcp add` path) in this work.

## 6. Client / OpenAPI regeneration

- Client generation command: **`bun run --cwd packages/client generate`**, defined at
  `packages/client/package.json:24` (`"generate": "bun run script/build.ts"`), implemented at
  `packages/client/script/build.ts:9-46` (emits promise, effect generated, and effect api outputs).
- Verify with `bun run --cwd packages/client check:generated` (`packages/client/package.json:25`), which
  re-runs generation and `git diff --exit-code` over the three generated directories.
- OpenAPI is **served dynamically**, not committed: `HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })`
  at `packages/server/src/routes.ts:150`. There is no repository command that writes a spec file.
- `packages/codemode/test/fixtures/ycoding-v2-openapi.json` (84 paths) is a hand-maintained fixture with no
  owning regeneration script (`git log` shows only feature commits; only reader is
  `packages/codemode/test/openapi.test.ts:18`). If the new group must appear there, it is a manual fixture edit,
  not a generated artifact.
- Rule source: "Regenerate Client output through the package's owning command after public Protocol changes"
  (`docs/architecture.md:95`, `:189`) and root `AGENTS.md` "Generated content and dependency boundaries".

## 7. Unverified kit claims

| Kit statement | Status |
|---|---|
| "The inspected desktop currently writes no runtime config" (`docs/ALL_SETTINGS.md:13`) | **verified** — only `user://motion.cfg` (`apps/office/core/motion.gd:17-18`) |
| "full settings requires an explicit scoped settings read/write API or existing equivalent" | **verified** — no equivalent exists (see §2) |
| "`credential.update` … changes a LABEL; it is not an API-key update endpoint" | **verified** (`packages/protocol/src/groups/credential.ts:11-13`) |
| "read effective values + source provenance + editable source revision" (proposed) | **not reachable as stated** — no per-key provenance or per-key revision exists; only whole-file path and a whole-file hash this lane proposes |
| "validate a scoped patch; preview diff; commit with expected revision" (proposed) | **reachable only by adding it** — no core service method backs any of the three today |
| "Operation names and wire shapes are proposed, not asserted to exist" | **verified** — none of `GET/POST/PUT /api/config*` exists |
| "preserve global/project/folder precedence, unknown valid extension data, comments, substitutions" | **partially reachable**: precedence and unknown-key tolerance exist on read (`config.ts:213-214, 393-403`); comment/substitution/atomicity guarantees exist only in the unrelated `cli.json` writer |
| "keep secrets redacted" | **not implemented for config** — redaction helpers exist for provider errors (`packages/core/src/aisdk.ts:889-984`), not for config reads |
| "atomic writes and conflict handling" | **not present for config**; `FileMutation.writeIfUnchanged` is not atomic and is unwired |
| "Do not edit a live registration file" | **consistent** — registrations live under `global.state`, not `global.config` (`packages/cli/src/services/service-config.ts:86-96`) |

## 8. Blast radius

- **Core**: `Config.Interface` gains three members; all 23 test files that build `Config.Service.of({ entries })`
  (29 sites) fail typecheck until updated. Core config suites: `packages/core/test/config/*.test.ts`.
- **Protocol**: new group changes the assembled `HttpApi` type; `packages/protocol/test/browser.test.ts:33` and
  `packages/protocol/test/isolated-browser.test.ts:38` only assert their own entries, so they stay valid.
- **Client**: `packages/client/test/promise.test.ts:6-36` asserts the exact 32-key group list — must add `config`.
  Generated files change; `check:generated` must pass.
- **Server**: new handler layer; `packages/server/test/*` unaffected except any route-count assumptions (none found).
- **Codemode**: fixture `ycoding-v2-openapi.json` is stale-but-valid unless manually updated; its test does not
  assert the endpoint set.
- **Desktop**: `apps/office` `gateway_contract.gd` needs new constants; no existing office test asserts config.
- **Docs/specs**: `docs/configuration.md` and a `specs/v2` contract must be updated in the same change per
  root `AGENTS.md`.

## 9. Unknowns

1. Whether the Godot `HttpTransport` correctly performs PUT/PATCH — it accepts an arbitrary method int
   (`apps/office/integration/http_transport.gd:66,250`) but every live caller uses only GET/POST
   (`apps/office/integration/live_transport.gd:96,222,313,338,370,383`,
   `apps/office/integration/session_api.gd:98,118`, `apps/office/integration/model_catalog_api.gd:73`).
2. Whether a write to the global scope from a project-scoped Location is allowed; the Location middleware
   resolves exactly one directory (`packages/server/src/location.ts:26-40`), so the design uses an explicit
   `scope` field rather than implying it from Location.
3. Whether a faithful JSONC diff can be produced for comments/substitution tokens without a line-level parser;
   `jsonc-parser` exposes `modify`/`applyEdits` but not a documented diff API.
4. Which exact `Info` leaves are secret-bearing is not centrally declared; the design infers it from
   `providers.<id>.settings`/`headers` and MCP `environment`/`headers` only.

## 10. Verification status of this note

Read-only lane. No repo file modified. `git status --porcelain` output at completion:

```
?? ycoding-office-repair-kit/
```



