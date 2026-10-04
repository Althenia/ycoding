# Fork-point classification

Upstream: anomalyco/opencode v2 @ 39fdd671. Checkout: 1af767b6. Tracked files under packages/: 4096.

| Package | upstream-unchanged | upstream-modified | ycoding-new | vendored |
|---|---|---|---|---|
| ai | 153 | 62 | 14 | 0 |
| cli | 36 | 42 | 91 | 0 |
| client | 16 | 19 | 4 | 0 |
| codemode | 58 | 3 | 2 | 0 |
| containers | 8 | 0 | 0 | 0 |
| core | 240 | 275 | 269 | 137 |
| effect-drizzle-sqlite | 25 | 1 | 0 | 0 |
| effect-sqlite-node | 3 | 1 | 0 | 0 |
| http-recorder | 27 | 3 | 0 | 0 |
| httpapi-codegen | 15 | 1 | 0 | 0 |
| identity | 6 | 0 | 0 | 0 |
| plugin | 5 | 3 | 41 | 0 |
| protocol | 25 | 15 | 24 | 0 |
| remote | 0 | 0 | 8 | 0 |
| schema | 67 | 25 | 27 | 0 |
| script | 2 | 2 | 2 | 0 |
| server | 29 | 22 | 37 | 0 |
| simulation | 24 | 3 | 3 | 0 |
| tui | 162 | 191 | 222 | 0 |
| ui | 1591 | 50 | 5 | 0 |
| **total** | 2492 | 718 | 749 | 137 |

## Current in-use review against cleanup

The baseline blob classification above remains a record of the original checkout. Current in-use evidence is a separate, incomplete reachability review; public source-subpath exposure is not proof of an internal caller, and absence of one is not deletion authority.

| Scope | Baseline source paths | Current paths | Confirmed internal use | Public-only exposure confirmed | Not resolved |
|---|---:|---:|---:|---:|---:|
| `packages/ai/src` | 56 | 56 | 39 (runtime-linked) | 0 | 17 |
| `packages/ai` example/script/declaration | 4 | 3 | 1 (package script) | 1 (documented example) | 1 |
| `packages/cli` | 29 | 28 | 28 (27 source, 1 build script) | 0 | 0 |
| `packages/client` | 9 | 8 | 7 (5 source, 2 build scripts) | 0 | 1 |
| `packages/containers` selected build script | 1 | 0 | 0 | 0 | 0 |
| `packages/codemode` | 32 | 31 | 31 (29 runtime-linked, 2 type-only) | 0 | 0 |
| `packages/core` | 151 | 141 | 138 (129 runtime-linked, 7 type-only, 2 script/config) | 0 | 3 |
| `packages/effect-drizzle-sqlite/src` | 19 | 19 | 17 runtime-linked | 2 explicit public subpaths | 0 |
| `packages/effect-drizzle-sqlite` example/declaration | 2 | 1 | 0 | 0 | 1 standalone example |
| `packages/effect-sqlite-node` | 2 | 1 | 0 | 0 | 1 |
| `packages/http-recorder` selected non-test source | 18 | 17 | 17 (12 test/public-linked, 2 type-only, 3 scripts) | 0 | 0 |
| `packages/httpapi-codegen` selected non-test source | 2 | 1 | 1 (Client generation entry) | 0 | 0 |
| `packages/protocol` | 22 | 20 | 20 (19 source, 1 build script) | 0 | 0 |
| `packages/schema` | 58 | 46 | 45 (44 schema import/entrypoint paths, 1 package script) | 0 | 1 |
| `packages/server` | 26 | 25 | 25 (24 runtime, 1 type-only) | 0 | 0 |
| `packages/simulation` selected non-test source | 14 | 14 | 14 (13 runtime-linked, 1 declaration) | 0 | 0 |
| `packages/plugin` baseline files | 2 | 0 | 0 | 0 | 0 |
| `packages/script` selected SST declaration | 1 | 0 | 0 | 0 | 0 |
| `packages/tui` | 107 | 103 | 101 (99 runtime, 2 declarations) | 0 | 2 |

The 19 rows account for all 555 named upstream-unchanged non-test TS/declaration/example/script paths outside `packages/ui`: 514 remain, of which 484 have a demonstrated internal, type, script, or test linkage, three have documented/example/public-subpath exposure without an internal consumer, and 27 remain unresolved for current-use purposes. Forty-one were removed under approved slices. The other 186 named `packages/ui` paths were removed under S2. This is file reachability, not an exported-symbol census or permission to delete unresolved/public surfaces.

A separate read-only classifier run at cleanup head `96c6b644` against upstream `39fdd671` counted 2,393 current tracked `packages/` files: 794 unchanged, 702 modified, 760 YCoding-new, and 137 vendored; 483 are currently unchanged non-test TS/TSX paths. Those current classes feed the code-leaning ranking. They differ from the historical 741-path baseline set above because approved cleanup removed or modified some baseline files; 483 is not the number of surviving paths from that set.

Confirmed internal AI source: `src/{llm.ts,schema/errors.ts,schema/ids.ts,schema/index.ts,tool.ts}` are on the package root/schema/tool construction consumed by Core `session/title.ts` and `session/model-request.ts`. Provider-facing `src/protocols/{openai-compatible-chat.ts,openai-compatible-responses.ts,bedrock-event-stream.ts,google-images.ts,openai-images.ts,xai-images.ts}` have runtime callers in maintained provider facades or Core `session/runner/model.ts`. `src/protocols/utils/{bedrock-auth.ts,bedrock-cache.ts,bedrock-media.ts,cache.ts,gemini-tool-schema.ts,image-input.ts,openai-image.ts,tool-stream.ts}` are imported by Bedrock, Anthropic, Gemini, OpenAI or image protocols. Exact import/call examples: `providers/openai-compatible.ts:2,27`, `providers/google.ts:7,41`, `providers/xai.ts:7,48`, `protocols/bedrock-converse.ts:20,23–25`, `protocols/gemini.ts:21,174`, `protocols/openai-chat.ts:25`, `protocols/openai-responses.ts:30–31`, and `protocols/openai-images.ts:21–22` at the reviewed cleanup head. `src/protocols/zai-images.ts` is imported only by `src/providers/zai.ts` in this bounded source search; no active Core builtin maps that facade, so both remain unresolved rather than current runtime use.

Additional internal AI paths: `src/image-client.ts` is imported by `src/image.ts:3`, which reaches the `providers/openai.ts:141` image operation through `protocols/openai-images.ts:4,204`; `src/provider-package.ts` is used by provider facades and `src/providers/{amazon-bedrock.ts,anthropic-compatible.ts,anthropic.ts,azure.ts,azure/chat.ts,azure/responses.ts,google.ts,openai-compatible.ts,openai/responses.ts}` reach active Core provider registrations (`packages/core/src/provider.ts:36–44`). Another eight runtime-linked paths are `src/{provider,route,tool-runtime}.ts`, `src/providers/xai.ts`, `src/route/{auth-options,endpoint,protocol}.ts`, and `src/utils/record.ts`: Core's builtin package map imports XAI (`core/src/provider.ts:47`), Core imports `@ycoding-ai/ai/route` (`session/runner/model.ts:13`, `aisdk.ts:40`), AI protocols and provider facades import the route helpers, and the package root links provider/tool-runtime modules. Module linkage does not prove every exported function is called.

The other seventeen AI `src/` paths have public/config-addressable exposure but no demonstrated current fixed-entrypoint consumer in this bounded review: `protocols.ts`, `protocols/index.ts`, `protocols/zai-images.ts`, `providers.ts`, `providers/cloudflare.ts`, `providers/{google-vertex-chat,google-vertex-messages,google-vertex-responses,google-vertex-shared,google-vertex}.ts`, `providers/google-vertex/{chat,gemini,messages,responses}.ts`, `providers/openai-compatible-responses.ts`, `providers/openai-compatible/responses.ts`, and `providers/zai.ts`. Core's builtin map omits those facades while its active Vertex plugin uses AI SDK routes; generic configured package loading can still import an AI subpath through the package wildcard export. They remain unresolved for internal runtime use, not public-only or safe-to-delete. Of four non-`src/` baseline paths, `example/tutorial.ts` is a documented runnable example, `script/setup-recording-env.ts` is invoked by the package's `setup:recording-env` script, `script/recording-cost-report.ts` has no demonstrated current caller, and `sst-env.d.ts` was removed by `507521e2` under S6. No tests or code mutations were performed for this reachability review.

