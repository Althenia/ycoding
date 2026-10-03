# S6 canonical knip triage

Local evidence artifact; do not stage or commit. The original audit was read-only except this artifact and authorized compiler-owned declaration emission under cleanup `.cache/knip-declarations`. Parent-authorized source/dependency remediation and current checks are recorded separately in P1; original audit evidence is not fresh integrated validation.

## Boundary and result

- Input: original `plan.md`, `tracking.md`, `testing.md`, and the four original JSON files in this directory. AC7 requires every finding to have a disposition; passing typechecks alone do not triage findings.
- Canonical scan: `knip-raw.json`, originally run on `61c8de05`. Current source boundary: cleanup worktree at `dddadd9d5624db3f93be844ca163a7bb0a9d29b6`. Later parent-owned test/documentation work is not acceptance evidence here.
- Every canonical finding is named below exactly once in its category. Semicolon-separated names in one row have the same disposition and evidence; expand them into individual findings when counting. A duplicate pair is one finding, not two exports. File findings use `—` because the file column is their canonical name.
- **719 findings; 719 settled decisions; zero unresolved decisions.** Parent remediation P1 below resolves O1/O2 and implements O3–O6. All 305 removal findings are removed/internalized in the current cleanup tree; final integrated cleanup gates remain separate from this canonical reconciliation.
- No proven unsafe earlier deletion with a current concrete consumer was found. This is bounded repository evidence, not proof about arbitrary external imports through Core/AI wildcard exports. The removed Core aliases were externally addressable; retain that compatibility risk in the parent review rather than asserting that an empty import scan proves safety.

### P1 parent remediation and checks

- Current cleanup source applies the 21 private-export/default removals over `397f15e4`; the twelve orphan catalog keys and three approved tsconfig removals are committed in that head. No public package export map, canonical Effect Tool.Content, loader, dialog input or sound tuple value changed.
- Inline installed-TypeScript declaration check, 8,192 MiB/120 s: explicitly resolve installed Bun ambient types and set repository rootDir; entire four-root compiler graph has zero diagnostics. Emit each of seven targets individually with zero emit diagnostics/unskipped output into ignored `.cache/knip-declarations/final`. All four public root declarations are byte-identical to the original baseline. Leaf AST comparison removes exactly host 17, route 2, Promise Content 1; surviving named exports 61/1/12 are unchanged.
- Initial harness attempts failed because root-level automatic ambient lookup omitted Bun/Node types. Global emission also returned emitSkipped=true despite zero diagnostics and all seven target outputs; individual target emission then returned unskipped outputs. The global skip flag's exact non-target cause was not investigated. These were harness failures, not RED behavioral evidence. One combined shell returned the later typecheck exit despite an earlier failed declaration check; the declaration check was then rerun separately and passed with its own exit 0. No failing invocation is counted as passing.
- `bun run --cwd packages/tui typecheck`, `bun run --cwd packages/plugin typecheck`, `bun run --cwd packages/cli typecheck`: each exit 0. `bun test --cwd packages/tui test/skills-conflict.test.tsx test/session-skill-render.test.tsx test/attention-sounds.test.ts test/attention.test.ts --timeout 30000 --reporter=junit --reporter-outfile=/tmp/yc-cleanup-s6-private-consumers.xml`: exit 0, 18 cases, 44 assertions, 2.11 s. No full TUI suite.
- `bunx --no-install oxlint --type-aware --threads=1` on the four edited source files: exit 0, zero errors, one unused local View warning; its unchanged declaration is present in HEAD. The skills import remains needed by View's Plugin.Context. Prettier's host/skills warnings concern unchanged pre-existing regions; no unrelated formatting edit was applied. Targeted diff check passed; the first primary-checkout status probe used an invalid outside-repository path and was corrected with `git -C ../.. status`, which confirms the primary source paths untouched.
- The unreferenced lookup wrapper, workspace/PluginRoutes/Promise Content aliases are deleted rather than retained as dead internal aliases. RouteMap and the sound tuple remain local because they have current type consumers. Named rail and factory implementation bodies are preserved. Final integrated root gates belong to SL/close-out, not this source-equivalence check.

## Counts and split reconciliation

| Canonical category | Raw count | remove | keep:public | keep:dynamic | keep:test-only | keep:vendored |
|---|---:|---:|---:|---:|---:|---:|
| files | 94 | 15 | 0 | 16 | 63 | 0 |
| dependencies | 9 | 8 | 0 | 1 | 0 | 0 |
| devDependencies | 29 | 7 | 1 | 20 | 1 | 0 |
| catalog | 12 | 12 | 0 | 0 | 0 | 0 |
| unlisted | 19 | 18 | 0 | 1 | 0 | 0 |
| binaries | 3 | 0 | 0 | 1 | 0 | 2 |
| exports | 365 | 125 | 0 | 7 | 3 | 230 |
| types | 178 | 115 | 63 | 0 | 0 | 0 |
| duplicates | 10 | 5 | 4 | 0 | 0 | 1 |
| **Total** | **719** | **305** | **68** | **46** | **67** | **233** |

All 305 `remove` findings are removed/internalized: 269 earlier findings, 12 orphan catalog keys, three approved unsupported language-service configurations, and 21 private standalone exports/defaults. The three language-service rows move from `keep:dynamic` to `remove`; the remaining 46 dynamic findings retain their verified consumers. Canonical decisions, source remediation, and final integrated validation remain distinct gates.

Raw `enumMembers`, `namespaceMembers`, `catalogReferences`, `optionalPeerDependencies`, and `unresolved` arrays total zero. Raw `nsExports`, `nsTypes`, and `classMembers` keys are absent; split copies contain null values for them, not additional findings. There are no omitted enum/class/namespace findings hidden behind the summary.

| Input copy | Counts | Relation to canonical raw |
|---|---|---|
| `files-deps.json` | files 94; dependencies 9; devDependencies 29; unlisted 19; binaries 3 = 154 | Same named findings; omits all 12 catalog entries. |
| `exports-core.json` | exports 230; types 1; duplicates 5 = 236 | Same named findings; includes excluded provider findings plus Core aliases/fixture type. |
| `exports-other.json` | exports 135; types 177; duplicates 5 = 317 | Same named findings, not a second scan. |
| Combined split copies | 707 | 707 + 12 omitted catalog entries = 719; never add split findings to raw. |

Tracking E15 lists 704 findings across its seven stated categories (94 + 9 + 29 + 19 + 365 + 178 + 10); the omitted 12 catalog and 3 binaries explain 719. The blank tracking §Unused exports is not evidence of triage.

## Evidence keys and limits

Current paths in the tables resolve inside the cleanup worktree. `D` means the reviewed S6 patch plus the current named file/declaration: deleted export modifiers, removed aliases, or deleted files are positive evidence of what was changed, not absence-of-import proof. Internalization preserves reachable implementation/type shapes; it does not imply the implementation was deleted.

| Key | Original S6 commit → rebased commit | Verified boundary |
|---|---|---|
| D-core | `a7e8959e` → `b14cc2cf` | Four duplicate aliases removed; fixture `SkillFile` internalized. |
| D-sst | `30227f56` → `507521e2` | Six publish scripts, CLI postinstall, 15 SST declarations removed. |
| D-files | `b27716a5` → `88b71129` | Four root scripts, Core wellknown example server, Client unconfigured type fixture removed. |
| D-tui-files | `a7770018` → `b4cd8153` | Two unused TUI modules removed. |
| D-deps | `f6ef056e` → `9aa19ccc` | Manifest/lock removals; retained dynamic/native dependencies unchanged. |
| D-ai | `4e405d67` → `63243b6a` | Test helper exports internalized; helpers retained for their test callers. |
| D-cf | `98a1da56` → `dfbec151`; `3962b14f` → `1141158a` | Cloudflare helper/type exports internalized; newer repeat constant retained during rebase. |
| D-cli | `8dfcc274` → `f5bdf30d` | CLI local helpers/types internalized. |
| D-sim | `a636a4c7` → `cc1a4e61` | Simulation manifest/control-server helpers internalized. |
| D-code | `e1986a2c` → `50addb4e` | CodeMode local helpers/types internalized. |
| D-http | `1239ded2` → `c55c5097` | Recorder internal helpers/schemas internalized; root `HttpRecorder` API preserved. |
| D-sql | `59f3482d` → `f648fdd9` | Private migration upgrade functions and unused type re-export removed; active migrator/backfill kept. |
| D-web | `8db5941a` → `eda76bbf` | Web presentation/local parsing helper exports internalized. |
| D-tui | `b4cdd978` → `2ecdd249` | TUI local exports/aliases removed; named render-test boundaries retained. |

Additional verified contracts: closed package export maps in each `package.json`; Core/AI wildcard maps; `packages/plugin/src/promise/index.ts` → `Plugin.Context` in `promise/plugin.ts` → domain types; TUI public `./builtins` → `BuiltinTuiPlugin` → `TuiPluginModule`/`TuiPluginApi` type graph; extension manifest/HTML and bundling; native package-name templates and asset resolver; Vite/HTML fixture entrypoints; tsconfig type-fixture inclusion; Codegen fixture content/consumer checks. Weak bare-word search matches were discarded, not treated as caller evidence.

Excluded provider files have an empty `git diff --name-only 61c8de05..dddadd9d -- packages/core/src/cursor/provider` and empty `c9a2957a..dddadd9d` diff. No canonical finding names a vendored OpenTUI source path; no OpenTUI source was edited by this audit. OpenTUI host API re-exports are not relabeled as vendored source.

## Original audit decisions before P1 remediation

| ID | Canonical findings | Concrete evidence / smallest next check |
|---|---:|---|
| O1 | 12 catalog entries | RESOLVED P1: verified zero manifest consumers; parent removed all twelve orphan keys and regenerated the lockfile through Bun under D16/D18. Frozen install and affected package checks passed. |
| O2 | 3 unlisted language-service entries | RESOLVED P1/D22: user chose removal of undeclared/unavailable plugin/transform settings in the three tsconfigs. No language-service installation or editor-support claim. Affected package typechecks passed. |
| O3 | 6 host API exports + 11 host API types | RESOLVED R3, READY: compiler candidate removes only the standalone re-exports/export modifiers listed below; all four public entry declarations are byte-identical, all 61 surviving host named declarations unchanged, and sound-name tuple/type preserved. No direct host-api package subpath exists. Keep implementation values/types where internally referenced; do not edit OpenTUI. |
| O4 | 2 TUI plugin route types | RESOLVED R4, READY: internalizing RouteMap and PluginRoutes produces an unchanged createPluginRoutes declaration and byte-identical public PluginRuntime declaration. Neither private alias is in the closed package export map. No route registration/get behavior or signature changes. |
| O5 | 1 Promise tool type | RESOLVED R5, READY: internalizing Content removes only that standalone alias from the emitted private tool declaration; all 12 surviving named declarations and public Promise root are unchanged. Canonical public `@ycoding-ai/plugin/tool` resolves to effect/tool.ts, not promise/tool.ts; preserve canonical Tool.Content. |
| O6 | 1 sidebar skills default export | RESOLVED R6, READY: current runtime registry is plugin/builtins.ts with nine explicit builtins and no skills default. Current TUI loader reads only explicit cli.json plugins entries plus that registry; it does not scan internal sidebar filenames. Plugin.define is an identity function; empty setup has no registration/effect. Remove only the empty default definition; retain named SkillsRailContent/test boundary and the local View's Plugin.Context type use. Do not blindly remove the Plugin import. |

