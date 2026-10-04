# SL AI and contracts lane inventory

Scope: branch `sl-ai`, lane `.worktrees/sl-ai`; `packages/{ai,server,schema,protocol,client,codemode,plugin}/test*` only. This is an uncommitted working inventory, not a product specification.

## Preservation and baseline

- Read original `plan.md`, `testing.md`, and `sl-brief.md`. Preserve inherited dirty files and three untracked Server helpers in named stash `sl-ai-approved-cleanup-preserve-before-rebase-2026-10-03`, object `fe873dd99c22d1e835b0a02f11598f96b1ab4465`; retain that stash.
- Execute approved `git rebase --onto codebase-cleanup 3962b14f sl-ai`, then apply that exact stash. Lane baseline is parent `1141158a`; do not rebase during probes.
- Read every inherited diff and all removed assertions. Run the original tracked tests by reversing the exact saved inherited patch temporarily, then apply it again on shell exit. No wholesale checkout or restoration.
- Baseline inventory: 147 suite files, 40,208 test-suite lines. Execute 145 files separately: 1,909 passed cases, 28 recorded skips, zero failures; two unchanged real-Chrome suites unrun. Registered executable cases total 1,937. Browser suites have additional unexecuted parameterized cases, not included in that total.
- Per-file command: `bun test --cwd packages/<package> <test-file-relative-to-package> --timeout 30000 --reporter=junit --reporter-outfile=<evidence>/baseline-packages_<package>_<test-file-with-slashes-replaced-by-underscores>.xml --only-failures`. One test process at a time, shell memory cap 8192 MiB, subprocess timeout 180 seconds.
- Evidence directory: `/tmp/sl-ai-evidence`; `baseline.json` contains exact commands, exits, wall times, and every registered case name, class/group, result, and JUnit case duration. `baseline-source.json` contains source case/group names, line ranges, and assertion methods, including unrun suites. XML/log files accompany every executed file. Durations are per-file process wall times on a shared host; host-wide isolation was not established.

| Package | Baseline suite files | Registered cases | Passed | Skipped | Suite lines | Sum per-file wall seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ai | 50 | 673 | 645 | 28 | 17,521 | 9.770 |
| server | 29 | 65 | 65 | 0 | 4,780 | 13.724 |
| schema | 18 | 109 | 109 | 0 | 1,855 | 1.206 |
| protocol | 18 | 38 | 38 | 0 | 973 | 2.263 |
| client | 9 | 75 | 75 | 0 | 2,215 | 46.144 |
| codemode | 20 | 969 | 969 | 0 | 12,669 | 5.529 |
| plugin | 3 | 8 | 8 | 0 | 195 | 0.255 |

## Retained-behavior mapping for inherited changes

All cases outside the groups below remain `keep`, including every fixture golden and usage/cache normalization case. No test-count target applies. Case-group classifications apply to every case/parameter row in that group; exact case names and source assertion ranges are recorded in the two baseline manifests.

| Original file / group | Classification and reason | Surviving layer and required assertions |
| --- | --- | --- |
| ai/test/provider/openai-responses.test.ts: eleven provider stream error cases | merge: repeated request/executor setup, not duplicate semantics; preserve all eleven rows | Real Responses protocol behind HTTP executor fake; each row checks LLMError identity plus original reason tag/message and overflow classification where required. Top-level code/message, missing/empty/null fields, nested `error`, nested `response.error`, response.failed details/defaults all survive. No cache/usage/replay cases removed. |
| schema/test/contract-hygiene.test.ts: no Any/mutable source-text gate | rewrite; deletion was unjustified because Schema contract hygiene is always retained | All exported current Schema values and their AST graphs reject Any nodes and mutable wrappers, including recursive and encoded graphs. Other twelve contract cases unchanged. |
| protocol/test/project-artifact.test.ts: absent legacy self-improvement group | rewrite; restore public-surface assertion without source-text coupling | Actual ClientApi group and endpoint manifest plus client groupNames reject self-improvement entries; managed artifact group positively present. Other four artifact contracts unchanged. |
| server/test/guardrail.test.ts: helper forwarding plus route-source gate | rewrite/merge; cover the same mappings through reachable HTTP routes | GET status and review list encode normalized values; POST reply returns204; unrelated-family request failure maps404 with request ID; missing Session maps404 with Session ID; exact original forwarding sequence retained. Core owns actual family-state enforcement; auth and Location lookup are outside this controlled HTTP fixture. |
| server/test/provider-usage.test.ts: list/get route-source gate | rewrite; usage normalization and route registration both required | Existing direct wrapper test retained. Added real HTTP router list/get assertions for refresh=true/false, server Location, complete encoded normalized snapshots, and original Core inputs. No provider credentials or live traffic. |
| server/test/project-artifact-handler.test.ts: eighteen Store registrations / refresh-path source gates | rewrite; required registrations, scope derivation, and refresh ordering must not disappear | New project-artifact-refresh.test.ts exercises all eighteen operations through real HTTP router, typed Store outputs, successful200/204 responses, exact bodies, successful Store-before-refresh order, no refresh for reads/previews/purge, sanitized409 on Store failure, and server project identity/optimistic expectations despite untrusted body fields. Existing helper failure-order and typed secret-redaction tests retained. |
| server/test/project-artifact-handler.test.ts: repeated identical successful refresh with a second structurally identical source object | merge; no distinct input/output/ordering/failure behavior | First success retains exact Store-before-refresh assertion; following failure retains no-refresh-on-failure assertion. HTTP operation cases separately guard reachable caller results. |
| server/test/session-location.test.ts: malformed/cross-parent cursor source gate | rewrite | New session-http.test.ts checks both invalid cursor forms return400 InvalidCursorError and never reach Core paged read. Existing endpoint declaration/control-route contracts retained. |
| server/test/session-location.test.ts: missing Session skills source gate | rewrite | Real HTTP skills endpoint returns404 SessionNotFoundError with exact Session ID. |
| server/test/session-location.test.ts: durable compact job ID/conflict source gate | rewrite | Real HTTP request forwards exact Session/job IDs;409 ConflictError resource is job ID, diagnostic includes job ID and Core message. Additional success-body coverage is assessed separately; source substring absence is not a behavioral guard. |
| server/test/session-{autonomy,daybreak,model-switch,snapshot,usage-report}.test.ts: duplicated HTTP setup | merge setup only, no case removal | Shared session-http.ts retains real SessionHandler, HttpApi decoding/encoding, process identity, explicit Core/orchestration mocks, auth/Location exclusion, disposal, and usage-report Location-call callback. Every original assertion retained except common epoch fixture identity changed to shared sessionHttpEpoch. |

