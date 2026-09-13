# Repository agent guide

## Repository identity and direction

- This repository is the YCoding product and source of truth.
- The default branch is `main`.
- Maintain one current runtime. Do not restore removed session, configuration, plugin, SDK, package, event, or TUI compatibility paths unless the user explicitly requests a migration design.
- The TUI is the only product, release, and behavior surface. Do not restore desktop, web, console, or website packages.
- Durable sessions, explicit autonomy, durable background subagents, session skills, project artifacts, Session-wide guardrails, provider-efficient caching, and normalized provider usage are current product contracts.
- Historical upstream material never overrides current code, tests, Schema, Protocol, or root `docs`.

Read [`docs/README.md`](./docs/README.md), [`docs/product-direction.md`](./docs/product-direction.md), and the relevant package-level `AGENTS.md` before changing cross-package behavior.

## Authority and verification

Use this authority order when sources disagree:

1. Current executable behavior and targeted tests.
2. Public shapes and durable events in `packages/schema`.
3. HTTP operations and middleware placement in `packages/protocol`.
4. Runtime behavior and persistence in `packages/core`.
5. Current YCoding documentation in `docs` and current contracts in `specs/v2`.
6. Package-local `AGENTS.md` guidance.
7. Generated clients and OpenAPI output, which must match Protocol.
8. Upstream documentation, upstream source, old plans, and historical notes.

Treat user-supplied paths, symbols, line numbers, root causes, and behavior claims as hypotheses. Verify them against the live checkout before building on them. When a premise is false, state the correction with evidence and continue on the corrected premise.

Do not present an assumption, planned command, or unrun test as a result. Preserve unrelated user changes in the working tree.

## Documentation requirements

Update documentation in the same change when behavior changes.

- Product direction or supported surfaces: update root `README.md` and `docs/product-direction.md`.
- Package ownership or dependency direction: update `docs/architecture.md`.
- Session, autonomy, subagent, skill, project-artifact, cache, or transcript behavior: update `docs/runtime.md`.
- Runtime, CLI/TUI, service, provider, MCP, permission, or environment configuration: update `docs/configuration.md`.
- Agent, command, skill, plugin, hook, tool, theme, instruction, or repository-resource discovery: update `docs/repository-resources.md`.
- Public API or schema: update the relevant `specs/v2` contract and regenerate clients/OpenAPI through the owning command.
- Contributor invariants or required verification: update this file or the relevant package `AGENTS.md`.

Never describe a proposal, historical plan, or incomplete implementation as current behavior. Use explicit statuses: implemented, partial, proposed, or historical.

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
- The root `bun test` script intentionally fails. Run tests from the affected package or with an explicit package working directory.
- Unit tests verify requests, responses, branching, ordering, processing, and state transitions with mocked external boundaries while running the implementation under test. Real browsers, listening servers, and packaged executables belong to explicitly named integration/E2E suites and commands, not unit-test commands. Preserve both kinds of evidence; never describe a mixed package-wide suite as unit-only.
- Browser service/tool and dialog unit checks run with `bun run test:unit:browser`; real Core/Server/TUI browser checks run separately with `bun run test:integration:browser` on macOS arm64 with installed Chrome 152. The latter fails when its required environment is unavailable. Schema/Protocol/Client contract suites remain separate affected-package checks.
- Run affected package typechecks. Run root `bun run typecheck`, `bun run lint`, and `bun run lint:effect-patterns` when the change crosses their scope.
- TUI-visible changes require a TUI render, component, integration, or smoke test that proves the actual displayed behavior.
- Before claiming completion, inspect `git diff`, run the relevant tests, and report exact commands and outcomes.

## Session core