One Core subset: `src/config/{agent,attachments,command,formatter,lsp,mcp,model,plugin,reference}.ts` feed `src/config.ts:20–36,85–110` and the runtime `Config.Service` (`src/session/model-request.ts:129`, CLI `main.ts:24`). `src/config/markdown.ts` is used by `src/skill.ts:9,187` and `src/tool/skill.ts:10,162`; `src/config/policy.ts` feeds `src/config/experimental.ts:5,11`. `src/command.ts` is imported by Core `src/session.ts:69` and Server `src/handlers/command.ts:1`.

In a separate sixteen-path Core subset, `src/config/{tool-output,watcher}.ts` feed `src/config.ts`; `src/control-plane/workspace.sql.ts` feeds the Session projector; `src/data-migration.sql.ts` feeds the attachment store; `src/database/{path,schema.sql,sqlite.bun,sqlite.node,sqlite}.ts` feed live SQL and conditional Bun/Node adapters; and `src/effect/{app-node,keyed-mutex,layer-node,memo-map,runtime,service-use}.ts` feed Session/runtime/filesystem services. `src/control-plane/move-session.ts` is exposed through the wildcard package subpath, but a bounded Core/Server/CLI source search found no caller beyond its self-export; it remains unresolved, not confirmed public-only or safe to remove.

A third sixteen-path Core subset remains internally referenced: `src/filesystem.ts` reaches Server through `location-services.ts`; `src/filesystem/{fff.bun,fff.node}.ts` are conditional `#fff` adapters consumed by `filesystem/search.ts`, while `ignore.ts`, `protected.ts`, `location-watcher.ts`, `search.ts`, and `fs-util.ts` feed active Location/filesystem services. The Copilot provider is dynamically imported by `src/plugin/provider/github-copilot.ts:199–200`; its chat model reaches `get-response-metadata.ts`, `map-openai-compatible-finish-reason.ts`, `openai-compatible-chat-options.ts`, and `openai-compatible-prepare-tools.ts`. `openai-compatible-api-types.ts` and `openai-compatible-metadata-extractor.ts` are current internal type-only dependencies of that chain, not runtime loads. This classification proves current references, not independent public consumers or permission to remove them.

Of the other 104 Core `src/` baseline paths, 88 have runtime import/entrypoint chains and five are type/declaration-only (`github-copilot/responses/{openai-config,openai-responses-settings}.ts`, `pty/pty.ts`, `markdown.d.ts`, `node-ffi.d.ts`). Runtime evidence includes Server `routes.ts:5–6,29,36–37` → Event/Location/ToolOutput/WellKnown services; Core `location-services.ts:14,25,33,39–40,47,60,62` → mutation/project/reference/session/tool services; CLI `main.ts:3–8` → observability/version/npm/process; Copilot plugin's dynamic import at `plugin/provider/github-copilot.ts:199` → Responses model helpers and tool files. Package `#pty`, `#photon-wasm`, `#runtime-import`, and `#process-lock-ffi` maps select Bun/Node adapters. The two current paths without a demonstrated runtime caller are `plugin/layer-map.example.ts` and `util/path.ts`; both are wildcard-exported, so they remain unresolved rather than public-only or safe to remove. Nine `src/` paths were removed in S4/S5: `account.ts`, `account/sql.ts`, `share/sql.ts`, `util/{array,binary,iife,module,retry}.ts`, and `v2-schema.ts`. Of three other baseline paths, `drizzle.config.ts` feeds `script/migration.ts:119`, `script/fix-node-pty.ts` is a package script, and `sst-env.d.ts` was removed by the approved S6 `D-sst` triage. Thus all 151 Core baseline paths are categorized at file reachability level; this does not establish every exported function's use or authorize deletion.

Selected CLI handlers `src/commands/handlers/{api.ts,auth/connect.ts,console/login.ts,debug/agents.ts,mcp/add.ts,mcp/auth.ts,mcp/list.ts,mcp/logout.ts,mini.ts,pair.ts,plugin/list.ts}` are lazy entries in the executable's `Runtime.handlers(Commands, …)` table (`packages/cli/src/index.ts:7–31`). `src/commands/handlers/mcp/resolve.ts` is imported by the active MCP auth and logout handlers (`mcp/{auth,logout}.ts`). These twelve paths are current CLI runtime entries or dependencies; the rest of the CLI baseline list remains unclassified for current use.

Fifteen more CLI paths have live entrypoint chains: `src/config/{index,schema}.ts` feed CLI `main.ts:11` through config parsing; `src/env.ts` feeds server connection/process; `src/framework/runtime.ts` feeds `index.ts:5`, `main.ts:9`, and TUI launch; `src/mini-host.ts`, `src/services/catalog.ts`, and `src/session-target.ts` feed mini/run; `src/node/index.ts` is the Node bundle entry in `vite.node.config.ts:197`, while `src/node/target.ts` feeds `script/build-node.ts:14` and `script/node-assets.ts:7`; `src/run/ui.ts` feeds interactive and noninteractive run; `src/services/standalone.ts` feeds `services/server-connection.ts`; `src/services/update-preflight.tsx` feeds `commands/handlers/tui-shared.ts`; and `src/ui/timeline.tsx` feeds the active console/login handler. `src/util/io.ts` supplies `readStdin` to mini/run, and `src/util/process.ts` supplies `selfCommand` to standalone/service config. All 27 non-test CLI `src/` paths are present and internally consumed; `script/node-assets.ts` is imported by `script/build-node.ts:12`, and `sst-env.d.ts` was removed under S6.

Five of six Client baseline `src/` paths have current internal consumers: `src/promise/index.ts` is the package root/`./promise` export and is imported by CLI connection/catalog and TUI; `src/promise/generated/index.ts` re-exports `client-error.ts` into that root, while the generated Promise client imports its error directly; `src/effect/generated/index.ts` is re-exported by the public Effect entry and its `client-error.ts` is imported by the generated Effect client. Generated files are owned by `packages/client` generation, not hand-edited. `src/contract.ts` re-exports Protocol client metadata but is not mapped by explicit exports or imported in the bounded source/script/test search; its consumer remains unresolved. `script/build.ts` and `script/build-package.ts` are package `generate`/`build` entries; `sst-env.d.ts` was removed under S6.

Nine CodeMode baseline files form one active interpreter chain: Core `src/tool/execute.ts:3` imports the CodeMode package, its `src/codemode.ts:2` invokes `src/interpreter/execute.ts`, and that file imports `errors.ts`, `model.ts`, `promises.ts`, and `runtime.ts`. Runtime imports `methods.ts`, `references.ts`, and `scope.ts`. Of the remaining 22 `src/` baseline files, `openapi/{index,runtime,spec}.ts`, all twelve `stdlib/*.ts` rows, and `{tool-error,tool-runtime,tool-schema,tool,values}.ts` are runtime-linked from current package entrypoints; `openapi/types.ts` and `tools.ts` are type-only. The root `src/index.ts:4` eagerly re-exports OpenAPI, though no production `OpenAPI.fromSpec` call was found; module linkage is not proof of functional invocation. The extra baseline `sst-env.d.ts` was removed by `507521e2` in the approved unused-file sweep. All 31 current CodeMode baseline source paths have an internal import/entrypoint chain; no safe-to-delete conclusion follows.

Of 106 baseline TUI `src/` paths, 99 have a current runtime import or entrypoint chain and two (`audio.d.ts`, `node-ffi.d.ts`) are declaration-only. CLI `tui-shared.ts` reaches the TUI root and `app.tsx`; its lazy mini handler reaches `mini/index.ts` and `mini/runtime.ts`; `attention.ts:23` reaches the package `#attention-sounds` Bun/Node mappings. `component/dialog-tag.tsx` has only a test import in the bounded review and `util/revert-diff.ts` has no demonstrated live caller, so both remain unresolved. Three source paths are absent: `component/prompt/cwd.ts` was removed in S4, while `context/directory.ts` and `theme/v2/solid.ts` were removed by `b4cd8153` under the S6 `D-tui-files` triage (`knip/triage.md:153–154`). The 107th baseline path, `sst-env.d.ts`, was removed by `507521e2` under S6 `D-sst`. Current internal reachability is not permission to remove public subpaths, and absence of a caller does not prove disuse.

Thirteen baseline Simulation `src/` runtime paths feed the current Drive mode: Server `routes.ts:144` dynamically imports the package backend, while TUI `app.tsx:222` dynamically imports its frontend. Backend `index.ts` reaches network/OpenAI/protocol/manifest; frontend `simulation.ts` reaches actions/renderer/server/manifest, and actions dynamically imports PNG while using semantics. Renderer reaches recording; control-server and frontend server reach the shared protocol. `src/assets.d.ts` is a declaration referenced by PNG. The two Plugin baseline paths (`script/publish.ts`, `sst-env.d.ts`) are absent under approved S6 upstream publish/SST triage. These observations do not classify other upstream source classes or Simulation test files.