The 15 unresolved decisions are 12 + 3; 21 additional removals are READY after R3–R6, so all 33 unapplied removal findings remain parent-owned. No source remediation was attempted here. G4 is not a canonical raw finding: `resumeSuspendedSessions` was removed separately in `716f5693`; tracking may now reconcile that historical gap, but it must not add a 720th knip row.

Rejected audit hypothesis: the AI tutorial's `.model(...)` call is not a missing-method defect. The current `OpenAI.configure` return object explicitly defines `model: responses` at `packages/ai/src/providers/openai.ts:154`; the README explicitly calls the tutorial runnable. Its retention is settled; execution and typechecking of the example remain unrun.

### R3–R6 decisive evidence

Parent-coordinated declaration check: inline `node` program using installed TypeScript, 8,192 MiB process-tree cap, 120,000 ms timeout, exit **0**. The program parsed the current TUI tsconfig, enabled declaration-only emission, and used exactly four roots: `packages/tui/src/feature-plugins/builtins.ts`, `packages/tui/src/plugin/runtime.tsx`, `packages/tui/src/plugin/slots.tsx`, and `packages/plugin/src/promise/index.ts`. It emitted only those roots plus `host-api.ts`, `plugin/api.ts`, and `promise/tool.ts`: seven `.d.ts` targets per variant, fourteen compiler-owned outputs total under `.cache/knip-declarations/{baseline,candidate}`. No config/script/source file was created or changed.

The candidate compiler host substitutes three source strings in memory only: omit the four standalone keymap value re-exports; omit the ten named type re-exports listed in O3; internalize createBindingLookup, TuiAttentionSoundNames, TuiWorkspace, RouteMap, PluginRoutes, and Promise Content. Implementations and reachable type shapes are otherwise identical. This is export-removal proof, not permission to delete reachable implementation values.

| Check | Baseline | In-memory candidate | Result |
|---|---:|---:|---|
| Loaded compiler source files | 1,070 | 1,070 | Same graph; not a claim that every dependency was independently checked. |
| Options/global + syntax/semantic + emit diagnostics for seven targets | 0 | 0 | Diagnostic delta 0; no suppressed target diagnostics. |
| Emitted target declarations | 7 | 7 | No skipped emit or output outside the authorized cache directory. |
| Public TUI builtins/runtime/slots and Plugin root declarations | 4 | 4 | All four byte-identical. |
| Host leaf declaration bytes | 17,758 | 17,004 | Exactly 17 named exports omitted; 61 surviving named declarations unchanged. |
| Route leaf declaration bytes | 505 | 296 | Exactly RouteMap/PluginRoutes omitted; createPluginRoutes signature unchanged. |
| Promise tool leaf declaration bytes | 1,744 | 1,708 | Exactly Content omitted; 12 surviving named declarations unchanged. |

Read-only declaration AST comparison (`node` inline checker, 512 MiB/10 s, exit **0**) compared each surviving named export/re-export separately, not only root text: no added names and no changed surviving declarations in any leaf. `TuiAttentionSoundNames` remains an identical local readonly tuple and `TuiAttentionSoundName = (typeof TuiAttentionSoundNames)[number]` is unchanged.

Module resolution (`require.resolve` from CLI, exit **0**) confirms all four public entries resolve. `@ycoding-ai/tui/plugin/host-api`, `@ycoding-ai/tui/plugin/api`, `@ycoding-ai/tui/feature-plugins/sidebar/skills`, and `@ycoding-ai/plugin/promise/tool` each fail **ERR_PACKAGE_PATH_NOT_EXPORTED**. Public `@ycoding-ai/plugin/tool` resolves to the canonical Effect module. The public `@ycoding-ai/tui/builtins` entry genuinely resolves to feature-plugins/builtins.ts even though the live PluginProvider uses a different registry: **retain that public entry and its named contract; no removal proposal for it is made**.

R6 loader flow: `packages/cli/src/config/config.ts:29` reads global `cli.json`; `commands/handlers/tui-shared.ts:75–82` passes its service and a package resolver constrained to `tui` subpaths; `packages/tui/src/plugin/context.tsx:213–229` loads the current nine-builtin registry and explicit configured entries. `loadPlugin` at 360–370 handles configured local file/directory/package targets and validates their default definition; no internal sidebar directory scan exists. `plugin/builtins.ts` imports Notifications, HomeFooter, SidebarContext, SidebarTodo, SidebarSubagents, SidebarMcp, SidebarFooter, Scrap, DiffViewer, not skills. The old public feature registry contains PluginManager/WhichKey, also not skills. The only bounded matching private default ID is its own source declaration; named rail consumers are the two existing render suites plus local View. `packages/plugin/src/tui/plugin.ts:12–14` proves define merely returns the input definition, and skills setup is empty.

Arbitrary external configuration could explicitly target any private source file by absolute path; this audit did not read user configuration or promise compatibility for that direct private-implementation coupling. Such loading does not establish a named package export for the private module. The plugin loader and named public module contracts remain intact. Parent regression checks after actual edits must retain the named skill rail/conflict render assertions; this audit did not run TUI rendering or a package-wide typecheck.

`git diff --name-only dddadd9d --` the seven compiler targets, both builtin registries, plugin loader, skills module, Plugin.define, owning manifests, CLI config and TUI handler returned empty. `git check-ignore` confirms emitted declaration paths are ignored. These checks verify the virtual experiment did not land source/Git/manifest edits.

## File findings

