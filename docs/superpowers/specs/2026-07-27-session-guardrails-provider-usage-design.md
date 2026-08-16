# Session Guardrails, Subagent Shell Permissions, and Provider Usage

**Status:** Accepted design
**Date:** 2026-07-27  
**Branch:** `agent-guardrails`

## Summary

YCoding will make three related but separate changes:

1. Managed and configured subagents can use the shell tool according to explicit agent permission rules.
2. A new guardrail layer constrains the complete root Session and every descendant Session, independently of agent permissions and autonomy mode.
3. The TUI sidebar displays provider usage from stable provider APIs, official local client protocols, provider response headers, and isolated best-effort internal provider endpoints already used by the providers' own clients. Every value identifies its source and stability; unavailable data is never guessed.

The implementation must preserve the existing V2 Session, Location, permission, durable subagent, Protocol, generated Client, and TUI ownership boundaries.

## Problem Statement

### Managed subagents cannot use shell

Configured agents already accept `Permission.Ruleset` through `ConfigAgent.Info`, and agent markdown files under `agent/` or `agents/` are loaded through the config agent plugin. Managed project-artifact agents are different:

- `ProjectArtifact.AgentDefinition.permissions` is `Schema.Array(Schema.Never)`.
- The project-artifact adapter renders deny-all frontmatter.
- Activation replaces the agent permission list with a deny-all rule.

Therefore a managed subagent cannot be granted shell permission even when the operator wants shell commands to require approval or be allowed selectively.

### Permissions do not express Session-wide safety policy

Agent permissions answer whether one selected agent may attempt one tool action. They do not provide a root-Session policy that:

- applies across agent switches;
- applies to direct shell mode and model tool calls;
- propagates to durable child Sessions;
- remains active in `yolo` and `goal` autonomy modes;
- enforces counters and limits such as maximum concurrent shells or subagents;
- distinguishes catastrophic denial from actions requiring human review.

A separate Session guardrail boundary is required.

### Provider quota information uses different transport surfaces

Provider usage information comes from different sources:

- OpenRouter exposes current-key usage, key limits, and remaining key allowance through a documented API. Account credit totals require a management key.
- OpenAI API organization usage and costs are exposed through documented organization endpoints requiring an admin key.
- Claude Code exposes Claude.ai subscription rate limits in its official status-line payload after the first model response. The underlying model responses also carry unified 5-hour and 7-day rate-limit headers. Claude Code's `/usage` implementation additionally uses Anthropic's OAuth usage endpoint, which is provider-owned but not documented as a stable public API.
- Codex exposes ChatGPT plan limits through its documented local `codex app-server` JSON-RPC method `account/rateLimits/read`. The official Codex source obtains those snapshots from the ChatGPT backend usage service and preserves multiple limit IDs, including model-specific lanes such as Spark when returned.

YCoding must not scrape web dashboards or infer quota percentages. It may adapt provider-owned client behavior when the authenticated user already selected that provider, but internal endpoints must be isolated behind adapters, schema-tolerant, cached conservatively, and labeled as best effort.

## Goals

- Allow shell execution in subagents through normal ordered permission rules.
- Preserve least privilege for newly created managed agents.
- Let users configure agent permissions in agent markdown files or `ycoding.json(c)`.
- Enforce guardrails at the root Session boundary and propagate them to descendants.
- Provide standard protections against catastrophic or high-impact actions.
- Load custom guardrails from `~/.config/ycoding/guardrails`.
- Require human approval for configured high-impact actions even during autonomous execution.
- Enforce configurable Session caps without depending on model compliance.
- Display supported provider usage in the sidebar with freshness and error state.
- Explicitly distinguish `available`, `stale`, `unsupported`, `unauthorized`, and `error` usage states.
- Keep credentials out of durable events, logs, API responses, and TUI state.

## Non-goals

- Guardrails are not a subagent-only feature.
- Guardrails do not replace operating-system shell sandboxing.
- This change does not implement a new shell parser or process sandbox backend.
- This change does not scrape Claude, ChatGPT, Codex, or provider web dashboards. Calling a provider-owned JSON endpoint already used by an official provider client is not dashboard scraping, but it remains best effort unless the provider documents it as stable.
- This change does not invent provider limits from model context windows, request counts, or local cost estimates.
- This change does not add organization billing management or credit purchasing.
- This change does not restore V1 permission behavior.
- This change does not weaken the existing child Session permission ceiling.

