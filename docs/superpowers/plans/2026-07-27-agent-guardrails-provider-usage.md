# Agent Guardrails and Provider Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow configured and managed subagents to use shell through explicit permissions, enforce root-Session guardrails at every supported side-effect boundary, and render provider-reported Claude, Codex, OpenRouter, and OpenAI usage in the TUI sidebar.

**Architecture:** Managed-agent permissions remain part of the existing agent/permission system. A new Location-scoped `SessionGuardrail` service resolves a root Session family, evaluates code-owned and global custom rules, owns pending human-review requests, and maintains family counters. A separate read-only `ProviderUsage` service normalizes stable APIs, official local client RPCs, response headers, and isolated best-effort provider endpoints behind provider-specific adapters and a stale-safe cache.

**Tech Stack:** TypeScript, Bun 1.3.14, Effect 4 beta, Effect Schema, Effect HttpApi, SolidJS, OpenTUI, Drizzle SQLite, generated Effect and Promise clients.

## Global Constraints

- Work only in `.worktrees/agent-guardrails` on branch `agent-guardrails`.
- Preserve V2-only Session, Location, Protocol, generated Client, and TUI boundaries.
- Guardrails apply to the root Session and every descendant; they are not a subagent-only feature.
- Agent permissions, Session guardrails, shell sandboxing, and provider usage remain separate concepts.
- `yolo` and `goal` modes never auto-approve guardrail reviews.
- Parent permission ceilings remain deny-only and cannot be widened by child configuration.
- Standard catastrophic denies cannot be weakened by custom rules.
- Invalid enabled custom guardrails fail closed for mutation actions.
- Provider usage is best effort and never blocks Session startup or model execution.
- Credentials, access tokens, API keys, account emails, and full organization identifiers never enter durable events, Protocol responses, logs, snapshots, or sidebar text.
- Generated Client output is changed only by `bun run --cwd packages/client generate`.
- Every behavior task follows red-green-refactor and ends with a conventional commit.

---

### Task 1: Managed Subagent Permission Rules

**Files:**
- Modify: `packages/schema/src/project-artifact.ts`
- Modify: `packages/core/src/project-artifact/adapter/agent.ts`
- Modify: `packages/core/src/project-artifact/validation.ts`
- Modify: `packages/core/src/tool/project-artifact.ts`
- Modify: `packages/core/test/project-artifact-adapter.test.ts`
- Modify: `packages/core/test/project-artifact-source.test.ts`
- Modify: `packages/core/test/tool-subagent.test.ts`

**Interfaces:**
- Consumes: `Permission.Ruleset`, `PermissionV2.merge`, existing agent activation draft.
- Produces: `ProjectArtifact.AgentDefinition.permissions: Permission.Ruleset`; `AgentAdapter.managedDefaults: Permission.Ruleset`; activated agents retain ordered explicit rules after safe defaults.

- [ ] **Step 1: Write failing schema and adapter tests**

Add tests proving a project-artifact agent accepts ordered `shell` rules, render/parse preserves them, activation uses safe defaults followed by explicit rules, and a parent deny ceiling still blocks shell.

```ts
const definition: ProjectArtifact.AgentDefinition = {
  kind: "agent",
  name: "Builder",
  description: "Runs focused verification",
  system: "Run the requested task.",
  mode: "subagent",
  permissions: [
    { action: "shell", resource: "bun test*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
  ],
}
```

- [ ] **Step 2: Run focused tests and confirm the current deny-all behavior fails them**

Run:

```bash
bun test packages/core/test/project-artifact-adapter.test.ts packages/core/test/project-artifact-source.test.ts packages/core/test/tool-subagent.test.ts
```

Expected: FAIL because `AgentDefinition.permissions` rejects values and activation replaces permissions with deny-all.

- [ ] **Step 3: Change the public agent definition schema**

Replace `Schema.Array(Schema.Never)` with `Permission.Ruleset` and import `Permission` from `./permission.js`.

- [ ] **Step 4: Implement safe managed-agent defaults**

Export this adapter-owned ruleset and merge explicit rules after it:

```ts
export const managedDefaults: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "write", resource: "*", effect: "ask" },
  { action: "patch", resource: "*", effect: "ask" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "deny" },
]
```