- Keep durable events minimal: record irreducible new facts and do not repeat state derivable by folding ordered aggregate history. Enrich projections and read models when consumers need self-contained views.
- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_pending` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior.
- The serialized runner promotes admitted inputs into visible user messages at safe boundaries, consuming the pending row in the same event transaction. `session_pending` stores only unconsumed work.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails.
- Retry of an already-promoted input reconciles against the projected message and durable admitted event rather than a retained pending row.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID.
- Interruption targets the active process-local ownership chain for that Session. Interruption of a known but idle or locally unowned Session is a no-op; the public API rejects an unknown Session.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per physical attempt and reload projected history before durable continuation. Most steps have one physical attempt; overflow-triggered compaction recovery may rebuild one step for a second attempt.
- Do not bridge through a legacy prompt loop or delegate Session orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently.
- Advisory wakes drain eligible durable inbox rows only. Post-crash continuation recovery requires an explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe step boundary while the current drain requires continuation.
- An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another.
- Promoting any new user input resets the selected agent's step allowance; a batch of steers resets it once.
- One step is one logical LLM call; its durable record covers only the model-visible span. Do not use “provider turn”, and do not use bare “turn” for a single call. “Turn” is reserved for the future assistant-turn unit containing all steps from prompt promotion until the session would go idle.
- Every logical Step that publishes `Step.Started` publishes exactly one terminal `Step.Ended` or `Step.Failed`, including malformed provider settlement and non-LLM stream failures.
- A settled terminal Step with no non-whitespace assistant text and no local-tool continuation gets exactly one additional text-only recovery Step; recovery has no tools, no synthetic prompt, and cannot start a third Step.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the Instructions algebra and built-ins in `src/instructions`; keep instruction producers with their observed domains, and keep Session History selection plus `InstructionState` and `InstructionEntry` persistence Session-owned.
- `InstructionDiscovery` observes ambient global and upward-project instructions. The runner composes built-ins, discovery, guidance, and entries explicitly in `loadInstructions`; there is no instruction registry.
- `session.instructions.updated` stores only changed source keys and content hashes. Blob values live once in `instruction_blob`; `instruction_state` is a rebuildable fold cache, never primary state.
- Render initial instructions and chronological updates from values during request assembly. Completed compaction moves the instruction epoch; Session movement and committed revert clear it.
- Unavailable sources retain the last value and block only the initial complete delta.

## Autonomy and orchestration

- Keep autonomy state durable on the Session. Valid modes are `normal`, `yolo`, and `goal`.
- Goal mode must terminate explicitly as `completed`, `stopped`, or `exhausted`; leaving goal mode must not silently discard the final goal state.
- Goal reports are reserved for unresolved blockers after reasonable self-resolution; each accepted report consumes one no-progress attempt. Successful active-goal settlement advances continuation without a report and does not reset the no-progress budget.
- Subagents are durable child Sessions and always launch in the background. Do not add a synchronous result path disguised by the deprecated `background` input.
- Preserve parent-child ownership, permission ceilings, explicit agent selection, and the configured nesting bound.
- Session guardrails apply to the root Session family independently from tool permissions. `yolo` levels `1-2` and `goal`/`permission auto-approval` never auto-answer ordinary guardrail reviews; only `yolo 3` auto-approves ordinary reviews. Hard reviews always require a human `once` or `reject` reply and cannot use YOLO 0-3, goal/agent automation, `always`, disabled ordinary guardrails, or custom allow rules.
- Ordinary guardrail reviews expose one-time approval, session-scoped Always approval for exact matching asks and metadata within the root Session family and current Location process, or rejection; hard reviews expose only one-time approval or rejection.
- Runtime observations are append-only durable messages in chronological history. TeamView is user-authority synthetic context, while trusted Session state and step-limit notices are System messages; none is an assistant narration of routine bookkeeping.
- TUI subagent indicators must rehydrate from durable state after reconnect or restart. Requiring the user to enter each child session to rebuild counts is a defect.

## Session skills and project artifacts

- Session skill status derives from durable messages and current instruction keys. Do not store a second independent skill-status authority.
- Agent switch and completed compaction deactivate prior skills with explicit reasons. Active conflicts are computed against active skills and instruction declarations.
- Completed duplicate skill-tool loads marked `alreadyActive` must not render or register as a new activation.
- Project artifacts are the current managed customization system. Do not restore the removed self-improvement subsystem.
- Supported artifact kinds are `skill`, `command`, `agent`, and `plugin`; supported scopes are project and global.
- Artifact mutations must use the validated store lifecycle, revisions, digests, preview/confirmation tokens, provenance, and version transitions. Do not write directly into adapter-owned source directories.
- Preserve lifecycle stages `trial`, `active`, `degraded`, `disabled`, and `quarantine` and their tested transition rules.

## TUI transcript history

- The TUI fetches each Session's complete current projected transcript in one canonical ascending-order request and retains it while that Session is resident.
- Navigation, resume, reconnect, and eviction invalidate or release the complete resident transcript without changing durable history.
- Every message-backed transcript row must verify that its message or assistant part is resident before mounting. An unresolved row must consume zero terminal lines and must not initialize child components that require Session context.
- Timeline selection follows option identity, not list index, because new events can reorder options.
- Messages render through the same typed transcript components.

## Provider cache and usage behavior

- Separate provider prompt caching, TUI cache diagnostics, project-artifact reuse, and provider quota reporting. Do not label them as one cache layer.
- Provider-usage refresh is read-only and best effort. It must never block Session startup or model execution.
- Preserve source and stability labels. Unknown quota values are absent and render as unreported; never coerce them to zero.
- Never expose provider credentials, credential IDs, account emails, arbitrary response headers, or raw usage payloads through Protocol, logs, events, or TUI state.
- Preserve stable model-visible prefixes before optimizing cache placement.
- Gate model-family-specific wire fields. GPT-5.6+ uses its explicit prompt-cache options and breakpoints; pre-5.6 requests use compatible retention fields.
- Preserve Anthropic cache-control placement across direct and compatible provider routes.
- Missing provider cache telemetry means unreported, not zero.
- Cache optimization must not swallow provider errors, change tool semantics, or trade correctness for hit rate.
