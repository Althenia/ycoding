# Repository agent guide

## Repository identity and direction

- This repository is the YCoding product and source of truth.
- YCoding is licensed under AGPL-3.0-only (`LICENSE`); keep every workspace `package.json` `license` field set to `AGPL-3.0-only`, and keep the upstream MIT notice in `NOTICE` intact.
- The default branch is `main`.
- Maintain one current runtime. Do not restore removed session, configuration, plugin, SDK, package, event, or TUI compatibility paths unless the user explicitly requests a migration design.
- The TUI is the primary product, release, and behavior surface.
- Maintain `apps/web` as a SolidJS/Vite presentation client and curated public site; keep execution in the local runtime. Keep Core and Server imports out of browser code.
- Use `packages/remote` for the closed remote transport contract; enforce authenticated user/device ownership before forwarding controls. Starting the local remote connector explicitly grants the owner access to every existing and future Session on that backend; resolve Session Locations from the backend, never from browser input.
- Publish user-facing content only. Do not automatically publish engineering `docs`, internal topology, task plans, or private configuration into the web build.
- Durable sessions, explicit autonomy, durable background subagents, session skills, project artifacts, Session-wide guardrails, provider-efficient caching, and normalized provider usage are current product contracts.
- Historical upstream material never overrides current code, tests, Schema, Protocol, or root `docs`.

Read [`docs/README.md`](./docs/README.md), [`docs/product-direction.md`](./docs/product-direction.md), and the relevant package-level `AGENTS.md` before changing cross-package behavior.

## Authority and verification

Use this authority order when sources disagree:

1. Current executable behavior and targeted tests.
2. Public shapes and durable events in `packages/schema`.
3. HTTP operations and middleware placement in `packages/protocol`.
4. Runtime behavior and persistence in `packages/core`.
5. Current YCoding documentation in `docs` and current contracts in `specs`.
6. Package-local `AGENTS.md` guidance.
7. Generated clients and OpenAPI output, which must match Protocol.
8. Upstream documentation, upstream source, old plans, and historical notes.

Treat user-supplied paths, symbols, line numbers, root causes, and behavior claims as hypotheses. Verify them against the live checkout before building on them. When a premise is false, state the correction with evidence and continue on the corrected premise.

Do not present an assumption, planned command, or unrun test as a result. Preserve unrelated user changes in the working tree.

## Design rules