| File | Category | Finding(s) | Disposition | Evidence / status |
|---|---|---|---|---|
| script/changelog.ts | files | — | remove | D-files; deleted historical changelog generator; current web changelog is maintained content, not this script. |
| script/format.ts | files | — | remove | D-files; deleted wrapper; current root formatting/lint scripts do not invoke it. |
| script/raw-changelog.ts | files | — | remove | D-files; deleted upstream changelog generator, including removed UI handling. |
| script/version.ts | files | — | remove | D-files; deleted old version helper; current release/build version comes from `packages/script/src/index.ts`. |
| extensions/chrome/popup.js | files | — | keep:dynamic | `manifest.json` action loads `popup.html`, whose module script loads popup.js; packaged through BrowserExtension.files. |
| extensions/chrome/service-worker.js | files | — | keep:dynamic | `manifest.json` background entry; `packages/cli/script/chrome-extension.ts` Bun.build entrypoint. |
| nix/scripts/canonicalize-node-modules.ts | files | — | keep:dynamic | `nix/node_modules.nix:59` invokes this exact interpolation as a Bun build script. |
| nix/scripts/normalize-bun-binaries.ts | files | — | keep:dynamic | `nix/node_modules.nix:60` invokes this exact interpolation as a Bun build script. |
| infra/cloudflare/test/smoke.ts | files | — | keep:test-only | Explicit argv-driven deployed auth-boundary smoke entrypoint, lines 5–9 and assertions; not run here. |
| infra/cloudflare/test/integration/admin-push.ts | files | — | keep:test-only | Standalone local Wrangler/D1/push-stand-in flow, argv-independent executable setup/assertions/finally cleanup. |
| infra/cloudflare/test/integration/completion-notices.ts | files | — | keep:test-only | Standalone local workerd DO transaction/notice flow; generates a test Worker and asserts rollback/retry at lines 18–30/127–133. |
| infra/cloudflare/test/integration/invite-flow.ts | files | — | keep:test-only | Standalone local Wrangler invitation/OAuth/relay flow, lines 15–24; assertions and fixture cleanup. |
| infra/cloudflare/test/integration/push-binding-local.ts | files | — | keep:test-only | Standalone local authenticated browser/device push binding test, lines 23–30 and real socket assertions. |
| infra/cloudflare/test/integration/relay-local.ts | files | — | keep:test-only | Explicit standalone real-worker integration command at lines 1–12; local Google stand-in, D1 and real WebSockets. |
| infra/cloudflare/test/support/push-server.ts | files | — | keep:test-only | `apps/web/test/remote-notice-sync.test.ts:42` loads this serverModule string; real test support. |
| extensions/chrome/test/fixtures/service-worker.case.js | files | — | keep:test-only | `extensions/chrome/test/service-worker.test.js:6` spawns exact fixture; isolation is intentional. |
| packages/cli/script/isolated-browser-smoke.ts | files | — | keep:test-only | `.github/workflows/release.yml:338` executes packaged smoke; `script/release.test.ts:306` guards it. |
| packages/cli/script/postinstall.mjs | files | — | remove | D-sst; upstream package postinstall removed; root current postinstall invokes Core fix-node-pty instead. |
| packages/cli/script/publish.ts | files | — | remove | D-sst; upstream npm publish script removed; current tag workflow packages native release assets. |
| packages/cli/script/service-smoke.ts | files | — | keep:test-only | `.github/workflows/test.yml:106` invokes exact compiled service-lifecycle smoke entrypoint. |
| packages/cli/src/tui.ts | files | — | keep:dynamic | `packages/cli/script/build.ts:16` selects `./src/tui.ts` for `--tui-only`; packaged primary product entrypoint. |
| packages/cli/test/remote-node-transport.ts | files | — | keep:test-only | `remote-node-transport.test.ts:9` constructs exact spawned-script path. |
| packages/cli/test/remote-prompt-pty.fixture.ts | files | — | keep:test-only | `remote-prompt.integration.test.ts:8` constructs exact PTY fixture path. |
| packages/cli/src/commands/tui.ts | files | — | keep:dynamic | `packages/cli/src/tui.ts:4` imports TuiCommand; reached by selected build entrypoint. |
| packages/cli/src/node/index.ts | files | — | keep:dynamic | `vite.node.config.ts:197` SSR entrypoint; `build-node.ts` uses owning Vite config. |
| packages/cli/src/node/plugin-runtime.effect.ts | files | — | keep:dynamic | `src/node/index.ts:2` side-effect import installs Effect plugin runtime for Node bundle. |
| packages/cli/src/node/plugin-runtime.promise.ts | files | — | keep:dynamic | `src/node/index.ts:1` side-effect import installs Promise plugin runtime for Node bundle. |
| packages/cli/test/drive/mini-interactive.drive.mjs | files | — | keep:test-only | External `ycoding-drive` defineScript fixture, manual launch/run and LLM queue at lines 2–30; not a Bun auto-discovered unit test. Harness availability/execution not verified. |
| packages/cli/test/drive/run-smoke.drive.mjs | files | — | keep:test-only | External `ycoding-drive` defineScript fixture, lines 1–25 drive real CLI run. Harness availability/execution not verified. |
| packages/cli/test/fixture/standalone-owner.ts | files | — | keep:test-only | `standalone.test.ts:8` spawns exact ownership fixture path. |
| packages/cli/src/commands/handlers/tui-serve.ts | files | — | keep:dynamic | `src/tui.ts:28` lazy imports handler by command dispatch; service entrypoint. |
| packages/cli/src/commands/handlers/tui.ts | files | — | keep:dynamic | `src/tui.ts:9` lazy imports handler for `$` dispatch; primary TUI execution. |
| packages/server/test-integration/keep-awake-backend.ts | files | — | keep:test-only | `keep-awake.test.ts:16` spawns exact integration backend fixture. |
| packages/tui/src/context/directory.ts | files | — | remove | D-tui-files; deleted module; current location/runtime contexts own active placement. |
| packages/tui/src/theme/v2/solid.ts | files | — | remove | D-tui-files; deleted unused Solid helper; active theme context/resolution retained. |
| packages/core/script/wellknown-server.ts | files | — | remove | D-files; deleted standalone old wellknown example server, not the active local Server. |
| packages/core/test/fixture/effect-flock-worker.ts | files | — | keep:test-only | `test/util/effect-flock.test.ts:47` constructs exact worker fixture path. |
| packages/core/test/fixture/flock-worker.ts | files | — | keep:test-only | `test/util/flock.test.ts:23` constructs exact worker fixture path. |
| packages/core/test/fixture/mcp-output-schema.ts | files | — | keep:test-only | `test/mcp.test.ts:382` spawns exact MCP output-schema fixture. |
| packages/core/test/fixture/mcp-timeout.ts | files | — | keep:test-only | `test/mcp.test.ts:419` spawns exact MCP timeout fixture. |
| packages/core/test/fixture/process-lock-worker.ts | files | — | keep:test-only | `test/util/process-lock.test.ts:9` constructs exact worker fixture path. |
| packages/core/test/plugin/fixtures/config-effect-plugin.ts | files | — | keep:test-only | `test/config/plugin.test.ts:114` and `location-layer.test.ts:205` configure exact plugin module. |
| packages/core/test/plugin/fixtures/config-promise-plugin.ts | files | — | keep:test-only | `test/config/plugin.test.ts:66` configures exact Promise plugin path. |
| packages/core/test/plugin/fixtures/failing-plugin.ts | files | — | keep:test-only | `test/location-layer.test.ts:416` configures exact failing plugin path. |
| packages/core/test/plugin/fixtures/invalid-plugin.ts | files | — | keep:test-only | `test/config/plugin.test.ts:145` configures exact invalid plugin path. |
| packages/core/test/plugin/fixtures/variant-source-plugin.ts | files | — | keep:test-only | `test/config/plugin.test.ts:255` configures exact variant source plugin path. |
| packages/core/test/config/fixtures/plugin/directory-plugin.ts | files | — | keep:test-only | Config plugin auto-discovery fixture; `plugin.test.ts:184–195` loads fixtures with discovery enabled and asserts its `directory` agent description. |
| packages/plugin/script/publish.ts | files | — | remove | D-sst; deleted upstream publish script; package exports/build retained. |
| packages/client/script/publish.ts | files | — | remove | D-sst; deleted upstream publish script; owning generation/build retained. |
| packages/client/test/api.types.ts | files | — | remove | D-files; deleted unconfigured type fixture. Client `tsconfig.json` includes `src`, not this fixture. Public generation/contracts retained; this audit does not claim substitute assertion coverage. |
| packages/client/test/fixture/service.ts | files | — | keep:test-only | `test/service.test.ts:9` and `promise-service.test.ts:7` construct exact spawned-service fixture path. |
| packages/protocol/script/publish.ts | files | — | remove | D-sst; deleted upstream publish script; owning Protocol build retained. |
| packages/ai/example/tutorial.ts | files | — | keep:dynamic | README lines 361/367 names runnable tutorial; explicit run instructions and Effect.runPromise entrypoint. Current OpenAI.configure exposes `model: responses` at providers/openai.ts:154. Example execution/typecheck not run. |
| packages/ai/script/publish.ts | files | — | remove | D-sst; deleted upstream publish script; AI build/export surface retained. |
| packages/ai/script/recording-cost-report.ts | files | — | keep:dynamic | Deliberate standalone report over recording fixtures: reads RECORDINGS_DIR and prints provider/model usage report at lines 236–249. Not executed; includes network pricing lookup. |
| packages/ai/test/auth-options.types.ts | files | — | keep:test-only | `tsconfig.types.json` includes `test/**/*.types.ts`; AI typecheck explicitly invokes that config. |
| packages/ai/test/image.types.ts | files | — | keep:test-only | Same explicit typecheck include; guards image API compile-time contract. |
| packages/ai/test/provider.types.ts | files | — | keep:test-only | Same explicit typecheck include; guards provider API compile-time contract. |
| packages/ai/test/tool.types.ts | files | — | keep:test-only | Same explicit typecheck include; guards tool API compile-time contract. |
| apps/web/script/generate-office-art.ts | files | — | keep:dynamic | Owning procedural asset generator: current DESIGN describes generated Office art; source writes office/assets PNGs and manifest. Not executed. |
| apps/web/script/office-art/png.ts | files | — | keep:dynamic | `generate-office-art.ts:5` imports encodePNG; current asset generator dependency. |
| apps/web/verify/_screenshot.ts | files | — | keep:test-only | Standalone visual-capture harness: argv output path, main at line 87, browser capture loop at 72–77; not executed. |
| apps/web/verify/activity-order-fixture.tsx | files | — | keep:test-only | `activity-order-fixture.html` module entrypoint; `guardrail-family.integration.test.ts:100` navigates it. |
| apps/web/verify/composer-fixture.tsx | files | — | keep:test-only | `composer-fixture.html` module entrypoint; `composer-controls.integration.test.ts:29` and new-session integration navigate it. |
| apps/web/verify/cursors-fixture.tsx | files | — | keep:test-only | `cursors-fixture.html:4` module entrypoint; `cursors.integration.test.ts:15` starts its fixture page. |
| apps/web/verify/guardrail-family-fixture.tsx | files | — | keep:test-only | Matching HTML module entrypoint; `guardrail-family.integration.test.ts:12` starts fixture page. |
| apps/web/verify/keep-awake-settings-fixture.tsx | files | — | keep:test-only | Matching HTML line 10 module entrypoint; `keep-awake-settings.integration.test.ts:18` navigates fixture page. |
| apps/web/verify/loading-fixture.tsx | files | — | keep:test-only | Matching HTML module entrypoint; `loading.integration.test.ts:15` starts fixture page. |
| apps/web/verify/matched-content.vite.config.ts | files | — | keep:test-only | Explicit Vite test-content override config; resolve/load hooks at lines 8–21 map current UI imports onto synthetic content. Independent test fixture config, not production content. |
| apps/web/verify/modal-focus-fixture.tsx | files | — | keep:test-only | Matching HTML module entrypoint; `modal-close.integration.test.ts:67` navigates fixture page. |
| apps/web/verify/model-replay-fixture.tsx | files | — | keep:test-only | Matching HTML module entrypoint; `model-replay.integration.test.ts:14` starts fixture page. |
| apps/web/verify/notifications-fixture.tsx | files | — | keep:test-only | Matching HTML line 4 module entrypoint; `notifications.integration.test.ts:15` starts fixture page. |
| apps/web/verify/office-engine-fixture.tsx | files | — | keep:test-only | `office-engine.html:4` module entrypoint; real browser Office engine fixture, not production app root. |
| apps/web/verify/push-settings-fixture.tsx | files | — | keep:test-only | Matching HTML line 4 module entrypoint; `push-settings.integration.test.ts:15` starts fixture page. |
| apps/web/verify/remote-fixture.tsx | files | — | keep:test-only | `remote.html:27` module entrypoint; remote browser-render fixture. |
| apps/web/verify/router-fixture.tsx | files | — | keep:test-only | Matching HTML line 4 module entrypoint; `router.integration.test.ts:16` starts fixture page. |
| apps/web/verify/running-sessions-fixture.tsx | files | — | keep:test-only | Matching HTML line 4 module entrypoint; `running-sessions.integration.test.ts:15` starts fixture page. |
| apps/web/verify/team-fixture.tsx | files | — | keep:test-only | Matching HTML line 4 module entrypoint; `team.integration.test.ts:118` navigates fixture page. |
| apps/web/verify/todo-fixture.tsx | files | — | keep:test-only | Matching HTML line 4 module entrypoint; `todo.integration.test.ts:15` starts fixture page. |
| apps/web/verify/transcript-fixture.tsx | files | — | keep:test-only | `transcript.html:4` module entrypoint; transcript integration uses the fixture for rendered Session state. |
| apps/web/verify/typography-fixture.tsx | files | — | keep:test-only | Matching HTML module entrypoint; `typography.integration.test.ts:11` starts fixture page. |
| apps/web/verify/usage-fixture.tsx | files | — | keep:test-only | Matching HTML module entrypoint; `usage-page.integration.test.ts:26` navigates fixture page. |
| apps/web/verify/matched-content/changelog.ts | files | — | keep:test-only | `matched-content.vite.config.ts:20–21` virtual-module re-export of this exact fixture. |
| apps/web/verify/matched-content/docs-registry.ts | files | — | keep:test-only | `matched-content.vite.config.ts:18–19` virtual-module re-export of this exact fixture. |
| apps/web/verify/matched-content/site.ts | files | — | keep:test-only | `matched-content.vite.config.ts:16–17` virtual-module re-export of this exact fixture. |
| packages/effect-drizzle-sqlite/examples/basic.ts | files | — | keep:dynamic | Package AGENTS names this minimal Bun SQLite example; top-level Effect.runPromise executes real in-memory migration/user flow. Not run or claimed typechecked here. |
| packages/httpapi-codegen/test/generated-consumer.ts | files | — | keep:test-only | `test/generate.test.ts:966` strict generated-consumer fixture group; consumer imports generated output; package tsconfig has no src-only include exclusion. |
| packages/httpapi-codegen/test/generated/client-error.ts | files | — | keep:test-only | Generated fixture modules checked against owning compile output by `generate.test.ts:966–986`; imported by generated client. |
| packages/httpapi-codegen/test/generated/client.ts | files | — | keep:test-only | Same generated fixture content check; consumer/client group contract, not production package artifact. |
| packages/httpapi-codegen/test/generated/event.ts | files | — | keep:test-only | Same generated fixture content check; current emitted event module consumed through generated client/index. |
| packages/httpapi-codegen/test/generated/index.ts | files | — | keep:test-only | Same generated fixture content check; generated-consumer entrypoint. |
| packages/httpapi-codegen/test/generated/session.ts | files | — | keep:test-only | Same generated fixture content check; Session fixture group imported by client. |
| packages/httpapi-codegen/test/generated/system.ts | files | — | keep:test-only | Same generated fixture content check; System fixture group imported by client. |
| packages/schema/script/publish.ts | files | — | remove | D-sst; deleted upstream publish script; Schema root/direct exports and build retained. |

