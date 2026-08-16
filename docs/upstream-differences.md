# Historical upstream differences

Last reviewed: **2026-07-27**

Historical upstream reference: `https://opencode.ai/v2/docs`

Status: **maintained divergence ledger**

YCoding originated from upstream OpenCode, but current YCoding code, tests, Schema, Protocol, and root documentation are authoritative. This ledger tracks externally relevant differences; it is not a complete source-code diff.

## Rules

- Verify exact behavior in current code and tests.
- Treat upstream source and documentation as comparison or selective-port input only.
- Preserve upstream names where attribution or an external provider protocol requires them.
- Do not restore a removed product, V1 path, or compatibility layer merely to simplify an upstream port.
- Update this file when a user-visible relationship changes.

## Current differences

| Area | Historical upstream behavior | YCoding behavior | Status and source |
| --- | --- | --- | --- |
| Product surface | Upstream includes multiple distribution and application surfaces. | YCoding ships one terminal application. Desktop, browser, console, website, statistics, and hosted-application packages are not active products. | **Diverged**: `docs/product-direction.md`, `script/ycoding-workspace.ts` |
| Product identity | Upstream uses OpenCode names, packages, paths, environment variables, headers, and executable names. | YCoding uses `YCoding`, `ycoding`, `@ycoding-ai/*`, `YCODING_*`, `.ycoding`, and `x-ycoding-*`. | **Diverged**: `docs/ycoding-migration.md` |
| CLI installation | Upstream distribution endpoints and package names belong to upstream. | The workspace package is `@ycoding-ai/cli`, exports `ycoding`, and builds artifacts with `bun run build:tui`. The installer requires an explicit YCoding release repository until one is configured. | **Diverged**: `packages/cli/package.json`, `install` |
| V1 compatibility | Historical upstream material includes V1 migration and compatibility paths. | YCoding is V2 only and does not restore V1 Session, config, event, plugin, client, or TUI paths. | **YCoding policy**: `AGENTS.md`, `docs/product-direction.md` |
| Session execution | Upstream ancestry does not define YCoding's full durable admission and process-local coordinator contract. | Prompt admission is durable and separate from execution wake-up. Same-Session drains serialize; different Sessions may execute concurrently. | **YCoding implementation**: `packages/core/src/session`, `specs/v2/session.md` |
| Autonomy | No equivalent durable YCoding state machine exists upstream. | Sessions persist `normal`, `yolo`, and `goal` mode, including goal progress, stop, exhaustion, and no-progress bounds. | **YCoding-only**: `packages/core/src/session/autonomy.ts`, `goal.ts` |
| Subagents | Historical agent behavior does not define YCoding's durable background-child contract. | Subagents are durable child Sessions, run in the background, inherit permission ceilings, obey nesting limits, and report lifecycle state to the parent. | **YCoding-only**: orchestration and subagent tools in Core |
| Session skills | Historical skill behavior covers discovery and invocation but not YCoding's session status model. | Skill status derives from durable activation and instruction state, including inactive reasons and active conflicts. | **YCoding-only**: `packages/core/src/session/skill-status.ts` |
| Project artifacts | No equivalent maintained lifecycle is inherited. | Agents, commands, skills, and plugin drafts can be managed as validated, versioned project or global artifacts with preview, confirmation, trash, restore, and rollback. | **YCoding-only**: Schema and Core project-artifact modules |
| Provider caching | Historical provider pages do not define YCoding's model-family cache lowering and diagnostics. | AI protocols apply provider-specific cache controls, stable prefixes, normalized usage, and cache telemetry without changing semantic behavior. | **YCoding implementation**: `packages/ai`, cache tests |
| Transcript history | No inherited contract defines the current bounded archive model. | The TUI keeps 50 completed hot messages plus active boundaries, archive pages of up to 1000 messages, lightweight placeholders, and one expanded page. | **YCoding-only**: `packages/tui/src/context/data.tsx` |
| Plugin API | Historical beta APIs are not authority. | YCoding supports current plugin contracts only, including Effect and Promise APIs and declared TUI extension slots. | **Diverged**: `packages/plugin`, `packages/core/src/plugin` |
| Documentation | Upstream pages describe upstream behavior. | Root `docs`, current code, and `specs/v2` define YCoding. No second hosted-documentation package is maintained. | **Diverged**: `docs/README.md` |

## External provider exception

OpenCode Zen and OpenCode Go are external provider identities. YCoding preserves provider-owned IDs, names, API URLs, credential environment variables, OAuth identifiers, and model selectors required to use those services. This exception does not make upstream product names valid for YCoding-owned UI, packages, paths, logs, headers, or documentation.

## Port review checklist

1. Record the upstream commit or behavior being considered.
2. Identify current YCoding package owners.
3. Compare public Schema, Protocol operations, and Client output.
4. Check whether the change restores a removed product or V1 path.
5. Check durable Session, Location, permission, orchestration, artifact, and cache invariants.
6. Add a failing regression test before production changes.
7. Update this ledger when the external relationship changes.