Effect Drizzle SQLite's current Core database calls `makeWithDefaults()` from the package root; 17 of its baseline `src/` modules form that driver/session/migrator and SQL builder chain. `src/effect-sqlite/index.ts` and `src/sqlite-core/effect/index.ts` are explicit public subpaths without a demonstrated internal caller in the bounded review; `examples/basic.ts` is a standalone example. These three public/example entries are not deletion candidates. Its `sst-env.d.ts` was removed under S6. HTTP Recorder's 12 baseline recorder/cassette/redaction/replay/WebSocket modules are linked from the public root and exercised by AI/Core tests, but no production `src/` importer was found; `src/{api,options}.ts` are type-only, and `script/{build,verify-package}.ts` are package scripts with `script/pack.ts` consumed by verification. Its `sst-env.d.ts` was removed under S6. HTTP API Codegen's `src/index.ts` is imported by `packages/client/script/build.ts:2` to emit Promise/Effect clients from Protocol `ClientApi`; its SST declaration was removed under S6. The six baseline Identity mark PNG/SVG assets (`mark-{96x96,192x192,512x512,512x512-light}.png`, `mark.svg`, `mark-light.svg`) were removed by approved G12 commit `519c6bb2`. Aggregate upstream counts include test/asset paths beyond this non-test source review; the current consumers and package exports, not missing imports alone, determine retention.

Among the other named baseline paths, Protocol `script/build.ts` is its package build command while `script/publish.ts` and `sst-env.d.ts` were removed under S6; Server's SST declaration was removed under S6. The Containers `script/build.ts` was removed with its package by approved G12 commit `519c6bb2`. Effect SQLite Node's private package root `src/index.ts` has an explicit `.` export and a workspace declaration, but the bounded Core/CLI/Server/adapter source search found no product caller; it remains unresolved, not safe to remove. Its SST declaration and the `packages/script/sst-env.d.ts` declaration were removed under S6. This completes the 555 named upstream-unchanged non-test source paths outside `packages/ui`; the aggregate 2,492-file comparison separately includes tests, assets, manifests, and UI files and does not assert their current-use status.

All nineteen Protocol baseline source paths are current runtime inputs: `src/api.ts:3–36` imports the seventeen `src/groups/{agent,command,debug,form,fs,generate,integration,location,mcp,model,permission,plugin,project-copy,question,reference,server,skill}.ts` definitions and both `src/middleware/{authorization,schema-error}.ts`. Server `src/api.ts:1` imports Protocol's `makeDefaultApi` and `src/routes.ts:42` mounts that API with live handlers. This is a runtime composition chain, not evidence about other Protocol upstream classes or generated clients.

In one ten-path Schema subset, `src/{catalog,config,credential,event-log,file-diff,filesystem,form,identifier}.ts` have current Core or Protocol subpath imports (`core/src/{catalog,config,credential,filesystem,form,id/id,vcs}.ts`; `protocol/src/groups/{event,form,fs,vcs}.ts`). `src/installation-event.ts` contributes definitions to `src/event-manifest.ts:13,70,81`, which Protocol's Event group and Core's plugin host consume. `src/ide-event.ts` has only a self-export in the bounded Schema/Core/Protocol/Server/CLI/TUI search; its current consumer is unresolved, not proven unused or safe to delete.

A second ten-path Schema subset is reached by current consumers: `src/{instruction-entry,instruction,integration,llm,location,mcp-event,mcp,models-dev}.ts` have direct Core, Protocol, or AI subpath imports; `src/integration-id.ts` feeds the active `credential.ts`, `integration.ts`, and `mcp.ts` schemas; `src/lsp-event.ts` contributes definitions to `event-manifest.ts`, which Protocol's Event group uses. These are current schema values or types, not proof that every exported member is called.

Of 38 other Schema baseline paths, 25 `src/` paths are linked by live Core/Protocol imports or the event manifest: `src/{money,permission-saved,permission,plugin,project-copy,project-directories,project-id,prompt-input,question,reference,schema,server-event,session-compaction-event,session-delivery,session-error,session-id,session-status-event,snapshot,token-usage,tui-event,vcs-event,workspace-event,workspace-id,workspace,worktree-event}.ts`. Protocol groups directly consume permission, project-copy, prompt-input, question, reference, session-delivery, workspace and schema helpers; Core imports money, permission, project directories, Session errors and snapshot. `event-manifest.ts:19–35,68–92` assembles plugin, project-directory, question, reference, server, Session, TUI, VCS, workspace, and worktree events; Protocol `groups/event.ts:54` mounts ServerDefinitions and Core `plugin/host.ts:167` filters subscriptions through it. Ten V1 source paths (`src/{filesystem-v1,legacy-event,permission-v1,question-v1,session-v1}.ts` and corresponding `src/v1/{filesystem,legacy-event,permission,question,session}.ts`) were removed under approved S3. Of three other baseline paths, `script/build.ts` is the package `build` entry, while `script/publish.ts` and `sst-env.d.ts` were removed under S6 `D-sst`. All 58 baseline paths are categorized at file reachability level; only `ide-event.ts` remains unresolved, and no deletion authority follows.

Ten baseline Schema V1 paths—`src/{filesystem-v1,legacy-event,permission-v1,question-v1,session-v1}.ts` and `src/v1/{filesystem,legacy-event,permission,question,session}.ts`—are absent from the current cleanup checkout under the approved S3 removal. They are historical inventory rows, not current in-use or new deletion candidates.

`packages/plugin` has no upstream-unchanged non-test source path in this baseline list. Its two baseline entries, `script/publish.ts` and `sst-env.d.ts`, are absent from the current checkout after the approved S4 cleanup; neither is a current in-use or deletion candidate.

All twenty-five Server baseline source paths remain internally referenced: `src/handlers.ts:2–31` imports the sixteen selected `src/handlers/{agent,command,debug,form,fs,generate,integration,mcp,model,permission,plugin,project-copy,question,reference,server,skill}.ts` layers and `src/routes.ts:44` mounts the merged handlers. `src/routes.ts:42–55` imports `api.ts`, `auth.ts`, `location.ts`, `middleware/{form-location,schema-error}.ts`, `pty-environment.ts`, and `server-info.ts`; `src/process.ts:15` imports `request-tracing.ts`. `src/options.ts` is currently a type-only `ServerOptions` dependency of routes/process, not a runtime load. This does not classify Server files in other upstream classes.

## Upstream-unchanged source files (non-test .ts/.tsx): 741 files, 77050 lines