## Dependency, catalog, unlisted and binary findings

| File | Category | Finding(s) | Disposition | Evidence / status |
|---|---|---|---|---|
| package.json | dependencies | @ycoding-ai/plugin; @ycoding-ai/script | remove | D-deps; removed root-only declarations. CLI/Core/Simulation retain owned declarations where runtime/build imports occur. |
| package.json | devDependencies | @actions/artifact; glob; semver | remove | D-deps; removed root declarations with deleted publish/changelog scripts. Active package-owned semver/glob consumers retain their own dependencies. |
| package.json | devDependencies | turbo | keep:dynamic | Root typecheck script invokes `bun turbo typecheck`; CLI binary use is not a TS import. |
| package.json | catalog | @shikijs/stream; @kobalte/core; @types/luxon; @pierre/diffs; @tailwindcss/vite; luxon; marked-shiki; remend; shiki; solid-list; tailwindcss; @solidjs/meta | remove | P1: all twelve removed; owning Bun regeneration/frozen install passed; no manifest consumers. |
| packages/cli/package.json | dependencies | @ycoding-ai/plugin | keep:dynamic | `src/node/plugin-runtime.effect.ts` and `.promise.ts` import published plugin APIs; Node preloader side-effect imports reach both. |
| packages/cli/package.json | dependencies | @parcel/watcher | remove | D-deps; CLI direct declaration removed, Core owns wrapper/runtime dependency. Node build assets use separately retained platform packages via nodeTarget. |
| packages/cli/package.json | devDependencies | @ycoding-ai/protocol | keep:test-only | `script/service-smoke.ts:4` imports ServiceStatus from Protocol health contract; CI invokes smoke. |
| packages/cli/package.json | devDependencies | @lydell/node-pty-darwin-arm64; @lydell/node-pty-darwin-x64; @lydell/node-pty-linux-arm64; @lydell/node-pty-linux-x64; @lydell/node-pty-win32-arm64; @lydell/node-pty-win32-x64 | keep:dynamic | `src/node/target.ts:12` builds platform/arch package names; `script/node-assets.ts:32` resolves target.nodePtyPackage. Native target declarations retained; Node 26.4 packaged darwin-x64 is currently rejected by build-node, so retention does not claim that target builds. |
| packages/cli/package.json | devDependencies | @parcel/watcher-darwin-arm64; @parcel/watcher-linux-arm64-glibc; @parcel/watcher-linux-x64-glibc; @parcel/watcher-win32-arm64; @parcel/watcher-win32-x64 | keep:dynamic | `src/node/target.ts:13` names watcher target package; `script/node-assets.ts:40` resolves exact binary for packaging. |
| packages/core/package.json | dependencies | @cursor/sdk; @ycoding-ai/effect-sqlite-node; ignore; semver | remove | D-deps; declarations removed. Native Cursor adapter uses preserved local provider, not SDK; active SQLite layering is generic Effect/Bun driver, not this unused Core declaration. No provider source edits. |
| packages/core/package.json | devDependencies | @types/semver | remove | D-deps; removed with Core semver declaration. CLI/script package semver types remain owned there. |
| packages/core/package.json | devDependencies | @parcel/watcher-darwin-arm64; @parcel/watcher-darwin-x64; @parcel/watcher-linux-arm64-glibc; @parcel/watcher-linux-arm64-musl; @parcel/watcher-linux-x64-glibc; @parcel/watcher-linux-x64-musl; @parcel/watcher-win32-arm64; @parcel/watcher-win32-x64 | keep:dynamic | `src/filesystem/watcher.ts:24–33` require template selects platform/arch/libc, or packaged YCODING_PARCEL_WATCHER_PATH; all named variants are runtime-resolvable template targets. |
| packages/plugin/package.json | dependencies | zod | remove | D-deps; Plugin schemas/tools use Effect or standard schema contract; removed direct declaration, not runtime's separately owned zod. |
| packages/plugin/package.json | devDependencies | @opentui/keymap | keep:public | Current published optional peerDependencies explicitly constrains this package to >=0.5.10; dev declaration supplies the catalog-aligned peer in the package workspace. Retain the advertised peer validation/install surface, not an invented local TS import. |
| packages/plugin/package.json | devDependencies | @tsconfig/node22 | remove | D-deps; Plugin typecheck extends current Bun/own config, removed unused Node config declaration. |
| packages/http-recorder/package.json | devDependencies | @effect/platform-node | remove | D-deps; removed unused declaration, current runtime explicitly depends on @effect/platform-node-shared; root API tests/build use current owners. |
| packages/remote/package.json | devDependencies | @tsconfig/bun | remove | D-deps; Remote tsconfig extends ../../tsconfig.json, not @tsconfig/bun; removed unused package-local base-config dependency. |
| packages/effect-drizzle-sqlite/tsconfig.json | unlisted | @effect/language-service | remove | P1/D22: unsupported plugin/transform settings removed; owning typecheck passed. |
| packages/effect-sqlite-node/tsconfig.json | unlisted | @effect/language-service | remove | P1/D22: unsupported plugin/transform settings removed; owning typecheck passed. |
| packages/http-recorder/tsconfig.json | unlisted | @effect/language-service | remove | P1/D22: unsupported plugin/transform settings removed; owning typecheck passed. |
| packages/ai/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted, current build does not use SST. |
| packages/cli/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted, native build/release retained. |
| packages/client/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted, owning Client generation/build retained. |
| packages/codemode/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted. |
| packages/core/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted, runtime config remains local. |
| packages/effect-drizzle-sqlite/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted. |
| packages/effect-sqlite-node/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted. |
| packages/http-recorder/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted. |
| packages/httpapi-codegen/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted. |
| packages/plugin/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted; Plugin public exports retained. |
| packages/protocol/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted; Protocol contracts retained. |
| packages/schema/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted; Schema contracts retained. |
| packages/script/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted. |
| packages/server/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted; local Server retained. |
| packages/tui/sst-env.d.ts | unlisted | sst | remove | D-sst; declaration file deleted; primary TUI build retained. |
| infra/cloudflare/src/relay/durable-object.ts | unlisted | cloudflare | keep:dynamic | Line 9 imports `cloudflare:workers` DurableObject, a workerd builtin; Wrangler generated worker declarations/tsconfig own types. Not an npm dependency to install. |
| packages/core/src/mcp/client.ts | binaries | pgrep | keep:dynamic | Line 649 execFile pgrep -P discovers process children for MCP cleanup; host binary, not a missing JS dependency. |
| packages/core/src/cursor/provider/protocol/device-id.js | binaries | ioreg; reg | keep:vendored | Explicit provider exclusion; OS device-ID commands are retained exactly with upstream source, not dependency-install candidates. |

## Non-vendored export and type findings

`remove` rows without OPEN describe verified completed export internalization/removal. Current schemas, fixtures and consumers remain in the owning files unless a row explicitly says deleted. Public type retention is based on an active published declaration boundary, not a claim that every symbol has an in-repository named import.