## Inherited-test defects and exclusions

- The untracked artifact refresh draft returned `undefined as never` from Store methods and checked only call arrays. Verified HTTP400 schema failures still yielded passing tests. Replace invalid fakes with canonical decoded outputs; require200/204 and payload assertions before accepting it.
- Bun1.4.2 `expect(received).toMatchObject({ message: expect.stringContaining(...) })` mutates the received property to the matcher. Verified both in the compact HTTP test and a standalone reproduction. Assert scalar message contents separately; this is a test-runner behavior, not a YCoding production defect.
- Recorded skips: one malformed-order Anthropic case, one Bedrock cache case, and26 golden provider scenarios. Preserve all; do not re-record or use live credentials to fabricate GREEN.
- Unrun unchanged suites: Chrome-owned extension suite has6 statically declared cases (two named plus source/packaged variants of two marker groups); required `YCODING_TEST_ISOLATED_BROWSER_CHROME` is unset. Isolated-browser suite has6 statically declared cases (three named plus moved/archived/deleted variants); not run, and its live prerequisites were not investigated in this reconciliation. No live-suite passing claim or asserted isolated-browser environment failure.
- Root AGENTS/checks belong to parent. Package typechecks ran after parent released the heavy slot, sequentially with8192 MiB aggregate shell cap. No production defect proven; no permanent production edits.

## Complete suite and case-group classification

Each row covers **every named case and parameter row** in that file. Exact case/group names, individual results and durations are in `baseline.json` and matching JUnit; case/group source ranges are in `baseline-source.json`. No case outside the explicitly mapped rewrites/merge above is deleted. Source references for kept assertions are the complete original file (line1 through the listed line count); moved/replaced assertions use the mapping above. Support helpers/fixtures have no independent cases and remain because these suites consume them.

Reason/layer codes:
- **A**: keep public AI schema/provider-wire behavior, required streaming/settlement/tool/replay rules, authentication, cache/usage normalization or regressions; protocol/LLM implementation runs with external transport fixtures. Parser/tool helpers guard the lowest relevant rule, with provider flows retained.
- **S/P/C**: keep mandatory Schema/Protocol/Client contract, serialization/identity, manifests, endpoint/client transport and service-lifetime trust boundaries. Import-boundary bundle checks are required consumer-integrity gates.
- **X**: keep public CodeMode execution/catalog/OpenAPI behavior, supported interpreted JavaScript semantics (including distinct Test262 boundary inputs), confinement, sanitized failures, tool/output lifetime and native-parity interactions. Tests execute the real interpreter; adapters mock only host tools/transport.
- **G**: keep public plugin exports, canonical contract identity and tool/schema boundaries.
- **H**: keep Server endpoint decoding/forwarding/encoding, scope/ownership/auth/error/privacy rules; execute actual handlers/router or relevant isolated service. **F**: keep real-component flow through Server/Core or explicitly named process/browser integration boundary. Flow fixtures do not prove live-provider/native-browser behavior outside their boundary.
- **M**: keep all cases; merge only repeated fixture setup. **R**: keep all remaining cases; replace specifically mapped source-text/duplicate groups with executable guards. **E**: merge eleven error-case setups with all parameter rows/assertions retained. No `delete` classification remains justified after auditing inherited removals.

Columns: suite relative to package, registered baseline cases, isolated-file process wall seconds, complete original assertion file lines, decision/reason/layer.

### AI — all673 registered cases

