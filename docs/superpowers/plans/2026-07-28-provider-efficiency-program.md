# Provider Efficiency Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce provider-request amplification and prompt-cache misses while preserving durable Session correctness, provider privacy settings, and full fallback behavior.

**Architecture:** Add content-free request telemetry and durable request records first, then remove default helper calls, stabilize the CodeMode tool prefix, activate adaptive provider-native cache policy, and add optional same-turn OpenAI Responses continuation. The canonical Session history remains complete; every optimization is allowed to fall back without changing correctness.

**Tech Stack:** TypeScript, Effect, Drizzle SQLite, SolidJS/OpenTUI, Bun tests, OpenAI Responses/Chat protocols, Anthropic Messages, provider usage APIs.

## Global Constraints

- Never store prompt text, tool output, credentials, request bodies, or response bodies in the provider-request ledger.
- Local title and goal defaults make no provider request.
- Compaction remains model-based and preserves the existing durable compaction contract.
- YCoding never enables OpenAI `store: true` implicitly.
- Prompt caching is an optimization, not durable conversation memory.
- Tool, system, model, permission, and cache-policy changes must invalidate incompatible continuation or cache state.
- A failed optimization retries through the canonical full request at most once.
- Raw token volume and estimated cost must be labeled separately.
- Existing configurations remain valid because `efficiency` is optional.
- Each task ends with targeted tests, affected package tests, typecheck, documentation, and a separate commit.

---

### Task 1: Efficiency configuration and request-attempt primitives

**Files:**

- Create: `packages/core/src/config/efficiency.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/test/config/config.test.ts`
- Create: `packages/ai/src/route/transport/attempt.ts`
- Modify: `packages/ai/src/route/transport/index.ts`
- Modify: `packages/ai/src/route/transport/http.ts`
- Modify: `packages/ai/src/route/transport/websocket.ts`
- Modify: `packages/ai/test/route/transport.test.ts`
- Modify: `docs/configuration.md`

**Interfaces:**

- Produces `ConfigEfficiency.Info` with decoded fields:

```ts
export class Info extends Schema.Class<Info>("ConfigEfficiency.Info")({
  title: Schema.Literals(["local", "model", "off"]).pipe(Schema.optional),
  goal_synthesis: Schema.Literals(["local", "model"]).pipe(Schema.optional),
  helper_model: ConfigModel.Selection.pipe(Schema.optional),
  prompt_cache: Schema.Struct({
    anthropic_ttl: Schema.Literals(["adaptive", "5m", "1h"]).pipe(Schema.optional),
    openai_mode: Schema.Literals(["auto", "implicit", "explicit"]).pipe(Schema.optional),
    openai_extended_retention: Schema.Boolean.pipe(Schema.optional),
  }).pipe(Schema.optional),
  openai_responses_continuation: Schema.Literals(["auto", "on", "off"]).pipe(Schema.optional),
}) {}
```

- Produces `TransportAttempt.Observer`:

```ts
export interface Info {
  readonly requestID: string
  readonly routeID: string
  readonly transport: string
  readonly attempt: number
  readonly phase: "started" | "succeeded" | "failed"
  readonly time: number
  readonly status?: number
  readonly error?: string
}

export type Observer = (info: Info) => Effect.Effect<void, never>
```

- Extends `TransportRuntime` with `readonly observeAttempt?: TransportAttempt.Observer`.

- [ ] **Step 1: Write failing configuration tests**

Add tests that decode an empty `efficiency` block to optional values, decode every supported enum, reject unknown enum values, and preserve existing configs that omit `efficiency`.

```ts
const decoded = Schema.decodeUnknownSync(Config.Info)({
  efficiency: {
    title: "local",
    goal_synthesis: "model",
    helper_model: "openai/gpt-5-mini#low",
    prompt_cache: {
      anthropic_ttl: "adaptive",
      openai_mode: "explicit",
      openai_extended_retention: true,
    },
    openai_responses_continuation: "auto",
  },
})
expect(decoded.efficiency?.title).toBe("local")
expect(decoded.efficiency?.helper_model?.providerID).toBe("openai")
```