| File | Category | Finding(s) | Disposition | Evidence / status |
|---|---|---|---|---|
| packages/cli/script/generate-extension-fonts.ts | exports | root | remove | D-cli; local font-generator root path retained as const, export removed. |
| extensions/chrome/protocol.js | exports | MAX_CAPTURE_BYTES; MAX_ELEMENTS; tabID | keep:dynamic | service-worker.js imports these exact three names; extension manifest and bundler execute consumer outside knip's inferred graph. |
| infra/cloudflare/src/auth/service.ts | exports | browserSessionRotationMs; enrollmentTtlMs; challengeTtlMs; accessCredentialTtlMs; refreshCredentialTtlMs; safeRedirectAfter | remove | D-cf; constants/helper internalized, auth lifetime/redirect use retained in same service. |
| infra/cloudflare/src/auth/google.ts | exports | googleConfigured | remove | D-cf; redundant standalone client-ID/secret predicate deleted, current Google endpoint/auth flow retained. |
| infra/cloudflare/src/auth/google.ts | types | AuthFailureReason | remove | D-cf; internal tagged auth-result reason type retained. |
| infra/cloudflare/src/invite/service.ts | exports | formatAccessKey; normalizeAccessKey | remove | D-cf; invite formatting/parsing remain internal to active service. |
| infra/cloudflare/src/router.ts | exports | sessionCookieName; oauthCookieName | remove | D-cf; names remain local constants for session/OAuth cookie handling. |
| infra/cloudflare/test/support/d1-sqlite.ts | exports | migrationNames | remove | D-cf; test-support local migration names internalized, support behavior retained. |
| packages/cli/src/remote-local.ts | exports | limits | remove | D-cli; duplicate `limits = RemoteLimits` alias deleted; canonical RemoteLimits contract remains owned by packages/remote. |
| apps/web/src/remote/http.ts | exports | readDeviceInfo | remove | D-web; local account/device decoder retained in HTTP boundary. |
| apps/web/src/remote/http.ts | types | RemoteHttpFailureReason | remove | D-web; local reason type retained in returned failure shapes. |
| apps/web/src/remote/store.ts | exports | readAutonomyFromResponse | remove | D-web; local response projection retained in remote store. |
| apps/web/src/remote/store.ts | types | TeamView; SessionCreation | remove | D-web; local store/team/session-creation shapes remain; no Schema or remote envelope change. |
| packages/cli/vite.node.config.ts | exports | default | keep:dynamic | Current Vite config exports default mainConfig, while `script/build-node.ts:13` imports mainConfig directly; config-loader entry is deliberate. |
| packages/cli/script/models-snapshot.ts | exports | validateModelsSnapshot | remove | D-cli; validator internalized, owning snapshot generation/check retained. |
| packages/cli/src/remote-config.ts | exports | filename; file | remove | D-cli; local config filename/file computation retained in same implementation. |
| packages/cli/src/remote-operations.ts | exports | unscopedOperations; failureFrame; filterActiveSessions | remove | D-cli; closed operation routing helpers retained locally; remote public envelope contract unchanged. |
| apps/web/src/remote/projection.ts | exports | messageTextLimit; formatElapsed; readDataList; readError | remove | D-web; local projection constants/decoders retained behind exported projection functions. |
| apps/web/src/remote/projection.ts | types | GenerationSpeedSampleView; GenerationSpeedHistoryView; ContextWindowView; FormWhenView | remove | D-web; local view shapes retained, no Schema contract removed. |
| packages/tui/src/plugin/host-api.ts | exports | stringifyKeySequence; stringifyKeyStroke; formatCommandBindings; formatKeySequence; createBindingLookup; TuiAttentionSoundNames | remove | P1: standalone re-exports removed; unreferenced local lookup wrapper/import removed after caller search; sound tuple retained locally with its public type unchanged. Four public entries and all 61 surviving named host exports unchanged. |
| packages/tui/src/plugin/host-api.ts | types | CliRenderer; KeyEvent; Renderable; SlotMode; Binding; KeySequenceFormatPart; SequenceBindingLike; TuiRouteCurrent; TuiKeys; TuiKeymap; TuiModeApi; TuiDialogProps; TuiDialogStack; TuiDialogAlertProps; TuiDialogConfirmProps; TuiDialogPromptProps; TuiDialogSelectOption; TuiDialogSelectProps; TuiPromptInfo; TuiPromptRef; TuiPromptProps; TuiToast; TuiAttentionSound; TuiAttentionNotification; TuiAttentionSoundboardActivateOptions; TuiAttentionSoundboard; TuiTheme; TuiState; TuiApp; TuiSidebarMcpItem; TuiSidebarLspItem; TuiSidebarFileItem; TuiHostSlotMap; TuiSlotPlugin; TuiSlots; TuiEventBus; TuiDispose; TuiLifecycle; TuiPluginState; TuiPluginEntry; TuiPluginMeta | keep:public | TUI `./builtins`, `./plugin/runtime`, `./plugin/slots` declaration graph; host-api TuiPluginApi lines 577–615, TuiPlugin line 618, slots/state/attention nested shapes. Keep reachable plugin boundary types. |
| packages/tui/src/plugin/host-api.ts | types | KeyLike; KeySequencePart; KeyStringifyInput; StringifyOptions; BindingConfig; BindingLookup; BindingValue; CreateBindingLookupOptions; FormatCommandBindingsOptions; FormatKeySequenceOptions; TuiWorkspace | remove | P1: ten unused re-exports and unreferenced workspace alias removed; all 61 surviving named host exports unchanged. OpenTUI and reachable types preserved. |
| packages/tui/src/theme/index.ts | exports | ThemeFile | remove | D-tui; unused barrel export removed, current local import and canonical schema/v2 export retained; docs point at schema.ts. |
| packages/tui/src/theme/index.ts | types | ThemeSource | remove | D-tui; aliased re-export removed; canonical ThemeFile type remains. Historical G7 is already resolved by this S6 patch. |
| packages/tui/src/theme/v2/index.ts | exports | ActionState; ActionVariant; BaseHue; CategoricalDefinition; FeedbackKind; FormfieldState; HueAlias; HueName; MarkdownDefinition; MarkdownToken; SyntaxDefinition; SyntaxToken; DEFAULT_CATEGORICAL; selectTheme; selectThemeMode; supportsThemeMode; themeModes | remove | D-tui; redundant barrel entries removed. Canonical schema/default/select modules retain active declarations except removed Formfield alias. No theme file version/token behavior changed. |
| packages/tui/src/theme/v2/index.ts | types | FormfieldStateKey; DiffDefinition; FormfieldColorDefinition; HueOverrideDefinition; Categorical; FormfieldColor; Hue; HueSource; ResolvedFormfieldState; StatefulColor | remove | D-tui; unused barrel type exports removed; owning schemas/types retained where reachable, Formfield aliases removed. |
| packages/tui/src/context/data.tsx | exports | isMessageComplete; reconcileCanonicalMessages | remove | D-tui; current transcript merge/completion logic remains local, not deleted. |
| packages/tui/src/context/data.tsx | types | SubagentPage | remove | D-tui; current paging shape retained locally. |
| packages/tui/src/component/error-component.tsx | exports | buildCrashReport | remove | D-tui; fatal crash report builder remains local to actual rendering/action boundary. |
| packages/tui/src/component/prompt/mode-chips.tsx | exports | FilledWarningChip | remove | D-tui; rendered chip component remains local. |
| packages/tui/src/routes/home.tsx | exports | LandingFooter | remove | D-tui; home route still renders local footer. |
| packages/tui/src/routes/session/provider-usage-reports.tsx | exports | providerUsageReportGroup | remove | D-tui; local usage report grouping retained, provider quota wire fields untouched. |
| packages/tui/src/util/session-autonomy.ts | exports | yoloLevelLabel; yoloLevelTooltip; YOLO_LEVEL_DETAILS; createSessionID | remove | D-tui; three obsolete duplicate label/detail helpers deleted; Session ID helper internalized behind current consumer. Active autonomyModeLabel/yoloLevel remain. |
| packages/tui/src/ui/glyph.ts | exports | GLYPHS | remove | D-tui; local glyph registry retained behind current glyph accessor. |
| packages/tui/src/ui/glyph.ts | types | GlyphColorKind; GlyphColorToken | remove | D-tui; local glyph color contract retained. |
| packages/tui/src/feature-plugins/sidebar/skills.tsx | exports | default | remove | P1: only empty private default removed; named rail, local View and Plugin.Context import retained. Existing conflict/skill render consumers pass; loader unchanged. |
| packages/tui/src/feature-plugins/sidebar/subagents.tsx | exports | SubagentRail | remove | D-tui; local active subagent rail retained, module plugin/render consumer unchanged. |
| packages/tui/src/feature-plugins/sidebar/guardrails.tsx | exports | GuardrailContent | keep:test-only | `test/cli/tui/guardrail.test.tsx:264` renders module.GuardrailContent through real TUI component boundary. |
| packages/tui/src/feature-plugins/system/diff-viewer-file-tree-utils.ts | exports | compareFileTreeNodes | remove | D-tui; local tree sorting retained behind exported tree operations. |
| packages/tui/src/feature-plugins/system/diff-viewer-file-tree-utils.ts | types | FileTreeNode | remove | D-tui; node shape retained in current tree contract; standalone export internalized. |
| packages/tui/src/mini/scrollback.writer.tsx | exports | entryLayout | remove | D-tui; local scrollback layout computation retained. |
| packages/tui/src/mini/footer.prompt.tsx | exports | TEXTAREA_MAX_ROWS | remove | D-tui; local rows limit still bounds prompt height and exported PROMPT_MAX_ROWS. |
| packages/tui/src/mini/form.shared.ts | exports | formSelected; formSetEditing | remove | D-tui; redundant forwarding export removed for formSelected; editing helper internalized, local form behavior retained. |
| packages/tui/src/mini/permission.shared.ts | exports | permissionReply | remove | D-tui; local permission reply derivation retained. |
| packages/tui/src/mini/stream.ts | exports | traceSubagentState | remove | D-tui; local diagnostic helper retained behind stream behavior. |
| packages/tui/src/routes/session/inline-diff.tsx | exports | inlineDiffFileStatus; inlineDiffSummary | remove | D-tui; local diff display status/summary retained behind real component. |
| packages/tui/src/routes/session/inline-diff.tsx | types | InlineDiffFileStatus | remove | D-tui; local diff status union retained. |
| packages/tui/src/util/selection.ts | exports | copy | remove | D-tui; local selection copy handling retained behind exported interaction path. |
| packages/tui/src/routes/session/composer/subagents-tab.tsx | exports | subagentMetadata | remove | D-tui; formatter internalized, live SubagentMetadata component retained. |
| packages/tui/src/routes/session/composer/subagents-tab.tsx | exports | SubagentMetadata | keep:test-only | `test/cli/tui/subagent-economics.test.tsx:84` and `subagents-tab.test.tsx:40` render actual metadata component. |
| packages/simulation/src/manifest.ts | exports | Manifest; defaults | remove | D-sim; local simulation manifest/defaults remain behind active simulation boundary; file is not a package export. |
| packages/ai/test/lib/http.ts | exports | runtimeLayer | remove | D-ai; local layer factory still powers exported dynamicResponse test helper. |
| packages/ai/test/lib/http.ts | types | HandlerInput | remove | D-ai; local handler input type remains in exported Handler shape. |
| packages/ai/test/recorded-scenarios.ts | exports | weatherRuntimeTool; expectFinish; expectWeatherToolCall; expectGoldenWeatherToolLoop | remove | D-ai; expectWeatherToolCall standalone assertion helper deleted; other three internalized behind exported recorded scenarios. No golden fixture or provider replay change. |
| packages/ai/test/continuation-scenarios.ts | exports | basicContinuation; toolContinuation; reasoningContinuation; mediaContinuation; maximalContinuation | remove | D-ai; local continuation feature sets remain in exported combined scenario definitions/type. |
| apps/web/src/app.tsx | exports | createAppRouter | keep:test-only | `verify/activity-order-fixture.tsx:3` and `router-fixture.tsx:3` inject real store/history through this named export; production also calls it locally. |
| apps/web/src/pwa/offline.ts | exports | isPrecachedShellUrl | remove | D-web; local service-worker policy helper remains behind current cache handling. |
| apps/web/src/remote/office/map.ts | exports | walkable; center | remove | D-web; walkable internalized in returned map/runtime data; center standalone geometry helper deleted. |
| apps/web/src/remote/queries.ts | exports | readUsageProviders; readUsageMetrics; readUsageReport | remove | D-web; local wire decoders remain connected to current usage Query definitions. |
| apps/web/src/seo/metadata.ts | exports | applyDocumentMetadata | remove | D-web; local document metadata application retained through route-owned metadata component. |
| apps/web/src/theme/theme.ts | exports | THEME_PREFERENCES; isThemePreference | remove | D-web; local theme preferences/type/validator retained. |
| packages/http-recorder/src/cassette/store.ts | exports | UnsafeCassetteError | remove | D-http; local tagged failure still raised by store, not swallowed. Root package exports only HttpRecorder and its curated types, not this class. |
| packages/http-recorder/src/http/recorder.ts | exports | defaultMatcher; recordingLayer | remove | D-http; forwarding export removed and local recording layer retained behind exported layer; root HttpRecorder.layer boundary preserved. |
| packages/http-recorder/src/http/recorder.ts | types | RecordReplayMode | remove | D-http; local mode union retained in recorder options. |
| packages/http-recorder/script/pack.ts | exports | pack | remove | D-http; local standalone pack entrypoint retained. |
| packages/http-recorder/src/cassette/model.ts | exports | CassetteMetadataSchema; InteractionSchema; isWebSocketInteraction | remove | D-http; schemas/guard remain local, tagged interaction encoding/filtering retained. |
| packages/http-recorder/src/redaction/redactor.ts | exports | compose | remove | D-http; local redaction composition still used by active redactor; security behavior not removed. |
| packages/codemode/src/tool-schema.ts | exports | toTypeScript | remove | D-code; local tool signature rendering retained behind actual exported CodeMode APIs. |
| packages/tui/src/theme/v2/schema.ts | exports | FormfieldState; CategoricalDefinition; SyntaxDefinition; MarkdownDefinition | remove | D-tui; FormfieldState alias removed, three canonical schema-building values internalized and still referenced by ThemeFile graph. |
| packages/tui/src/theme/v2/schema.ts | types | FormfieldStateKey; HueOverrideDefinition; FormfieldColorDefinition; DiffDefinition | remove | D-tui; Formfield aliases removed, hue/diff shape types internalized; active ActionState/StatefulColorDefinition retained. |
| packages/tui/src/ui/border.ts | exports | EmptyBorder | remove | D-tui; local border definition retained in composed borders. |
| packages/tui/src/util/scroll.ts | exports | CustomSpeedScroll | remove | D-tui; implementation class remains local to current scroll factory. |
| packages/tui/src/util/subagent.ts | exports | activeSubagentCount | remove | D-tui; redundant helper deleted; current active Session-ID selection and isActiveSubagent remain. |
| packages/tui/src/util/session-daybreak.ts | exports | daybreakStateLabel | remove | D-tui; local display label helper retained. |
| packages/tui/src/util/time.ts | exports | subagentElapsedSeconds | remove | D-tui; local elapsed calculation remains behind current formatter. |
| packages/client/src/contract.ts | exports | effectOmitEndpoints; groupNames; promiseOmitEndpoints | keep:dynamic | `packages/client/script/build.ts:5–7` imports exact names for generation from this contract barrel. No direct published Client contract subpath; owning codegen consumer is decisive. |
| packages/ai/test/recorded-utils.ts | exports | envList | remove | D-ai; local scenario environment-list helper retained. |
| apps/web/src/ui/site.tsx | exports | OfflineBanner | remove | D-web; local banner component retained in site render. |
| apps/web/src/ui/docs.tsx | exports | DocsNav | remove | D-web; local documentation navigation retained in docs render. |
| packages/http-recorder/src/http/matching.ts | exports | canonicalSnapshot; requestDiff | remove | D-http; local matching/diagnostic helpers retained behind request matcher. |
| packages/http-recorder/src/http/model.ts | exports | RequestSnapshotSchema; ResponseSnapshotSchema | remove | D-http; local schemas remain in HttpInteractionSchema; public RequestSnapshot type owned by api.ts unchanged. |
| packages/http-recorder/src/websocket/model.ts | exports | WebSocketEventSchema | remove | D-http; local schema remains in WebSocket interaction type/codec graph. |
| packages/codemode/src/openapi/spec.ts | exports | resolve | remove | D-code; local reference resolver remains in parsed OpenAPI operation flow. |
| packages/tui/src/component/bg-pulse-render.ts | exports | toRgb | remove | D-tui; local color helper retained behind current render behavior. |
| packages/effect-drizzle-sqlite/src/up-migrations/sqlite.ts | exports | upgradeSyncIfNeeded; upgradeAsyncIfNeeded | remove | D-sql; deleted private upstream driver-specific upgrade paths; active Effect migrator imports retained prepareSQLiteMigrationBackfill/buildSQLiteMigrationBackfillStatements. Closed package export map does not expose up-migrations/sqlite. |
| infra/cloudflare/src/relay/notice-store.ts | types | NoticeSql; NoticePage | remove | D-cf; standalone type exports internalized; current notice store result/SQL adapter shapes and newer repeat constant retained. |
| infra/cloudflare/src/push/store.ts | types | PushTestClaim | remove | D-cf; local push test-claim shape retained. |
| infra/cloudflare/src/relay/core.ts | types | Relay | remove | D-cf final commit; standalone ReturnType export removed, createRelay returned boundary retained. |
| packages/cli/test/remote-harness.ts | types | ProviderStandIn | remove | D-cli; local stand-in shape still checked with satisfies, test behavior retained. |
| packages/cli/src/remote-transport.ts | types | RemoteTransport; RemoteSocketOptions | remove | D-cli; local implementation/socket option shapes retained, exported factory/class boundary unchanged. |
| packages/tui/src/devtools/index.ts | types | Group | remove | D-tui; local devtools group shape retained. |
| packages/tui/src/plugin/api.ts | types | RouteMap; PluginRoutes | remove | P1: RouteMap internalized, unreferenced PluginRoutes alias removed; exact createPluginRoutes and public PluginRuntime declarations preserved. |
| packages/tui/src/mini/types.ts | types | RunProviderModel; FooterPhase; TurnSummary; ToolCodeSnapshot; ToolDiffSnapshot; ToolTaskSnapshot; ToolQuestionSnapshot; MiniToolState; StreamPhase; StreamSource; StreamToolState | remove | D-tui; local constituent types retained inside exported Mini/run/transcript structures. |
| packages/tui/src/component/dialog-custom-endpoint.tsx | types | CustomEndpointModel | remove | D-tui; local constituent of current CustomEndpointResult retained. |
| packages/tui/src/context/local.tsx | types | LocalTheme | remove | D-tui; obsolete standalone flat-color theme type deleted; current theme contracts retained. |
| packages/tui/src/routes/session/composer/index.tsx | types | ComposerHint | remove | D-tui; local composer hint shape retained. |
| packages/tui/src/prompt/history.tsx | types | PastedText | remove | D-tui; local prompt-history constituent type retained. |
| packages/tui/src/prompt/traits.ts | types | PromptMode | remove | D-tui; local mode type remains in PromptTraitsInput. |
| packages/tui/src/ui/dialog-confirm.tsx | types | DialogConfirmResult | remove | D-tui; local confirm-result union retained. |
| packages/simulation/src/control-server.ts | types | Server | remove | D-sim; local control-server ReturnType remains internal; closed simulation export map does not expose this file. |
| packages/core/test/fixture/mcp-skills.ts | types | SkillFile | remove | D-core; MCP fixture skill-file type internalized, fixture runtime retained. |
| packages/plugin/src/promise/tool.ts | types | Context; SchemaType; DynamicOutput; Definition; DynamicDefinition; ToolExecuteBeforeEvent; ToolExecuteAfterEvent; RegisterOptions; ToolDraft; ToolHooks | keep:public | Root Promise `Plugin.Context.tool` → ToolDomain; AnyTool root export → Definition/DynamicDefinition; hooks/draft/context/schema types are reachable API constituents. |
| packages/plugin/src/promise/tool.ts | types | Content | remove | P1: unreferenced private Promise Content alias removed; all twelve surviving tool exports and public Promise root unchanged. Canonical Effect Tool.Content retained. |
| apps/web/verify/remote-scenarios.ts | types | RemoteScenarioName; RemoteScenarioViewport; RemoteScenarioView | remove | D-web; fixture-local scenario shape exports internalized. |
| apps/web/src/remote/keep-awake.ts | types | KeepAwakeChange | remove | D-web; local keep-awake state-change type retained. |
| apps/web/src/remote/notifications.ts | types | SyncedNotice | remove | D-web; local receive/admit notice type retained; relay Schema contract unchanged. |
| apps/web/src/remote/preferences.ts | types | NotificationPreference | remove | D-web; local constituent of exported NotificationPreferences retained. |
| apps/web/src/remote/catalog.ts | types | PromptMentionInput; AgentOption; CommandOption; SkillOption; ResourceOption | remove | D-web; local mention/catalog option constituents retained. |
| apps/web/src/remote/file-change-diff.ts | types | SplitDiffRow | remove | D-web; local constituent of exported ParsedDiff retained. |
| apps/web/src/remote/view-model.ts | types | RemoteCapabilityName; RemoteCapabilities; RemoteDevice; RemoteAutonomyMode; RemoteToolStatus; RemoteMessagePart; RemoteMessage; RemoteApproval; RemotePromptInput; RemoteActionFailureReason; RemoteActionResult; RemoteActions; AccountAction; ShellOutputStatus | remove | D-web; local presentation constituents retained; package has no public library export map and remote wire owner remains packages/remote. |
| apps/web/src/remote/office/types.ts | types | Direction; TaskState; TeamCueInput; ActorPose | remove | D-web; local Office view/type constituents retained. |
| apps/web/src/remote/ui/team-model.ts | types | TeamSideChat | remove | D-web; local team-side-chat constituent retained. |
| infra/cloudflare/src/auth/store.ts | types | IdentityRow | remove | D-cf; unused standalone identity row type deleted; no data/schema migration. |
| packages/cli/src/framework/spec.ts | types | Children | remove | D-cli; local constituent of Node/Any command spec remains. |
| packages/tui/src/theme/v2/types.ts | types | ResolvedFormfieldState; Hue; HueSource; Categorical; StatefulColor; FormfieldColor | remove | D-tui; unused ResolvedFormfieldState alias removed, remaining constituents internalized within ResolvedThemeView. |
| packages/plugin/src/promise/agent.ts | types | AgentDraft | keep:public | Root PluginContext.agent → AgentDomain transform signature uses canonical draft; direct type re-export preserves schema identity. |
| packages/plugin/src/promise/aisdk.ts | types | AISDKHooks | keep:public | Root PluginContext.aisdk → AISDKDomain registration accepts this hook contract. |
| packages/plugin/src/promise/catalog.ts | types | CatalogDraft; CatalogProviderRecord | keep:public | Root PluginContext.catalog → CatalogDomain transform draft/provider-record shape. |
| packages/plugin/src/promise/command.ts | types | CommandDraft | keep:public | Root PluginContext.command → CommandDomain transform draft contract. |
| packages/plugin/src/promise/integration.ts | types | IntegrationDraft; IntegrationMethodRegistration | keep:public | Root PluginContext.integration → IntegrationDomain draft/method registration contract. |
| packages/plugin/src/promise/reference.ts | types | ReferenceDraft | keep:public | Root PluginContext.reference → ReferenceDomain transform draft contract. |
| packages/plugin/src/promise/session.ts | types | SessionContext; SessionHooks | keep:public | Root PluginContext.session → SessionDomain registration/hooks/context contract. |
| packages/plugin/src/promise/skill.ts | types | SkillDraft | keep:public | Root PluginContext.skill → SkillDomain transform draft contract. |
| packages/plugin/src/promise/registration.ts | types | Registration | keep:public | Root Promise domain transform methods return Registration via Transform alias; cleanup/lifetime contract is public. |
| packages/effect-drizzle-sqlite/src/internal/drizzle-utils.ts | types | JoinNullability | remove | D-sql; private unused Drizzle type forwarding removed, upstream generic runtime contracts preserved. |
| packages/codemode/src/openapi/types.ts | types | InputLocation | remove | D-code; local constituent of current InputField remains. |
| packages/cli/src/services/update-preflight.tsx | types | Handoff | remove | D-cli; local update/service handoff shape remains. |
| packages/codemode/src/interpreter/model.ts | types | SourcePosition; SourceLocation | remove | D-code; local interpreter source-location constituents retained; package publishes only curated root. |