| Suite/case-group | Cases | Wall s | Lines | Decision |
| --- | ---: | ---: | ---: | --- |
| `test/adapter.test.ts` — LLM route | 5 | .078 | 183 | keep A |
| `test/anthropic-model.test.ts` — model rules | 3 | .012 | 75 | keep A |
| `test/auth.test.ts` — authentication | 7 | .084 | 103 | keep A |
| `test/cache-policy.test.ts` — TTL, anchors, policy, volatile messages | 57 | .139 | 1577 | keep A; mandatory cache |
| `test/cache-profile.test.ts` — model normalization/cache profile | 7 | .013 | 85 | keep A; mandatory cache |
| `test/codex-websocket.test.ts` — Responses WebSocket | 4 | .141 | 293 | keep A |
| `test/endpoint.test.ts` — Endpoint | 3 | .084 | 58 | keep A |
| `test/executor.test.ts` — RequestExecutor | 18 | .131 | 592 | keep A |
| `test/exports.test.ts` — public exports | 4 | .141 | 94 | keep A |
| `test/generate-object.test.ts` — tool schema/object generation | 6 | .090 | 184 | keep A |
| `test/http-transport-lifecycle.test.ts` — HTTP lifecycle | 3 | .084 | 142 | keep A |
| `test/image.test.ts` — images | 10 | .141 | 578 | keep A |
| `test/llm.test.ts` — canonical constructors | 11 | .081 | 199 | keep A |
| `test/prepare.test.ts` — request precedence | 5 | .133 | 178 | keep A |
| `test/provider-error.test.ts` — provider error classification | 14 | .087 | 150 | keep A |
| `test/provider-package.test.ts` — provider entrypoints | 14 | .123 | 318 | keep A |
| `test/provider/anthropic-messages-cache.recorded.test.ts` — cache write/read | 1 | .127 | 71 | keep A; mandatory golden/cache |
| `test/provider/anthropic-messages.recorded.test.ts` — malformed tool order | 1 | .082 | 45 | keep A; mandatory golden; skipped |
| `test/provider/anthropic-messages.test.ts` — Messages protocol | 40 | .140 | 1227 | keep A |
| `test/provider/bedrock-converse-cache.recorded.test.ts` — cache write/read | 1 | .140 | 61 | keep A; mandatory golden/cache; skipped |
| `test/provider/bedrock-converse.test.ts` — protocol/recorded rows | 32 | .144 | 903 | keep A |
| `test/provider/cloudflare.test.ts` — Cloudflare wire rules | 9 | .080 | 283 | keep A |
| `test/provider/gemini-cache.recorded.test.ts` — Gemini cache | 1 | .140 | 53 | keep A; mandatory golden/cache |
| `test/provider/gemini.test.ts` — Gemini protocol | 19 | .147 | 592 | keep A |
| `test/provider/golden.recorded.test.ts` — all provider/scenario rows | 39 | .149 | 240 | keep A; mandatory goldens;26 skipped |
| `test/provider/google-images.recorded.test.ts` — image goldens | 2 | .138 | 56 | keep A; mandatory goldens |
| `test/provider/google-vertex.test.ts` — Vertex routes | 7 | .148 | 246 | keep A |
| `test/provider/openai-chat-reasoning.recorded.test.ts` — reasoning | 4 | .138 | 144 | keep A; mandatory goldens |
| `test/provider/openai-chat.test.ts` — Chat protocol/cache family gates | 63 | .141 | 1446 | keep A; all cache/usage cases retained |
| `test/provider/openai-compatible-chat.test.ts` — compatible Chat | 6 | .079 | 259 | keep A |
| `test/provider/openai-compatible-responses.test.ts` — compatible Responses | 1 | .083 | 53 | keep A |
| `test/provider/openai-images.recorded.test.ts` — image goldens | 2 | .135 | 62 | keep A; mandatory goldens |
| `test/provider/openai-responses-cache.recorded.test.ts` — cache write/read | 1 | .143 | 54 | keep A; mandatory golden/cache |
| `test/provider/openai-responses-images.recorded.test.ts` — image generation | 1 | .142 | 67 | keep A; mandatory golden |
| `test/provider/openai-responses.test.ts` — Responses protocol/cache family gates | 131 | .150 | 3160 | keep A + E; all eleven errors and cache/usage/replay rows retained |
| `test/provider/openrouter.test.ts` — OpenRouter wire rules | 13 | .133 | 352 | keep A |
| `test/provider/runpod.test.ts` — Ollama, vLLM, worker selection | 29 | 4.172 | 397 | keep A |
| `test/provider/xai-images.recorded.test.ts` — image goldens | 2 | .138 | 55 | keep A; mandatory goldens |
| `test/provider/xai-images.test.ts` — image wire rules | 2 | .082 | 109 | keep A |
| `test/provider/zai-images.recorded.test.ts` — image golden | 1 | .124 | 32 | keep A; mandatory golden |
| `test/provider/zai-images.test.ts` — image wire rules | 3 | .087 | 130 | keep A |
| `test/response.test.ts` — response reducer | 6 | .081 | 113 | keep A |
| `test/route.test.ts` — route options | 1 | .083 | 43 | keep A |
| `test/schema.test.ts` — LLM schema/Usage | 13 | .087 | 162 | keep A; mandatory usage |
| `test/sse-framing.test.ts` — SSE boundaries | 5 | .087 | 130 | keep A |
| `test/tool-runtime.test.ts` — LLMClient tools | 24 | .146 | 818 | keep A |
| `test/tool-schema-projection.test.ts` — provider projections | 20 | .129 | 528 | keep A |
| `test/tool-stream.test.ts` — tool delta rules | 8 | .082 | 193 | keep A |
| `test/transport-attempt.test.ts` — observation/transport failure | 5 | .135 | 214 | keep A; real TCP case retained |
| `test/websocket-transport-lifecycle.test.ts` — WebSocket lifecycle | 9 | .196 | 414 | keep A |

### Server — all65 executed cases and both unrun browser suites