- Before any visual change to the web app, the TUI, the Chrome extension, the Meeting live page, or brand assets, read the nearest `DESIGN.md` and its `extends` chain: root [`DESIGN.md`](./DESIGN.md), then [`apps/web/DESIGN.md`](./apps/web/DESIGN.md), [`packages/tui/DESIGN.md`](./packages/tui/DESIGN.md), [`extensions/chrome/DESIGN.md`](./extensions/chrome/DESIGN.md), or [`extensions/meeting/view/DESIGN.md`](./extensions/meeting/view/DESIGN.md). Their approved rules bind every agent and model; code that disagrees is a defect or a recorded exception, never a new rule.
- Map every visible element to a documented token or component. Add or change the rule first, then update code, tests, and the owning `DESIGN.md` in the same change. Never leave a user-agent or library default view or behavior unowned; forced-colors system rendering is the standing accessibility exception.
- `apps/web/src/styles/design-md.test.ts` (in `bun run test:web`), `packages/tui/test/design-md.test.ts` (in the TUI test script), `extensions/chrome/test/design-md.test.js` (in `bun run test:extension`), and `extensions/meeting/test/view-design.test.ts` (in `bun run --cwd extensions/meeting test:unit`) fail when documented token values drift from `apps/web/src/styles/tokens.css`, the default `ycoding` theme, `extensions/chrome/indicator.js`, or the Meeting live page stylesheet. Run them with the affected package tests. Lint every changed chain file with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint <file> --strict`.

## Documentation requirements

Update documentation in the same change when behavior changes.

- Product direction or supported surfaces: update root `README.md` and `docs/product-direction.md`.
- Package ownership or dependency direction: update `docs/architecture.md`.
- Session, autonomy, subagent, skill, project-artifact, cache, or transcript behavior: update `docs/runtime.md`.
- Runtime, CLI/TUI, service, provider, MCP, permission, or environment configuration: update `docs/configuration.md`.
- Agent, command, skill, plugin, hook, tool, theme, instruction, or repository-resource discovery: update `docs/repository-resources.md`.
- Public API or schema: update the relevant `specs` contract and regenerate clients/OpenAPI through the owning command.
- Contributor invariants or required verification: update this file or the relevant package `AGENTS.md`.
- Visual design, brand, marks, tokens, components, motion, or UI rules on any surface: update the owning `DESIGN.md` in the chain in the same change.

- Write product documentation as specifications of current behavior, configuration, interfaces, constraints, and examples.
- Describe the current contract directly; omit change-history narration such as “no longer uses,” “previously,” or “has been removed.” Keep migration instructions and release history in their dedicated documents.
- Do not add implementation-status banners, progress labels, delivery ledgers, or test-run tracking to product documentation. Keep delivery evidence and unfinished work in the task's tracking artifacts.
- State functional limitations in the relevant specification section. Never present proposals, historical plans, or unverified behavior as current capabilities; keep proposals separate from current product guides.

## Generated content and dependency boundaries

- After changing the public Protocol or Server `HttpApi`, run the client package's owning generation command and verify generated output.
- Do not edit generated client output directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server.
- Client runtime code may depend on Schema and Protocol but never Core or Server; SDK composition may combine public client-facing packages without making Client depend on Server.
- Use the owning tool or documented regeneration path for generated, vendor, lock, cache, migration-generated, and tool-managed content.
- In `src/config`, follow the existing self-export pattern at the top of the file, for example `export * as ConfigAgent from "./agent"`, when adding a config module.

## Branch names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Release practices

- TUI and web share one release version and one nonempty note at `docs/releases/v<version>.md`.
- When preparing a release, add its user-facing changes to `apps/web/src/content/changelog.ts` in newest-first order and update the changelog test; include every version since the last listed release using its `docs/releases/v<version>.md` note as evidence.
- CI installs Bun dependencies cold, without an Actions dependency cache: on every release runner, a cold `bun install` measured faster than restoring the cache plus a warm install. Measure both paths on each runner before adding a dependency cache. On Windows, `BUN_INSTALL_CACHE_DIR` keeps Bun's cache on the runner's workspace disk.
- The release workflow (`release.yml`) triggers on `push` to `v<version>` tags. Its `verify-source` suite legs (types, web, remote, CLI with the Chrome extension unit suite, TUI, and separate isolated-browser and source/packaged Chrome extension integration legs on macOS arm64) run in parallel with the native builds. Packaging and the packaged isolated-browser smoke each wait for the builds and run in parallel; web deploys to Cloudflare only after every source verification leg, packaging, and the packaged isolated-browser smoke succeed, and one TUI GitHub Release with the note and native assets is created only after deployment succeeds. Add new release checks to a `verify-source` leg so deployment stays gated on them. Configure `CLOUDFLARE_API_TOKEN` as a GitHub Actions secret for deployment. macOS builds import the release signing identity from the `YCODING_MACOS_SIGNING_P12` (base64 PKCS#12) and `YCODING_MACOS_SIGNING_PASSWORD` Actions secrets into a temporary keychain, restore the keychain search list and delete that keychain afterwards, and sign the computer-use app as `YCoding Code Signing`; a missing secret fails the build with no ad-hoc fallback, and staging verifies the signature and that its designated requirement names the certificate fingerprint pinned as `YCODING_MACOS_SIGNING_SHA1` in `release.yml`. Release archives contain only the entries installed updaters accept (`ycoding`, `ycoding-chrome-extension`, and on macOS the app) and the packaging step fails on any other top-level entry; `LICENSE` and `NOTICE` are attached to the release as separate assets. `ycoding update` and `script/install.sh` require only the files a version needs and skip other entries, but releases already installed do not, so never add an archive entry at any depth: v0.7.13 through v0.7.15 reject every entry outside their exact list, including files inside `ycoding-chrome-extension` (the four icons, `manifest.json`, `popup.css`, `popup.html`, `popup.js`, `protocol.js`, and `service-worker.js`), so `packages/cli/script/chrome-extension.ts` bundles new extension source modules into `service-worker.js` and keeps `BrowserExtension.files` equal to that list. Manual runs prepare assets without publishing or deploying.

## Commits and PR titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, for example `core`, `tui`, `cli`, `server`, `sdk`, `plugin`, or `ai`.

Examples: `fix(tui): hide unresolved transcript rows`, `docs: document runtime`, `chore(client): regenerate clients`.

## Style guide

### General principles

- Solve the verified requirement or root cause with the smallest complete change.
- Keep things in one function unless logic is composable or reusable.
- Do not extract single-use helpers preemptively. Inline logic unless a helper is reused, hides a genuinely complex boundary, or names a real concept that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, identify the concrete failure mode, likelihood, and complexity cost. Do not silently expand scope for theoretical robustness.
- Avoid `try`/`catch` where possible.
- Avoid the `any` type.
- Use Bun APIs when possible, such as `Bun.file()`.
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless required for exports or clarity.
- Prefer functional array methods such as `flatMap`, `filter`, and `map` over loops; use type guards on filters to preserve downstream inference.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Add comments for non-obvious constraints and surprising behavior, not obvious assignments or control flow.

Reduce total variable count by inlining a value used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports such as `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@ycoding-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules used only in selected paths, especially startup-sensitive entrypoints.
- Destructure dynamic-import bindings near the top of the narrowest scope that needs them so they read like normal imports.
- Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`.
- Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  // ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept such as `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they perform effectful work. Synchronous parsing, validation, and option building stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` for untrusted JSON strings.

### Schema definitions with Drizzle

Use snake_case field names so column names do not need string overrides.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing and completion evidence

- Use test-driven development for behavior changes and bug fixes: write the focused regression test, observe the expected failure, implement the smallest fix, then rerun targeted and neighboring suites.
- Avoid mocks as much as possible. Do not use `globalThis.*` unless no realistic alternative exists.
- Test actual implementation behavior; do not duplicate production logic in tests.
- Keep tests that guard a required contract, documented rule, trust boundary, reproduced regression, cross-component flow, rendered behavior, or design drift. Map retained behaviors to surviving assertions before merging or deleting cases; mutation-probe each removed required group, preserve release and contract gates, and replace success-path sleeps with deterministic completion signals.
- The root `bun test` script intentionally fails. Run tests from the affected package or with an explicit package working directory.
- Unit tests verify requests, responses, branching, ordering, processing, and state transitions with mocked external boundaries while running the implementation under test. Real browsers, listening servers, and packaged executables belong to explicitly named integration/E2E suites and commands, not unit-test commands. Preserve both kinds of evidence; never describe a mixed package-wide suite as unit-only.
- Browser service/tool and dialog unit checks run with `bun run test:unit:browser`; real Core/Server/TUI browser checks run separately with `bun run test:integration:browser` on macOS arm64 with installed Chrome 152 or newer. The latter fails when its required environment is unavailable. Schema/Protocol/Client contract suites remain separate affected-package checks. Chrome extension unit and design-drift checks run with `bun run test:extension`; its real Chrome for Testing suite runs with `bun run test:integration:extension` and `YCODING_TEST_ISOLATED_BROWSER_CHROME` set to a Chrome for Testing executable (branded Chrome ignores `--load-extension`), and headless Chrome proves neither native tab-strip pixels nor the debugger infobar or native Cancel.
- After changing the macOS computer-use app or its permission requests, rebuild it with `bun run build:computer-use`. With `YCODING_MACOS_SIGNING_IDENTITY` set to your own stable code-signing identity, existing privacy grants survive rebuilds; with an ad-hoc build, remove any existing `YCoding Computer Use` Privacy & Security entries and enable the rebuilt app as each run adds it. Then run `YCODING_TEST_DESKTOP_TARGET=<bundle-id>/<pid>/<window-id> YCODING_TEST_DESKTOP_CLICK_X=<x> YCODING_TEST_DESKTOP_CLICK_Y=<y> bun run --cwd packages/core test:integration:computer` with fresh IDs for a window on another Space and a safe capture-pixel coordinate whose click visibly changes it (for example a Calculator digit); its desktop cases fail without them. The Electron debug bridge and the Safari/Chrome Apple Events bridge have no automated live suite: after changing either, verify it live against an off-Space window with the built app, confirm the frontmost app is unchanged, and restore the state you changed.
- Run affected package typechecks. Run root `bun run typecheck`, `bun run lint`, and `bun run lint:effect-patterns` when the change crosses their scope.
- Typechecks and the full CLI suite exhaust CPU and memory on developer machines. Run one typecheck at a time, never concurrently with another typecheck, build, or package-wide suite, including across parallel agents sharing a machine. Prefer the affected package's typecheck and run root `bun run typecheck` once, at the final release or merge check. Cap typechecks with a shell memory limit of 6144 MiB and the full CLI suite with 12288 MiB; rerun only failing test files before one final full-suite run.
- Keep Core's `typecheck` script as two `bun check` runs, `src test` and `drizzle.config.ts script test-integration`; one `bun check` over the whole package stalls on Bun 1.4.3. Add every new Core source root to one of the two runs.
- After changing `turbo.json` or cross-workspace typecheck inputs, run `bun test --cwd script ./typecheck-cache.integration.test.ts`. Keep `typecheck-inputs` hash-only to preserve parallel executable checks, and include imported non-workspace source, declarations, and test adapters in each consuming task's inputs.
- Run `bun run check:cloudflare` after changing `infra/cloudflare`, its generated Worker types, Wrangler configuration, or Cloudflare validation scripts. Regenerate `infra/cloudflare/worker-configuration.d.ts` only with `bun run generate:cloudflare-types`.
- TUI-visible changes require a TUI render, component, integration, or smoke test that proves the actual displayed behavior.
- Before claiming completion, inspect `git diff`, run the relevant tests, and report exact commands and outcomes.
- Before pushing a release tag, build a fresh native TUI artifact and run both `smoke:tui` and `smoke:runtime` against that artifact. Source verification and compilation do not replace packaged-runtime validation; inspect durable Session failure events when a smoke scenario produces no provider requests.

## Session core

- Keep durable events minimal: record irreducible new facts and do not repeat state derivable by folding ordered aggregate history. Enrich projections and read models when consumers need self-contained views.
- Prune message rows and message-only events below a valid local summary checkpoint only through the retention sweep, skipping executing, staged-revert, and active-compaction Sessions and re-checking in each batch transaction; never prune remote-manifest Sessions.
- For a settled execution, the projected messages are the record. One minute after the newest execution terminal event (after the completion check), and in the startup and hourly sweep, delete only message-only events at or before it plus `provider.request.recorded` and `file-change.recorded`, in re-checked batches of at most 100; keep the latest event of each step and execution type, every `context.observed`, every non-message event, and provider-request rows. Error events follow the same rules. Request assembly, completion, forks, reverts, snapshots, and usage must never read deleted event types.
- Replace tool-result images with a placeholder only in Sessions idle for 24 hours since their newest terminal event, never in an executing Session. Never delete anything before the one-time `<database>.pre-prune-backup` exists; skip pruning when free space is below database size plus 1 GiB.
- Keep `session.tool.progress` live-only; tool success and failure are the durable settlement. Delete stored legacy progress rows at or before each Session's newest execution terminal event in every Session.
- Keep every pruning statement, image rewrite, reclaim step, and the backup off long blocking slices: the backup runs on a worker thread, and pruning yields between batches and Sessions.
- Keep durable prompt admission separate from model execution. `Session.prompt(...)` admits one durable `session_pending` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior.
- The serialized runner promotes admitted inputs into visible user messages at safe boundaries, consuming the pending row in the same event transaction. `session_pending` stores only unconsumed work.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID returns the admitted durable record and wakes execution; the first admission wins and sending a prompt never fails on ID reuse. A prompt message ID belongs to one Session and one input kind, so reuse across Sessions or across input kinds is rejected.
- Retry of an already-promoted input reconciles against the projected message and durable admitted event rather than a retained pending row.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID.
- Interruption targets the active process-local ownership chain for that Session. Interruption of a known but idle or locally unowned Session is a no-op; the public API rejects an unknown Session.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per physical attempt and reload projected history before durable continuation. Most steps have one physical attempt; overflow-triggered compaction recovery may rebuild one step for a second attempt. Before observable output, a failure eligible for model fallback (retries exhausted; quota, no route, or retry delay beyond the ceiling immediately; or an unavailable model, variant, or package) reruns the same Step on the next untried `model_fallbacks` entry, at most three per drain: reuse the assistant message, start a new logical provider request, close the abandoned record with zero tokens and no connection digest, publish one `session.step.rerouted`, and never change `session.model` or compact for a fallback. Authentication, profile, content-policy, invalid-request, invalid-output, unclassified provider, context-overflow, post-output, and interruption failures never switch models.
- Do not bridge through a legacy prompt loop or delegate Session orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently.
- Advisory wakes drain eligible durable inbox rows only. Recovery after a crash or restart applies only to managed child tasks: it never replays a provider attempt or tool call and never resumes a root Session; a recovered child starts one new Step from projected history, and a child with uncertain dispatched tools waits for a human-only Continue or Stop. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe step boundary while the current drain requires continuation.
- An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another.
- Promoting any new user input resets the selected agent's step allowance; a batch of steers resets it once.
- One step is one logical LLM call; its durable record covers only the model-visible span. Do not use “provider turn”, and do not use bare “turn” for a single call. “Turn” is reserved for the future assistant-turn unit containing all steps from prompt promotion until the session would go idle.
- Every logical Step that publishes `Step.Started` publishes exactly one terminal `Step.Ended` or `Step.Failed`, including malformed provider settlement, non-LLM stream failures, and interruption during provider retry backoff.
- A settled terminal Step with no non-whitespace assistant text and no local-tool continuation gets exactly one additional text-only recovery Step; recovery has no tools, no synthetic prompt, and cannot start a third Step.
- Keep EventRuntime replay owner claims separate from clustered Session execution ownership.
- Keep the Instructions algebra and built-ins in `src/instructions`; keep instruction producers with their observed domains, and keep Session History selection plus `InstructionState` and `InstructionEntry` persistence Session-owned.
- `InstructionDiscovery` observes ambient global and upward-project instructions. The runner composes built-ins, discovery, guidance, and entries explicitly in `loadInstructions`; there is no instruction registry.
- `capabilities` configuration is the single source for turning capabilities off; gate each consumer through `ConfigCapabilities`, and keep tool visibility in the registry filter rather than a second hiding path. A built-in block that describes a tool is observed as removed while `ToolRegistry.available` for the selected agent lacks that tool.
- `session.instructions.updated` stores only changed source keys and content hashes. Blob values live once in `instruction_blob`; `instruction_state` is a rebuildable fold cache, never primary state.
- Render initial instructions and chronological updates from values during request assembly. Completed compaction moves the instruction epoch; Session movement and committed revert clear it.
- Unavailable sources retain the last value and block only the initial complete delta.

## Autonomy and orchestration

- Keep autonomy state durable on the Session. Preserve YOLO 0–2 and goal state; migrate a stored level 3 once to 2 and reject new requests above 2, with no standing alias. Keep the durable per-Session `/auto-answer` toggle (default off) Session-local: no family propagation, independent of YOLO, goals, and sleep. Store optional `sleep: {}` as a root-family presence marker; inherit it across descendants. Ignore stored `guardrailDecision` and `sleep.priorGuardrailDecision` fields during decoding. Clear sleep on wake or any user prompt without restoring another setting; publish trusted chronological System observations and rehydrate machine keep-awake holds before serving Sessions.
- Goal mode must terminate explicitly as `completed`, `stopped`, or `exhausted`; leaving goal mode must not silently discard the final goal state.
- Goal reports are reserved for unresolved blockers after reasonable self-resolution; each accepted report consumes one no-progress attempt. Successful active-goal settlement advances continuation without a report and does not reset the no-progress budget.
- Subagents are durable child Sessions and always launch in the background. Do not add a synchronous result path disguised by the deprecated `background` input.
- Preserve parent-child ownership, permission ceilings, explicit agent selection, and the configured nesting bound.
- Keep YOLO 0 (Ask first) manual; YOLO 1 (Allow tools) auto-approves ask permissions only; YOLO 2 (Tools + reviews) also auto-approves awake ordinary guardrail reviews. Goal continuation grants no permission, answer, or review authority. Automatic question/form and orchestration child-question answers require only the Session's own `/auto-answer` toggle on (default off); asleep with it off, defer without a helper call, and with it on keep the existing eligible-choice and confidence rules while required free text and uncertainty defer. Name levels `Ask first`, `Allow tools`, and `Tools + reviews`; show actual auto-answer and review settings rather than conditional YOLO text.
- Apply Session guardrails to the root family independently from tool permissions. Ordinary built-in review covers outside-repository work; awake effective YOLO 2 auto-approves it before delegation. YOLO 1 permission auto-approval or an active goal cannot grant it. Exempt YCoding's global config, data, cache, state, temporary, bin, log, and repos descendants and effective `external_directory: allow` paths using directory-glob and `~` permission semantics; `ask` and `deny` do not exempt paths, and mixed non-exempt targets stay reviewed. Exempt read tools, recognized read-only shell commands (including `cd`, `exit`, `ps`, `pgrep`, `lsof`), and read-only compound segments without outside redirections. Treat interpreter script arguments and non-shell heredocs as executed code, not outside operands; parse shell-fed heredocs. Exempt managed worktree, memory, project-artifact, subagent, and MCP operations from ordinary review; retain custom rules, invalid-configuration reviews, denies, and caps. Hard reviews cover project/ancestor and direct home-child deletion, destructive Git, force push, destructive database statements, and custom `hard_review` rules. Model guardrail verification and grading require `guardrails.decide_reviews: true`, default false, even during goals and sleep; disabled, they ask humans awake or defer asleep with reason `disabled`, with no helper call or escalation provenance. When enabled, delegate every surviving review, with no YOLO guardrail auto-approval asleep. Default `guardrails.decide_hard_reviews` to true beneath that switch; false sends hard reviews directly to humans awake or the review box asleep. Make one graded call with approve_all, approve, reject, and escalate; include approve_all only where Always is offered. Pick the highest-confidence qualifying choice: approve_all ≥0.9 replies always, approve ≥0.8 (≥0.95 hard) replies once, reject ≥0.8 replies reject. Escalate highest escalation grades (including ties), conflicting qualifying approval/rejection, no qualifying choice, refusal, invalid output, error, or the 60-second deadline. Ask humans awake or defer asleep with Guardrail.DeferredError. Preserve human choices and attribution. Carry optional selected choice/confidence and grades on decided/escalated events, pending escalation, Status, and guardrail review items. Redact and bound nonempty grade evidence to 500 characters; omit grades on refusal, error, and timeout. Preserve canonical tool-call source and rule IDs; never copy command text or targets into provenance events. Interruption or shutdown ends pending actions and prompts; restart restores neither. Block denies before any helper call. Preserve computer/browser skipReview and caps.
- With `guardrails.decide_reviews: true`, verify matched standard `standard.review.*` rules before human review or delegated approval; disabled, keep the deterministic match without a helper call. Always run the narrow semantic predicate unless an ordinary review is already YOLO-auto-approved or `skipReview` applies. Supply redacted executable-segment and resolved-target fields; treat evidence as untrusted data and never accept comments, embedded claims, quoted/printed text, or names as proof of a non-match. Dismiss only an explicit false predicate at confidence ≥0.9 within 15 seconds. Preserve review on refusal, error, unavailability, timeout, or lower confidence; never verify catastrophic denies, explicit denies, or custom rules. Reevaluate remaining rules after dismissal, retain permission and cap gates, and durably record only the rule ID, confidence, and canonical tool-call source (message and call IDs) with root and reviewed Session attribution; never copy command text, targets, or raw evidence into guardrail provenance events. Render and rehydrate provenance chronologically only in the reviewed Session; keep only pending family reviews pinned at the tail. Treat dismissal as a nonmatch, never approval of another rule; unit framing tests do not prove model resistance.
- Publish escalation history only for an awake human handoff. While a family sleeps, defer unsettled guardrail grades, option answers below 0.8, free-text questions, and ask permissions that YOLO does not settle to the durable review box; confident choices apply, denies never defer. Entering sleep converts pending human guardrail reviews with their grades, waiting questions/forms, subagent questions, and permission asks into deferred items. Only the human decides them through `session.review.decide`; decision prompts use origin `review` and never wake the family. A guardrail or permission approval is a one-shot grant matching the re-issued request's fingerprint; never replay an action. `max_pending_reviews` caps open items per family for new deferrals; sleep-entry conversions and managed-child restart recovery holds may exceed it.
- Surviving ordinary guardrail reviews expose one-time approval, a durable directory-scoped Always approval that covers the reviewed request's outside directories for the root Session family, or rejection; surviving hard reviews expose only one-time approval or rejection.
- Defer required free-text input even with suggested defaults; validate deferred Form answers through the live Form validator. Isolate sleep-entry producer conversions. Derive child-question deferred flags from open review events on reads. Treat open review items as unfinished work awake or asleep: pause goal continuation, preserve its retry budget, and block completion receipts without re-asking or retrying deferred actions. Commit affected review and unused-grant withdrawals atomically with inclusive revert boundaries, and project replayable withdrawal notices. Reject every already-settled human decision with the existing conflict error, except one later human Continue on a stopped managed-child recovery item; reconcile interrupted delivery internally.
- Runtime observations are append-only durable messages in chronological history. TeamView is user-authority synthetic context, while trusted Session state and step-limit notices are System messages; none is an assistant narration of routine bookkeeping.
- Invoke agent judgments only through explicit `decision` calls; never interpret them as approval, a user answer, or completion proof. Choice grade defaults to false; grade true requires every listed choice exactly once with finite confidence in [0,1] and nonempty evidence ≤500 characters, without a single pick. Reject missing, duplicate, extra, or invalid grades. Permit runtime calls for standard-match verification and graded guardrail reviews only with `guardrails.decide_reviews: true`, and for a Session's sleeping option answers only with that Session's `/auto-answer` toggle on, under their separate thresholds; the explicit `decision` tool does not depend on these switches. Load shared `core/decision-use` guidance and preserve tool permission ceilings and owner choices.
- TUI subagent indicators must rehydrate from durable state after reconnect or restart. Requiring the user to enter each child session to rebuild counts is a defect.

## Session skills and project artifacts

- Session skill status derives from durable messages and current instruction keys. Do not store a second independent skill-status authority.
- Agent switch and completed compaction deactivate prior skills with explicit reasons. Active conflicts are computed against active skills and instruction declarations.
- Completed duplicate skill-tool loads marked `alreadyActive` must not render or register as a new activation, and a pending or running skill-tool load for a skill that resident history already shows as active must not render either.
- Project artifacts are the current managed customization system. Do not restore the removed self-improvement subsystem.
- Supported artifact kinds are `skill`, `command`, `agent`, and `plugin`; supported scopes are project and global.
- Artifact mutations must use the validated store lifecycle, revisions, digests, preview/confirmation tokens, provenance, and version transitions. Do not write directly into adapter-owned source directories.
- Preserve lifecycle stages `trial`, `active`, `degraded`, `disabled`, and `quarantine` and their tested transition rules.

## TUI transcript history

- The TUI opens, reopens, and reconnects each Session with the newest 100 projected messages from `session.snapshot`, pages older history backward with its opaque cursor, discards durable events at or below the snapshot watermark, and stops paging at a resident completed compaction checkpoint. Copy and export read the retained canonical transcript explicitly, starting at the checkpoint summary after pruning; Find, Fork, and Timeline operate on loaded history.
- Navigation, resume, reconnect, and eviction invalidate or release resident transcript windows without changing durable history.
- Every message-backed transcript row must verify that its message or assistant part is resident before mounting. An unresolved row must consume zero terminal lines and must not initialize child components that require Session context.
- Timeline selection follows option identity, not list index, because new events can reorder options.
- Messages render through the same typed transcript components.

## Provider cache and usage behavior

- Keep backend/Location usage analytics in `usage_analytics_request` and Session/tree views on Session-owned records; select the source once by scope and never mix stores in a read. Capture analytics dimensions at request time and retain facts independently of Session lifetime. Read global-only retention at each sweep: `session_retention.records_days` defaults to 7 idle days, `analytics_retention.usage_days` to 30 request-date days, and `analytics_retention.latency_days` to 30 server-receipt days; require positive integers. Keep exact boundaries, skip executing Sessions during record cleanup, and never reconstruct expired Session records from analytics.
- Separate provider prompt caching, TUI cache diagnostics, project-artifact reuse, and provider quota reporting. Do not label them as one cache layer.
- Provider-usage refresh is read-only and best effort. It must never block Session startup or model execution.
- Preserve source and stability labels. Unknown quota values are absent and render as unreported; never coerce them to zero.
- Never expose provider credentials, credential IDs, account emails, arbitrary response headers, or raw usage payloads through Protocol, logs, events, or TUI state.
- Preserve stable model-visible prefixes before optimizing cache placement.
- Gate model-family-specific wire fields. GPT-5.6+ uses its explicit prompt-cache options and breakpoints; pre-5.6 requests use compatible retention fields.
- Preserve Anthropic cache-control placement across direct and compatible provider routes.
- Missing provider cache telemetry means unreported, not zero.
- Usage summaries and reports read one snapshot on `Database.Interface.reader` (the main connection when absent), scan the provider-request ledger in statements of at most 10,000 requests, and yield between statements; keep any new usage read bounded the same way so it never holds the main connection or the event loop for a whole history.
- Keep model incidents backend-wide in `model_incident` with identifiers, bounded categories, and sanitized rule IDs only; never store command text, targets, messages, or evidence. Derive guidance deterministically from guardrail incidents (never fallbacks) newer than the per-model clear watermark; clearing moves only that watermark. Keep `incident.report` and `incident.recent` free of Location; resolve guidance capability from a Location, and remote guidance from the verified Session, never browser input. Local guidance operations are `incident.guidance.get` and `incident.guidance.clear`; the remote read is `incident.guidance`.
- Cache optimization must not swallow provider errors, change tool semantics, or trade correctness for hit rate.