## Duplicate findings

Each `A ↔ B` cell is one original duplicate group. Retained public aliases are contract decisions, not proposals to add compatibility layers.

| File | Category | Finding(s) | Disposition | Evidence / status |
|---|---|---|---|---|
| packages/core/src/form.ts | duplicates | layer ↔ locationLayer | remove | D-core; locationLayer alias deleted; canonical layer/node retained. Core wildcard public reachability acknowledged; no current named alias contract/caller found in bounded review. |
| packages/core/src/aisdk.ts | duplicates | locationLayer ↔ defaultLayer | remove | D-core; defaultLayer alias deleted; canonical locationLayer remains in active AISDK wiring. Wildcard external-import risk acknowledged. |
| packages/core/src/config/experimental.ts | duplicates | Info ↔ Experimental | remove | D-core; Experimental alias deleted; ConfigExperimental.Info remains used by `config.ts:148`. Docs `Config.Experimental` is the config shape vocabulary, not a demonstrated import of deleted ConfigExperimental.Experimental. |
| packages/core/src/session/runner/image-analyzer.ts | duplicates | isMultimodal ↔ detectMultimodal | remove | D-core; detectMultimodal alias deleted; canonical isMultimodal/node retained. Wildcard external-import risk acknowledged. |
| packages/tui/src/theme/v2/schema.ts | duplicates | ActionState ↔ FormfieldState | remove | D-tui; duplicate FormfieldState value/type alias deleted; canonical ActionState and theme graph retained. |
| packages/ai/src/providers/azure.ts | duplicates | responsesModel ↔ model | keep:public | AI wildcard provider exports; `providers/azure/responses.ts:1` forwards responsesModel as provider-package model, while Azure default provider-package model remains model. Both address distinct entrypoint contracts. |
| packages/ai/src/providers/openrouter.ts | duplicates | model ↔ responses | keep:public | AI wildcard/provider namespace API exposes both current names; model implements ProviderPackage.Definition. Do not break named provider export merely because they reference the same function. No alias removal approved by this audit. |
| packages/ai/src/route/auth.ts | duplicates | none ↔ passthrough | keep:public | Auth namespace re-exported by `route/index.ts`; current documented AI AGENTS names Auth.passthrough, and `test/auth.test.ts:97` exercises Auth.none. Both are exposed auth contracts. |
| packages/ai/src/route/auth.ts | duplicates | bearer ↔ apiKey | keep:public | Published Auth namespace/wildcard route module exposes both; bearer is exercised by current auth tests/provider routes. Removal is public-contract work, not an unused-export conclusion. |