| Suite/case-group | Cases | Wall s | Decision |
| --- | ---: | ---: | --- |
| `test-integration/authentication.test.ts` — lifecycle/application URL credentials | 1 | .543 | keep F; auth trust boundary |
| `test-integration/browser-connect.test.ts` — pairing/restart/exact origin | 2 | 1.565 | keep F; transport fixtures, not live Chrome |
| `test-integration/browser-owned-chrome.test.ts` — pairing, stopped worker recovery,2 parameterized indicator/lease/expiry groups | unrun | unrun | keep F; environment gate |
| `test-integration/isolated-browser.test.ts` — authenticated lifecycle, Location/ref fences, stopped restart, parameterized Session disposal | unrun | unrun | keep F; environment gate |
| `test-integration/keep-awake.test.ts` — owned OS assertion lifecycle | 1 | 1.415 | keep F |
| `test-integration/project-inventory.test.ts` — paging/forget flow | 1 | .581 | keep F |
| `test-integration/provider-refresh.test.ts` — late project config refresh | 1 | .838 | keep F |
| `test-integration/usage.test.ts` — retained historical usage | 1 | .538 | keep F; mandatory usage |
| `test/auth.test.ts` — fixed user/header-only authentication | 3 | .088 | keep H; auth trust boundary |
| `test/cors.test.ts` — supported-origin CORS policy | 2 | .041 | keep H |
| `test/event-feed.test.ts` — replay/fan-out/lifetime | 5 | .191 | keep H |
| `test/guardrail.test.ts` — ownership/output/registration | 2 | .412 | keep H + R |
| `test/keep-awake.test.ts` — API state/lifetime | 3 | .786 | keep H |
| `test/location-inventory.test.ts` — active Location inventory | 1 | .665 | keep H |
| `test/project-artifact-handler.test.ts` — refresh failure/order, sanitized errors, Store routes | 4 | .429 | keep H + R |
| `test/provider-usage.test.ts` — normalized refresh/output/routes | 2 | .440 | keep H + R; mandatory usage |
| `test/pty-connect.test.ts` — owned PTY connection | 3 | .821 | keep H |
| `test/remote-contract.test.ts` — local authenticated controls | 1 | .429 | keep H; mandatory ownership/security |
| `test/remote.test.ts` — remote response/state forwarding | 1 | .426 | keep H; mandatory security |
| `test/request-tracing.test.ts` — bounded private request diagnostics | 1 | .048 | keep H |
| `test/service-status.test.ts` — service lifecycle responses | 4 | .075 | keep H |
| `test/session-autonomy.test.ts` — decode/forward/failure/deferred settlement | 4 | .434 | keep H + M |
| `test/session-daybreak.test.ts` — selected program/typed failure | 2 | .430 | keep H + M |
| `test/session-location.test.ts` — Session/parent scope, usage/skills/subagent declarations, cursor/404/compact source gates | 7 | .424 | keep H + R |
| `test/session-model-switch.test.ts` — blocked/error/deferred success | 3 | .417 | keep H + M |
| `test/session-skill-conflict.test.ts` — conflict routes/failures | 2 | .429 | keep H |
| `test/session-snapshot.test.ts` — bounded window/watermark/attachment | 2 | .417 | keep H + M |
| `test/session-usage-report.test.ts` — Session lifetime/errors/export/Location | 3 | .424 | keep H + M; mandatory usage |
| `test/usage.test.ts` — global usage decode/forwarding/export | 3 | .418 | keep H; mandatory usage |
| new `test/project-artifact-refresh.test.ts` —18 operation routes plus scope, sanitized failure and global preview-before-confirmation | 22 | final ledger | rewrite H; replaces the two mapped source groups |
| new `test/session-http.test.ts` — invalid cursors, skills404, compact conflict and settled result | 4 | final ledger | rewrite H; replaces three mapped source groups |
| new `test/session-http.ts` — shared router/mocks/disposal/epoch | helper | n/a | merge M; consumed by seven HTTP suites |

### Schema — all109 mandatory contract cases

| Suite/case-group | Cases | Wall s | Decision |
| --- | ---: | ---: | --- |
| `test/browser.test.ts` — selected-tab contract | 6 | .048 | keep S |
| `test/compatibility.test.ts` — schema construction contract | 1 | .045 | keep S |
| `test/contract-hygiene.test.ts` — identifiers/defaults/epochs/current shapes | 13 | .083 | keep S + R |
| `test/event-manifest.test.ts` — public event inventory | 12 | .090 | keep S |
| `test/event.test.ts` — event schemas | 4 | .048 | keep S |
| `test/guardrail.test.ts` — decisions/replies/status/events | 4 | .045 | keep S |
| `test/isolated-browser.test.ts` — isolated lifecycle contract | 3 | .046 | keep S |
| `test/mcp.test.ts` — resources | 2 | .048 | keep S |
| `test/model.test.ts` — model references | 2 | .077 | keep S |
| `test/project-artifact.test.ts` — lifecycle/identity/content boundaries | 6 | .073 | keep S |
| `test/prompt.test.ts` — Base64 boundary rows | 25 | .134 | keep S |
| `test/provider-request.test.ts` — request overlays/cache/options | 7 | .087 | keep S |
| `test/pty.test.ts` — owned terminal contract | 3 | .046 | keep S |
| `test/session-cache-diagnostics.test.ts` — cache telemetry | 5 | .082 | keep S; mandatory cache |
| `test/session-error.test.ts` — typed failures | 5 | .079 | keep S |
| `test/session-orchestration.test.ts` — durable child task shapes | 7 | .080 | keep S |
| `test/session-todo.test.ts` — todo contract | 2 | .048 | keep S |
| `test/shell.test.ts` — shell result contract | 2 | .047 | keep S |