| File | Lines |
|---|---|
| packages/ai/example/tutorial.ts | 256 |
| packages/ai/script/recording-cost-report.ts | 251 |
| packages/ai/script/setup-recording-env.ts | 555 |
| packages/ai/src/image-client.ts | 39 |
| packages/ai/src/image.ts | 167 |
| packages/ai/src/llm.ts | 187 |
| packages/ai/src/protocols.ts | 2 |
| packages/ai/src/protocols/bedrock-event-stream.ts | 88 |
| packages/ai/src/protocols/google-images.ts | 315 |
| packages/ai/src/protocols/index.ts | 9 |
| packages/ai/src/protocols/openai-compatible-chat.ts | 26 |
| packages/ai/src/protocols/openai-compatible-responses.ts | 24 |
| packages/ai/src/protocols/openai-images.ts | 271 |
| packages/ai/src/protocols/utils/bedrock-auth.ts | 71 |
| packages/ai/src/protocols/utils/bedrock-cache.ts | 38 |
| packages/ai/src/protocols/utils/bedrock-media.ts | 91 |
| packages/ai/src/protocols/utils/cache.ts | 17 |
| packages/ai/src/protocols/utils/gemini-tool-schema.ts | 100 |
| packages/ai/src/protocols/utils/image-input.ts | 35 |
| packages/ai/src/protocols/utils/openai-image.ts | 21 |
| packages/ai/src/protocols/utils/tool-stream.ts | 227 |
| packages/ai/src/protocols/xai-images.ts | 203 |
| packages/ai/src/protocols/zai-images.ts | 133 |
| packages/ai/src/provider-package.ts | 17 |
| packages/ai/src/provider.ts | 37 |
| packages/ai/src/providers.ts | 2 |
| packages/ai/src/providers/amazon-bedrock.ts | 69 |
| packages/ai/src/providers/anthropic-compatible.ts | 68 |
| packages/ai/src/providers/anthropic.ts | 57 |
| packages/ai/src/providers/azure.ts | 141 |
| packages/ai/src/providers/azure/chat.ts | 3 |
| packages/ai/src/providers/azure/responses.ts | 3 |
| packages/ai/src/providers/cloudflare.ts | 128 |
| packages/ai/src/providers/google-vertex-chat.ts | 82 |
| packages/ai/src/providers/google-vertex-messages.ts | 112 |
| packages/ai/src/providers/google-vertex-responses.ts | 83 |
| packages/ai/src/providers/google-vertex-shared.ts | 78 |
| packages/ai/src/providers/google-vertex.ts | 99 |
| packages/ai/src/providers/google-vertex/chat.ts | 3 |
| packages/ai/src/providers/google-vertex/gemini.ts | 3 |
| packages/ai/src/providers/google-vertex/messages.ts | 3 |
| packages/ai/src/providers/google-vertex/responses.ts | 3 |
| packages/ai/src/providers/google.ts | 68 |
| packages/ai/src/providers/openai-compatible-responses.ts | 56 |
| packages/ai/src/providers/openai-compatible.ts | 83 |
| packages/ai/src/providers/openai-compatible/responses.ts | 2 |
| packages/ai/src/providers/openai/responses.ts | 3 |
| packages/ai/src/providers/xai.ts | 70 |
| packages/ai/src/providers/zai.ts | 36 |
| packages/ai/src/route.ts | 2 |
| packages/ai/src/route/auth-options.ts | 61 |
| packages/ai/src/route/endpoint.ts | 57 |
| packages/ai/src/route/protocol.ts | 85 |
| packages/ai/src/schema/errors.ts | 160 |
| packages/ai/src/schema/ids.ts | 44 |
| packages/ai/src/schema/index.ts | 6 |
| packages/ai/src/tool-runtime.ts | 79 |
| packages/ai/src/tool.ts | 254 |
| packages/ai/src/utils/record.ts | 4 |
| packages/ai/sst-env.d.ts | 10 |
| packages/cli/script/node-assets.ts | 84 |
| packages/cli/src/commands/handlers/api.ts | 87 |
| packages/cli/src/commands/handlers/auth/connect.ts | 53 |
| packages/cli/src/commands/handlers/console/login.ts | 119 |
| packages/cli/src/commands/handlers/debug/agents.ts | 26 |
| packages/cli/src/commands/handlers/mcp/add.ts | 69 |
| packages/cli/src/commands/handlers/mcp/auth.ts | 68 |
| packages/cli/src/commands/handlers/mcp/list.ts | 56 |
| packages/cli/src/commands/handlers/mcp/logout.ts | 40 |
| packages/cli/src/commands/handlers/mcp/resolve.ts | 19 |
| packages/cli/src/commands/handlers/mini.ts | 39 |
| packages/cli/src/commands/handlers/pair.ts | 44 |
| packages/cli/src/commands/handlers/plugin/list.ts | 25 |
| packages/cli/src/config/index.ts | 2 |
| packages/cli/src/config/schema.ts | 6 |
| packages/cli/src/env.ts | 16 |
| packages/cli/src/framework/runtime.ts | 101 |
| packages/cli/src/mini-host.ts | 176 |
| packages/cli/src/node/index.ts | 10 |
| packages/cli/src/node/target.ts | 35 |
| packages/cli/src/run/ui.ts | 28 |
| packages/cli/src/services/catalog.ts | 44 |
| packages/cli/src/services/standalone.ts | 64 |
| packages/cli/src/services/update-preflight.tsx | 496 |
| packages/cli/src/session-target.ts | 167 |
| packages/cli/src/ui/timeline.tsx | 243 |
| packages/cli/src/util/io.ts | 6 |
| packages/cli/src/util/process.ts | 27 |
| packages/cli/sst-env.d.ts | 10 |
| packages/client/script/build-package.ts | 10 |
| packages/client/script/build.ts | 36 |
| packages/client/src/contract.ts | 7 |
| packages/client/src/effect/generated/client-error.ts | 6 |
| packages/client/src/effect/generated/index.ts | 3 |
| packages/client/src/promise/generated/client-error.ts | 17 |
| packages/client/src/promise/generated/index.ts | 4 |
| packages/client/src/promise/index.ts | 17 |
| packages/client/sst-env.d.ts | 10 |
| packages/codemode/src/codemode.ts | 158 |
| packages/codemode/src/interpreter/errors.ts | 94 |
| packages/codemode/src/interpreter/execute.ts | 232 |
| packages/codemode/src/interpreter/methods.ts | 1148 |
| packages/codemode/src/interpreter/model.ts | 217 |
| packages/codemode/src/interpreter/promises.ts | 326 |
| packages/codemode/src/interpreter/references.ts | 128 |
| packages/codemode/src/interpreter/runtime.ts | 2202 |
| packages/codemode/src/interpreter/scope.ts | 103 |
| packages/codemode/src/openapi/index.ts | 133 |
| packages/codemode/src/openapi/runtime.ts | 332 |
| packages/codemode/src/openapi/spec.ts | 730 |
| packages/codemode/src/openapi/types.ts | 107 |
| packages/codemode/src/stdlib/collections.ts | 71 |
| packages/codemode/src/stdlib/console.ts | 123 |
| packages/codemode/src/stdlib/date.ts | 181 |
| packages/codemode/src/stdlib/json.ts | 46 |
| packages/codemode/src/stdlib/math.ts | 156 |
| packages/codemode/src/stdlib/number.ts | 79 |
| packages/codemode/src/stdlib/object.ts | 99 |
| packages/codemode/src/stdlib/promise.ts | 4 |
| packages/codemode/src/stdlib/regexp.ts | 130 |
| packages/codemode/src/stdlib/string.ts | 50 |
| packages/codemode/src/stdlib/url.ts | 91 |
| packages/codemode/src/stdlib/value.ts | 115 |
| packages/codemode/src/tool-error.ts | 12 |
| packages/codemode/src/tool-runtime.ts | 725 |
| packages/codemode/src/tool-schema.ts | 245 |
| packages/codemode/src/tool.ts | 77 |
| packages/codemode/src/tools.ts | 6 |
| packages/codemode/src/values.ts | 54 |
| packages/codemode/sst-env.d.ts | 10 |
| packages/containers/script/build.ts | 78 |
| packages/core/drizzle.config.ts | 11 |
| packages/core/script/fix-node-pty.ts | 29 |
| packages/core/src/account.ts | 102 |
| packages/core/src/account/sql.ts | 40 |
| packages/core/src/command.ts | 255 |
| packages/core/src/config/agent.ts | 26 |
| packages/core/src/config/attachments.ts | 16 |
| packages/core/src/config/command.ts | 13 |
| packages/core/src/config/formatter.ts | 13 |
| packages/core/src/config/lsp.ts | 19 |
| packages/core/src/config/markdown.ts | 37 |
| packages/core/src/config/mcp.ts | 22 |
| packages/core/src/config/model.ts | 37 |
| packages/core/src/config/plugin.ts | 14 |
| packages/core/src/config/policy.ts | 14 |
| packages/core/src/config/reference.ts | 23 |
| packages/core/src/config/tool-output.ts | 10 |
| packages/core/src/config/watcher.ts | 8 |
| packages/core/src/control-plane/move-session.ts | 182 |
| packages/core/src/control-plane/workspace.sql.ts | 21 |
| packages/core/src/data-migration.sql.ts | 7 |
| packages/core/src/database/path.ts | 95 |
| packages/core/src/database/schema.sql.ts | 11 |
| packages/core/src/database/sqlite.bun.ts | 180 |
| packages/core/src/database/sqlite.node.ts | 175 |
| packages/core/src/database/sqlite.ts | 9 |
| packages/core/src/effect/app-node.ts | 15 |
| packages/core/src/effect/keyed-mutex.ts | 46 |
| packages/core/src/effect/layer-node.ts | 334 |
| packages/core/src/effect/memo-map.ts | 4 |
| packages/core/src/effect/runtime.ts | 22 |
| packages/core/src/effect/service-use.ts | 44 |
| packages/core/src/event-logger.ts | 25 |
| packages/core/src/event.ts | 715 |
| packages/core/src/event/sql.ts | 27 |
| packages/core/src/file-mutation.ts | 206 |
| packages/core/src/file.ts | 7 |
| packages/core/src/filesystem.ts | 121 |
| packages/core/src/filesystem/fff.bun.ts | 141 |
| packages/core/src/filesystem/fff.node.ts | 139 |
| packages/core/src/filesystem/ignore.ts | 68 |
| packages/core/src/filesystem/location-watcher.ts | 91 |
| packages/core/src/filesystem/protected.ts | 54 |
| packages/core/src/filesystem/search.ts | 254 |
| packages/core/src/fs-util.ts | 277 |
| packages/core/src/github-copilot/chat/get-response-metadata.ts | 16 |
| packages/core/src/github-copilot/chat/map-openai-compatible-finish-reason.ts | 20 |
| packages/core/src/github-copilot/chat/openai-compatible-api-types.ts | 65 |
| packages/core/src/github-copilot/chat/openai-compatible-chat-language-model.ts | 816 |
| packages/core/src/github-copilot/chat/openai-compatible-chat-options.ts | 29 |
| packages/core/src/github-copilot/chat/openai-compatible-metadata-extractor.ts | 45 |
| packages/core/src/github-copilot/chat/openai-compatible-prepare-tools.ts | 84 |
| packages/core/src/github-copilot/copilot-provider.ts | 101 |
| packages/core/src/github-copilot/openai-compatible-error.ts | 28 |
| packages/core/src/github-copilot/responses/map-openai-responses-finish-reason.ts | 23 |
| packages/core/src/github-copilot/responses/openai-config.ts | 19 |
| packages/core/src/github-copilot/responses/openai-error.ts | 23 |
| packages/core/src/github-copilot/responses/openai-responses-prepare-tools.ts | 174 |
| packages/core/src/github-copilot/responses/openai-responses-settings.ts | 2 |
| packages/core/src/github-copilot/responses/tool/code-interpreter.ts | 88 |
| packages/core/src/github-copilot/responses/tool/file-search.ts | 128 |
| packages/core/src/github-copilot/responses/tool/image-generation.ts | 115 |
| packages/core/src/github-copilot/responses/tool/local-shell.ts | 65 |
| packages/core/src/github-copilot/responses/tool/web-search-preview.ts | 104 |
| packages/core/src/github-copilot/responses/tool/web-search.ts | 103 |
| packages/core/src/id/id.ts | 50 |
| packages/core/src/image.ts | 80 |
| packages/core/src/image/photon-wasm.bun.ts | 5 |
| packages/core/src/image/photon-wasm.node.ts | 5 |
| packages/core/src/image/photon.ts | 94 |
| packages/core/src/installation/version.ts | 9 |
| packages/core/src/instructions/index.ts | 269 |
| packages/core/src/integration/connection.ts | 13 |
| packages/core/src/kv.ts | 48 |
| packages/core/src/kv/sql.ts | 10 |
| packages/core/src/location-mutation.ts | 163 |
| packages/core/src/location-service-map.ts | 19 |
| packages/core/src/location.ts | 40 |
| packages/core/src/markdown.d.ts | 5 |
| packages/core/src/mime.ts | 35 |
| packages/core/src/model.ts | 37 |
| packages/core/src/node-ffi.d.ts | 19 |
| packages/core/src/npm-config.ts | 41 |
| packages/core/src/npm.ts | 277 |
| packages/core/src/observability.ts | 45 |
| packages/core/src/observability/otlp.ts | 91 |
| packages/core/src/observability/shared.ts | 2 |
| packages/core/src/patch.ts | 198 |
| packages/core/src/permission/saved.ts | 80 |
| packages/core/src/permission/sql.ts | 21 |
| packages/core/src/plugin/layer-map.example.ts | 95 |
| packages/core/src/process.ts | 262 |
| packages/core/src/project/copy-strategies.ts | 36 |
| packages/core/src/project/copy.ts | 293 |
| packages/core/src/project/directories.ts | 150 |
| packages/core/src/project/schema.ts | 36 |
| packages/core/src/project/sql.ts | 36 |
| packages/core/src/pty/pty.bun.ts | 29 |
| packages/core/src/pty/pty.node.ts | 32 |
| packages/core/src/pty/pty.ts | 26 |
| packages/core/src/pty/schema.ts | 2 |
| packages/core/src/reference.ts | 129 |
| packages/core/src/reference/instructions.ts | 94 |
| packages/core/src/repository-cache.ts | 262 |
| packages/core/src/repository.ts | 209 |
| packages/core/src/ripgrep.ts | 280 |
| packages/core/src/ripgrep/binary.ts | 133 |
| packages/core/src/runtime/import.bun.ts | 8 |
| packages/core/src/runtime/import.node.ts | 40 |
| packages/core/src/schema.ts | 90 |
| packages/core/src/session/event.ts | 3 |
| packages/core/src/session/generate.ts | 22 |
| packages/core/src/session/instruction-entry.ts | 139 |
| packages/core/src/session/message.ts | 3 |
| packages/core/src/session/revert.ts | 115 |
| packages/core/src/session/runner/index.ts | 31 |
| packages/core/src/session/schema.ts | 10 |
| packages/core/src/share/sql.ts | 14 |
| packages/core/src/shell/select.ts | 207 |
| packages/core/src/skill/discovery.ts | 215 |
| packages/core/src/state.ts | 181 |
| packages/core/src/tool-output-store.ts | 212 |
| packages/core/src/tool/hooks.ts | 99 |
| packages/core/src/tool/http-body.ts | 31 |
| packages/core/src/tool/read-filesystem.ts | 367 |
| packages/core/src/tool/tools.ts | 24 |
| packages/core/src/util/array.ts | 11 |
| packages/core/src/util/binary.ts | 42 |
| packages/core/src/util/effect-flock.ts | 313 |
| packages/core/src/util/encode.ts | 52 |
| packages/core/src/util/error.ts | 71 |
| packages/core/src/util/flock.ts | 359 |
| packages/core/src/util/glob.ts | 35 |
| packages/core/src/util/hash.ts | 12 |
| packages/core/src/util/identifier.ts | 2 |
| packages/core/src/util/iife.ts | 4 |
| packages/core/src/util/lazy.ts | 12 |
| packages/core/src/util/module.ts | 11 |
| packages/core/src/util/path.ts | 38 |
| packages/core/src/util/process-lock-ffi.bun.ts | 51 |
| packages/core/src/util/process-lock-ffi.node.ts | 44 |
| packages/core/src/util/process-lock.ts | 134 |
| packages/core/src/util/retry.ts | 43 |
| packages/core/src/util/slug.ts | 75 |
| packages/core/src/util/which.ts | 15 |
| packages/core/src/util/wildcard.ts | 15 |
| packages/core/src/v2-schema.ts | 4 |
| packages/core/src/vcs/patch.ts | 107 |
| packages/core/src/wellknown.ts | 195 |
| packages/core/src/workspace.ts | 7 |
| packages/core/sst-env.d.ts | 10 |
| packages/effect-drizzle-sqlite/examples/basic.ts | 93 |
| packages/effect-drizzle-sqlite/src/effect-sqlite/driver.ts | 78 |
| packages/effect-drizzle-sqlite/src/effect-sqlite/index.ts | 5 |
| packages/effect-drizzle-sqlite/src/effect-sqlite/migrator.ts | 15 |
| packages/effect-drizzle-sqlite/src/effect-sqlite/session.ts | 219 |
| packages/effect-drizzle-sqlite/src/index.ts | 7 |
| packages/effect-drizzle-sqlite/src/internal/drizzle-utils.ts | 128 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/count.ts | 59 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/db.ts | 297 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/delete.ts | 262 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/index.ts | 11 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/insert.ts | 350 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/query.ts | 199 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/raw.ts | 50 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/select.ts | 280 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/session.ts | 491 |
| packages/effect-drizzle-sqlite/src/sqlite-core/effect/update.ts | 403 |
| packages/effect-drizzle-sqlite/src/up-migrations/effect-sqlite.ts | 103 |
| packages/effect-drizzle-sqlite/src/up-migrations/sqlite.ts | 254 |
| packages/effect-drizzle-sqlite/src/up-migrations/utils.ts | 46 |
| packages/effect-drizzle-sqlite/sst-env.d.ts | 10 |
| packages/effect-sqlite-node/src/index.ts | 172 |
| packages/effect-sqlite-node/sst-env.d.ts | 10 |
| packages/http-recorder/script/build.ts | 27 |
| packages/http-recorder/script/pack.ts | 42 |
| packages/http-recorder/script/verify-package.ts | 111 |
| packages/http-recorder/src/api.ts | 47 |
| packages/http-recorder/src/cassette/model.ts | 44 |
| packages/http-recorder/src/cassette/store.ts | 202 |
| packages/http-recorder/src/http/matching.ts | 78 |
| packages/http-recorder/src/http/model.ts | 31 |
| packages/http-recorder/src/http/recorder.ts | 177 |
| packages/http-recorder/src/index.ts | 44 |
| packages/http-recorder/src/options.ts | 2 |
| packages/http-recorder/src/redaction/redactor.ts | 174 |
| packages/http-recorder/src/redaction/secrets.ts | 48 |
| packages/http-recorder/src/replay/comparison.ts | 30 |
| packages/http-recorder/src/replay/state.ts | 97 |
| packages/http-recorder/src/websocket/model.ts | 36 |
| packages/http-recorder/src/websocket/recorder.ts | 585 |
| packages/http-recorder/sst-env.d.ts | 11 |
| packages/httpapi-codegen/src/index.ts | 1610 |
| packages/httpapi-codegen/sst-env.d.ts | 10 |
| packages/plugin/script/publish.ts | 39 |
| packages/plugin/sst-env.d.ts | 10 |
| packages/protocol/script/build.ts | 10 |
| packages/protocol/script/publish.ts | 46 |
| packages/protocol/src/groups/agent.ts | 23 |
| packages/protocol/src/groups/command.ts | 28 |
| packages/protocol/src/groups/debug.ts | 33 |
| packages/protocol/src/groups/form.ts | 146 |
| packages/protocol/src/groups/fs.ts | 69 |
| packages/protocol/src/groups/generate.ts | 36 |
| packages/protocol/src/groups/integration.ts | 201 |
| packages/protocol/src/groups/location.ts | 45 |
| packages/protocol/src/groups/mcp.ts | 104 |
| packages/protocol/src/groups/model.ts | 45 |
| packages/protocol/src/groups/permission.ts | 138 |
| packages/protocol/src/groups/plugin.ts | 28 |
| packages/protocol/src/groups/project-copy.ts | 57 |
| packages/protocol/src/groups/question.ts | 85 |
| packages/protocol/src/groups/reference.ts | 28 |
| packages/protocol/src/groups/server.ts | 17 |
| packages/protocol/src/groups/skill.ts | 28 |
| packages/protocol/src/middleware/authorization.ts | 7 |
| packages/protocol/src/middleware/schema-error.ts | 8 |
| packages/protocol/sst-env.d.ts | 10 |
| packages/schema/script/build.ts | 10 |
| packages/schema/script/publish.ts | 46 |
| packages/schema/src/catalog.ts | 7 |
| packages/schema/src/config.ts | 11 |
| packages/schema/src/credential.ts | 36 |
| packages/schema/src/event-log.ts | 22 |
| packages/schema/src/file-diff.ts | 24 |
| packages/schema/src/filesystem-v1.ts | 2 |
| packages/schema/src/filesystem.ts | 44 |
| packages/schema/src/form.ts | 165 |
| packages/schema/src/ide-event.ts | 14 |
| packages/schema/src/identifier.ts | 31 |
| packages/schema/src/installation-event.ts | 21 |
| packages/schema/src/instruction-entry.ts | 33 |
| packages/schema/src/instruction.ts | 22 |
| packages/schema/src/integration-id.ts | 8 |
| packages/schema/src/integration.ts | 155 |
| packages/schema/src/legacy-event.ts | 2 |
| packages/schema/src/llm.ts | 32 |
| packages/schema/src/location.ts | 26 |
| packages/schema/src/lsp-event.ts | 8 |
| packages/schema/src/mcp-event.ts | 38 |
| packages/schema/src/mcp.ts | 136 |
| packages/schema/src/models-dev.ts | 10 |
| packages/schema/src/money.ts | 19 |
| packages/schema/src/permission-saved.ts | 21 |
| packages/schema/src/permission-v1.ts | 2 |
| packages/schema/src/permission.ts | 66 |
| packages/schema/src/plugin.ts | 23 |
| packages/schema/src/project-copy.ts | 31 |
| packages/schema/src/project-directories.ts | 11 |
| packages/schema/src/project-id.ts | 9 |
| packages/schema/src/prompt-input.ts | 27 |
| packages/schema/src/question-v1.ts | 2 |
| packages/schema/src/question.ts | 87 |
| packages/schema/src/reference.ts | 41 |
| packages/schema/src/schema.ts | 31 |
| packages/schema/src/server-event.ts | 9 |
| packages/schema/src/session-compaction-event.ts | 14 |
| packages/schema/src/session-delivery.ts | 7 |
| packages/schema/src/session-error.ts | 10 |
| packages/schema/src/session-id.ts | 16 |
| packages/schema/src/session-status-event.ts | 52 |
| packages/schema/src/session-v1.ts | 2 |
| packages/schema/src/snapshot.ts | 7 |
| packages/schema/src/token-usage.ts | 15 |
| packages/schema/src/tui-event.ts | 61 |
| packages/schema/src/v1/filesystem.ts | 12 |
| packages/schema/src/v1/legacy-event.ts | 19 |
| packages/schema/src/v1/permission.ts | 67 |
| packages/schema/src/v1/question.ts | 67 |
| packages/schema/src/v1/session.ts | 677 |
| packages/schema/src/vcs-event.ts | 15 |
| packages/schema/src/workspace-event.ts | 33 |
| packages/schema/src/workspace-id.ts | 20 |
| packages/schema/src/workspace.ts | 10 |
| packages/schema/src/worktree-event.ts | 23 |
| packages/schema/sst-env.d.ts | 10 |
| packages/script/sst-env.d.ts | 10 |
| packages/server/src/api.ts | 13 |
| packages/server/src/auth.ts | 53 |
| packages/server/src/handlers/agent.ts | 14 |
| packages/server/src/handlers/command.ts | 9 |
| packages/server/src/handlers/debug.ts | 26 |
| packages/server/src/handlers/form.ts | 114 |
| packages/server/src/handlers/fs.ts | 41 |
| packages/server/src/handlers/generate.ts | 27 |
| packages/server/src/handlers/integration.ts | 174 |
| packages/server/src/handlers/mcp.ts | 70 |
| packages/server/src/handlers/model.ts | 41 |
| packages/server/src/handlers/permission.ts | 103 |
| packages/server/src/handlers/plugin.ts | 14 |
| packages/server/src/handlers/project-copy.ts | 69 |
| packages/server/src/handlers/question.ts | 65 |
| packages/server/src/handlers/reference.ts | 9 |
| packages/server/src/handlers/server.ts | 14 |
| packages/server/src/handlers/skill.ts | 9 |
| packages/server/src/location.ts | 61 |
| packages/server/src/middleware/form-location.ts | 77 |
| packages/server/src/middleware/schema-error.ts | 21 |
| packages/server/src/options.ts | 38 |
| packages/server/src/pty-environment.ts | 20 |
| packages/server/src/request-tracing.ts | 7 |
| packages/server/src/server-info.ts | 33 |
| packages/server/sst-env.d.ts | 10 |
| packages/simulation/src/assets.d.ts | 5 |
| packages/simulation/src/backend/index.ts | 55 |
| packages/simulation/src/backend/network.ts | 86 |
| packages/simulation/src/backend/openai.ts | 134 |
| packages/simulation/src/control-server.ts | 92 |
| packages/simulation/src/frontend/actions.ts | 250 |
| packages/simulation/src/frontend/png.ts | 118 |
| packages/simulation/src/frontend/renderer.ts | 77 |
| packages/simulation/src/frontend/semantics.ts | 21 |
| packages/simulation/src/frontend/server.ts | 73 |
| packages/simulation/src/frontend/simulation.ts | 28 |
| packages/simulation/src/manifest.ts | 111 |
| packages/simulation/src/protocol/index.ts | 563 |
| packages/simulation/src/recording.ts | 130 |
| packages/tui/src/attention-sounds.bun.ts | 9 |
| packages/tui/src/attention-sounds.node.ts | 17 |
| packages/tui/src/audio.d.ts | 10 |
| packages/tui/src/audio.ts | 54 |
| packages/tui/src/component/bg-pulse-render.ts | 437 |
| packages/tui/src/component/bg-pulse.tsx | 101 |
| packages/tui/src/component/devtools-sidebar.tsx | 66 |
| packages/tui/src/component/dialog-agent.tsx | 32 |
| packages/tui/src/component/dialog-pair.tsx | 130 |
| packages/tui/src/component/dialog-tag.tsx | 53 |
| packages/tui/src/component/dialog-workspace-file-changes.tsx | 151 |
| packages/tui/src/component/plugin-route-missing.tsx | 22 |
| packages/tui/src/component/prompt/cwd.ts | 1 |
| packages/tui/src/component/prompt/frecency.tsx | 2 |
| packages/tui/src/component/prompt/history.tsx | 2 |
| packages/tui/src/component/prompt/stash.tsx | 2 |
| packages/tui/src/component/reconnecting.tsx | 25 |
| packages/tui/src/component/register-spinner.ts | 7 |
| packages/tui/src/component/spinner-frames.ts | 2 |
| packages/tui/src/component/use-connected.tsx | 9 |
| packages/tui/src/context/directory.ts | 14 |
| packages/tui/src/context/editor.ts | 409 |
| packages/tui/src/context/epilogue.tsx | 7 |
| packages/tui/src/context/event.ts | 33 |
| packages/tui/src/context/exit.tsx | 9 |
| packages/tui/src/context/helper.tsx | 27 |
| packages/tui/src/context/location.tsx | 53 |
| packages/tui/src/context/log.tsx | 25 |
| packages/tui/src/context/path-format.tsx | 13 |
| packages/tui/src/context/prompt.tsx | 19 |
| packages/tui/src/context/runtime.tsx | 76 |
| packages/tui/src/context/thinking.ts | 21 |
| packages/tui/src/devtools/index.ts | 42 |
| packages/tui/src/editor-zed-sqlite.bun.ts | 2 |
| packages/tui/src/editor-zed-sqlite.node.ts | 22 |
| packages/tui/src/editor-zed.ts | 287 |
| packages/tui/src/editor.ts | 90 |
| packages/tui/src/feature-plugins/system/diff-viewer-file-tree-utils.ts | 233 |
| packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx | 156 |
| packages/tui/src/feature-plugins/system/diff-viewer-ui.tsx | 104 |
| packages/tui/src/index.tsx | 3 |
| packages/tui/src/mini/catalog.shared.ts | 189 |
| packages/tui/src/mini/demo.ts | 1074 |
| packages/tui/src/mini/entry.body.ts | 206 |
| packages/tui/src/mini/footer.form.tsx | 427 |
| packages/tui/src/mini/footer.menu.tsx | 301 |
| packages/tui/src/mini/footer.permission.tsx | 501 |
| packages/tui/src/mini/footer.subagent.tsx | 188 |
| packages/tui/src/mini/footer.width.ts | 28 |
| packages/tui/src/mini/form.shared.ts | 242 |
| packages/tui/src/mini/index.ts | 12 |
| packages/tui/src/mini/permission.shared.ts | 188 |
| packages/tui/src/mini/prompt.editor.ts | 69 |
| packages/tui/src/mini/prompt.shared.ts | 155 |
| packages/tui/src/mini/runtime.boot.ts | 86 |
| packages/tui/src/mini/runtime.queue.ts | 349 |
| packages/tui/src/mini/scrollback.shared.ts | 89 |
| packages/tui/src/mini/scrollback.surface.ts | 424 |
| packages/tui/src/mini/scrollback.writer.tsx | 300 |
| packages/tui/src/mini/session-data.ts | 14 |
| packages/tui/src/mini/stream-v2.fragment.ts | 87 |
| packages/tui/src/mini/stream.ts | 153 |
| packages/tui/src/mini/turn-summary.ts | 22 |
| packages/tui/src/node-ffi.d.ts | 14 |
| packages/tui/src/parsers-config.ts | 387 |
| packages/tui/src/prompt/content.ts | 14 |
| packages/tui/src/prompt/frecency.tsx | 81 |
| packages/tui/src/prompt/mention.ts | 140 |
| packages/tui/src/prompt/parse.ts | 27 |
| packages/tui/src/prompt/part.ts | 16 |
| packages/tui/src/prompt/traits.ts | 30 |
| packages/tui/src/routes/session/form.tsx | 1021 |
| packages/tui/src/routes/session/message-navigation.ts | 49 |
| packages/tui/src/runtime.tsx | 2 |
| packages/tui/src/simulation/semantics.ts | 13 |
| packages/tui/src/terminal-win32.bun.ts | 131 |
| packages/tui/src/terminal-win32.node.ts | 78 |
| packages/tui/src/terminal-win32.ts | 2 |
| packages/tui/src/theme/color.ts | 49 |
| packages/tui/src/theme/discovery.ts | 31 |
| packages/tui/src/theme/v2/component.ts | 42 |
| packages/tui/src/theme/v2/resolve.ts | 266 |
| packages/tui/src/theme/v2/select.ts | 52 |
| packages/tui/src/theme/v2/solid.ts | 53 |
| packages/tui/src/ui/border.ts | 22 |
| packages/tui/src/ui/dialog-export-options.tsx | 248 |
| packages/tui/src/ui/file-path.tsx | 108 |
| packages/tui/src/ui/link.tsx | 35 |
| packages/tui/src/ui/select-controller.ts | 39 |
| packages/tui/src/ui/spinner.ts | 369 |
| packages/tui/src/util/connected-provider.ts | 6 |
| packages/tui/src/util/filetype.ts | 131 |
| packages/tui/src/util/form.ts | 147 |
| packages/tui/src/util/path-format.ts | 38 |
| packages/tui/src/util/path.ts | 13 |
| packages/tui/src/util/persistence.ts | 34 |
| packages/tui/src/util/record.ts | 4 |
| packages/tui/src/util/renderer.ts | 8 |
| packages/tui/src/util/revert-diff.ts | 19 |
| packages/tui/src/util/scroll.ts | 30 |
| packages/tui/src/util/signal.ts | 52 |
| packages/tui/src/util/string-width.bun.ts | 2 |
| packages/tui/src/util/string-width.node.ts | 27 |
| packages/tui/src/util/string-width.ts | 2 |
| packages/tui/src/util/system.ts | 21 |
| packages/tui/src/util/tool-display.ts | 35 |
| packages/tui/sst-env.d.ts | 10 |
| packages/ui/script/pack.ts | 41 |
| packages/ui/script/publish.ts | 27 |
| packages/ui/script/tailwind.ts | 24 |
| packages/ui/src/components/accordion.stories.tsx | 150 |
| packages/ui/src/components/accordion.tsx | 93 |
| packages/ui/src/components/animated-number.tsx | 110 |
| packages/ui/src/components/app-icon.stories.tsx | 70 |
| packages/ui/src/components/app-icon.tsx | 86 |
| packages/ui/src/components/app-icons/types.ts | 22 |
| packages/ui/src/components/avatar.stories.tsx | 77 |
| packages/ui/src/components/avatar.tsx | 56 |
| packages/ui/src/components/button.stories.tsx | 109 |
| packages/ui/src/components/button.tsx | 34 |
| packages/ui/src/components/card.stories.tsx | 89 |
| packages/ui/src/components/card.tsx | 124 |
| packages/ui/src/components/checkbox.stories.tsx | 72 |
| packages/ui/src/components/checkbox.tsx | 44 |
| packages/ui/src/components/collapsible.stories.tsx | 87 |
| packages/ui/src/components/collapsible.tsx | 49 |
| packages/ui/src/components/context-menu.stories.tsx | 114 |
| packages/ui/src/components/context-menu.tsx | 309 |
| packages/ui/src/components/dialog.stories.tsx | 174 |
| packages/ui/src/components/dialog.tsx | 73 |
| packages/ui/src/components/diff-changes.stories.tsx | 82 |
| packages/ui/src/components/diff-changes.tsx | 116 |
| packages/ui/src/components/dock-surface.tsx | 55 |
| packages/ui/src/components/dropdown-menu.stories.tsx | 98 |
| packages/ui/src/components/dropdown-menu.tsx | 309 |
| packages/ui/src/components/favicon.stories.tsx | 50 |
| packages/ui/src/components/favicon.tsx | 14 |
| packages/ui/src/components/file-icon.stories.tsx | 95 |
| packages/ui/src/components/file-icon.tsx | 589 |
| packages/ui/src/components/file-icons/types.ts | 1096 |
| packages/ui/src/components/font.stories.tsx | 49 |
| packages/ui/src/components/font.tsx | 2 |
| packages/ui/src/components/hover-card.stories.tsx | 71 |
| packages/ui/src/components/hover-card.tsx | 33 |
| packages/ui/src/components/icon-button.stories.tsx | 75 |
| packages/ui/src/components/icon-button.tsx | 30 |
| packages/ui/src/components/icon.stories.tsx | 172 |
| packages/ui/src/components/icon.tsx | 171 |
| packages/ui/src/components/image-preview.stories.tsx | 60 |
| packages/ui/src/components/image-preview.tsx | 33 |
| packages/ui/src/components/inline-input.stories.tsx | 51 |
| packages/ui/src/components/inline-input.tsx | 23 |
| packages/ui/src/components/keybind.stories.tsx | 44 |
| packages/ui/src/components/keybind.tsx | 21 |
| packages/ui/src/components/list.stories.tsx | 171 |
| packages/ui/src/components/list.tsx | 395 |
| packages/ui/src/components/logo.stories.tsx | 58 |
| packages/ui/src/components/motion-spring.tsx | 59 |
| packages/ui/src/components/popover.stories.tsx | 88 |
| packages/ui/src/components/popover.tsx | 154 |
| packages/ui/src/components/progress-circle.stories.tsx | 60 |
| packages/ui/src/components/progress-circle.tsx | 65 |
| packages/ui/src/components/progress.stories.tsx | 68 |
| packages/ui/src/components/progress.tsx | 40 |
| packages/ui/src/components/provider-icon.stories.tsx | 70 |
| packages/ui/src/components/provider-icon.tsx | 26 |
| packages/ui/src/components/provider-icons/types.ts | 106 |
| packages/ui/src/components/radio-group.stories.tsx | 93 |
| packages/ui/src/components/radio-group.tsx | 84 |
| packages/ui/src/components/resize-handle.stories.tsx | 162 |
| packages/ui/src/components/resize-handle.tsx | 99 |
| packages/ui/src/components/scroll-view.tsx | 389 |
| packages/ui/src/components/select.stories.tsx | 114 |
| packages/ui/src/components/select.tsx | 175 |
| packages/ui/src/components/spinner.stories.tsx | 54 |
| packages/ui/src/components/spinner.tsx | 53 |
| packages/ui/src/components/sticky-accordion-header.stories.tsx | 55 |
| packages/ui/src/components/sticky-accordion-header.tsx | 19 |
| packages/ui/src/components/switch.stories.tsx | 69 |
| packages/ui/src/components/switch.tsx | 30 |
| packages/ui/src/components/tabs.stories.tsx | 180 |
| packages/ui/src/components/tabs.tsx | 126 |
| packages/ui/src/components/tag.stories.tsx | 59 |
| packages/ui/src/components/tag.tsx | 23 |
| packages/ui/src/components/text-field.stories.tsx | 112 |
| packages/ui/src/components/text-field.tsx | 129 |
| packages/ui/src/components/text-reveal.stories.tsx | 321 |
| packages/ui/src/components/text-reveal.tsx | 144 |
| packages/ui/src/components/text-shimmer.stories.tsx | 93 |
| packages/ui/src/components/text-shimmer.tsx | 63 |
| packages/ui/src/components/text-strikethrough.stories.tsx | 280 |
| packages/ui/src/components/text-strikethrough.tsx | 85 |
| packages/ui/src/components/thinking-heading.stories.tsx | 855 |
| packages/ui/src/components/toast.stories.tsx | 139 |
| packages/ui/src/components/toast.tsx | 186 |
| packages/ui/src/components/tooltip.stories.tsx | 65 |
| packages/ui/src/components/tooltip.tsx | 164 |
| packages/ui/src/components/typewriter.stories.tsx | 52 |
| packages/ui/src/components/typewriter.tsx | 56 |
| packages/ui/src/context/dialog.tsx | 198 |
| packages/ui/src/context/file.tsx | 11 |
| packages/ui/src/context/helper.tsx | 39 |
| packages/ui/src/context/i18n.tsx | 39 |
| packages/ui/src/context/index.ts | 5 |
| packages/ui/src/context/marked-code-span.ts | 18 |
| packages/ui/src/context/marked.tsx | 571 |
| packages/ui/src/context/worker-pool.tsx | 21 |
| packages/ui/src/custom-elements.d.ts | 18 |
| packages/ui/src/hooks/create-auto-scroll.tsx | 238 |
| packages/ui/src/hooks/index.ts | 3 |
| packages/ui/src/hooks/use-filtered-list.tsx | 135 |
| packages/ui/src/i18n/ar.ts | 192 |
| packages/ui/src/i18n/br.ts | 192 |
| packages/ui/src/i18n/bs.ts | 196 |
| packages/ui/src/i18n/da.ts | 191 |
| packages/ui/src/i18n/de.ts | 198 |
| packages/ui/src/i18n/en.ts | 195 |
| packages/ui/src/i18n/es.ts | 192 |
| packages/ui/src/i18n/fr.ts | 192 |
| packages/ui/src/i18n/ja.ts | 191 |
| packages/ui/src/i18n/ko.ts | 193 |
| packages/ui/src/i18n/no.ts | 196 |
| packages/ui/src/i18n/pl.ts | 191 |
| packages/ui/src/i18n/ru.ts | 191 |
| packages/ui/src/i18n/th.ts | 193 |
| packages/ui/src/i18n/tr.ts | 198 |
| packages/ui/src/i18n/uk.ts | 195 |
| packages/ui/src/i18n/zh.ts | 195 |
| packages/ui/src/i18n/zht.ts | 195 |
| packages/ui/src/storybook/fixtures.ts | 52 |
| packages/ui/src/storybook/scaffold.tsx | 63 |
| packages/ui/src/theme/color.ts | 300 |
| packages/ui/src/theme/v2/foreground.ts | 61 |
| packages/ui/src/theme/v2/mapping.ts | 171 |
| packages/ui/src/v2/components/accordion-v2.stories.tsx | 178 |
| packages/ui/src/v2/components/accordion-v2.tsx | 87 |
| packages/ui/src/v2/components/avatar-v2.stories.tsx | 86 |
| packages/ui/src/v2/components/avatar-v2.tsx | 60 |
| packages/ui/src/v2/components/badge-v2.stories.tsx | 60 |
| packages/ui/src/v2/components/badge-v2.tsx | 24 |
| packages/ui/src/v2/components/button-v2.stories.tsx | 154 |
| packages/ui/src/v2/components/button-v2.tsx | 36 |
| packages/ui/src/v2/components/checkbox-v2.stories.tsx | 93 |
| packages/ui/src/v2/components/checkbox-v2.tsx | 66 |
| packages/ui/src/v2/components/dialog-v2.stories.tsx | 207 |
| packages/ui/src/v2/components/dialog-v2.tsx | 116 |
| packages/ui/src/v2/components/diff-changes-v2.stories.tsx | 61 |
| packages/ui/src/v2/components/diff-changes-v2.tsx | 29 |
| packages/ui/src/v2/components/divider-v2.stories.tsx | 39 |
| packages/ui/src/v2/components/divider-v2.tsx | 21 |
| packages/ui/src/v2/components/field-v2.stories.tsx | 136 |
| packages/ui/src/v2/components/field-v2.tsx | 266 |
| packages/ui/src/v2/components/icon-button-v2.stories.tsx | 106 |
| packages/ui/src/v2/components/icon-button-v2.tsx | 38 |
| packages/ui/src/v2/components/icon.tsx | 210 |
| packages/ui/src/v2/components/inline-input-v2.stories.tsx | 142 |
| packages/ui/src/v2/components/inline-input-v2.tsx | 106 |
| packages/ui/src/v2/components/keybind-v2.stories.tsx | 83 |
| packages/ui/src/v2/components/keybind-v2.tsx | 31 |
| packages/ui/src/v2/components/line-comment-v2.stories.tsx | 89 |
| packages/ui/src/v2/components/line-comment-v2.tsx | 305 |
| packages/ui/src/v2/components/loader-v2.stories.tsx | 43 |
| packages/ui/src/v2/components/loader-v2.tsx | 32 |
| packages/ui/src/v2/components/menu-v2.stories.tsx | 217 |
| packages/ui/src/v2/components/menu-v2.tsx | 226 |
| packages/ui/src/v2/components/progress-circle-v2.tsx | 53 |
| packages/ui/src/v2/components/project-avatar-v2.stories.tsx | 90 |
| packages/ui/src/v2/components/project-avatar-v2.tsx | 67 |
| packages/ui/src/v2/components/radio-v2.stories.tsx | 93 |
| packages/ui/src/v2/components/radio-v2.tsx | 73 |
| packages/ui/src/v2/components/segmented-control-v2.stories.tsx | 108 |
| packages/ui/src/v2/components/segmented-control-v2.tsx | 209 |
| packages/ui/src/v2/components/select-v2.stories.tsx | 176 |
| packages/ui/src/v2/components/select-v2.tsx | 209 |
| packages/ui/src/v2/components/split-button-v2.tsx | 49 |
| packages/ui/src/v2/components/switch-v2.stories.tsx | 65 |
| packages/ui/src/v2/components/switch-v2.tsx | 29 |
| packages/ui/src/v2/components/tab-state-indicator.tsx | 38 |
| packages/ui/src/v2/components/tabs-v2.stories.tsx | 169 |
| packages/ui/src/v2/components/tabs-v2.tsx | 148 |
| packages/ui/src/v2/components/text-input-v2.stories.tsx | 142 |
| packages/ui/src/v2/components/text-input-v2.tsx | 94 |
| packages/ui/src/v2/components/text-shimmer-v2.stories.tsx | 71 |
| packages/ui/src/v2/components/text-shimmer-v2.tsx | 64 |
| packages/ui/src/v2/components/textarea-v2.stories.tsx | 112 |
| packages/ui/src/v2/components/textarea-v2.tsx | 32 |
| packages/ui/src/v2/components/toast-v2.stories.tsx | 152 |
| packages/ui/src/v2/components/toast-v2.tsx | 147 |
| packages/ui/src/v2/components/tooltip-v2.stories.tsx | 92 |
| packages/ui/src/v2/components/tooltip-v2.tsx | 148 |
| packages/ui/src/v2/components/wordmark-v2.tsx | 72 |
| packages/ui/sst-env.d.ts | 10 |
| packages/ui/vite.config.ts | 60 |