## Terminology

### Agent permission

An ordered `Permission.Ruleset` attached to an agent. It controls which tools and resources the selected agent may use. The effective permission evaluation remains agent permissions plus the Session permission ceiling and saved approvals.

### Session guardrail

A policy owned by the root Session execution family. It evaluates attempted actions after permission eligibility is known but before side effects begin. It can allow, require human approval, deny, or reject because a cap is exhausted.

### Root Session family

The root Session and every durable descendant reached through `parentID`. A child Session inherits the root guardrail profile and remaining family-wide caps.

### Provider usage

Read-only provider-reported account, key, or organization usage data. Session-local token and cost telemetry remains a separate diagnostic and is not relabeled as provider quota.

## Design Principles

The guardrail design follows these principles:

- **Least privilege:** grant only required tool functionality and downstream authority.
- **Complete mediation:** evaluate every guarded action at the side-effect boundary rather than relying on model instructions.
- **Human review for high impact:** high-impact actions pause for an explicit operator decision.
- **Fail closed for invalid policy:** malformed enabled custom guardrails do not silently disable the standard profile.
- **Separation of concerns:** permissions, guardrails, shell sandboxing, and provider usage remain separate services and UI concepts.
- **Auditable decisions:** every non-trivial guardrail decision records the matched rule identities and outcome without recording secrets.

These principles are consistent with OWASP guidance on excessive agency and human approval, NIST AI RMF guidance on explicit human oversight, and OpenAI Codex guidance on sandboxing, restricted network access, and approvals.

## Subagent Shell Permissions

### Configured agent files

YCoding already discovers agent definitions from:

- global `~/.config/ycoding/agent/**/*.md` and `~/.config/ycoding/agents/**/*.md` through the XDG-aware global config directory;
- project `.ycoding/agent/**/*.md` and `.ycoding/agents/**/*.md` discovered upward from the active Location;
- the `agents` object in global or project `ycoding.json` and `ycoding.jsonc` documents.

The existing `.agents` compatibility directory supplies skill sources, not agent definitions. Root repository `AGENTS.md` remains an instruction file and is not an agent-definition file.

Example agent definition:

```yaml
---
name: Build helper
description: Runs builds and focused tests
mode: subagent
permissions:
  - action: shell
    resource: "git status*"
    effect: allow
  - action: shell
    resource: "bun test*"
    effect: allow
  - action: shell
    resource: "*"
    effect: ask
---
Run focused implementation and verification tasks.
```

### Managed project-artifact agents

`ProjectArtifact.AgentDefinition.permissions` changes from an impossible array to `Permission.Ruleset`.

The schema, validation, and adapter will:

- accept and validate ordered permission rules;
- render the stored rules into frontmatter;
- parse rules from frontmatter;
- preserve rules during activation;
- stop requiring an empty permission array;
- stop replacing every managed agent with deny-all permissions.

### Safe default for empty managed-agent permissions

An empty managed-agent permission list means “use managed subagent defaults,” not “allow everything.” The defaults are:

| Action | Default |
| --- | --- |
| `read`, `glob`, `grep` | allow |
| `webfetch`, `websearch` | allow |
| `edit`, `write`, `patch` | ask |
| `shell` | ask |
| `question` | allow |
| `subagent` | deny |
| all other actions | deny |

Explicit stored rules are merged after these defaults, so later explicit rules override the default for matching actions and resources. The existing parent permission ceiling still propagates deny rules to the child and cannot be widened by the child agent.

### Shell approval behavior

A subagent shell call follows the same shell tool path as a parent Session:

1. The tool validates input and resolves workdir.
2. Effective agent permission is evaluated.
3. The root Session guardrail evaluates the command and current caps.
4. Any required permission or guardrail approval is surfaced to the TUI.
5. The shell service prepares sandbox behavior.
6. The command is spawned only after all required approvals succeed.

Permission approval does not bypass guardrail approval. Guardrail approval does not grant an agent permission it does not have.

## Session Guardrails

### Ownership

Core adds a `SessionGuardrail` service. It is Location-scoped because it depends on Location config and filesystem discovery, while evaluation is keyed by Session ID and resolves the root Session family through `SessionStore`.