### Protocol — all38 mandatory contract cases

| Suite/case-group | Cases | Wall s | Decision |
| --- | ---: | ---: | --- |
| `test/browser.test.ts` — browser operations | 3 | .140 | keep P |
| `test/event.test.ts` — manifests/source epoch/errors | 4 | .136 | keep P |
| `test/isolated-browser.test.ts` — isolated operations | 1 | .147 | keep P |
| `test/project-artifact.test.ts` — managed operations/scope/confirmation | 5 | .135 | keep P + R |
| `test/pty.test.ts` — PTY operations | 3 | .138 | keep P |
| `test/session-archive.test.ts` — archive route/response | 1 | .145 | keep P |
| `test/session-autonomy.test.ts` — closed mode/goal/update shape | 5 | .150 | keep P |
| `test/session-completions.test.ts` — bounded completion feed | 1 | .141 | keep P |
| `test/session-cursor.test.ts` — cursor round-trip | 1 | .083 | keep P |
| `test/session-daybreak.test.ts` — Daybreak route/schema | 3 | .143 | keep P |
| `test/session-diagnostics.test.ts` — diagnostics shape | 1 | .132 | keep P |
| `test/session-orchestration.test.ts` — subagent paging/control | 2 | .089 | keep P |
| `test/session-outstanding.test.ts` — outstanding work | 1 | .132 | keep P |
| `test/session-pin.test.ts` — pin route/response | 1 | .089 | keep P |
| `test/session-skill-conflict.test.ts` — skill conflict controls | 1 | .090 | keep P |
| `test/session-snapshot.test.ts` — bounded snapshot/attachment | 2 | .149 | keep P |
| `test/session-usage-report.test.ts` — report/export contract | 2 | .139 | keep P; mandatory usage |
| `test/usage.test.ts` — global usage | 1 | .085 | keep P; mandatory usage |

### Client — all75 mandatory contract cases

| Suite/case-group | Cases | Wall s | Decision |
| --- | ---: | ---: | --- |
| `test/contract-identity.test.ts` — canonical schema identity | 2 | .135 | keep C |
| `test/effect.test.ts` — typed Effect transport/response/error flows | 8 | .200 | keep C |
| `test/file-change-summary.test.ts` — projected file summaries | 10 | .013 | keep C |
| `test/import-boundaries.test.ts` — real public-entrypoint bundle graph | 1 | .082 | keep C |
| `test/isolated-browser.test.ts` — generated lifecycle/control client | 4 | .138 | keep C |
| `test/owned-browser.test.ts` — owned-browser client contract | 3 | .011 | keep C |
| `test/promise-service.test.ts` — real service startup/stop/failure | 5 | 9.235 | keep C; process flow |
| `test/promise.test.ts` — Promise requests/events/errors | 30 | .250 | keep C |
| `test/service.test.ts` — real concurrent service lifetime/replacement | 12 | 36.080 | keep C; process flow |

Client file/process waits and negative lifetime windows are retained as current real-process contracts, not deleted merely because they use timers. The baseline has zero failures. No claim is made that all temporal waits across the lane have been converted or proven against every scheduler load.

### CodeMode — all969 execution/catalog/confinement case rows

| Suite/case-group | Cases | Wall s | Decision |
| --- | ---: | ---: | --- |
| `test/array-callbacks-test262.test.ts` — callback semantics/regressions | 45 | .190 | keep X |
| `test/array-core-test262.test.ts` — core array semantics | 48 | .209 | keep X |
| `test/callbacks.test.ts` — callable references/constructors/sort/map/thisArg/rejection | 35 | .196 | keep X |
| `test/codemode.test.ts` — host failure/observation/console/output budgets/schema/public contracts | 52 | .434 | keep X |
| `test/date-test262.test.ts` — setters/default primitive | 8 | .201 | keep X |
| `test/enumeration.test.ts` — Object.keys/tools/arrays/for-in | 14 | .208 | keep X |
| `test/groupby-test262.test.ts` — Object/Map grouping | 8 | .198 | keep X |
| `test/lexical-test262.test.ts` — TDZ/loop/switch/parameter environments | 9 | .183 | keep X |
| `test/openapi.test.ts` — real adapter generation/wire serialization/security/skips | 41 | .243 | keep X; trust/contract boundary |
| `test/parity.test.ts` — property/spread/typeof/scope/void/delete/numeric/undefined/Error/assignment/destructuring/coercion boundaries | 104 | .247 | keep X |
| `test/promise-test262.test.ts` — statics/async/await/any/AggregateError/construction | 74 | .249 | keep X |
| `test/promise.test.ts` — values/boundaries/combinators/timeouts/chaining/settlement/unsupported surface/construction | 84 | 1.275 | keep X |
| `test/regexp-math-test262.test.ts` — RegExp/precise sum | 11 | .198 | keep X |
| `test/set-methods-test262.test.ts` — composition/relation/set-like validation | 14 | .199 | keep X |
| `test/signature.test.ts` — schema catalog rendering/non-identifier keys/unions/JSDoc/paths | 24 | .199 | keep X |
| `test/stdlib.test.ts` — Number/Math/Date/RegExp/URL/URI/Map/Set/checkpoint interactions | 90 | .256 | keep X |
| `test/string-core-test262.test.ts` — core String boundaries | 130 | .260 | keep X |
| `test/string-regexp-test262.test.ts` — String/RegExp boundaries | 72 | .197 | keep X |
| `test/string-search-test262.test.ts` — search/extraction boundaries | 90 | .199 | keep X |
| `test/tool-paths.test.ts` — dotted/callable/blocked/empty/collision paths | 16 | .188 | keep X; confinement boundary |