Render real YAML permission entries, parse `markdown.data.permissions`, and activate with `PermissionV2.merge(managedDefaults, definition.permissions)`.

- [ ] **Step 5: Remove empty-permission validation assumptions and unsafe casts**

Update validation and `tool/project-artifact.ts` so agent definitions accept validated permission rules without `as []` casts.

- [ ] **Step 6: Run focused tests and package typechecks**

```bash
bun test packages/core/test/project-artifact-adapter.test.ts packages/core/test/project-artifact-source.test.ts packages/core/test/tool-subagent.test.ts
bun run --cwd packages/schema typecheck
bun run --cwd packages/core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/project-artifact.ts packages/core/src/project-artifact packages/core/src/tool/project-artifact.ts packages/core/test/project-artifact-adapter.test.ts packages/core/test/project-artifact-source.test.ts packages/core/test/tool-subagent.test.ts
git commit -m "feat(core): allow managed agent permissions"
```

### Task 2: Guardrail Public Contracts and Config Parsing

**Files:**
- Create: `packages/schema/src/guardrail.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/event-manifest.ts`
- Create: `packages/core/src/config/guardrail.ts`
- Modify: `packages/core/src/config.ts`
- Create: `packages/core/test/config/guardrail.test.ts`
- Create: `packages/core/test/guardrail-schema.test.ts`

**Interfaces:**
- Produces: `Guardrail.Rule`, `Guardrail.Profile`, `Guardrail.Request`, `Guardrail.Reply`, `Guardrail.Decision`, `Guardrail.Status`, `Guardrail.Event`; `ConfigGuardrail.Info` for caps and custom-rule settings.

- [ ] **Step 1: Write failing schema/config tests**

Cover omitted optional fields, invalid decisions, non-empty actions/resources, deterministic default priority, duplicate IDs, custom directory discovery under `Global.Service.config/guardrails`, and malformed enabled files.

- [ ] **Step 2: Run tests and confirm missing modules fail**

```bash
bun test packages/core/test/config/guardrail.test.ts packages/core/test/guardrail-schema.test.ts
```

- [ ] **Step 3: Add browser-safe schemas**

Define closed decisions `allow | ask | deny | cap_exceeded`, stability-safe request/reply payloads, counter snapshots, and ephemeral asked/replied events. Use canonical IDs with `grd_` and `grq_` prefixes.

- [ ] **Step 4: Add config module**

Create `ConfigGuardrail.Info`:

```ts
export class Info extends Schema.Class<Info>("Config.Guardrail")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  max_concurrent_shells: PositiveInt.pipe(Schema.optional),
  max_concurrent_subagents: PositiveInt.pipe(Schema.optional),
  max_pending_reviews: PositiveInt.pipe(Schema.optional),
  max_cost_usd: Schema.Finite.pipe(Schema.optional),
  max_steps: PositiveInt.pipe(Schema.optional),
  max_tool_calls: PositiveInt.pipe(Schema.optional),
  max_file_mutations: PositiveInt.pipe(Schema.optional),
  max_network_actions: PositiveInt.pipe(Schema.optional),
}) {}
```

Expose `guardrails: ConfigGuardrail.Info.pipe(Schema.optional)` from `Config.Info` and preserve the self-export pattern.

- [ ] **Step 5: Implement custom Markdown parser**

Parse sorted `guardrails/*.md` files with `ConfigMarkdown`, validate unique IDs, preserve source path and body explanation, and return explicit diagnostics rather than silently dropping malformed enabled files.

- [ ] **Step 6: Run tests and typechecks**

```bash
bun test packages/core/test/config/guardrail.test.ts packages/core/test/guardrail-schema.test.ts
bun run --cwd packages/schema typecheck
bun run --cwd packages/core typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/guardrail.ts packages/schema/src/index.ts packages/schema/src/event-manifest.ts packages/core/src/config/guardrail.ts packages/core/src/config.ts packages/core/test/config/guardrail.test.ts packages/core/test/guardrail-schema.test.ts
git commit -m "feat(schema): add session guardrail contracts"
```

### Task 3: Session Guardrail Matcher, Requests, and Family Counters