The service interface conceptually provides:

```ts
evaluate(input): Effect<Decision, GuardrailError>
assert(input): Effect<void, GuardrailDenied | GuardrailCapExceeded | SessionNotFound>
reply(input): Effect<void, GuardrailRequestNotFound>
forSession(sessionID): Effect<ReadonlyArray<Request>>
profile(sessionID): Effect<Profile>
```

The exact exported schema names must follow existing package conventions.

### Evaluation order

At each guarded side-effect boundary:

1. Validate the tool input.
2. Evaluate effective agent permission.
3. Resolve the root Session guardrail profile.
4. Match standard and custom guardrail rules.
5. Check family-wide caps.
6. Deny, ask, or reserve cap capacity.
7. Execute the side effect.
8. Release concurrent reservations and record outcome.

A hard guardrail denial wins over permission allow or saved permission approval. A guardrail `ask` remains an ask in `normal`, `yolo`, and `goal` modes.

### Root inheritance

The root Session records the selected guardrail profile identity when created. Child Session creation copies the root guardrail identity rather than recomputing a weaker profile from the child agent.

Existing Sessions without a stored profile resolve the current standard profile lazily and persist it at the next guarded mutation. This avoids a database migration that falsely assigns historical decisions.

Child Sessions share family-wide counters with the root. Per-Session counters remain keyed to the individual Session where specified.

### Decision types

- `allow`: execute without a guardrail prompt.
- `ask`: create a guardrail request requiring a human reply.
- `deny`: reject before side effects.
- `cap_exceeded`: reject because a configured counter or budget is exhausted.

Guardrail prompts are distinct from permission prompts in schema and UI so the operator can tell whether the action lacks agent authorization or violates Session safety policy.

### Standard profile

The standard profile is code-owned, versioned, and covered by tests. It cannot be deleted by custom files.

#### Catastrophic hard denies

The standard profile denies commands that directly target catastrophic host destruction, including normalized equivalents of:

- recursive deletion of filesystem roots or the user home root;
- filesystem formatting and raw block-device writes;
- destructive disk partition operations;
- fork bombs or deliberate unbounded process spawning;
- commands whose stated purpose is disabling, deleting, or bypassing the active YCoding guardrail files or service from within the guarded Session.

The implementation must use a small conservative matcher and tests. It must not claim complete shell-language understanding. Ambiguous commands fall through to approval instead of being classified safe.

#### Mandatory human approval

The standard profile asks before:

- bulk recursive deletion outside known generated directories;
- `git reset --hard`, `git clean`, destructive checkout/restore, and force push;
- publishing packages, releases, or container images;
- production deployment or production namespace mutation;
- database drop, truncate, destructive migration, or broad data deletion;
- IAM, credential, keychain, firewall, security-policy, or access-control mutation;
- exporting secrets or transmitting likely secrets to a network destination;
- writing outside approved workspace/config/data roots;
- commands using an untrusted or previously unseen network destination when network policy can identify it.

The prompt shows the command/action, matched guardrail IDs, reason, scope, and affected resources. It never displays credential values.

#### Standard caps

Defaults:

| Cap | Default | Scope |
| --- | ---: | --- |
| Concurrent running subagents | 8 | root Session family |
| Concurrent running shells | 8 | root Session family |
| Nested subagent depth | existing `experimental.subagent_depth` | Session ancestry |
| Single shell timeout | existing shell maximum | shell process |
| Guardrail prompts pending | 16 | root Session family |

Additional optional caps can be configured but are disabled when omitted:

- maximum Session-family provider cost in USD;
- maximum model steps;
- maximum total tool calls;
- maximum file mutations;
- maximum network actions.

Caps use real runtime counters. Model text, plans, or claimed completion do not affect them.

### Custom guardrail discovery

Global custom guardrails are loaded from:

```text
~/.config/ycoding/guardrails/*.md
```

`Global.Service.config` is the authoritative XDG-aware base, so tests can replace the directory without reading the real home directory.

Files are sorted lexicographically for deterministic loading. Each file contains YAML frontmatter and an optional Markdown explanation.

Example:

```yaml
---
id: protect-production
enabled: true
decision: ask
actions:
  - shell
resources:
  - "kubectl * -n production*"
  - "terraform apply*"
reason: Production infrastructure modification
priority: 100
---
Confirm the target account, cluster, namespace, and change plan before approving.
```

Validated fields:

- `id`: unique stable identifier;
- `enabled`: boolean, default `true`;
- `decision`: `allow`, `ask`, or `deny`;
- `actions`: non-empty action patterns;
- `resources`: non-empty resource patterns;
- `reason`: concise operator-facing reason;
- `priority`: integer, default `0`;
- optional cap definition with explicit unit and scope.

The Markdown body is operator-facing explanatory text and is not model-visible instruction content.

### Rule precedence

Rules are ordered by the following precedence:

1. Standard catastrophic hard denies.
2. Custom denies.
3. Standard mandatory approvals.
4. Custom asks.
5. Custom allows.
6. Standard allow fallback.

Within one precedence class, higher priority wins; equal priority is resolved by lexical file path then rule order. An allow can reduce unnecessary standard fallback prompts but cannot override a standard catastrophic deny or a stricter custom deny.

Malformed enabled files produce a visible configuration diagnostic and cause guardrail evaluation to fail closed with `ask` for actions that would otherwise mutate state. Read-only actions remain available unless the malformed rule explicitly targeted them before validation failed. The TUI exposes the invalid file path and parse error without exposing file contents that may contain secrets.

### Guarded boundaries

Initial implementation guards:

- shell tool execution;
- direct Session shell mode;
- edit, write, and patch tool mutations;
- external-directory mutation approval;
- subagent launch;
- MCP tools identified as command/process execution or mutation;
- project-artifact mutation;
- provider calls for configured cost/step caps.

Each boundary calls the shared service. Guardrail logic must not be duplicated in TUI components or model prompts.

### Durable and ephemeral state

Guardrail policy identity and terminal decisions required to reconstruct Session behavior are durable. Pending approval requests are process-local ephemeral state, matching current permission request behavior.

Durable events record:

- root Session ID;
- acting Session ID;
- action and redacted resource summary;
- matched guardrail IDs;
- decision;
- approval reply when applicable;
- cap reservation or release summary;
- timestamp.

Raw commands may remain in existing shell/session records where already required by product behavior. Guardrail audit metadata must not duplicate secrets or complete environment values.

Process restart rejects unresolved pending guardrail requests. The side effect remains unexecuted and the Session can retry explicitly.

## Guardrail TUI

### Approval prompt

A guardrail request uses the established blocker flow but has distinct labels:

- title: `Session guardrail review`;
- actions: `Approve once` and `Reject`;
- no `Always allow` option for standard mandatory approvals;
- custom rules may permit a persisted override only when the matched rule explicitly declares persistence and no standard mandatory rule also matched.

The prompt identifies the root Session and acting child when a subagent requested the action.

### Sidebar section

The Session sidebar shows:

```text
Guardrails
Standard + 2 custom
3 approvals · 1 blocked
Shells 2 / 8
Subagents 4 / 8
```

Selecting the section opens details containing active rule sources, invalid files, counters, and recent decisions. The sidebar summary does not list raw commands or secrets.

## Provider Usage

### Service boundary

Core adds a read-only `ProviderUsage` service. It resolves provider credentials through existing credential/provider infrastructure and delegates to provider-specific adapters.

The normalized result contains:

- provider ID and account/key label when safely available;
- status: `available`, `stale`, `unsupported`, `unauthorized`, or `error`;
- retrieval time and optional reset time;
- one or more named windows;
- used, limit, remaining, and unit when provider-reported;
- source: `provider_api`, `local_client_rpc`, `response_headers`, `provider_internal_api`, or `local_session`;
- stability: `stable`, `client_contract`, `observed`, or `best_effort`;
- a user-facing explanation for unsupported fields.

`local_session` entries are displayed only as local spend/token diagnostics and never as provider quota.

### Caching and refresh

- Successful provider usage responses are cached for 60 seconds unless an adapter specifies a longer provider-safe interval. The Claude OAuth usage snapshot uses a five-minute interval; response-header observations update immediately.
- Unsupported status is cached for the process lifetime unless credentials or provider configuration changes.
- Authentication failures are cached for 30 seconds.
- Provider `Retry-After` is honored.
- Only one refresh per provider/account runs concurrently.
- Sidebar mount and active provider change trigger refresh through the cache; there is no faster polling loop.
- A failed refresh retains the last successful value as `stale` with the error timestamp.