### Plugin — all8 public contract cases

| Suite/case-group | Cases | Wall s | Decision |
| --- | ---: | ---: | --- |
| `test/contract-identity.test.ts` — facade/schema identity | 3 | .083 | keep G |
| `test/package-exports.test.ts` — real package export manifest | 1 | .083 | keep G |
| `test/tool.test.ts` — tool definitions/schema conversion/execution | 4 | .089 | keep G |

## Probe and final validation ledger

All probes used `bun test --cwd packages/<package> <named-file(s)> --reporter=junit --reporter-outfile=<evidence>/<probe>.xml --only-failures`; filters listed below used `--test-name-pattern=<filter>`. Each command had8192 MiB shell cap and20s timeout. An expected mutation failure is not a passing suite. Restore each exact patch before continuing; no wholesale checkout. Final production diff is empty relative to `1141158a`.

| Probe evidence stem | Exact production mutation | Retained assertion / observed result |
| --- | --- | --- |
| `probe-ai-error-details` | ai/src/protocols/openai-responses.ts:1423 replace providerErrorMessage with fixed missing-details text | Responses file, filter `classifies`: all11 retained error scenarios fail; exit1,0 pass,120 filtered |
| `probe-schema-any-mutable2` | schema/src/agent.ts:16 Name uses Any; schema/src/project.ts:72 sandboxes uses mutable array wrapper | contract-hygiene file, filter `current exported contracts`: AST violation assertion contains both Any and mutable; exit1,1 fail,12 filtered |
| `probe-protocol-legacy-client` | protocol/src/client.ts:36 add selfImprovement client group mapping | project-artifact file, filter `self-improvement`: groupNames absence assertion fails; exit1,1 fail,4 filtered |
| `probe-protocol-legacy-endpoint` | protocol/src/groups/project-artifact.ts artifact.list path becomes `/api/self-improvement` | same filter: actual endpoint manifest assertion fails; exit1,1 fail,4 filtered |
| `probe-server-retained-groups` | server guardrail handler swallows RequestNotFoundError; providerUsage.list drops refresh; Session subagent bypasses parent cursor check; skills uses orDie; compact resource uses Session ID; artifact refresh helper drops refresh | guardrail/provider-usage/session-http/project-artifact-refresh files: unrelated reply204≠404, lost refresh input, cross-parent500≠400, skills500≠404, wrong compact resource and all11 committed mutations missing refresh; exit1,16 fail,10 pass |
| `probe-artifact-target-scope-enable` | artifact.get uses wrong artifact ID; update omits server project ID; disable dispatches enable | project-artifact-refresh: exact target input, scope input and named Store-operation assertions fail; exit1,3 fail,17 pass |
| `probe-artifact-repeat` | refreshAfterProjectArtifactMutation omits refresh | project-artifact-handler, filter `committed mutation`: first surviving Store-before-refresh assertion catches removal despite deduplicated second success; exit1,1 fail,1 filtered |
| `probe-global-confirmation` | global create/update bypass preview condition and commit immediately | project-artifact-refresh, filter `global artifact`: both expected confirmation-preview responses fail; exit1,2 fail,20 filtered |

Excluded probe attempt: `probe-schema-any-mutable` applied mutable to a Struct instead of an Array, causing import-time TypeError. It did not reach the behavioral assertion and is **not** mutation evidence. Restore it exactly, then use the valid array probe above. Excluded setup failures while authoring: Protocol dotted toHaveProperty key, plain Guardrail Class-shaped fake, omitted required artifact-list scope, partial metrics expectation, class-vs-encoded Snapshot matcher. Resolved against canonical runtime/schema values; no production change or contract weakening. Server initial package types exited2 for new fixture request Context and Compact overload mismatch; final fixtures preserve the actual Context and both Core overload signatures; rerun exits0.

### Final stability, type and lint results