## Excluded provider export findings

All rows below are `keep:vendored` because the plan expressly excludes `packages/core/src/cursor/provider/**`. Their names/current definitions were checked against the untouched source and scan; a symbol's apparent lack of in-repository consumer does not override that exclusion. Test/debug names retain the same exclusion. No npm SDK substitution, provider edit, alias deletion, or vendor cleanup is authorized here.

| File | Category | Finding(s) | Disposition | Evidence / status |
|---|---|---|---|---|
| packages/core/src/cursor/provider/session.js | exports | DEFAULT_CONTINUATION_POLICY; SessionManager | keep:vendored | Explicit provider exclusion; current file unchanged from scan boundary. |
| packages/core/src/cursor/provider/protocol/tools.js | exports | REQUEST_CONTEXT_RESULT_FIELD; OPENCODE_2_TOOL_DIALECT; sanitizeMcpServerId; resolveToolServerIdentity; buildLiveRequestContext; mapExecServerToToolName; mapToolNameToExecField; resolveCursorSubagentType; decodeWriteBytes; buildExecStreamClose; unwrapReadOutput; buildTypedExecResult | keep:vendored | Explicit provider exclusion; tool wire/dialect contract stays untouched. |
| packages/core/src/cursor/provider/plugin-core.js | exports | isCursorPackage; cursorApiBaseURL; cursorGetServerConfigTelemetryEnabled | keep:vendored | Explicit provider exclusion; plugin/provider configuration stays untouched. |
| packages/core/src/cursor/provider/protocol/blob-store.js | exports | snapshotConversationBlobs; resetConversationBlobsForTests | keep:vendored | Explicit provider exclusion; conversation blob/test hooks unchanged. |
| packages/core/src/cursor/provider/errors.js | exports | sanitizeHostTerminalMessage; isAuthGrpcStatus | keep:vendored | Explicit provider exclusion; error/redaction boundary unchanged. |
| packages/core/src/cursor/provider/protocol/request.js | exports | buildSeedConversationState | keep:vendored | Explicit provider exclusion; request seed contract unchanged. |
| packages/core/src/cursor/provider/protocol/conversation-bind.js | exports | MAX_ACTIVE_CONVERSATION_BINDINGS; resetConversationBindingsForTests; peekConversationId | keep:vendored | Explicit provider exclusion; binding limits/state hooks unchanged. |
| packages/core/src/cursor/provider/language-model.js | exports | MAX_TURN_STATE_SESSIONS; MAX_CHECKPOINT_BLOB_GRAPH_BYTES; checkpointBlobGraphRequiresRebase; checkpointBlobGraphConcern; resolveRetryPolicy; connectFrameError; restoreTurnToolCatalog; rememberMirroredTodos; snapshotMirroredTodosBySession; promptIdentityWouldRemint; pumpWithRecovery; attachSessionHeartbeat; findContinuationSession; FRESH_TURN_DRAIN_TIMEOUT_MS; FRESH_TURN_PENDING_CANCEL_REASON; preparePriorSessionForFreshTurn; cancelPendingExecsForFreshTurn; drainSessionUntilTurnEnded; deliverContinuationResults; pump; extractTrailingToolResults; groundCheckpointTurnText; buildOpenCodeInteractionGuidance; estimateTokens; cursorTurnEndedProviderMetadata; extractPromptHistory; opencodeSessionKey; resolveConversationId; sessionIdToUuid; spanEndParts; computeAllowTools; resolveTurnToolState; resolveTurnConversationReset; resetTurnStateForTests | keep:vendored | Explicit provider exclusion; transport/continuation/checkpoint/usage boundaries unchanged. |
| packages/core/src/cursor/provider/transport/connect.js | exports | buildBaseHeaders; isAllowedAgentHost; cursorRunTerminationError; HTTP2_SESSION_MAX_AGE_MS; shouldReuseHttp2Session; resolveAgentOrigin; closeCachedHttp2SessionsForTests; installSessionInvalidationForTests; getSession; makeRequestId | keep:vendored | Explicit provider exclusion; HTTP2/auth/host-selection contract unchanged. |
| packages/core/src/cursor/provider/activity.js | exports | SessionActivityTracker | keep:vendored | Explicit provider exclusion; activity tracker unchanged. |
| packages/core/src/cursor/provider/context/build.js | exports | DYNAMIC_REQUEST_CONTEXT_KEYS | keep:vendored | Explicit provider exclusion; provider context keys unchanged. |
| packages/core/src/cursor/provider/context/rules.js | exports | isProjectConfigDisabled; fetchRemoteInstruction | keep:vendored | Explicit provider exclusion; instruction/config boundary unchanged. |
| packages/core/src/cursor/provider/protocol/ask-question.js | exports | FREEFORM_OPTION_ID; SKIPPED_REASON; DISMISSED_REASON; isCatchAllOptionLabel; displayOptions; rejectedResult; asyncResult; answerForQuestion | keep:vendored | Explicit provider exclusion; question protocol unchanged. |
| packages/core/src/cursor/provider/protocol/generate-image.js | exports | CURSOR_IMAGE_ASSETS_DIR | keep:vendored | Explicit provider exclusion; image asset contract unchanged. |
| packages/core/src/cursor/provider/protocol/create-plan.js | exports | createPlanApprovalQuestion; CREATE_PLAN_APPROVAL_HEADER; randomPlanSlug; slugifyPlanName; resolveHostPlanPath; resolveOpencodePlanPath; renderOpencodePlanMarkdown | keep:vendored | Explicit provider exclusion; plan approval/path/render contract unchanged. |
| packages/core/src/cursor/provider/protocol/create-plan.js | duplicates | resolveHostPlanPath ↔ resolveOpencodePlanPath | keep:vendored | Explicit provider exclusion; duplicate exported names left untouched. |
| packages/core/src/cursor/provider/protocol/switch-mode.js | exports | USER_REJECTED_REASON; MISSING_TARGET_REASON; PLAN_EXIT_UNAVAILABLE_REASON; SWITCH_MODE_EXIT_QUESTION; SWITCH_MODE_EXIT_HEADER; normalizeSwitchModeId; switchModeExitQuestionInput; switchModeRejectedResult; clearActiveCursorMode; resetActiveCursorModesForTests; cursorModeSystemReminder | keep:vendored | Explicit provider exclusion; mode-switch protocol unchanged. |
| packages/core/src/cursor/provider/image-input.js | exports | MAX_CURSOR_IMAGE_INPUT_BYTES; hasCursorUserImages; extractCursorUserImages; extractCursorHistoryImages | keep:vendored | Explicit provider exclusion; image-input bounds/history unchanged. |
| packages/core/src/cursor/provider/protocol/exec-variants.js | exports | CURSOR_EXEC_VARIANTS | keep:vendored | Explicit provider exclusion; exec variant wire contract unchanged. |
| packages/core/src/cursor/provider/shell-timeout.js | exports | CURSOR_TIMEOUT_CANCEL; CURSOR_TIMEOUT_BACKGROUND; setCursorShellPath; resolveCursorShellKind; shellPolicyFromMetadata; buildSoftBackgroundCommand; prepareCursorShellArgs; cursorShellOriginalCommand; releaseCursorShellEnv; cursorShellEnvForCall; cursorShellEnvForCommand; sanitizeCursorShellDisplayOutput; sanitizeRegisteredCursorShellOutput; captureCursorShellResult; resetCursorShellCalls | keep:vendored | Explicit provider exclusion; shell timeout/environment/output boundary unchanged. |
| packages/core/src/cursor/provider/auth.js | exports | AuthExchangeError; AuthRefreshError; AuthPollError; AuthTimeoutError; isExpiringSoon; decodeJwtPayload; useAuthToken; exchangeApiKey; clearBearerTokenCache | keep:vendored | Explicit provider exclusion; auth/token boundary unchanged. |
| packages/core/src/cursor/provider/models.js | exports | CURSOR_VARIANT_PARAMETERS_KEY; CURSOR_WIRE_MODEL_ID_KEY; CursorVariantSelectionError; normalizeModelParameterValues; normalizeModelCache; paramsImplyMaxMode; parseCursorContextLimit; isCacheFresh; writeCache; mapAvailableModelsResponse; fetchModels; refreshModelCache | keep:vendored | Explicit provider exclusion; catalog/model variant contract unchanged. |
| packages/core/src/cursor/provider/pricing.js | exports | CURSOR_UNPRICED_MODEL_IDS; validateOpenCodeModelCost; isOpenCodeModelCost; wireModelIdForPricing; applyCursorModelCost; toOpenCode2Costs; checkCursorPricingCoverage | keep:vendored | Explicit provider exclusion; usage/pricing normalization unchanged. |
| packages/core/src/cursor/provider/debug.js | exports | DEBUG_LOG_MAX_BYTES; isDebugEnabled; resolveDebugLogPath; ensureSecureDebugLog; truncateDebugLogIfOversized | keep:vendored | Explicit provider exclusion; secure debug-log boundary unchanged. |
| packages/core/src/cursor/provider/protocol/messages.js | exports | createMessageTypes; decodeWrappedMessage | keep:vendored | Explicit provider exclusion; protobuf message decoding unchanged. |
| packages/core/src/cursor/provider/protocol/struct.js | exports | decodeValueToJson | keep:vendored | Explicit provider exclusion; wire value decoding unchanged. |
| packages/core/src/cursor/provider/context/paths.js | exports | HOST_PATH_BRIDGE; getHostCacheDirOverride; resolveHostCacheDir; opencodeGlobalConfigDir; opencodeGlobalDataDir; hostGlobalDataDir; slugifyWorkspacePath; opencodeProjectDir | keep:vendored | Explicit provider exclusion; provider host/config paths unchanged. |
| packages/core/src/cursor/provider/shared.js | exports | TOKEN_EXPIRY_THRESHOLD_S; RUN_PATH; AVAILABLE_MODELS_PATH; CONTENT_TYPE_CONNECT_PROTO | keep:vendored | Explicit provider exclusion; shared wire/auth constants unchanged. |
| packages/core/src/cursor/provider/protocol/checkpoint.js | exports | resetCheckpointsForTests | keep:vendored | Explicit provider exclusion; checkpoint test hook unchanged. |
| packages/core/src/cursor/provider/context/frozen.js | exports | MAX_FROZEN_REQUEST_CONTEXTS; clearFrozenRequestContext; resetFrozenRequestContextsForTests | keep:vendored | Explicit provider exclusion; frozen context bounds/hooks unchanged. |
| packages/core/src/cursor/provider/protocol/framing.js | exports | FLAG_GZIP; FLAG_END_STREAM; asyncStreamFrames | keep:vendored | Explicit provider exclusion; stream framing unchanged. |
| packages/core/src/cursor/provider/protocol/git-diff.js | exports | GIT_DIFF_FORMAT_UNSPECIFIED; GIT_DIFF_FORMAT_NAME_STATUS; GIT_DIFF_FORMAT_NAME_STATUS_AND_NUMSTAT; GIT_DIFF_FORMAT_FILE_DIFFS; GIT_DIFF_FORMAT_DIFFS_WITH_BEFORE_AND_AFTER; parseUnifiedDiff; executeGitDiff | keep:vendored | Explicit provider exclusion; git diff protocol unchanged. |
| packages/core/src/cursor/provider/protocol/progress-continuation.js | exports | PROGRESS_ONLY_PATTERNS; isProgressOnlyAssistantText | keep:vendored | Explicit provider exclusion; continuation classification unchanged. |
| packages/core/src/cursor/provider/protocol/tool-call-bridge.js | exports | applyTodoMerge | keep:vendored | Explicit provider exclusion; todo tool bridge unchanged. |
| packages/core/src/cursor/provider/protocol/interactions.js | exports | UnsupportedInteractionQueryError; inspectInteractionQueryWire | keep:vendored | Explicit provider exclusion; interaction wire boundary unchanged. |
| packages/core/src/cursor/provider/plan-execution-kickoff.js | exports | createPlanExecutionKickoffText; setPlanExecutionKickoff; cancelPlanExecutionKickoff; resetPlanExecutionKickoffForTests | keep:vendored | Explicit provider exclusion; plan kickoff state unchanged. |
| packages/core/src/cursor/provider/host-agent-mode.js | exports | setHostAgentModeSwitch; cancelHostAgentModeSwitch; resetHostAgentModeSwitchForTests | keep:vendored | Explicit provider exclusion; host mode switching unchanged. |
| packages/core/src/cursor/provider/image-staging.js | exports | MAX_STAGED_IMAGE_BYTES; STAGED_IMAGE_TTL_MS; StagedImageTooLargeError; discardPendingCursorImage; clearPendingCursorImages; pendingCursorImageCount | keep:vendored | Explicit provider exclusion; image staging limits/lifetime unchanged. |
| packages/core/src/cursor/provider/image-save.js | exports | resolveContainedImagePath; executeCursorImageSave | keep:vendored | Explicit provider exclusion; contained image save boundary unchanged. |
| packages/core/src/cursor/provider/protocol/conversation-persistence.js | exports | conversationCacheDirectoryPath; conversationCacheFilePath; getPersistedConversation; resetConversationPersistenceForTests | keep:vendored | Explicit provider exclusion; conversation persistence unchanged. |
| packages/core/src/cursor/provider/context/epoch.js | exports | MAX_CONTEXT_EPOCHS; getContextEpoch | keep:vendored | Explicit provider exclusion; context epoch bounds unchanged. |
| packages/core/src/cursor/provider/agent-url.js | exports | resetAgentUrlCache | keep:vendored | Explicit provider exclusion; agent URL test hook unchanged. |
| packages/core/src/cursor/provider/compaction-marker.js | exports | markCompactionSession; clearCompactionSessions | keep:vendored | Explicit provider exclusion; compaction markers unchanged. |
| packages/core/src/cursor/provider/session-directory.js | exports | markSessionDirectory; getSessionDirectory; clearSessionDirectories; opencodeDirectoryHeader | keep:vendored | Explicit provider exclusion; session Location header bridge unchanged. |
| packages/core/src/cursor/provider/model-metadata.js | exports | getDocumentedCursorModelContext; getDocumentedCursorModelCapabilities | keep:vendored | Explicit provider exclusion; documented model capability projection unchanged. |
| packages/core/src/cursor/provider/usage.js | exports | buildLanguageModelV3UsageFromCounters; buildLanguageModelV3UsageFromTurnEnded; flatUsageFromV3 | keep:vendored | Explicit provider exclusion; normalized provider usage unchanged. |
| packages/core/src/cursor/provider/protocol/checksum.js | exports | obfuscate | keep:vendored | Explicit provider exclusion; checksum wire function unchanged. |
| packages/core/src/cursor/provider/protocol/client-version.js | exports | resetClientVersionCache; cursorAgentVersionsDir; discoverLocalVersion; extractVersionFromInstaller | keep:vendored | Explicit provider exclusion; client version discovery unchanged. |
| packages/core/src/cursor/provider/transport/https-proxy.js | exports | hostMatchesNoProxy; openHttpsConnectTunnel | keep:vendored | Explicit provider exclusion; proxy transport contract unchanged. |
| packages/core/src/cursor/provider/context/overlay.js | exports | MAX_OVERLAY_HOLDS | keep:vendored | Explicit provider exclusion; context overlay bound unchanged. |
| packages/core/src/cursor/provider/pricing-data.js | exports | CURSOR_PRICING_SOURCE; CURSOR_CONTEXT_SOURCE | keep:vendored | Explicit provider exclusion; upstream documented pricing/context source constants unchanged. |