**Files:**
- Create: `packages/core/src/session/guardrail.ts`
- Create: `packages/core/src/session/guardrail-standard.ts`
- Create: `packages/core/src/session/guardrail-match.ts`
- Create: `packages/core/src/session/guardrail-counter.ts`
- Modify: `packages/core/src/location-services.ts`
- Create: `packages/core/test/session-guardrail.test.ts`
- Create: `packages/core/test/session-guardrail-counter.test.ts`

**Interfaces:**
- Produces:

```ts
export interface EvaluateInput {
  readonly sessionID: SessionSchema.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly source?: Guardrail.Source
}

export interface Reservation {
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<Guardrail.Decision, SessionErrors.NotFoundError>
  readonly assert: (input: EvaluateInput) => Effect.Effect<Reservation, GuardrailError | SessionErrors.NotFoundError>
  readonly reply: (input: Guardrail.ReplyInput) => Effect.Effect<void, RequestNotFound>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Guardrail.Request>>
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Guardrail.Status, SessionErrors.NotFoundError>
}
```

- [ ] **Step 1: Write matcher and counter tests**

Cover catastrophic command denial, mandatory approval, lexical/priority precedence, malformed-policy fail-closed behavior, root-family resolution, shell/subagent reservations, pending-review cap, release after interruption, and `yolo`/`goal` preserving asks.

- [ ] **Step 2: Run tests and confirm missing services fail**

```bash
bun test packages/core/test/session-guardrail.test.ts packages/core/test/session-guardrail-counter.test.ts
```

- [ ] **Step 3: Implement conservative standard matchers**

Keep command matching in `guardrail-standard.ts`. Normalize whitespace and executable basename, but do not claim shell-language completeness. Hard-deny only direct catastrophic forms; classify ambiguous mutations as `ask`.

- [ ] **Step 4: Implement deterministic precedence**

Return all matched IDs for audit, then choose by precedence: standard hard deny, custom deny, standard ask, custom ask, custom allow, fallback allow. Equal priority sorts by source path then original rule index.

- [ ] **Step 5: Implement root-family and counters**

Walk `parentID` through `SessionStore` to the root. Key family counters by root ID. Reserve before side effects, return an idempotent release Effect, and release from `Effect.ensuring`/`onInterrupt` call sites.

- [ ] **Step 6: Implement pending human reviews**

Use `Deferred` and ephemeral Guardrail events, parallel to `PermissionV2` but without autonomy auto-approval and without `Always` for standard mandatory rules. Reject pending requests on service shutdown.

- [ ] **Step 7: Register the Location node**

Add `SessionGuardrail.node` after `PermissionV2.node` and before tool registry consumers in `location-services.ts`.

- [ ] **Step 8: Run tests and typecheck**

```bash
bun test packages/core/test/session-guardrail.test.ts packages/core/test/session-guardrail-counter.test.ts
bun run --cwd packages/core typecheck
```

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/session/guardrail* packages/core/src/location-services.ts packages/core/test/session-guardrail*.test.ts
git commit -m "feat(core): add session guardrail service"
```

### Task 4: Guard Shell, File Mutation, Subagent, MCP, and Artifact Boundaries

**Files:**
- Modify: `packages/core/src/tool/shell.ts`
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/tool/edit.ts`
- Modify: `packages/core/src/tool/write.ts`
- Modify: `packages/core/src/tool/patch.ts`
- Modify: `packages/core/src/location-mutation.ts`
- Modify: `packages/core/src/tool/subagent.ts`
- Modify: `packages/core/src/tool/mcp.ts`
- Modify: `packages/core/src/tool/project-artifact.ts`
- Modify: `packages/core/test/tool-shell.test.ts`
- Modify: `packages/core/test/shell.test.ts`
- Modify: `packages/core/test/tool-edit.test.ts`
- Modify: `packages/core/test/tool-write.test.ts`
- Modify: `packages/core/test/tool-patch.test.ts`
- Modify: `packages/core/test/tool-subagent.test.ts`
- Modify: `packages/core/test/mcp.test.ts`
- Modify: `packages/core/test/tool-project-artifact.test.ts`

**Interfaces:**
- Consumes: `SessionGuardrail.Service.assert(...)` and `Reservation.release`.
- Produces: guarded mutation paths with no side effect before permission and guardrail approval.