- Three separate-Bun-process repetitions of all14 touched suites: **198 pass,0 fail,0 skip** each. Ten unchanged final inputs reuse `isolated-{1,2,3}.json`; four later-changed files (AI Responses, artifact helper dedupe, new artifact HTTP, new Session HTTP) use `final-isolated-{1,2,3}.json`. Merged per-file wall sums: **4.949 /5.219 /4.914 seconds**. Isolation means one fresh Bun process per file, not an exclusive host or performance benchmark.
- First measured loaded run: `loaded-types-final.json`,14 suites,198 pass/0 fail; every file interval overlaps a sequential local package typecheck from `types.json`. Typecheck interval03:16:51.573716–03:17:01.612378Z. Two new Server fixture typing fixes invalidated their final-source evidence; `loaded-types-fixed.json` reruns those two final files:26 pass/0 fail,1.124s combined,03:21:35.817652–03:21:36.941331Z, both overlap final successful Server typecheck (3.820s). Remaining12 final files retain the prior measured loaded evidence.
- Earlier `loaded-parent-final` phase at03:13:00–05Z **did not overlap** parent's03:12:23–42Z typecheck and is not counted as loaded. `loaded-cli` phase has unconfirmed overlap and is not counted. No inflated loaded-run claim.
- Exact package commands `bun run --cwd packages/<package> typecheck`: ai exit0(.938s; both tsgo configs), schema exit0(.295s), protocol exit0(1.496s), client exit0(1.380s), codemode exit0(.127s), plugin exit0(1.472s); Server final exit0(3.820s), after initial exit2(4.330s) and a successful fixed rerun. No root typecheck or root lint run by this lane.
- Final touched lint: `git diff --name-only | grep '\.test\.ts$' | xargs node_modules/.bin/oxlint` before staging:12 files,0 errors/0 warnings, exit0; `node_modules/.bin/oxlint packages/server/test/session-http.ts packages/server/test/session-http.test.ts packages/server/test/project-artifact-refresh.test.ts`:3 files,0 errors/0 warnings, exit0. New-helper `prettier --check` exits0. `git diff --check` exits0. No lint waivers, hooks bypasses, generated changes, dependencies, migrations, push or deployment.

### Before/after counts and timing

| Package | Suite files before→after | Registered measured cases before→after | Suite lines before→after |
| --- | ---: | ---: | ---: |
| ai | 50→50 | 673→673 | 17,521→17,424 |
| server | 29→31 | 65→85 | 4,780→4,976 |
| schema | 18→18 | 109→109 | 1,855→1,866 |
| protocol | 18→18 | 38→38 | 973→975 |
| client | 9→9 | 75→75 | 2,215→2,215 |
| codemode | 20→20 | 969→969 | 12,669→12,669 |
| plugin | 3→3 | 8→8 | 195→195 |
| Total | 147→149 | 1,937→1,957 | 40,208→40,320 |

The new shared helper adds72 non-suite lines. Registered totals include28 retained recorded skips and exclude12 statically declared unrun browser cases (six per suite). Including these unexecuted declarations gives1,949→1,969 scheduled cases, not verified passing cases. Final area evidence combines1,731 unchanged baseline passes with198 final changed-suite passes =1,929 passing cases;28 remain skipped. No final all-package rerun was performed.

Affected files:12 original suites/178 cases/4.195s baseline →14 suites/198 cases/4.949,5.219,4.914s final separate-file runs. Whole-area baseline separate-file wall sum78.891s; no independently measured final whole-area wall total. Lines/cases grew where source-only or invalid-fake checks became real HTTP contract guards; there is no count target or claimed speedup. All AI error permutations and all mandatory contract/cache/usage/security/recorded cases survive.

### Coherent completed commits and handoff

- `30439b57` — `test(ai): consolidate Responses stream error scenarios` (AI only; all131 cases retained).
- `174a8765` — `test(contracts): replace source checks with executable assertions` (Schema/Protocol; public production contracts unchanged).
- `f9da65ca` — `test(server): replace source gates with HTTP boundary coverage` (HTTP guards, shared Session fixture, safe success dedupe).

Lane working tree is clean. Original-root inventory remains uncommitted; named preservation stash remains retained. Parent owns rebasing/integrating onto its moved base and root AGENTS/validation. No permanent production changes, real production RED, changed public contract, missing surviving guard or runtime defect was discovered in this reconciliation. Remaining limitations:28 recorded skips,12 unrun browser cases and unchanged timer/process suites without universal scheduler-load proof. This inventory and these coherent slices do **not** establish all SL finished.

## AC15 completion pass (lane `ai-contracts`, base `d30e97bf`)

Scope re-verified against the live checkout: `packages/{ai,codemode,server,schema,protocol,client,plugin}`; remaining packages and `script/*.test.ts` are in `remaining.md`; Client in `client.md`. Every suite file in these packages is classified in the tables above; the live per-file JUnit counts equal the table counts for every file (ai 673, codemode 969, server 85 executed plus 12 browser cases, schema 109, protocol 38, client 75, plugin 8).

CodeMode coverage: the historical "~580" estimate in `tracking.md` predates `test.each` expansion. Live JUnit registers 969 cases in 20 files, matching the CodeMode table row by row, so every CodeMode case is classified (`keep X`). No CodeMode source-text or mock-call-only case exists; Test262 rows are distinct boundary inputs.

### Baseline at `d30e97bf` (per-file JUnit, batched invocations through the lane wrapper)

| Package | Files | Registered | Pass | Skip | Fail | Suite lines | Summed JUnit seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ai | 50 | 673 | 645 | 28 | 0 | 17,429 | 8.196 |
| codemode | 20 | 969 | 969 | 0 | 0 | 12,669 | 4.877 |
| server | 31 | 97 | 84 | 1 | 12 | 4,976 | 14.958 |
| schema | 18 | 109 | 109 | 0 | 0 | 1,866 | 0.672 |
| protocol | 18 | 38 | 38 | 0 | 0 | 975 | 0.901 |
| client | 9 | 75 | 75 | 0 | 0 | 2,215 | 48.250 |
| plugin | 3 | 8 | 8 | 0 | 0 | 195 | 0.181 |

Seconds are JUnit in-process suite times, not process wall time, on a host shared with other lanes. Server: the 12 failures are the two environment-blocked browser suites below; the skip is `test-integration/keep-awake.test.ts` (`skipIf` not macOS).