- [ ] **Step 2: Run the config test red**

Run:

```bash
cd packages/core
bun test test/config/config.test.ts
```

Expected: FAIL because `Config.Info` has no `efficiency` field.

- [ ] **Step 3: Implement `ConfigEfficiency.Info` and wire it into `Config.Info`**

Create the focused config module, import it in `packages/core/src/config.ts`, add the optional annotated field, and do not add compatibility aliases.

- [ ] **Step 4: Write failing HTTP and WebSocket attempt-observer tests**

Use a fake observer and fake executors. Assert one `started` event and exactly one terminal event for each physical open/execute attempt. Assert observer failure is contained and never changes the provider result.

- [ ] **Step 5: Run the transport tests red**

Run:

```bash
cd packages/ai
bun test test/route/transport.test.ts
```

Expected: FAIL because `TransportRuntime` has no observer and transports emit no attempt events.

- [ ] **Step 6: Implement attempt observation**

Wrap each real HTTP execute and WebSocket open/send attempt with a local attempt counter. Use `Effect.ensuring` or `Effect.matchCauseEffect` so every started attempt has one succeeded or failed terminal observation. Never include headers, URLs with query values, bodies, or credentials in `TransportAttempt.Info`.

- [ ] **Step 7: Document the new efficiency block**

Add the exact schema, defaults, privacy behavior, and the rule that `openai_responses_continuation` does not enable storage.

- [ ] **Step 8: Verify and commit**

Run:

```bash
cd packages/ai
bun test test/route/transport.test.ts
bun run typecheck
cd ../core
bun test test/config/config.test.ts
bun run typecheck
cd ../..
git diff --check
```

Commit:

```bash
git add packages/core/src/config/efficiency.ts packages/core/src/config.ts packages/core/test/config/config.test.ts packages/ai/src/route/transport/attempt.ts packages/ai/src/route/transport/index.ts packages/ai/src/route/transport/http.ts packages/ai/src/route/transport/websocket.ts packages/ai/test/route/transport.test.ts docs/configuration.md
git commit -m "feat(config): add provider efficiency policy"
```

---

### Task 2: Durable provider-request ledger

**Files:**

- Create: `packages/schema/src/provider-request.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/session-event.ts`
- Modify: `packages/schema/src/event-manifest.ts`
- Modify: `packages/core/src/session/sql.ts`
- Modify: `packages/core/src/session/projector.ts`
- Create: `packages/core/src/session/provider-request.ts`
- Modify: `packages/core/src/session/cache-diagnostics.ts`
- Modify: `packages/schema/src/session-cache-diagnostics.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Modify: `packages/core/src/session/title.ts`
- Modify: `packages/core/src/session/goal.ts`
- Modify: `packages/core/src/session/compaction.ts`
- Modify: `packages/core/src/effect/app-node-platform.ts`
- Modify: `packages/core/src/location-services.ts`
- Test: `packages/core/test/session-provider-request.test.ts`
- Modify: `packages/core/test/session-runner.test.ts`
- Regenerate: `packages/core/src/database/schema.gen.ts`
- Regenerate: `packages/core/src/database/migration.gen.ts`

**Interfaces:**

- Produces `ProviderRequest.Record` with no content fields:

```ts
export const Source = Schema.Literals(["step", "title", "goal", "compaction"])
export const Invalidation = Schema.Literals([
  "first-request",
  "stable-hit",
  "prefix-changed",
  "below-minimum",
  "provider-not-reported",
  "cache-disabled",
  "retry-fallback",
])
export const Continuation = Schema.Literals(["full", "continued", "fallback"])