- [ ] **Step 1: Add failing integration tests for each boundary**

Use real services/fixtures. Assert denied/asked operations do not spawn a shell, mutate a file, launch a child, invoke an MCP mutation, or modify an artifact.

- [ ] **Step 2: Run focused integration tests and capture failures**

```bash
bun test packages/core/test/tool-shell.test.ts packages/core/test/shell.test.ts packages/core/test/tool-edit.test.ts packages/core/test/tool-write.test.ts packages/core/test/tool-patch.test.ts packages/core/test/tool-subagent.test.ts packages/core/test/mcp.test.ts packages/core/test/tool-project-artifact.test.ts
```

- [ ] **Step 3: Guard shell tool and direct Session shell**

Order: validate, permission, guardrail assert, sandbox prepare, spawn. Wrap running reservation release in `Effect.ensuring`. Direct `Session.shell` uses the same `action: "shell"` and raw command resource.

- [ ] **Step 4: Guard filesystem mutations**

Use `action: "file_mutation"` with canonical absolute paths and operation metadata. Do not duplicate permission evaluation.

- [ ] **Step 5: Guard subagent launch and process-like MCP tools**

Reserve the subagent family cap immediately before durable child creation. MCP tools classified as backgroundable/process-like use `action: "mcp_execute"`; other mutation tools use `mcp_mutation` only when their registration metadata identifies mutation.

- [ ] **Step 6: Guard project-artifact mutations**