Environment-blocked, not passing: `server/test-integration/isolated-browser.test.ts` (6 cases) returns `ServiceUnavailableError: Isolated browser requires macOS arm64` on this Linux x64 host. `server/test-integration/browser-owned-chrome.test.ts` (6 cases) requires `YCODING_TEST_ISOLATED_BROWSER_CHROME`; with the available Playwright Chromium 141 (below the required Chrome 152, not Chrome for Testing, running as root) every case fails at launch with `Chrome control pipe failed`. Both remain release gates on macOS arm64; neither was edited.

### Timing waits (G10) in scope

| File / case | Wait | Decision |
| --- | --- | --- |
| `codemode/test/promise.test.ts` — timeout interrupts forked fibers; timeout interrupts `Promise.all` | 100 ms real timeout raced interpreter progress | rewrite: `TestClock`, advanced 100 ms only after both pending calls start; all assertions unchanged |
| `codemode/test/promise.test.ts` — invalid returned data cancels pending work; race loser cannot hold execution | 100 ms safety timeout that must not fire | rewrite: 10 s safety limit; a held loser or an uncancelled call still fails the same assertions |
| `codemode/test/promise.test.ts` — two stubborn completion-cleanup cases | real 100 ms timeout during 400 ms cleanup | keep real clock: under `TestClock` execution settled as soon as cleanup began and never reported the timeout, so the clock cannot model this cleanup; the program returns in microseconds of a 100 ms window |
| `codemode/test/codemode.test.ts` — timeout interrupts a busy loop | elapsed < 3 s for a 200 ms timeout | keep: regression on real-timer interruption of a CPU-bound fiber; 15x margin |
| `server/test-integration/browser-connect.test.ts` — shared tab listing | state poll, 20 x 10 ms | rewrite: same state poll bounded at 500 attempts (5 s) |
| `server/test-integration/provider-refresh.test.ts`, `keep-awake.test.ts` | state polls bounded at 5 s / 60 s | keep: poll actual state |
| `ai/test/transport-attempt.test.ts` — socket reset | server resets 10 ms after writing | keep: loopback data precedes the RST on one connection; correct client behavior does not depend on the delay |
| `server/test-integration/isolated-browser.test.ts`, `browser-owned-chrome.test.ts` | fixed sleeps and real-time expiry windows | not changed: environment-blocked here, cannot be stability-verified |

### Mutation probes (this pass)

Each mutation was applied to the production line, the named retained test ran, then the file was restored with `git checkout -- <file>`; production diff is empty.

| Production line | Mutation | Retained test result |
| --- | --- | --- |
| `codemode/src/interpreter/execute.ts:80` | timeout result kind `TimeoutExceeded` -> `TimeoutProbe` | both `TestClock` timeout cases fail |
| `codemode/src/interpreter/promises.ts:76` | completion awaits instead of interrupting active promises | "a non-settling race loser cannot hold the execution to the timeout" fails after the 10 s limit with the timeout warning |
| `codemode/src/interpreter/promises.ts:75` | skip the completion interrupt loop | not detected: scope close still interrupts; recorded as an ineffective probe, superseded by the two rows around it |
| `codemode/src/interpreter/execute.ts:66` | scope release no longer closes the scope | "invalid returned data cancels pending work" fails (`interrupted` 0, expected 1) |

### Changes in this pass

- `test(codemode): drive pending-call timeouts with TestClock` — `promise.test.ts`, 84 cases retained.
- `test(server): bound the shared-tab poll by attempts that survive load` — `browser-connect.test.ts`, 2 cases retained.
- Client service changes are recorded in `client.md`.

### Stability and final checks (this pass)

Touched files, each run as its own `bun test --cwd <package> <file> --timeout 30000` through the lane wrapper:

| File | Cases | Isolated 1 / 2 / 3 (JUnit s) | Loaded (JUnit s, overlapping a forced root typecheck) |
| --- | ---: | --- | --- |
| `client/test/service.test.ts` | 12 | 37.890 / 37.843 / 37.855, 0 fail | 39.592, 0 fail |
| `codemode/test/promise.test.ts` | 84 | 1.604 / 1.618 / 1.623, 0 fail | 3.171, 0 fail |
| `server/test-integration/browser-connect.test.ts` | 2 | 3.285 / 3.179 / 3.308, 0 fail | 9.828, 0 fail |

Package typechecks `bun run --cwd packages/{client,codemode,server} typecheck`: exit 0 each. `oxlint` on the four touched test/fixture files: exit 0, 0 warnings, 0 errors. `bun run lint:effect-patterns`: exit 0. Prettier check on touched files: clean.

### Before / after (this pass)

| Package | Files | Cases | Suite lines | Summed JUnit s (touched file) |
| --- | --- | --- | --- | --- |
| client | 9 -> 9 | 75 -> 75 | 2,215 -> 2,229 (fixture 84 -> 86) | service 36.399 -> 37.9 |
| codemode | 20 -> 20 | 969 -> 969 | 12,669 -> 12,681 | promise 1.857 -> 1.62 |
| server | 31 -> 31 | 97 -> 97 (85 executed) | 4,976 -> 4,976 | browser-connect 1.275 (batched) -> 3.3 (isolated) |
| ai, schema, protocol, plugin | unchanged | unchanged | unchanged | unchanged |

No case was deleted or merged in this pass; the changes replace timing windows with event or clock-driven waits. No production defect was found; production diff is empty.