### OpenRouter adapter

With the active OpenRouter API key, call the documented current-key endpoint and normalize:

- total usage;
- daily, weekly, and monthly usage;
- key spending limit;
- remaining key allowance;
- reset period;
- expiration.

When the credential is a management key, the adapter may also call the documented credits endpoint to show total credits purchased, used, and calculated remaining account credits.

All money values use USD because OpenRouter reports these fields in USD.

### OpenAI API adapter

When an OpenAI organization admin key is explicitly configured, call documented organization Usage and Costs endpoints for selected time windows. The default sidebar summary uses the current UTC week and current calendar month.

Ordinary project/API keys do not receive admin usage access. The adapter returns `unauthorized` or `unsupported` without asking the user to replace their normal inference key with an admin key.

### ChatGPT Codex and Spark

The ChatGPT-plan adapter follows the official Codex source and protocol instead of treating plan usage as unavailable.

#### Source order

1. When an explicitly configured Codex app-server bridge is available, call the documented local JSON-RPC method `account/rateLimits/read`. This is `local_client_rpc` with `client_contract` stability.
2. Otherwise, when YCoding owns a ChatGPT OAuth credential for the active OpenAI/Codex provider, use a native adapter based on Codex's `BackendClient.get_rate_limits_many()` behavior and call `GET https://chatgpt.com/backend-api/wham/usage`. This is `provider_internal_api` with `best_effort` stability. The implementation must use YCoding's own client identity and must not claim to be Codex Desktop.
3. Merge rate-limit snapshots observed in normal Codex response headers or SSE events as fresher `response_headers` observations.

The native adapter must scope every request and cache entry to the authenticated ChatGPT user and account ID. When present, it sends the same account-routing header used by the Codex client. Switching credentials invalidates the prior account snapshot.

#### Normalized fields

Normalize:

- primary 5-hour usage and reset;
- secondary weekly usage and reset;
- plan type;
- rate-limit reached type;
- credit balance and unlimited state when returned;
- effective monthly credit limit and spend-control state when returned;
- earned rate-limit reset count and expiry details when returned;
- every additional named limit by stable limit ID.

Additional rate-limit entries must not be collapsed into the global Codex lane. A returned `codex-spark` or equivalent model-specific ID renders as a separate Spark row with its own windows and reset timestamps. Unknown future limit IDs render by provider title or sanitized ID rather than being discarded.

The adapter does not consume reset credits or purchase credits. It is read-only.

### Claude subscription

The Claude subscription adapter uses two complementary sources.

#### Live response-header source

For every authenticated Claude.ai subscription model response, capture and normalize the provider's unified rate-limit headers when present, including:

- `anthropic-ratelimit-unified-5h-utilization` and `anthropic-ratelimit-unified-5h-reset`;
- `anthropic-ratelimit-unified-7d-utilization` and `anthropic-ratelimit-unified-7d-reset`;
- `anthropic-ratelimit-unified-representative-claim`;
- `anthropic-ratelimit-unified-overage-status` and `anthropic-ratelimit-unified-overage-utilization`;
- `anthropic-ratelimit-unified-fallback-percentage` when returned.

Header names are parsed case-insensitively. Unknown future unified headers are ignored unless a schema update explicitly supports them.

Header values are account-wide provider state, not Session-local token estimates. They are stored only in the in-memory provider-usage cache and replace older snapshots for the same credential identity.

Claude Code's official status-line contract exposes equivalent `rate_limits.five_hour` and `rate_limits.seven_day` values after the first API response. YCoding should expose the same normalized semantics in its sidebar.

#### OAuth usage snapshot

When YCoding has a Claude Code OAuth credential, the adapter may call:

```text
GET https://api.anthropic.com/api/oauth/usage
anthropic-beta: oauth-2025-04-20
```

using the existing refreshed OAuth access token. This provider-owned endpoint is not a documented stable public API, so the adapter is `provider_internal_api` with `best_effort` stability and a five-minute cache.

Normalize all returned optional buckets without assuming they always exist:

- `five_hour`;
- `seven_day`;
- model-specific weekly buckets such as Sonnet, Opus, or future named lanes;
- `extra_usage` enablement, monthly limit, used credits, and utilization.

Response headers win for overlapping fields when they are newer because they come from the model-serving request path. The OAuth snapshot fills cold-start and model-specific fields. A 401 triggers one credential refresh through the existing Claude Code credential store; a 429 honors retry information and retains stale data.

API-key-only Anthropic usage remains separate: organization usage reports require an authorized Admin API key and do not represent Claude.ai subscription windows.

### Sidebar presentation

The sidebar displays the current Session provider first, followed by other configured providers with available usage.

Example:

```text
Provider usage

OpenRouter
$74.50 / $100.00 remaining
$25.50 used this month

OpenAI API
$18.20 used this week
Updated 40s ago

Claude plan
5h 42% used · resets 11:30 PM
7d 18% used · resets Friday
Source: response headers

Codex plan
5h 31% used · weekly 12% used
Spark 4% used · $18.50 credits
```

Formatting rules:

- currency uses en-US USD formatting for provider-reported USD values;
- unknown limits do not render zero;
- unsupported data is visibly different from an error;
- stale values include age and refresh failure state;
- no credential, account email, organization secret, or full key label is rendered.

## Schema and Protocol

Expected public additions:

- project-artifact agent permission schema update;
- guardrail profile, request, decision, reply, status, counter, and event schemas;
- provider usage status and window schemas;
- Session guardrail status/read endpoints;
- guardrail request list/reply endpoints;
- Location provider-usage endpoint.

All public Protocol changes require regeneration through the Client package’s owning command. Generated files must not be edited directly.

## Error Handling

- Invalid agent permissions reject that agent document and emit a config diagnostic.
- Invalid custom guardrails produce a diagnostic and fail closed for mutation actions.
- Guardrail hard denial returns a typed Session/tool error with matched rule IDs and safe reason.
- Cap exhaustion returns current, limit, scope, and reset/release condition when known.
- Provider 401/403 becomes `unauthorized`.
- Provider 404 or documented absence becomes `unsupported` only when the endpoint is not applicable; unexpected 404 remains `error`.
- Provider 429 honors `Retry-After` and retains stale data.
- Network failures retain stale data and never block normal Session execution.
- Provider-usage failure must not fail Session startup or model execution.

## Testing Strategy

### Core tests

- Project-artifact agent permission schema accepts valid rules and rejects invalid rules.
- Adapter render/parse/activate preserves exact rule ordering.
- Empty managed-agent permissions resolve to the safe defaults.
- Explicit shell allow/ask/deny rules behave through the real permission service.
- Parent permission ceilings continue to deny child shell even when the child agent allows it.
- Standard catastrophic commands deny before shell spawn.
- Standard high-impact commands create guardrail requests before shell spawn.
- `yolo` and `goal` modes do not auto-approve guardrail requests.
- Direct Session shell and tool shell share guardrail behavior.
- Child Sessions resolve the same root profile and family counters.
- Concurrent shell and subagent reservations cannot exceed configured caps.
- Reservations release after success, failure, cancellation, and interruption.
- Invalid custom guardrail files fail closed for mutations and expose diagnostics.
- Rule precedence is deterministic.
- Secrets are redacted from guardrail audit metadata.

### Provider adapter tests

Use local HTTP fixtures, not live provider calls:

- OpenRouter current-key normalization.
- OpenRouter management credit normalization.
- OpenAI usage/cost pagination and aggregation.
- Codex app-server `account/rateLimits/read` normalization.
- Codex backend usage normalization with primary, secondary, credits, reset credits, account scoping, and additional Spark limit IDs.
- Claude unified response-header normalization.
- Claude OAuth usage normalization for five-hour, weekly, model-specific, and extra-usage buckets.
- source precedence, credential switching, unauthorized, retry-after, stale-cache, unsupported, and malformed-response behavior.
- no credential values in normalized output or logs.

### Protocol and Client tests

- Endpoint request/response schemas.
- Session ownership checks for guardrail replies.
- Location scoping for provider usage.
- Generated Client methods compile and match Protocol identifiers.

### TUI tests