Use one `project_artifact_mutation` assertion after validation/preview-token verification and before store mutation.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
bun test packages/core/test/tool-shell.test.ts packages/core/test/shell.test.ts packages/core/test/tool-edit.test.ts packages/core/test/tool-write.test.ts packages/core/test/tool-patch.test.ts packages/core/test/tool-subagent.test.ts packages/core/test/mcp.test.ts packages/core/test/tool-project-artifact.test.ts
bun run --cwd packages/core typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tool packages/core/src/session.ts packages/core/src/location-mutation.ts packages/core/test
git commit -m "feat(core): enforce guardrails at mutation boundaries"
```

### Task 5: Guardrail Protocol, Server, and Generated Clients

**Files:**
- Create: `packages/protocol/src/groups/guardrail.ts`
- Modify: `packages/protocol/src/api.ts`
- Create: `packages/server/src/handlers/guardrail.ts`
- Modify: `packages/server/src/handlers.ts`
- Create: `packages/server/test/guardrail.test.ts`
- Generated: `packages/client/src/promise/generated/**`
- Generated: `packages/client/src/effect/generated/**`
- Generated: `packages/client/src/effect/api/**`

**Interfaces:**
- Produces endpoints:
  - `GET /api/session/:sessionID/guardrail`
  - `GET /api/session/:sessionID/guardrail/request`
  - `POST /api/session/:sessionID/guardrail/request/:requestID/reply`

- [ ] **Step 1: Write failing Protocol/Server tests**

Cover ownership, wrong-Session reply rejection, status/counters, and request reply schema.

- [ ] **Step 2: Add mixed-middleware guardrail group**

Follow `makePermissionGroup` placement so Session Location middleware owns the service context.

- [ ] **Step 3: Add Server handlers**

Resolve `SessionGuardrail.Service` from Session Location and map typed errors without leaking metadata.

- [ ] **Step 4: Generate clients**

```bash
bun run --cwd packages/client generate
bun run --cwd packages/client check:generated
```

- [ ] **Step 5: Run tests/typechecks**

```bash
bun test packages/server/test/guardrail.test.ts
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client test
bun run --cwd packages/client typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/protocol packages/server packages/client/src
git commit -m "feat(server): expose session guardrails"
```

### Task 6: Provider Usage Contracts, Cache, and Stable Adapters

**Files:**
- Create: `packages/schema/src/provider-usage.ts`
- Modify: `packages/schema/src/index.ts`
- Create: `packages/core/src/provider-usage.ts`
- Create: `packages/core/src/provider-usage/cache.ts`
- Create: `packages/core/src/provider-usage/openrouter.ts`
- Create: `packages/core/src/provider-usage/openai.ts`
- Modify: `packages/core/src/location-services.ts`
- Create: `packages/core/test/provider-usage.test.ts`
- Create: `packages/core/test/provider-usage-openrouter.test.ts`
- Create: `packages/core/test/provider-usage-openai.test.ts`

**Interfaces:**
- Produces `ProviderUsage.Snapshot`, `ProviderUsage.Window`, `ProviderUsage.Status`, and service:

```ts
export interface Interface {
  readonly get: (input: {
    readonly providerID: string
    readonly credentialID?: Credential.ID
    readonly refresh?: boolean
  }) => Effect.Effect<ProviderUsage.Snapshot>
  readonly list: (input?: { readonly refresh?: boolean }) => Effect.Effect<ReadonlyArray<ProviderUsage.Snapshot>>
  readonly observe: (observation: ProviderUsage.Observation) => Effect.Effect<void>
}
```

- [ ] **Step 1: Write failing normalization/cache tests**

Cover no-zero unknowns, stale retention, single-flight refresh, credential-scoped cache keys, Retry-After, redaction, and provider failure isolation.

- [ ] **Step 2: Add public schemas**

Include source `provider_api | local_client_rpc | response_headers | provider_internal_api | local_session` and stability `stable | client_contract | observed | best_effort`.

- [ ] **Step 3: Implement stale-safe cache**

Store successful snapshots by provider and credential ID, never secret value. A refresh failure returns previous data as `stale`; no previous data returns `error`, `unauthorized`, or `unsupported`.

- [ ] **Step 4: Implement OpenRouter adapter**

Use Effect `HttpClient` against documented key and optional management-credit endpoints. Normalize key usage, daily/weekly/monthly usage, limit, remaining, reset, expiration, and account credits.

- [ ] **Step 5: Implement OpenAI organization adapter**

Only activate for explicitly configured admin credentials. Normalize Usage and Costs pagination for UTC week/month without replacing ordinary inference credentials.

- [ ] **Step 6: Register ProviderUsage node and run tests**

```bash
bun test packages/core/test/provider-usage.test.ts packages/core/test/provider-usage-openrouter.test.ts packages/core/test/provider-usage-openai.test.ts
bun run --cwd packages/schema typecheck
bun run --cwd packages/core typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/provider-usage.ts packages/schema/src/index.ts packages/core/src/provider-usage* packages/core/src/location-services.ts packages/core/test/provider-usage*.test.ts
git commit -m "feat(core): add provider usage service"
```

### Task 7: Claude Usage Sources

**Files:**
- Create: `packages/core/src/provider-usage/claude.ts`
- Modify: `packages/core/src/plugin/provider/anthropic-claude-code-account.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Create: `packages/core/test/provider-usage-claude.test.ts`
- Modify: `packages/core/test/plugin/provider-anthropic-claude-code.test.ts`

**Interfaces:**
- Consumes existing refreshed Claude Code OAuth credentials.
- Produces five-hour, seven-day, model-specific weekly, extra-usage, and observed header windows.

- [ ] **Step 1: Write failing fixtures for OAuth and unified headers**

Cover optional buckets, percentage scaling, reset parsing, extra usage, one refresh after 401, 429 stale retention, and header precedence over older OAuth data.

- [ ] **Step 2: Expose a non-secret credential refresh seam**

Add a method that returns refreshed credential data only inside Core; do not expose it through Protocol.

- [ ] **Step 3: Implement OAuth usage adapter**

Call `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`, a five-minute cache, schema-tolerant optional fields, and `best_effort` stability.

- [ ] **Step 4: Capture live unified headers**

At the Core Session runner transport boundary, map only recognized quota headers into `ProviderUsage.observe`. Never store arbitrary response headers.

- [ ] **Step 5: Run tests/typecheck**

```bash
bun test packages/core/test/provider-usage-claude.test.ts packages/core/test/plugin/provider-anthropic-claude-code.test.ts
bun run --cwd packages/core typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/provider-usage/claude.ts packages/core/src/plugin/provider/anthropic-claude-code-account.ts packages/core/src/session/runner/llm.ts packages/core/test/provider-usage-claude.test.ts packages/core/test/plugin/provider-anthropic-claude-code.test.ts
git commit -m "feat(core): collect Claude plan usage"
```

### Task 8: Codex and Spark Usage Sources

**Files:**
- Create: `packages/core/src/provider-usage/codex.ts`
- Modify: `packages/core/src/plugin/provider/openai-codex.ts`
- Modify: `packages/core/src/session/runner/llm.ts`
- Create: `packages/core/test/provider-usage-codex.test.ts`
- Modify: `packages/core/test/plugin/provider-openai.test.ts`

**Interfaces:**
- Produces primary/secondary windows, credits, reset credits, spend controls, and additional named limit IDs such as Spark.

- [ ] **Step 1: Write failing app-server and backend fixtures**

Cover JSON-RPC `account/rateLimits/read`, native backend snapshots, account routing, primary/secondary windows, credit balance, reset-credit fields, credential switching, and unknown additional limit IDs.

- [ ] **Step 2: Implement optional app-server RPC client**

Use configured process/endpoint only; never spawn an unmanaged long-lived Codex process from sidebar render code. Mark source `local_client_rpc`, stability `client_contract`.

- [ ] **Step 3: Implement native authenticated fallback**

Use existing ChatGPT OAuth and account ID against the backend usage service, isolated as `provider_internal_api` and `best_effort`. Cache by credential and account ID.

- [ ] **Step 4: Preserve every named limit**

Render sanitized unknown IDs and map known Spark IDs to `Spark`. Do not collapse additional limits into the global Codex row.

- [ ] **Step 5: Capture newer response observations**

Map recognized Codex limit events/headers into `ProviderUsage.observe` without storing arbitrary transport metadata.

- [ ] **Step 6: Run tests/typecheck**

```bash
bun test packages/core/test/provider-usage-codex.test.ts packages/core/test/plugin/provider-openai.test.ts
bun run --cwd packages/core typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/provider-usage/codex.ts packages/core/src/plugin/provider/openai-codex.ts packages/core/src/session/runner/llm.ts packages/core/test/provider-usage-codex.test.ts packages/core/test/plugin/provider-openai.test.ts
git commit -m "feat(core): collect Codex and Spark usage"
```

### Task 9: Provider Usage Protocol, Server, and Generated Clients

**Files:**
- Create: `packages/protocol/src/groups/provider-usage.ts`
- Modify: `packages/protocol/src/api.ts`
- Create: `packages/server/src/handlers/provider-usage.ts`
- Modify: `packages/server/src/handlers.ts`
- Create: `packages/server/test/provider-usage.test.ts`
- Generated: `packages/client/src/promise/generated/**`
- Generated: `packages/client/src/effect/generated/**`
- Generated: `packages/client/src/effect/api/**`

**Interfaces:**
- Produces:
  - `GET /api/provider/usage`
  - `GET /api/provider/:providerID/usage`
  - optional `refresh=true` query.

- [ ] **Step 1: Write failing Server tests**

Prove Location scoping, safe labels, redaction, refresh behavior, and provider failure isolation.

- [ ] **Step 2: Add Location-scoped Protocol group and handlers**

Return only normalized schema values. Never return credential IDs unless represented by an opaque safe account label.

- [ ] **Step 3: Regenerate clients and verify**

```bash
bun run --cwd packages/client generate
bun run --cwd packages/client check:generated
```

- [ ] **Step 4: Run tests/typechecks**

```bash
bun test packages/server/test/provider-usage.test.ts
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client test
bun run --cwd packages/client typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/server packages/client/src
git commit -m "feat(server): expose provider usage"
```

### Task 10: TUI Data, Guardrail Blocker, and Sidebar Rendering

**Files:**
- Modify: `packages/tui/src/context/data.tsx`
- Create: `packages/tui/src/feature-plugins/sidebar/guardrails.tsx`
- Create: `packages/tui/src/feature-plugins/sidebar/provider-usage.tsx`
- Modify: `packages/tui/src/feature-plugins/builtins.ts`
- Create: `packages/tui/src/routes/session/guardrail.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx`
- Modify: `packages/tui/src/routes/session/sidebar.tsx`
- Create: `packages/tui/src/util/provider-usage.ts`
- Create: `packages/tui/test/cli/tui/provider-usage-sidebar.test.tsx`
- Create: `packages/tui/test/cli/tui/guardrail.test.tsx`
- Modify: `packages/tui/test/cli/tui/data.test.tsx`

**Interfaces:**
- Consumes generated `guardrail` and `providerUsage` clients.
- Produces compact and expanded provider rows plus distinct guardrail review UI.

- [ ] **Step 1: Write failing render/data tests**

Cover ten-cell bars, 70/90 warning thresholds, unknown limit as `Not reported`, relative/absolute reset formatting, active provider first, stale/best-effort labels, separate Spark row, guardrail acting-child attribution, and rehydration.

- [ ] **Step 2: Add canonical data caches**

Store guardrail status/requests by Session ID and provider snapshots by Location/provider. Sync on route startup and invalidate on relevant events. Do not store secrets.

- [ ] **Step 3: Add guardrail blocker**

Use labels `Session guardrail review`, `Approve once`, and `Reject`. Do not expose `Always` for standard mandatory matches. Ensure parent views can answer child requests.

- [ ] **Step 4: Render provider usage sidebar plugin**

Use a compact summary by default:

```text
Provider usage
Claude   5h 68% · 7d 27%
Codex    5h 38% · 7d 16%
Spark    7% · $18.50
Router   $14.50 left
```

Expanded rows use a ten-cell bar, safe labels, source/freshness, and reset timestamps. Active Session provider sorts first.

- [ ] **Step 5: Render guardrail sidebar plugin**

Show profile, custom count, approvals/blocked counts, shell/subagent caps, and invalid-file state without raw commands.

- [ ] **Step 6: Run TUI tests/typecheck**

```bash
bun test packages/tui/test/cli/tui/provider-usage-sidebar.test.tsx packages/tui/test/cli/tui/guardrail.test.tsx packages/tui/test/cli/tui/data.test.tsx
bun run --cwd packages/tui typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src packages/tui/test/cli/tui
git commit -m "feat(tui): show guardrails and provider usage"
```

### Task 11: Documentation and Complete Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runtime.md`
- Modify: `docs/architecture.md`
- Modify: `docs/product-direction.md`
- Modify: `docs/upstream-differences.md`
- Modify or create: `docs/configuration.md`
- Create: `specs/v2/session-guardrails.md`
- Create: `specs/v2/provider-usage.md`
- Modify: `specs/v2/README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces user/operator documentation that exactly matches verified implementation and source stability.

- [ ] **Step 1: Update documentation with implemented status only**

Document agent permission examples, guardrail directory/schema/precedence/caps, provider source/stability labels, sidebar layout, unsupported states, and security boundaries.

- [ ] **Step 2: Run focused neighboring suites**

```bash
bun test packages/core/test/permission.test.ts packages/core/test/session-permission-ceiling.test.ts packages/core/test/session-orchestration.test.ts packages/core/test/tool-shell.test.ts packages/core/test/project-artifact-adapter.test.ts packages/core/test/provider-usage*.test.ts
bun test packages/server/test/guardrail.test.ts packages/server/test/provider-usage.test.ts
bun test packages/tui/test/cli/tui/guardrail.test.tsx packages/tui/test/cli/tui/provider-usage-sidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run generated output and package verification**

```bash
bun run --cwd packages/client check:generated
bun run --cwd packages/schema typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client typecheck
bun run --cwd packages/tui typecheck
```

Expected: PASS.

- [ ] **Step 4: Run repository-wide verification**

```bash
bun run typecheck
bun run lint
bun run lint:effect-patterns
bun run check:ycoding-workspace
bun run check:ycoding-brand
git diff --check
git status --short
git diff --stat main...HEAD
git diff main...HEAD
```

Expected: all commands pass; diff contains no unrelated changes, generated-file hand edits, credentials, placeholders, or mock production behavior.

- [ ] **Step 5: Commit documentation and final verification adjustments**

```bash
git add README.md AGENTS.md docs specs
git commit -m "docs: document guardrails and provider usage"
```

- [ ] **Step 6: Final evidence**

Record exact test counts and command outcomes in the final response. Do not claim completion if any required command fails; report the precise remaining failure and complete all unaffected work.