export class Record extends Schema.Class<Record>("ProviderRequest.Record")({
  id: ID,
  sessionID: Session.ID,
  inputID: SessionMessage.ID.pipe(Schema.optional),
  source: Source,
  agent: Agent.ID,
  model: Model.Ref,
  routeID: Schema.String,
  promptCacheKey: Schema.String,
  systemDigest: Schema.String,
  toolDigest: Schema.String,
  request: NonNegativeInt,
  attempts: PositiveInt,
  invalidation: Invalidation,
  continuation: Continuation,
  cost: Money.USD,
  tokens: TokenUsage.Info,
  time: DateTimeUtcFromMillis,
}) {}
```

- Adds durable `session.provider.request.recorded` event containing `Record` fields.
- Produces `SessionProviderRequest.Service`:

```ts
export interface Interface {
  readonly next: (input: BeginInput) => Effect.Effect<Tracker>
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<ProviderRequest.Record>>
  readonly summary: (sessionID: Session.ID) => Effect.Effect<ProviderRequest.Summary>
}

export interface Tracker {
  readonly requestID: string
  readonly observeAttempt: TransportAttempt.Observer
  readonly complete: (input: CompleteInput) => Effect.Effect<void>
}
```

- [ ] **Step 1: Write failing Schema and projector tests**

Test decoding rejects unknown sources and negative counts. Project two recorded requests and assert stable ordering, request count, helper count, attempt count, and token/cost sums.

- [ ] **Step 2: Run the new Core test red**

Run:

```bash
cd packages/core
bun test test/session-provider-request.test.ts
```

Expected: FAIL because the schema, table, event, and service do not exist.

- [ ] **Step 3: Implement the content-free schema and durable event**

Add branded request IDs, exact enums, `Record`, and `Summary`. Export from the Schema root and add the durable event to the manifest.

- [ ] **Step 4: Add `session_provider_request` projection storage**

Add a table keyed by request ID with indexes on `(session_id, request)` and `(session_id, source)`. Store only digests, identifiers, counters, tokens, cost, and timestamps. Add projector insertion for the durable event.

Generate migrations through the owning command:

```bash
cd packages/core
bun run migration
```

Review generated SQL before staging. Do not hand-edit generated migration output.

- [ ] **Step 5: Implement `SessionProviderRequest.Service`**

`next()` allocates a request ID and an attempt observer. The observer increments only physical `started` events for that request ID. `complete()` publishes exactly one durable event and is idempotent by request ID. Failed completion observation must not fail the provider call.

- [ ] **Step 6: Wire the tracker into model calls**

For main steps, create the tracker after request preparation and set `LLMRequest.id` to `tracker.requestID`. Supply a request-scoped `TransportRuntime` observer through the Core LLM client construction. Complete from step settlement or provider failure with the final normalized usage.

For title, goal, and compaction, record the same fields with their source. When later tasks make title/goal local, no tracker is created.

- [ ] **Step 7: Extend Session cache diagnostics with request amplification**

Add optional fields:

```ts
requests: {
  logical: number
  physical: number
  helpers: number
  continuation: number
  fallback: number
}
```

Populate them from `SessionProviderRequest.summary` without changing existing token semantics.

- [ ] **Step 8: Verify migration, replay, and full Core tests**

Run:

```bash
cd packages/schema
bun test
bun run typecheck
cd ../core
bun test test/session-provider-request.test.ts test/session-runner.test.ts
bun run typecheck
bun test
```

Expected: all pass; existing databases migrate and event replay remains deterministic.

- [ ] **Step 9: Commit**

```bash
git add packages/schema packages/core/src/session packages/core/src/database packages/core/src/effect/app-node-platform.ts packages/core/src/location-services.ts packages/core/test/session-provider-request.test.ts packages/core/test/session-runner.test.ts
git commit -m "feat(core): record provider request amplification"
```

---

### Task 3: Remove default title and goal provider calls

**Files:**

- Create: `packages/core/src/session/helper-policy.ts`
- Modify: `packages/core/src/session/title.ts`
- Modify: `packages/core/src/session/goal.ts`
- Modify: `packages/core/src/session/compaction.ts`
- Modify: `packages/core/src/session/context.ts`
- Modify: `packages/core/src/location-services.ts`
- Test: `packages/core/test/session-title.test.ts`
- Test: `packages/core/test/session-goal.test.ts`
- Modify: `packages/core/test/session-compact.test.ts`
- Modify: `docs/runtime.md`
- Modify: `docs/configuration.md`

**Interfaces:**

- Produces:

```ts
export interface HelperPolicy {
  readonly titleMode: "local" | "model" | "off"
  readonly goalMode: "local" | "model"
  readonly helperModel?: ConfigModel.Selection
  readonly localTitle: (text: string) => string
  readonly localGoal: (text: string) => string
  readonly resolveModel: (
    session: SessionSchema.Info,
    hiddenAgent: AgentV2.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved | undefined>
}
```

- `localTitle` returns one trimmed line, removes control characters and Markdown prefix punctuation, limits to 50 terminal-safe characters, and falls back to `New session` only for empty input.
- `localGoal` collapses whitespace and returns the user text unchanged semantically.

- [ ] **Step 1: Write failing local helper tests**

Assert one first prompt in default config calls only the main provider. Assert the title is deterministic, goal mode uses the normalized request, and `title: "off"` leaves the current generated title unchanged.

- [ ] **Step 2: Run tests red**

```bash
cd packages/core
bun test test/session-title.test.ts test/session-goal.test.ts test/session-compact.test.ts
```

Expected: FAIL because title and goal always call the provider.

- [ ] **Step 3: Implement local title and goal functions**

Keep them pure and covered by table-driven tests including multiline text, Markdown headings, wide characters, blank input, and strings longer than 50 characters.

- [ ] **Step 4: Implement helper-model precedence**

Resolve hidden-agent explicit model first, then `efficiency.helper_model`, then current Session model. Do not choose an arbitrary cheap model automatically.

- [ ] **Step 5: Apply policy to title, goal, and compaction**

- title local default publishes one rename event and no usage/provider-request event;
- title model mode preserves the current model path and request ledger source;
- title off returns without renaming;
- goal local default returns normalized text and no provider request;
- goal model mode preserves current behavior;
- compaction remains model-based but uses helper-model precedence.

- [ ] **Step 6: Document behavior and migration impact**

Document that model-generated titles/goals now require explicit modes, how to restore old behavior, and how helper model precedence works.

- [ ] **Step 7: Verify full Core suite and commit**

```bash
cd packages/core
bun test test/session-title.test.ts test/session-goal.test.ts test/session-compact.test.ts
bun run typecheck
bun test
```

Commit:

```bash
git add packages/core/src/session/helper-policy.ts packages/core/src/session/title.ts packages/core/src/session/goal.ts packages/core/src/session/compaction.ts packages/core/src/session/context.ts packages/core/src/location-services.ts packages/core/test/session-title.test.ts packages/core/test/session-goal.test.ts packages/core/test/session-compact.test.ts docs/runtime.md docs/configuration.md
git commit -m "feat(core): reduce helper model traffic"
```

---

### Task 4: Stabilize CodeMode and MCP prompt prefix

**Files:**

- Create: `packages/codemode/src/discovery-prompt.ts`
- Modify: `packages/codemode/src/codemode.ts`
- Modify: `packages/codemode/src/tool-runtime.ts`
- Modify: `packages/core/src/tool/execute.ts`
- Modify: `packages/core/src/tool/registry.ts`
- Modify: `packages/core/src/mcp/instructions.ts`
- Modify: `packages/core/src/session/runner/cache.ts`
- Modify: `packages/codemode/test/codemode.test.ts`
- Modify: `packages/core/test/tool-execute.test.ts`
- Modify: `packages/core/test/session-runner-cache.test.ts`
- Modify: `packages/core/test/mcp.test.ts`
- Modify: `docs/runtime.md`

**Interfaces:**

- Produces constant `DiscoveryPrompt.EXECUTE_DESCRIPTION` containing only the fixed CodeMode language and search workflow.
- Keeps `CodeMode.Runtime.catalog()` and runtime `search(...)` dynamic.
- Adds `McpInstructions.MAX_SERVER_BYTES = 2048` and deterministic server ordering.

- [ ] **Step 1: Write failing prefix-stability tests**

Build two `execute` tools from different MCP catalogs and assert their provider-visible name, description, input schema, and output schema are deeply equal. Assert runtime search results still differ and expose the correct catalog.

- [ ] **Step 2: Run focused tests red**

```bash
cd packages/codemode
bun test test/codemode.test.ts
cd ../core
bun test test/tool-execute.test.ts test/session-runner-cache.test.ts test/mcp.test.ts
```

Expected: FAIL because `execute.description` embeds the catalog.

- [ ] **Step 3: Separate fixed provider prompt from runtime discovery state**

Move the fixed language/workflow description into `discovery-prompt.ts`. `CodeMode.make()` still prepares catalog/search state, but `ExecuteTool.create()` uses the fixed description instead of `discovery.instructions()`.

- [ ] **Step 4: Keep prompt-cache namespace stable across MCP catalog changes**

Verify `SessionRunnerCache.promptCacheNamespace()` sees the same single `execute` definition when only CodeMode registrations change. Direct non-CodeMode tool changes must still change the digest.

- [ ] **Step 5: Bound and normalize MCP instructions**

Sort by server ID, normalize line endings, trim trailing whitespace, and truncate each server instruction block at 2048 UTF-8 bytes with an explicit truncation marker. Keep the final text behaviorally meaningful and deterministic.

- [ ] **Step 6: Verify full Codemode/Core suites and commit**

```bash
cd packages/codemode
bun run typecheck
bun test
cd ../core
bun test test/tool-execute.test.ts test/session-runner-cache.test.ts test/mcp.test.ts
bun run typecheck
bun test
```

Commit:

```bash
git add packages/codemode packages/core/src/tool/execute.ts packages/core/src/tool/registry.ts packages/core/src/mcp/instructions.ts packages/core/src/session/runner/cache.ts packages/core/test/tool-execute.test.ts packages/core/test/session-runner-cache.test.ts packages/core/test/mcp.test.ts docs/runtime.md
git commit -m "fix(cache): stabilize provider tool prefix"
```

---

### Task 5: Adaptive Anthropic TTL and explicit OpenAI caching

**Files:**

- Create: `packages/core/src/session/runner/cache-runtime.ts`
- Modify: `packages/core/src/session/model-request.ts`
- Modify: `packages/core/src/session/runner/cache.ts`
- Modify: `packages/ai/src/cache-policy.ts`
- Modify: `packages/ai/src/protocols/utils/openai-options.ts`
- Modify: `packages/ai/src/protocols/openai-chat.ts`
- Modify: `packages/ai/src/protocols/openai-responses.ts`
- Modify: `packages/ai/test/cache-policy.test.ts`
- Modify: `packages/ai/test/provider/openai-chat.test.ts`
- Modify: `packages/ai/test/provider/openai-responses.test.ts`
- Modify: `packages/core/test/session-runner-cache.test.ts`
- Modify: `packages/core/test/session-model-request.test.ts`
- Modify: `docs/runtime.md`
- Modify: `docs/configuration.md`

**Interfaces:**

- Produces `SessionCacheRuntime.Service`:

```ts
export interface Interface {
  readonly policy: (input: {
    namespace: string
    modelID: string
    configured: "adaptive" | "5m" | "1h"
    now?: number
  }) => Effect.Effect<{ ttlSeconds: 300 | 3600; promoted: boolean }>
  readonly observe: (input: {
    namespace: string
    cacheRead: number
    cacheWrite: number
    eligible: number
    now?: number
  }) => Effect.Effect<void>
}
```

- Adaptive promotion requires two eligible observations of the same namespace within five minutes. A namespace change or no reusable provider report clears promotion.
- OpenAI Core options become:

```ts
openai: {
  promptCacheKey,
  promptCacheOptions: isExplicit ? { mode: "explicit" } : undefined,
  promptCacheRetention: extendedRetention ? "24h" : undefined,
}
```

- [ ] **Step 1: Write failing adaptive-state tests**

Use a deterministic clock. Assert first and second observations remain 5m, the third request after two observations promotes to 1h, namespace changes reset, and explicit overrides bypass state.

- [ ] **Step 2: Run Core tests red**

```bash
cd packages/core
bun test test/session-runner-cache.test.ts test/session-model-request.test.ts
```

- [ ] **Step 3: Implement process-local cache runtime**

Use a bounded map keyed by namespace. Cap entries at 1024 and evict least-recently-observed entries. This state is never persisted and never required for correctness.

- [ ] **Step 4: Feed adaptive TTL into `LLMRequest.cache`**

For Anthropic-compatible inline routes, set a concrete object policy with tools/system/message placement and the selected TTL. Keep manual per-part hints authoritative.

- [ ] **Step 5: Write failing OpenAI explicit-body tests**

Assert GPT-5.6+ gets `prompt_cache_options.mode = "explicit"` and explicit breakpoint fields; pre-5.6 gets no unsupported options; explicit override on unsupported routes falls back with diagnostic metadata rather than a 400.

- [ ] **Step 6: Implement OpenAI mode/retention routing**

Extend `SessionRunnerCache.providerOptions()` to accept efficiency policy and model family. Reuse current protocol family gating. `openai_extended_retention` remains false by default.

- [ ] **Step 7: Feed provider observations back into adaptive state**

After each step/helper settlement, call `SessionCacheRuntime.observe()` with normalized read/write/eligible counts. Provider-not-reported does not falsely promote.

- [ ] **Step 8: Run AI/Core suites and recorded cache tests**

```bash
cd packages/ai
bun test test/cache-policy.test.ts test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts
bun run typecheck
bun test
cd ../core
bun test test/session-runner-cache.test.ts test/session-model-request.test.ts
bun run typecheck
bun test
```

Run recorded provider tests only when credentials are available; absence of credentials is a documented skip, not a pass claim.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/session/runner/cache-runtime.ts packages/core/src/session/model-request.ts packages/core/src/session/runner/cache.ts packages/core/test/session-runner-cache.test.ts packages/core/test/session-model-request.test.ts packages/ai/src/cache-policy.ts packages/ai/src/protocols packages/ai/test docs/runtime.md docs/configuration.md
git commit -m "feat(cache): adapt provider prompt caching"
```

---

### Task 6: Guarded OpenAI Responses same-turn continuation

**Files:**

- Modify: `packages/ai/src/providers/openai-options.ts`
- Modify: `packages/ai/src/protocols/utils/openai-options.ts`
- Modify: `packages/ai/src/protocols/openai-responses.ts`
- Modify: `packages/ai/test/provider/openai-responses.test.ts`
- Create: `packages/core/src/session/runner/continuation.ts`
- Modify: `packages/core/src/session/model-request.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Modify: `packages/core/src/location-services.ts`
- Test: `packages/core/test/session-continuation.test.ts`
- Modify: `packages/core/test/session-runner.test.ts`
- Modify: `docs/runtime.md`
- Modify: `docs/configuration.md`

**Interfaces:**

- Adds provider options:

```ts
readonly previousResponseId?: string
readonly continuationInputStart?: number
```

- Adds `previous_response_id` to OpenAI Responses HTTP and WebSocket request schemas.
- Produces `SessionContinuation.Service`:

```ts
export interface Fingerprint {
  readonly sessionID: Session.ID
  readonly execution: number
  readonly routeID: string
  readonly model: Model.Ref
  readonly promptCacheKey: string
  readonly systemDigest: string
  readonly toolDigest: string
  readonly optionsDigest: string
}

export interface State extends Fingerprint {
  readonly responseID: string
  readonly representedMessages: number
}

export interface Interface {
  readonly select: (
    input: Fingerprint & { mode: "auto" | "on" | "off"; store: boolean },
  ) => Effect.Effect<State | undefined>
  readonly remember: (state: State) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
}
```

- [ ] **Step 1: Write failing protocol lowering tests**

Assert `previousResponseId` lowers to `previous_response_id`, `continuationInputStart` slices only the message input portion, and system/tools remain present. Assert options are omitted when absent.

- [ ] **Step 2: Run AI test red**

```bash
cd packages/ai
bun test test/provider/openai-responses.test.ts
```

- [ ] **Step 3: Implement Responses continuation fields**

Add schema fields to both HTTP and WebSocket bodies. Lower only when the route is OpenAI Responses and effective `store` is true.

- [ ] **Step 4: Write failing Core continuation tests**

Cover:

- first step uses full request;
- second compatible step uses prior response ID and only new tool-result messages;
- `store: false` never continues;
- system, tool, model, route, namespace, compaction, or execution changes force full request;
- provider invalid-request clears state and retries once with full history;
- second failure follows the existing provider error path.

- [ ] **Step 5: Implement process-local continuation service**

Scope state to one active execution generation. Never persist it. Clear on execution end, interruption, compaction, Session deletion, and incompatible request fingerprint.

- [ ] **Step 6: Capture response IDs and represented boundaries**

Use `stepFinish.providerMetadata.openai.responseId` already emitted by the OpenAI Responses parser. Remember state only after a clean step finish. Record continuation/full/fallback in the request ledger.

- [ ] **Step 7: Implement one-time canonical fallback**

When a continued request receives an invalid-request/provider-state error, clear state and rerun the same logical step with the original full prepared request. The request ledger records one logical request, two physical attempts, and continuation `fallback`.

- [ ] **Step 8: Verify AI/Core suites and commit**

```bash
cd packages/ai
bun test test/provider/openai-responses.test.ts
bun run typecheck
cd ../core
bun test test/session-continuation.test.ts test/session-runner.test.ts
bun run typecheck
bun test
```

Commit:

```bash
git add packages/ai/src/providers/openai-options.ts packages/ai/src/protocols/utils/openai-options.ts packages/ai/src/protocols/openai-responses.ts packages/ai/test/provider/openai-responses.test.ts packages/core/src/session/runner/continuation.ts packages/core/src/session/model-request.ts packages/core/src/session/runner/llm.ts packages/core/src/location-services.ts packages/core/test/session-continuation.test.ts packages/core/test/session-runner.test.ts docs/runtime.md docs/configuration.md
git commit -m "feat(openai): continue compatible response turns"
```

---

### Task 7: Expose request amplification and estimated cost

**Files:**

- Modify: `packages/schema/src/session-cache-diagnostics.ts`
- Modify: `packages/protocol/src/groups/session.ts`
- Modify: `packages/server/src/handlers/session.ts`
- Regenerate: `packages/client/src/effect/generated/**`
- Regenerate: `packages/client/src/promise/generated/**`
- Modify: `packages/tui/src/routes/session/provider-usage.tsx`
- Modify: `packages/tui/src/util/provider-usage.ts`
- Modify: `packages/tui/src/component/dialog-session-cache.tsx`
- Modify: `packages/tui/test/cli/tui/provider-usage-command.test.tsx`
- Modify: `packages/tui/test/util/cache-diagnostics.test.ts`
- Modify: `packages/client/test/promise.test.ts`
- Modify: `docs/runtime.md`

**Interfaces:**

- Session diagnostics include logical/physical/helper/continuation/fallback counters and the latest invalidation reason.
- Add a Session provider-request list endpoint only if the existing diagnostics endpoint cannot supply the bounded summary. The default response must remain bounded and contain no prompt content.
- Provider usage dialog adds a local `YCoding requests` section beside external quota windows.

- [ ] **Step 1: Write failing TUI presentation tests**

Assert the dialog distinguishes:

```text
Logical requests  6
Transport attempts 7
Helpers           1
Continued         3
Fallbacks         1
Raw cache read    18.2k tokens
Estimated cost    $0.0421
Last invalidation Tool prefix changed
```

Unknown pricing renders `Estimated cost unavailable`; it never renders `$0.00`.

- [ ] **Step 2: Run tests red**

```bash
cd packages/tui
bun test test/cli/tui/provider-usage-command.test.tsx test/util/cache-diagnostics.test.ts
```

- [ ] **Step 3: Extend bounded diagnostics contracts**

Use existing Session diagnostics when possible. If adding an endpoint, add it through Schema, Protocol, Server, and generated Client ownership; do not hand-edit generated output.

- [ ] **Step 4: Implement TUI request/cost sections**

Keep quota data and local request telemetry visually separate. Label raw tokens, cache categories, and estimated cost explicitly. Show the last prompt-cache namespace prefix only as an 8-character digest, not a full hash.

- [ ] **Step 5: Regenerate Client output**

```bash
cd packages/client
bun run generate
```

Review generated diff for only the intended contract changes.

- [ ] **Step 6: Verify TUI/Client/Server tests and commit**

```bash
cd packages/client
bun test
bun run typecheck
cd ../server
bun test
bun run typecheck
cd ../tui
bun test test/cli/tui/provider-usage-command.test.tsx test/util/cache-diagnostics.test.ts
bun run typecheck
bun test
```

Commit:

```bash
git add packages/schema packages/protocol packages/server packages/client packages/tui docs/runtime.md
git commit -m "feat(tui): explain provider request cost"
```

---

### Task 8: Final verification and provider-efficiency report

**Files:**

- Create: `docs/provider-efficiency.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/2026-07-28-provider-efficiency-program.md` to mark every completed step.

**Interfaces:**

- `docs/provider-efficiency.md` documents defaults, provider capability matrix, privacy behavior, diagnostics interpretation, and a reproducible measurement procedure.

- [ ] **Step 1: Add deterministic benchmark fixtures**

Create or extend a runtime smoke scenario that performs:

1. a new normal Session first prompt;
2. two tool continuations;
3. a second Session with the same stable prefix;
4. an MCP catalog change that must not change the CodeMode tool digest;
5. an OpenAI stored continuation scenario using a fake Responses provider.

Assert request counts, cache namespace equality, attempt counts, continuation fallback, and raw/cost accounting.

- [ ] **Step 2: Run all affected package suites**

```bash
cd packages/ai && bun test && bun run typecheck
cd ../codemode && bun test && bun run typecheck
cd ../schema && bun test && bun run typecheck
cd ../core && bun test && bun run typecheck
cd ../protocol && bun test && bun run typecheck
cd ../server && bun test && bun run typecheck
cd ../client && bun test && bun run typecheck
cd ../tui && bun test && bun run typecheck
```

- [ ] **Step 3: Run repository gates and compiled artifact checks**

```bash
cd ../..
bun run typecheck
bun run lint
bun run lint:effect-patterns
bun run check:ycoding-workspace
bun run check:ycoding-brand
bun run build:tui
bun run smoke:tui
bun run smoke:runtime
git diff --check
```

Lint may print existing warnings but must exit 0.

- [ ] **Step 4: Run recorded provider verification when credentials exist**

Run the Anthropic and OpenAI cache recording tests. Record exact read/write tokens and request counts in a local report. Do not commit credentials or raw provider payloads. When credentials are absent, state that recorded-provider verification was skipped and rely only on deterministic tests.

- [ ] **Step 5: Write the provider-efficiency guide**

Document:

- defaults and how to restore model title/goal behavior;
- adaptive Anthropic TTL state;
- OpenAI explicit mode and extended-retention privacy implications;
- continuation prerequisites and fallback;
- how request counts differ from raw tokens and estimated cost;
- how to diagnose prefix invalidation and MCP/tool churn;
- a before/after measurement procedure using the same model, prompt, tools, and Session length.

- [ ] **Step 6: Mark the plan complete and commit**

```bash
git add docs/provider-efficiency.md docs/README.md docs/superpowers/plans/2026-07-28-provider-efficiency-program.md packages/cli/script/runtime-smoke.ts
git commit -m "docs: complete provider efficiency program"
```

- [ ] **Step 7: Confirm final repository state**

```bash
git status --short --branch
git log -10 --oneline
git diff --check HEAD~8..HEAD
```

Expected: clean feature worktree with eight scoped implementation/documentation commits after the design and plan commits.