## Audit validation and handoff

- Read-only commands: Python JSON/count/name reduction; bounded tracked-file reference reads; `git log`, `git show`, `git diff`, `git ls-files`, `git status`, and targeted `rg`/file reads. The canonical JSON was not regenerated and knip was not run again.
- Artifact check passed: all 719 exact `(file, category, name/group)` identities match canonical raw, with zero missing, extra, or duplicate identities; all three split copies are exact canonical subsets. Recomputed category/disposition counts match the table. No row relies only on a matching bare word in an unrelated file. Canonical raw SHA-256: `ad203e9b927b828109faf54afc7d47367af07303fef7aa27b2c19d48fac5e8c2`.
- The original audit did not run source/build/runtime suites. P1 records current parent typechecks, scoped declarations and the eighteen focused TUI consumer cases. Historical E16/E17 remain historical. No S6 claim is made here for external Drive, live providers, physical browsers, packaged native targets or editor language-service loading; notification workerd evidence has its separate artifact.
- Parent owns O1/O2 decisions, all 33 unapplied removal findings, AC7 integration, any compatibility/dependency approvals, and the blank tracking table/status updates. Keep this evidence artifact uncommitted.

Exact read-only identity/count check (run from original repository root; exit 0):

```sh
python3 - <<'PY'
import collections, hashlib, json
from pathlib import Path
p = Path('plans/codebase-cleanup/knip')
raw = json.loads((p / 'knip-raw.json').read_text())['issues']
expected, actual = collections.Counter(), collections.Counter()
categories, dispositions, opened, ready = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
def name(value):
    return ' ↔ '.join(item['name'] for item in value) if isinstance(value, list) else value['name']
for issue in raw:
    for category, values in issue.items():
        if category != 'file':
            for value in values:
                expected[(issue['file'], category, name(value))] += 1
for line in (p / 'triage.md').read_text().splitlines():
    cells = [cell.strip() for cell in line.split('|')]
    if len(cells) != 7 or cells[2] not in {key[1] for key in expected}:
        continue
    file, category, names, disposition, evidence = cells[1:6]
    for symbol in [file] if category == 'files' else names.split('; '):
        actual[(file, category, symbol)] += 1
        categories[category] += 1
        dispositions[disposition] += 1
        if 'OPEN O' in evidence:
            opened[evidence.split('OPEN ')[1].split(';')[0]] += 1
        if 'READY R' in evidence:
            ready[evidence.split('READY ')[1].split(';')[0]] += 1
assert expected == actual, (expected - actual, actual - expected)
assert all(value == 1 for value in actual.values())
assert sum(actual.values()) == 719
assert sum(opened.values()) == 15
assert sum(ready.values()) == 21
assert dispositions == {'remove': 302, 'keep:public': 68, 'keep:dynamic': 49, 'keep:test-only': 67, 'keep:vendored': 233}
for file in ['files-deps.json', 'exports-core.json', 'exports-other.json']:
    count = 0
    for issue in json.loads((p / file).read_text()):
        for category, values in issue.items():
            if category == 'file' or values is None:
                continue
            for value in values:
                assert expected[(issue['file'], category, name(value))] == 1
                count += 1
    print(file, count)
assert hashlib.sha256((p / 'knip-raw.json').read_bytes()).hexdigest() == 'ad203e9b927b828109faf54afc7d47367af07303fef7aa27b2c19d48fac5e8c2'
print('PASS', sum(actual.values()), dict(categories), dict(dispositions), 'open', dict(opened), 'ready', dict(ready))
PY
```
