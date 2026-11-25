# Repository agent guide

## Repository identity and direction

- This repository is the YCoding product and source of truth.
- YCoding is licensed under AGPL-3.0-only (`LICENSE`); keep every workspace `package.json` `license` field set to `AGPL-3.0-only`, and keep the upstream MIT notice in `NOTICE` intact.
- The default branch is `main`.
- Maintain one current runtime. Do not restore removed session, configuration, plugin, SDK, package, event, or TUI compatibility paths unless the user explicitly requests a migration design.
- The TUI is the primary product, release, and behavior surface.
- Maintain `apps/web` as a SolidJS/Vite presentation client and curated public site; keep execution in the local runtime. Keep Core and Server imports out of browser code.
- Use `packages/remote` for the closed browser relay contract; enforce authenticated user/device ownership before forwarding controls. Starting the local remote connector grants the owner access to every existing and future Session on that backend. Resolve Session Locations from the backend, never from browser input. Keep native Dots Channels private to the server-process Host; expose only sessionless global access and connection-status administration through HTTP and the browser relay.
- Publish user-facing content only. Do not automatically publish engineering `docs`, internal topology, task plans, or private configuration into the web build.
- Durable sessions, explicit autonomy, durable background subagents, session skills, project artifacts, Session-wide guardrails, provider-efficient caching, and normalized provider usage are current product contracts.
- Gate native Dots with trusted global `dots.enabled` and an explicit OpenAI OAuth profile pinned to credential, account, and account generation. Persist one global access preference Off by default at revision 0; On covers every existing and future eligible Session. Never initialize access from Session creation or historical family events. Share the global authority between HTTP and native Channels; use transactional CAS and capture the global revision in connection pins and native source receipts. Off retires Channels, subscriptions, candidates, and staged answers without interrupting execution, removing admitted prompts, or consuming pending decisions. Keep transport status process-owned, read-only, bounded, sanitized, and identity-fenced. Bind typed decisions to the exact candidate, source, and revision; recheck ownership, ceilings, archive state, explicit denies, access, and connection lifetime at settlement. Include permissions, hard/custom guardrails, Forms, Questions, child questions, deferred reviews, and recovery without blanket approval. Preserve historical events and attribution; reject queued retired routine/delegated inputs at normal promotion with one durable `delegation_invalid` receipt. Never replay uncertain work or infer authority from prompt text.
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
- `release.yml` has three targets. The first job, `release-target`, resolves the target and its `verify-source` suites with `script/release-version.sh --target`; every other job needs it. A push of tag `v<version>` is `full` and keeps the CLI, Desktop, GitHub Latest and Web flow unchanged. A push of `desktop-v<version>` is `desktop`, with notes in `docs/releases/desktop/v<version>.md`. It runs every source suite except `web`, builds the runtime and Desktop without the CLI archive, finalizes only the Desktop zip into `ycoding-desktop-<version>-checksums.txt`, and the `publish Desktop release` job creates a new non-Latest `desktop-v<version>` GitHub release. It fails when that release already exists or when GitHub Latest changes. A push of `web-v<version>` is `web`, with notes in `docs/releases/web/v<version>.md`. It runs the `types` and `web` suites and deploys that verified Web build without building Desktop or creating a GitHub release. Tag pushes require the nonempty note for their own target, and publication uses it. Manual runs take a `target` input (default `full`) and never publish or deploy. Every manual run resolves its version as a full manual run does: the `version` input or the newest `docs/releases/v*.md`, whose shared note must exist and be nonempty.
- Native-layout Desktop installations inspect the 20 most recent releases for stable, non-draft `v<semver>` and `desktop-v<semver>` tags, choose the newest version with combined releases winning ties, and download the matching zip and checksum manifest. Bun-era Desktop uses `releases/latest`; the CLI updater and `script/install.sh` consider only `v*` releases.
- When preparing a release, add its user-facing changes to `apps/web/src/content/changelog.ts` in newest-first order and update the changelog test; include every version since the last listed release using its `docs/releases/v<version>.md` note as evidence.
- Keep CI tests file- or case-selected and limited to unit, stub and mock boundaries; retain schema, Protocol, provider, permission, guardrail, installer, publication-contract and design-drift checks. Keep genuine production builds, bundle-boundary checks, signing, metadata, archive-layout and checksum validation. Run real browser, loopback-listener, service and packaged-runtime integration checks locally with their existing environment requirements. Select named mock-only cases from mixed files; never classify a suite from its filename alone or replace live acceptance with a weaker mock.
- Do not start GitHub Actions on branch pushes to `main`, `dev`, or `v2`. Keep pull request checks, manual runs, the `beta` Nix hash refresh, and release tag triggers.
- Install Bun through `.github/actions/install-bun` in CI. Bump only its `bun-pin` step. It retries the pinned setup action once after 30 seconds, then checks that the npm fallback installs the same version. The shared Setup Bun action installs Node and dependencies without restoring or uploading the package store. Use Install Bun alone for release finalization.
- Share Turbo cache keys between CI workflows using the runner OS, architecture, root lockfile and root config files. Let Turbo validate each task's declared inputs on restore.
- The release workflow (`release.yml`) runs on tag pushes and manual dispatch. Its `verify-source` matrix runs alongside the Apple Silicon runtime build. The CLI checks run on a Linux runner. The Project TUI shard checks Dots mocks; the runtime TUI shard builds and checks the Linux native runtime. Keep every TUI command, selector, working directory and timeout in exactly one shard. Restore the shared Cargo and sccache caches only in `build-desktop-runtime`, and save them only from the default branch. Normalize vendored source timestamps only after an exact Cargo cache hit. Both packagers verify the runtime staged on their runner against the producer's receipt digest for that run attempt before embedding it. Upload the staged runtime and receipt once. Keep signing credentials out of the runtime compilation step. Keep native compilation, frontend compilation, helper and extension timings separate. Each packager validates and archives its target, then uploads it once with Actions compression disabled. Add unit and mock release checks to a `verify-source` leg. Real browser, relay-flow, publisher-listener, service and packaged-runtime acceptance stays local.
- Push a version tag only after its commit is on `main` and its release notes are ready. Verification, build, and publication each check that the fetched tag still points to the event commit and that `origin/main` contains it. A manual run accepts an optional `version` and stops after read-only finalization. Finalization uses runtime-only Bun, validates both signed archives from the current run, and uploads their versioned checksum manifest.
- Only a tag run can publish. Only the two publication jobs have GitHub write access. Each checks the finalizer's manifest digest and the assets. The full release publishes the tagged notes with the comparison link. A stable Rust release becomes GitHub Latest only if the current Latest is not a stable Rust release or is no newer. Deploy the verified Rust and Bun Web bundle from that run after publication, with read-only GitHub access and the `CLOUDFLARE_API_TOKEN` secret. Deploy the `ycoding-preview` Worker after the relay only when `YCODING_APP_PREVIEW_DEPLOY` is `true`.
- To replace an existing release, `script/release-publish.ts` uploads under `staged-<run>-` names and verifies all sizes and SHA-256 digests before swapping public names, checksums last. Preserve replaced assets as `prior-<run>-<name>`, restore original names and metadata on failure, and retain the replacement's recovery manifest. Never delete a replaced asset. A download during the swap can briefly miss or mismatch and fail closed because GitHub does not swap assets atomically.
- Import `YCODING_MACOS_SIGNING_P12` (base64 PKCS#12) and `YCODING_MACOS_SIGNING_PASSWORD` into a temporary keychain for macOS builds. Restore the keychain search list and delete that keychain afterwards. Require `YCoding Code Signing` with no ad-hoc fallback. Verify the CLI, Interaction helper, and Desktop app signatures against their required identifiers and the `YCODING_MACOS_SIGNING_SHA1` pin in `release.yml`.
- Validate the archive inventory for the release version. Publish only the Apple Silicon CLI and Desktop archives for a v0.13.0 replacement and for v0.13.2 or later. The CLI archive contains `ycoding-native`, `ycoding-chrome-extension`, and `YCoding Interaction.app`. Attach `LICENSE` and `NOTICE` separately. When replacing v0.13.0, retain its complete original nine-asset set, including all three retired target archives. Bundle Interaction modules into `service-worker.js` and keep the release extension file list exact.

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
- Interaction Script and Code single-tab isolation runs with `bun run --cwd packages/core test:integration:interaction-script` on macOS: headless Chrome for Testing with the unpacked `extensions/interaction-chrome`, two same-origin tabs, an opener-related tab and revocation. Set `YCODING_TEST_ISOLATED_BROWSER_CHROME` to the Chrome for Testing executable and `YCODING_TEST_FOCUS_SAMPLER` to a sampler built with `xcrun swiftc -O -parse-as-library -target arm64-apple-macosx14.0 packages/core/interaction-macos/tests/FocusSampler.swift -o <dir>/focus-sampler`; `YCODING_TEST_INTERACTION_ARTIFACTS` optionally keeps its logs and screenshots. It fails if the frontmost app or the selected tab changes. Never run it headed.
- Interaction favicon cleanup runs with `bun test --cwd extensions/interaction-chrome ./test/favicon-cleanup.integration.test.js` and `YCODING_TEST_ISOLATED_BROWSER_CHROME` set to the Chrome for Testing executable: headless Chrome loads the unpacked `extensions/interaction-chrome`, marks and clears pages without an icon link, with only `/favicon.ico`, and with their own icon link, and reads the favicon Chrome reports for the tab. Run it after changing the page mark or its cleanup.
- Use the exact Chrome for Testing build owned by `script/chrome-for-testing.ts` for local web render and extension checks. Provision it into an isolated directory and set `YCODING_WEB_CHROME` or `YCODING_TEST_ISOLATED_BROWSER_CHROME` to the returned executable. Native paired-browser acceptance continues to use installed Chrome.
- After changing the macOS computer-use app or its permission requests, rebuild it with `bun run build:computer-use`. With `YCODING_MACOS_SIGNING_IDENTITY` set to your own stable code-signing identity, existing privacy grants survive rebuilds; with an ad-hoc build, remove any existing `YCoding Computer Use` Privacy & Security entries and enable the rebuilt app as each run adds it. Then run `YCODING_TEST_DESKTOP_TARGET=<bundle-id>/<pid>/<window-id> YCODING_TEST_DESKTOP_CLICK_X=<x> YCODING_TEST_DESKTOP_CLICK_Y=<y> bun run --cwd packages/core test:integration:computer` with fresh IDs for a window on another Space and a safe capture-pixel coordinate whose click visibly changes it (for example a Calculator digit); its desktop cases fail without them. The Electron debug bridge and the Safari/Chrome Apple Events bridge have no automated live suite: after changing either, verify it live against an off-Space window with the built app, confirm the frontmost app is unchanged, and restore the state you changed.
- Wall-clock performance budgets measure the host, so keep them out of package-wide suites and the release workflow. Run `bun run --cwd packages/core test:performance` and `bun run --cwd packages/cli test:performance` (the local and remote Usage dashboard budgets) on a developer machine after changing Usage reads, the remote connector, or the relay transport, and before pushing a release tag.
- Run affected package typechecks. Run root `bun run typecheck`, `bun run lint`, and `bun run lint:effect-patterns` when the change crosses their scope.
- Run targeted tests for affected behavior and the checks configured in CI; release preparation does not require an additional local full-suite run. Reuse passing results when their inputs are unchanged. Run one typecheck at a time, never concurrently with another typecheck, build, or package-wide suite, including across parallel agents sharing a machine. Prefer the affected package's typecheck and run root `bun run typecheck` once when the change crosses its scope. Cap typechecks with a shell memory limit of 6144 MiB and CI or explicitly requested full CLI suites with 12288 MiB.
- Keep Core's `typecheck` script as two single-threaded `bun check --threads=1` runs, `src test` and `drizzle.config.ts script test-integration`; whole-package and default-threaded checks stall on Bun 1.4.3. Add every new Core source root to one of the two runs.
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
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers bound placement through `SessionStore` plus `LocationServiceMap.get(session.location, [LocationServiceMap.full])` only when a drain starts; no layer should take a Session ID. Standalone execution requires an isolated reduced closure and fails closed until it is available.
- Interruption targets the active process-local ownership chain for that Session. Interruption of a known but idle or locally unowned Session is a no-op; the public API rejects an unknown Session.
- `LocationServiceMap.get(ref, nodes)` and `contextEffect(ref, nodes)` provide exactly the services of the listed nodes; the node list is the contract. Each Location builds its dependency closure lazily, extends it when a later request lists more nodes, and is released after an idle period. `invalidate(ref)` releases a Location without rebuilding it; `loaded()` lists each loaded Location with the names of the services built so far.
- Declare the smallest node set a caller uses. Pricing, model, and provider reads use the catalog slice (`CatalogContributions.nodes`, plus `Location.node` when `Location.Service` is read); bound Session execution, shell, MCP, tools, and anything that waits on the plugin host use `LocationServiceMap.full`. Bound Session-scoped middleware uses `full`; standalone Sessions reject `full` and require an isolated reduced closure. HTTP groups select a set through typed Location middleware so handler service types match what is built.
- A Location's build and release publish no update events. Run a contributor's first asynchronous load that is forked during the build (account model inventories, MCP prompt lists) inside `LocationAnnouncements.initial`; it then announces only after a server handler that returns that data marked it read with `LocationAnnouncements.read(kind)`. Never publish an update event from a read path; reread configuration with `config.reload({ notify: false })`.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per physical attempt and reload projected history before durable continuation. Most steps have one physical attempt; overflow-triggered compaction recovery may rebuild one step for a second attempt. Before observable output, a failure eligible for model fallback (retries exhausted; quota, no route, or retry delay beyond the ceiling immediately; or an unavailable model, variant, or package) reruns the same Step on the next untried `model_fallbacks` entry, at most three per drain: reuse the assistant message, start a new logical provider request, close the abandoned record with zero tokens and no connection digest, publish one `session.step.rerouted`, and never change `session.model` or compact for a fallback. Authentication, profile, content-policy, invalid-request, invalid-output, unclassified provider, context-overflow, post-output, and interruption failures never switch models.
- Do not bridge through a legacy prompt loop or delegate Session orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently.
- Advisory wakes drain eligible durable inbox rows only. Recovery after a crash or restart applies only to managed child tasks: it never replays a provider attempt or tool call and never resumes a root Session; a recovered child starts one new Step from projected history, and a child with uncertain dispatched tools waits for an authorized typed `session.review.decide` Continue or Stop after exact candidate validation. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe step boundary while the current drain requires continuation.
- An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another.
- Promoting any new user input resets the selected agent's step allowance; a batch of steers resets it once.
- One step is one logical LLM call; its durable record covers only the model-visible span. Do not use “provider turn”, and do not use bare “turn” for a single call. “Turn” is reserved for the future assistant-turn unit containing all steps from prompt promotion until the session would go idle.
- Every logical Step that publishes `Step.Started` publishes exactly one terminal `Step.Ended` or `Step.Failed`, including malformed provider settlement, non-LLM stream failures, and interruption during provider retry backoff.
- A settled terminal Step with no non-whitespace assistant text and no local-tool continuation gets exactly one additional text-only recovery Step; recovery prohibits local tool execution, retains declarations only on verified AI SDK Google/OpenAI and native OpenAI Responses routes (including Codex and OpenRouter Responses), adds no synthetic prompt, and cannot start a third Step.
- Keep EventRuntime replay owner claims separate from clustered Session execution ownership.
- Keep the Instructions algebra and built-ins in `src/instructions`; keep instruction producers with their observed domains, and keep Session History selection plus `InstructionState` and `InstructionEntry` persistence Session-owned.
- `InstructionDiscovery` observes ambient global and upward-project instructions. The runner composes built-ins, discovery, guidance, and entries explicitly in `loadInstructions`; there is no instruction registry.
- `capabilities` configuration is the single source for turning capabilities off; gate each consumer through `ConfigCapabilities`, and keep tool visibility in the registry filter rather than a second hiding path. A built-in block that describes a tool is observed as removed while `ToolRegistry.available` for the selected agent lacks that tool.
- `session.instructions.updated` stores only changed source keys and content hashes. Blob values live once in `instruction_blob`; `instruction_state` is a rebuildable fold cache, never primary state.
- Render initial instructions and chronological updates from values during request assembly. Completed compaction moves the instruction epoch; Session movement and committed revert clear it.
- Unavailable sources retain the last value and block only the initial complete delta.

## Autonomy and orchestration

- Keep autonomy durable as `{ mode: "normal", permissions, guardrails, answers, goal?, defer? }`; categories are `manual`, `auto`, or `yolo`, default Manual. Apply a nonempty category subset atomically; goal and `{ defer: boolean }` are separate operations. Normalize persisted legacy `sleep` markers to `defer: {}` on read and write only `defer`; preserve historical immutable `sleep_entry` events and emit `defer_entry` for new reviews. Permissions resolve YOLO over Auto over Manual across managed-task ancestry. Answers resolve local or inherited YOLO before local Auto; ancestor Auto answers do not propagate. Guardrails use root-family mode. Expose inherited source IDs. `/defer` toggles persistent root-family state across all prompts, commands and steers; hold keep-awake on enable/recovery and release on explicit disable. Defer unresolved manual waits without replaying actions.
- Goal mode must terminate explicitly as `completed`, `stopped`, or `exhausted`; leaving goal mode must not silently discard the final goal state.
- Goal reports are reserved for unresolved blockers after reasonable self-resolution; each accepted report consumes one no-progress attempt. Successful active-goal settlement advances continuation without a report and does not reset the no-progress budget.
- Let `SessionGoalDecisions` grant answer authority only for ordinary questions outside answers YOLO. Reconsider routine permission asks and standard guardrail reviews through their current native category mode, without a proposed decision, `groupID`, reply, or escalation. Resolve deterministic defaults and a unique Recommended option first; otherwise synthesize bounded Goal agent answers for pending ordinary Question, Form and child questions outside answers YOLO. Preserve truthful automatic provenance, native-lock revalidation and idempotent settlement receipts. Outside the corresponding YOLO category, explicit-decision, hard/custom, non-routine, blocked-delegation and review-box items remain human-only. Wake only an idle goal owner after settlement; a typed review-box rejection may resume, but a live rejection or cancellation does not.
- Subagents are durable child Sessions and always launch in the background. Do not add a synchronous result path disguised by the deprecated `background` input.
- Preserve parent-child ownership, permission ceilings, explicit agent selection, and the configured nesting bound.
- Keep Permissions, Guardrails and Answers independent in `/autonomous`, CLI mode flags and Web/Desktop controls. Manual makes no helper call. Auto uses deterministic ask permission approval, ordinary standard review approval only while defer is off, and valid explicit defaults or one Recommended answer. YOLO removes every category blocker: permissions allow ask, explicit-decision, deny, ceiling and prior-rejection cases immediately; guardrails reserve and allow hard, catastrophic, destructive, custom deny/review, invalid configuration and disabled hard-fallback cases without evaluation. Preserve Project coordinator structural mutation separation, capability and visibility filters, and capacity limits. Answers YOLO settles every question/Form/child question, including required, optional, conditional, multi-select, free-text, open and explicit-decision input, through valid evaluation or deterministic valid fallback; physical external redirects remain external when synthetic input is invalid. Settle existing waits once and supersede stale reviews on effective YOLO changes. Before controls save a new YOLO category, require explicit acceptance of all risks and full user responsibility; Cancel/Escape saves nothing and Manual/Auto applies directly.
- Outside guardrails YOLO, apply Session guardrails to the root family independently from tool permissions. Ordinary built-in review covers outside-repository work; the root family's awake guardrails `auto` mode auto-approves it before delegation. Permission or answer modes and active goals grant no guardrail authority. Exempt system temporary roots, resolved through symlinks, from ordinary review and the `external_directory` ask, never from denies, ceilings, or destructive-action rules. Exempt YCoding's global config, data, cache, state, temporary, bin, log, and repos descendants and effective `external_directory: allow` paths using directory-glob and `~` permission semantics; `ask` and `deny` do not exempt paths, and mixed non-exempt targets stay reviewed. Exempt read tools, recognized read-only shell commands (including `cd`, `exit`, `ps`, `pgrep`, `lsof`), and read-only compound segments without outside redirections. Treat interpreter script arguments and non-shell heredocs as executed code, not outside operands, except recognized literal file-mutation calls inside Python inline code and heredocs; parse shell-fed heredocs. API routes, URLs, and non-file option values are not outside file operands; file-valued options, `@file` inputs, redirections, and file-command operands are. Exempt managed worktree, memory, project-artifact, subagent, and MCP operations from ordinary review; retain custom rules, invalid-configuration reviews, denies, and caps. Hard reviews cover project/ancestor and direct home-child deletion, destructive Git, force push, destructive database statements, and custom `hard_review` rules. Guardrails YOLO admits every action before rule denial or review, reserves its action counter and records an allow decision without helper grading. Preserve historical audit events. Defer remains independent of category modes.
- Keep guardrail classification deterministic outside YOLO; guardrails YOLO admits before classification and never invokes match verification or review grading. Preserve historical dismissal and model-rejection provenance. Rehydrate settled rejections chronologically in the reviewed Session, at or after its first resident chat message; pin only pending family reviews at the tail.
- Outside YOLO, publish escalation history only for a live handoff and defer unresolved Manual requests while defer is active. Entering defer converts pending guardrail, permission, question, Form and child-question waits into durable reviews. Preserve exact one-shot fingerprints and never replay an action. `max_pending_reviews` caps new deferrals; defer-entry and restart recovery conversions may exceed it. Review decisions preserve defer state. YOLO category reconciliation supersedes its open reviews with reason `autonomy` and retains automatic provenance.
- Surviving ordinary guardrail reviews expose one-time approval, a durable directory-scoped Always approval that covers the reviewed request's outside directories for the root Session family, or rejection; surviving hard reviews expose only one-time approval or rejection.
- While defer is active outside answers YOLO, defer unresolved free-text input when neither deterministic answer authority nor an active Goal supplies a valid answer. Validate deferred Form answers with the live Form validator. Isolate defer-entry producer conversions and derive child-question deferred flags from open review events. Open review items remain unfinished work after defer is disabled: pause goal continuation, preserve its retry budget and block completion without re-asking or retrying deferred actions. Commit affected review and unused-grant withdrawals atomically with inclusive revert boundaries and project replayable withdrawal notices. Reject already-settled decisions with the existing conflict error, except one later authorized typed Continue on a stopped managed-child recovery item; reconcile interrupted delivery internally.
- Runtime observations are append-only durable messages in chronological history. TeamView is user-authority synthetic context, while trusted Session state and step-limit notices are System messages; none is an assistant narration of routine bookkeeping.
- Invoke advisory judgments through explicit `decision` calls; never interpret them as approval, a user answer or completion proof. Choice grade defaults to false; grade true requires every listed choice exactly once with finite confidence in [0,1] and nonempty evidence of at most 500 characters, without a single pick. Reject missing, duplicate, extra and invalid grades. Automatic category evaluation uses only `yolo-answer` under effective answers YOLO and falls back to a valid native answer on refusal, error, timeout or unusable output. Permissions and guardrails YOLO invoke no evaluator. Typed text questions accept optional maxLength 1–8192, default 8192, and return the bounded value in text. Load shared core/decision-use guidance and preserve owner choices.
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

## Native client identity

- Keep each impersonated native-client identity in its owning module: Claude Code in `packages/core/src/plugin/provider/anthropic-claude-code-request.ts` (`defaultVersion`, beta flags, Stainless headers, `claudeCodeAPIUserAgent`, `claudeCodeMCPProxyHeaders`), Codex in `packages/core/src/plugin/provider/openai-codex.ts` (`catalogClientVersion`), and Cursor in `packages/core/src/cursor/provider/shared.js` with `shared.d.ts` (`FALLBACK_CLIENT_VERSION`). Consumers, including account connectors, import these values; never copy a client version or identity string into another module.
- When bumping a native client version, read the installed native client's current values (version, user agents, required headers such as `X-Mcp-Client-Session-Id`, beta flags, and MCP protocol revisions) and update every identity surface of that client in one change: model requests, catalog requests, and account connector discovery and proxy requests.
- In the same change, update the pinned expectations in `packages/core/test/plugin/provider-anthropic-claude-code.test.ts`, `packages/core/test/plugin/provider-openai.test.ts`, and `packages/core/test/claude-account-connectors.test.ts`, the identity description in `docs/configuration.md`, and the release note. Then `git grep` the old version string and replace every current-behavior occurrence; historical release notes and changelog entries keep their recorded versions.

## Provider cache and usage behavior

- Keep backend/Location usage analytics in `usage_analytics_request` and Session/tree views on Session-owned records; select the source once by scope and never mix stores in a read. Capture analytics dimensions at request time and retain facts independently of Session lifetime. Read global-only retention at each sweep: `session_retention.records_days` defaults to 7 idle days, `analytics_retention.usage_days` to 30 request-date days, and `analytics_retention.latency_days` to 30 server-receipt days; require positive integers. Keep exact boundaries, skip executing Sessions during record cleanup, and never reconstruct expired Session records from analytics. Serve normal usage, forecast, local-spend and local-rate reads from the derived prepared stores `usage_analytics_cell` (backend scope) and `session_usage_cell` (Session scope); never aggregate raw request rows per read. Update a store's cells in the projector transaction only after its source insert succeeds, delete them atomically with their matching source rows only, and keep them rebuildable from source through bounded, yielding, idempotent keyset backfill. Keep quota snapshots, observations and forecast history account-bound process memory, and keep web latency samples bounded paginated diagnostics.
- Separate provider prompt caching, TUI cache diagnostics, project-artifact reuse, and provider quota reporting. Do not label them as one cache layer.
- Provider-usage refresh is read-only and best effort. It must never block Session startup or model execution.
- Preserve source and stability labels. Unknown quota values are absent and render as unreported; never coerce them to zero.
- Never expose provider credentials, credential IDs, account emails, arbitrary response headers, or raw usage payloads through Protocol, logs, events, or TUI state.
- Preserve stable model-visible prefixes before optimizing cache placement.
- Gate model-family-specific wire fields. GPT-5.6+ uses its explicit prompt-cache options and breakpoints; pre-5.6 requests use compatible retention fields.
- Preserve Anthropic cache-control placement across direct and compatible provider routes.
- Missing provider cache telemetry means unreported, not zero.
- Usage summaries and reports read one snapshot on `Database.Interface.reader` (the main connection when absent), merge prepared usage cells in statements that read at most 10,000 stored rows (pricing correction pages: at most 200 contexts), and yield between statements; keep any new usage read bounded the same way so it never holds the main connection or the event loop for a whole history. Limit source-request slices to at most 10,000 requests, used only by append, backfill, and retention maintenance, never by normal reads.
- The Usage page reads through the single composed `usage.dashboard` operation (`preparing`, `error`, or `ready`); never fan out to the separate usage, provider, or forecast reads when it is preparing or unsupported, and request only the report slots a view renders, and send `refresh` once per explicit refresh only.
- Keep model incidents backend-wide in `model_incident` with identifiers, bounded categories, and sanitized rule IDs only; never store command text, targets, messages, or evidence. Derive guidance deterministically from guardrail incidents (never fallbacks) newer than the per-model clear watermark; clearing moves only that watermark. Keep `incident.report` and `incident.recent` free of Location; resolve guidance capability from a Location, and remote guidance from the verified Session, never browser input. Local guidance operations are `incident.guidance.get` and `incident.guidance.clear`; the remote read is `incident.guidance`.
- Cache optimization must not swallow provider errors, change tool semantics, or trade correctness for hit rate.