- Subagent shell approval appears in the parent blocker flow and identifies the acting child.
- Guardrail prompt is visually distinct from permission prompt.
- Guardrail sidebar summary renders counters and invalid-rule state.
- Provider usage renders available, stale, unsupported, unauthorized, and error states.
- Unknown limits do not render as zero.
- Sidebar state rehydrates after restart through canonical API state.

### Verification commands

The implementation plan must identify exact package commands after inspecting each affected `package.json`. Minimum completion evidence includes:

- targeted Core tests;
- targeted Schema and Protocol tests;
- generated Client verification;
- targeted TUI render/component tests;
- affected package typechecks;
- root `bun run typecheck`;
- root `bun run lint`;
- root `bun run lint:effect-patterns`;
- `git diff --check` and final `git diff` inspection.

## Documentation Updates

Implementation must update:

- `README.md` for user-visible capabilities;
- `docs/runtime.md` for Session guardrails, subagent permissions, and provider usage;
- `docs/architecture.md` for service ownership and dependency flow;
- `docs/product-direction.md` if the safety contract changes product expectations;
- `docs/upstream-differences.md` for YCoding-specific guardrails and managed-agent permissions;
- configuration documentation with agent and guardrail examples;
- relevant `specs/v2` contracts for public Schema and Protocol additions.

## Rollout and Compatibility

- Existing configured agents retain their current permission behavior.
- Existing managed project-artifact agents with empty permissions receive the documented safe managed-agent defaults.
- Existing root Sessions without a guardrail profile resolve the current standard profile lazily.
- Standard guardrails are enabled by default.
- Custom guardrail absence is valid and produces no warning.
- Provider usage is best-effort and never blocks coding Sessions.
- Unsupported provider-plan usage is displayed honestly rather than omitted or guessed.

## Acceptance Criteria

The feature is complete only when all of the following are proven:

1. A managed or configured subagent with `shell: ask` can request and, after human approval, execute a harmless shell command.
2. A subagent with `shell: deny` cannot advertise or execute shell.
3. A parent deny ceiling cannot be widened by child configuration.
4. A standard catastrophic command is rejected before process creation in parent, child, and direct shell paths.
5. A standard high-impact command requires human approval in `normal`, `yolo`, and `goal` modes.
6. Custom files from `~/.config/ycoding/guardrails` load deterministically and invalid enabled files fail closed for mutations.
7. Root-family shell and subagent caps hold under concurrent attempts and release correctly.
8. Guardrail and permission prompts are distinguishable and attributable to the acting Session.
9. OpenRouter key remaining allowance is rendered from the documented API when available.
10. OpenAI organization usage is rendered only with an authorized admin key.
11. Claude subscription 5-hour and weekly usage render from response headers after a normal authenticated request; the OAuth snapshot fills supported cold-start, model-specific, and extra-usage fields when available.
12. Codex 5-hour, weekly, credit, and reset data render from the app-server RPC or native authenticated adapter; Spark renders as a separate row when the backend returns its limit ID.
13. Internal provider endpoint failure degrades to stale or unsupported state without failing Session execution, and the sidebar identifies best-effort sources.
14. No provider credential or secret appears in events, logs, Protocol responses, snapshots, or sidebar text.
15. Public clients are regenerated and all targeted tests, typechecks, and lint commands pass.

## References

- OWASP GenAI Security Project, “LLM06:2025 Excessive Agency”: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- NIST AI RMF Generative AI Profile: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- NIST AI RMF Core: https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
- OpenAI, “Introducing upgrades to Codex”: https://openai.com/index/introducing-upgrades-to-codex/
- OpenRouter current API key endpoint: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- OpenRouter credits endpoint: https://openrouter.ai/docs/api/api-reference/credits/get-credits
- OpenAI Usage API: https://platform.openai.com/docs/api-reference/usage
- OpenAI Codex app-server account and rate-limit protocol: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI Codex backend implementation and rate-limit model: https://github.com/openai/codex
- OpenAI Codex rate card and Usage panel: https://help.openai.com/en/articles/20001106-codex-rate-card
- Claude Code status-line rate-limit contract: https://code.claude.com/docs/en/statusline
- Claude Code changelog entry adding status-line rate limits: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Claude Code source archive used for implementation comparison only: https://github.com/tanbiralam/claude-code
- Claude usage-limit best practices and Usage settings: https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- Claude Code models, usage, and limits: https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code
