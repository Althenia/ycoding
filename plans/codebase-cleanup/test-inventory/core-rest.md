# Core non-Session test inventory

Scope: `packages/core/test` except the Session test family (`test/session*.test.ts`): 205 test files. The lane owns the core test files; production is unchanged. Baseline is `codebase-cleanup` at `1141158a`; lane cleanup commits are `22b7cfe6` and `277c945c`, plus the preserved `sl-core-rest-tool-patch` work. The changed groups and every remaining test file are inventoried below.

## Reconstructed changed-group coverage map

| Area / prior cases | Classification and reason | Surviving assertion |
|---|---|---|
| Bundled AI SDK adapters: 38 cases across Alibaba, Cohere, DeepInfra, Gateway, Groq, Mistral, Perplexity, TogetherAI, and Venice | Merge: each provider had repeated exact-package, SDK construction, provider-name, and default model-ID assertions. The data-driven cases test canonical and custom provider IDs against the real SDK factory and reject another package, a `/compat` path, a `-lookalike` package, and a file URL. | `test/plugin/provider-bundled-sdk.test.ts`: 24 cases cover all 12 plugin adapters; `languageModel` provider and model IDs are compared with each real factory. Probe: changing Alibaba's exact package match failed both Alibaba table cases. |
| Google adapter: 3 generic cases; native runner case | Merge generic adapter cases into the table; keep the separate native-runner boundary. | `test/plugin/provider-bundled-sdk.test.ts`; `test/plugin/provider-google.test.ts` runtime `AISDK.model` assertion. |
| Vercel adapter: custom SDK case; header/configuration cases | Merge custom SDK case into the provider table; keep title-header behavior and provider-isolation checks because the table does not observe catalog mutation. | `test/plugin/provider-bundled-sdk.test.ts`; `test/plugin/provider-vercel.test.ts` header and non-Vercel catalog assertions. |
| xAI adapter: exact package/custom SDK cases; OAuth registration and language selection | Merge SDK construction/package cases into the table; keep OAuth method registration, `modelID`-selected responses, and non-xAI language behavior as distinct provider contracts. | `test/plugin/provider-bundled-sdk.test.ts`; `test/plugin/provider-xai.test.ts`. |
| Agent prompt tests removed in the lane commits: safety/action boundary, explicit permission deny, YOLO 3 guardrail rule, child ownership, title and utility output contracts | Restore/merge: runtime-composed prompt text is the model-consumed output contract. Remove only incidental voice/style wording and source-text checks. Keep enforcement permissions separately from model guidance. | `test/agent.test.ts`: runtime `Agent` service asserts shared safety paragraphs, God deny/YOLO rules, Zeus child limits, and title/compaction/goal/summary/BTW output constraints. Probes: removing the explicit-deny sentence or title-output-only rule failed this assertion. |
| `tool-edit.test.ts`, `tool-write.test.ts`: source-comment/TODO assertions | Delete source-text checks; keep real tool-definition input schemas and external path permission and mutation outcomes. Source comments/TODOs are not runtime behavior. | `test/tool-edit.test.ts` exact edit input keys; `test/tool-write.test.ts` exact write input keys and actual write/permission flows. |
| `tool-shell.test.ts`: source TODO assertion | Delete source-text check; retain shell timeout, memory ceiling, permission, cancellation, and output behavior tests. | Remaining `ShellTool` runtime cases. |
| Patch updates: empty file, EOF anchor, multiple hunks, newline, contextual header, heredoc, whitespace/punctuation, and malformed inputs | Keep all observable file-update behavior. Merge only the four malformed-input cases into one table, both heredoc wrappers into one test, and three surrounding-whitespace/Unicode cases into one test. | `test/tool-patch.test.ts` asserts resulting file contents and model-visible errors. Probes: changed required-input error, removed heredoc extraction plus required first-line marker, and removed Unicode normalization; each made its merged assertion fail. |
| Watcher startup source-text assertion | Delete: this inspected implementation text (`readdirSync`/recursive options), not runtime behavior; do not encode this implementation detail. | Runtime recursive-fallback create/update/delete tests remain in `test/filesystem/watcher.test.ts`. |

## Remaining 195 test files

Classification is `keep` for every case group below. Each suite exercises current Core behavior through the named package unit/service boundary and asserts returned values, persisted rows/files, emitted events, permission/ownership outcomes, or typed errors in that same test file. These are Core unit or in-process runtime integration tests, not the separate Core `test-integration` E2E suites. The path and test names identify each assertion mapping. Process, filesystem, browser/computer, migration, permission, cache/usage, and project-artifact groups retain their concrete side-effect or boundary assertions. No additional merge, rewrite, or delete candidate was found in this inventory.

The remaining suite-to-contract mapping is: AI/provider and provider-usage tests assert provider request/response lowering, model selection, cache and unknown-usage semantics, and secret exclusion; database and shared-schema tests assert storage/migration preservation and canonical shapes; browser/computer/PTY tests assert permission, ownership, revision, cancellation, and transport boundaries; filesystem/location/Git tests assert path containment, mutation, checkout, and watcher outcomes; config/plugin/agent/instruction/MCP tests assert discovery, precedence, runtime composition, and state changes; memory/project-artifact tests assert durable lifecycle, versioning, trash/recovery, provenance, and safety; tools/jobs/events/process tests assert user-visible result/error/state transitions and concurrency ownership. Each behavior remains asserted through the named case(s) in its listed file.

Screening found no `toHaveBeenCalled`-only assertions or Jest snapshot matchers. The only remaining direct file reads used by tests are the Agent service's Markdown prompt inputs and the OAuth page's brand SVG; both feed the behavior being asserted. Timer waits remain in process/filesystem/event-boundary tests; all passed individually, with no reproduced load failure requiring a rewrite. “V1 sanitization” in `mcp.test.ts` tests the current MCP tool-name encoding output, not a compatibility branch. Snapshot checkout asserts file restoration and unrelated-file preservation, not a golden snapshot.

| File | Pass/skip/fail | Isolated Bun wall time | Classification |
|---|---:|---:|---|
| `test/aisdk.test.ts` | 34/0/0 | 88.00ms | keep |
| `test/attachment-store.test.ts` | 10/0/0 | 461.00ms | keep |
| `test/browser/browser.test.ts` | 33/0/0 | 297.00ms | keep |
| `test/browser/isolated-browser.test.ts` | 18/0/0 | 221.00ms | keep |
| `test/browser/isolated-capture.test.ts` | 4/0/0 | 37.00ms | keep |
| `test/browser/isolated-cdp.test.ts` | 4/0/0 | 55.00ms | keep |
| `test/browser/protocol.test.ts` | 2/0/0 | 41.00ms | keep |
| `test/browser-extension.test.ts` | 2/0/0 | 6.00ms | keep |
| `test/catalog.test.ts` | 13/0/0 | 450.00ms | keep |
| `test/command.test.ts` | 2/0/0 | 367.00ms | keep |
| `test/computer-electron.test.ts` | 9/0/0 | 2.30s | keep |
| `test/computer-tool.test.ts` | 19/0/0 | 391.00ms | keep |
| `test/computer.test.ts` | 41/0/0 | 435.00ms | keep |
| `test/config/agent.test.ts` | 6/0/0 | 398.00ms | keep |
| `test/config/command.test.ts` | 1/0/0 | 894.00ms | keep |
| `test/config/config.test.ts` | 24/0/0 | 780.00ms | keep |
| `test/config/guardrail.test.ts` | 5/0/0 | 50.00ms | keep |
| `test/config/memory.test.ts` | 2/0/0 | 134.00ms | keep |
| `test/config/model.test.ts` | 2/0/0 | 42.00ms | keep |
| `test/config/plugin.test.ts` | 12/0/0 | 3.03s | keep |
| `test/config/policy.test.ts` | 3/0/0 | 936.00ms | keep |
| `test/config/provider-usage.test.ts` | 2/0/0 | 164.00ms | keep |
| `test/config/provider.test.ts` | 8/0/0 | 2.06s | keep |
| `test/config/reload.test.ts` | 1/0/0 | 1428.00ms | keep |
| `test/config/skill.test.ts` | 1/0/0 | 178.00ms | keep |
| `test/credential.test.ts` | 2/0/0 | 135.00ms | keep |
| `test/cursor/models.test.ts` | 4/0/0 | 43.00ms | keep |
| `test/cursor/route.test.ts` | 4/0/0 | 163.00ms | keep |
| `test/database-housekeeping.test.ts` | 4/0/0 | 5.47s | keep |
| `test/database-migration.test.ts` | 19/0/0 | 216.00ms | keep |
| `test/drop-legacy-account-share-migration.test.ts` | 1/0/0 | 65.00ms | keep |
| `test/effect/cross-spawn-spawner.test.ts` | 25/0/0 | 440.00ms | keep |
| `test/effect/keyed-mutex.test.ts` | 3/0/0 | 39.00ms | keep |
| `test/effect/layer-node/layer-node-types.test.ts` | 1/0/0 | 35.00ms | keep |
| `test/effect/layer-node/layer-node.test.ts` | 13/0/0 | 38.00ms | keep |
| `test/effect/layer-node/node-build.test.ts` | 4/0/0 | 400.00ms | keep |
| `test/effect/observability.test.ts` | 6/0/0 | 317.00ms | keep |
| `test/event-logger.test.ts` | 1/0/0 | 359.00ms | keep |
| `test/event.test.ts` | 51/0/0 | 566.00ms | keep |
| `test/file-mutation.test.ts` | 13/0/0 | 394.00ms | keep |
| `test/filesystem/filesystem.test.ts` | 27/0/0 | 115.00ms | keep |
| `test/filesystem/ignore.test.ts` | 2/0/0 | 16.00ms | keep |
| `test/filesystem/search.test.ts` | 2/0/0 | 113.00ms | keep |
| `test/form.test.ts` | 14/0/0 | 436.00ms | keep |
| `test/generate.test.ts` | 1/0/0 | 185.00ms | keep |
| `test/git.test.ts` | 5/0/0 | 895.00ms | keep |
| `test/github-copilot/chat-cache.test.ts` | 2/0/0 | 59.00ms | keep |
| `test/github-copilot/convert-to-copilot-messages.test.ts` | 18/0/0 | 13.00ms | keep |
| `test/github-copilot/copilot-chat-model.test.ts` | 11/0/0 | 19.00ms | keep |
| `test/github-copilot/models.test.ts` | 1/0/0 | 47.00ms | keep |
| `test/github-copilot/openai-responses-language-model.test.ts` | 14/0/0 | 25.00ms | keep |
| `test/global.test.ts` | 4/0/0 | 37.00ms | keep |
| `test/guardrail-schema.test.ts` | 4/0/0 | 55.00ms | keep |
| `test/image-analyzer.test.ts` | 14/0/0 | 170.00ms | keep |
| `test/instruction-content.test.ts` | 5/0/0 | 7.00ms | keep |
| `test/instruction-discovery.test.ts` | 8/0/0 | 343.00ms | keep |
| `test/instruction-state.test.ts` | 9/0/0 | 418.00ms | keep |
| `test/instructions/builtins.test.ts` | 7/0/0 | 332.00ms | keep |
| `test/instructions/index.test.ts` | 14/0/0 | 46.00ms | keep |
| `test/integration.test.ts` | 12/0/0 | 486.00ms | keep |
| `test/job.test.ts` | 11/0/0 | 366.00ms | keep |
| `test/keep-awake.test.ts` | 13/0/0 | 2.98s | keep |
| `test/kv.test.ts` | 1/0/0 | 105.00ms | keep |
| `test/location-filesystem.test.ts` | 3/0/0 | 135.00ms | keep |
| `test/location-layer.test.ts` | 17/0/0 | 4.65s | keep |
| `test/location-mutation.test.ts` | 10/0/0 | 127.00ms | keep |
| `test/location.test.ts` | 1/0/0 | 347.00ms | keep |
| `test/logging.test.ts` | 3/0/0 | 79.00ms | keep |
| `test/mcp-background.test.ts` | 4/0/0 | 369.00ms | keep |
| `test/mcp-instructions.test.ts` | 4/0/0 | 346.00ms | keep |
| `test/mcp-skill-integration.test.ts` | 8/0/0 | 420.00ms | keep |
| `test/mcp-skills.test.ts` | 24/0/0 | 576.00ms | keep |
| `test/mcp.test.ts` | 20/0/0 | 1.72s | keep |
| `test/memory-graph.test.ts` | 3/0/0 | 337.00ms | keep |
| `test/memory-maintenance-safety.test.ts` | 14/0/0 | 1481.00ms | keep |
| `test/memory-maintenance.test.ts` | 19/0/0 | 1.76s | keep |
| `test/memory-search.test.ts` | 2/0/0 | 389.00ms | keep |
| `test/memory-store.test.ts` | 6/0/0 | 520.00ms | keep |
| `test/memory-write.test.ts` | 7/0/0 | 714.00ms | keep |
| `test/model.test.ts` | 2/0/0 | 40.00ms | keep |
| `test/models.test.ts` | 11/0/0 | 1086.00ms | keep |
| `test/move-session.test.ts` | 4/0/0 | 1.65s | keep |
| `test/newtype.test.ts` | 5/0/0 | 40.00ms | keep |
| `test/npm-config.test.ts` | 5/0/0 | 57.00ms | keep |
| `test/npm.test.ts` | 4/0/0 | 1399.00ms | keep |
| `test/oauth-page.test.ts` | 2/0/0 | 6.00ms | keep |
| `test/patch.test.ts` | 12/0/0 | 8.00ms | keep |
| `test/permission.test.ts` | 17/0/0 | 505.00ms | keep |
| `test/plugin/command.test.ts` | 1/0/0 | 399.00ms | keep |
| `test/plugin/models-dev.test.ts` | 6/0/0 | 426.00ms | keep |
| `test/plugin/promise.test.ts` | 9/0/0 | 483.00ms | keep |
| `test/plugin/provider-amazon-bedrock.test.ts` | 18/0/0 | 618.00ms | keep |
| `test/plugin/provider-anthropic-claude-code-integration.test.ts` | 5/0/0 | 481.00ms | keep |
| `test/plugin/provider-anthropic-claude-code.test.ts` | 33/0/0 | 60.00ms | keep |
| `test/plugin/provider-anthropic-oauth.recorded.test.ts` | 0/1/0 | 353.00ms | keep |
| `test/plugin/provider-anthropic.test.ts` | 6/0/0 | 639.00ms | keep |
| `test/plugin/provider-azure-cognitive-services.test.ts` | 5/0/0 | 458.00ms | keep |
| `test/plugin/provider-azure.test.ts` | 11/0/0 | 559.00ms | keep |
| `test/plugin/provider-cerebras.test.ts` | 5/0/0 | 437.00ms | keep |
| `test/plugin/provider-cloudflare-ai-gateway.test.ts` | 11/0/0 | 487.00ms | keep |
| `test/plugin/provider-cloudflare-workers-ai.test.ts` | 8/0/0 | 466.00ms | keep |
| `test/plugin/provider-cursor.test.ts` | 10/0/0 | 5.28s | keep |
| `test/plugin/provider-dynamic.test.ts` | 8/0/0 | 458.00ms | keep |
| `test/plugin/provider-github-copilot.test.ts` | 13/0/0 | 530.00ms | keep |
| `test/plugin/provider-gitlab.test.ts` | 8/0/0 | 485.00ms | keep |
| `test/plugin/provider-google-vertex-anthropic.test.ts` | 9/0/0 | 576.00ms | keep |
| `test/plugin/provider-google-vertex.test.ts` | 9/0/0 | 499.00ms | keep |
| `test/plugin/provider-kilo.test.ts` | 4/0/0 | 443.00ms | keep |
| `test/plugin/provider-llmgateway.test.ts` | 3/0/0 | 426.00ms | keep |
| `test/plugin/provider-nvidia.test.ts` | 4/0/0 | 431.00ms | keep |
| `test/plugin/provider-openai-compatible.test.ts` | 4/0/0 | 431.00ms | keep |
| `test/plugin/provider-openai.test.ts` | 16/0/0 | 567.00ms | keep |
| `test/plugin/provider-opencode.test.ts` | 10/0/0 | 1.72s | keep |
| `test/plugin/provider-openrouter.test.ts` | 10/0/0 | 506.00ms | keep |
| `test/plugin/provider-sap-ai-core.test.ts` | 5/0/0 | 430.00ms | keep |
| `test/plugin/provider-snowflake-cortex.test.ts` | 14/0/0 | 453.00ms | keep |
| `test/plugin/provider-zenmux.test.ts` | 5/0/0 | 439.00ms | keep |
| `test/plugin/skill.test.ts` | 1/0/0 | 372.00ms | keep |
| `test/plugin/system-prompt.test.ts` | 6/0/0 | 430.00ms | keep |
| `test/plugin/variant.test.ts` | 2/0/0 | 385.00ms | keep |
| `test/plugin-hooks.test.ts` | 2/0/0 | 71.00ms | keep |
| `test/plugin-runtime.test.ts` | 1/0/0 | 223.00ms | keep |
| `test/plugin.test.ts` | 11/0/0 | 525.00ms | keep |
| `test/policy.test.ts` | 2/0/0 | 113.00ms | keep |
| `test/process/process.test.ts` | 24/0/0 | 545.00ms | keep |
| `test/project-artifact-accounting.test.ts` | 19/0/0 | 872.00ms | keep |
| `test/project-artifact-adapter.test.ts` | 9/0/0 | 383.00ms | keep |
| `test/project-artifact-legacy-cleanup.test.ts` | 6/0/0 | 79.00ms | keep |
| `test/project-artifact-package.test.ts` | 27/0/0 | 7.90s | keep |
| `test/project-artifact-source.test.ts` | 6/0/0 | 510.00ms | keep |
| `test/project-artifact-sql.test.ts` | 71/0/0 | 737.00ms | keep |
| `test/project-artifact-store.test.ts` | 43/0/0 | 3.36s | keep |
| `test/project-artifact-validation.test.ts` | 57/0/0 | 10.00ms | keep |
| `test/project-copy.test.ts` | 13/0/0 | 1249.00ms | keep |
| `test/project-directories.test.ts` | 4/0/0 | 390.00ms | keep |
| `test/project-inventory.test.ts` | 3/0/0 | 408.00ms | keep |
| `test/project.test.ts` | 16/1/0 | 1171.00ms | keep |
| `test/provider-usage-claude.test.ts` | 9/0/0 | 45.00ms | keep |
| `test/provider-usage-codex.test.ts` | 9/0/0 | 44.00ms | keep |
| `test/provider-usage-copilot.test.ts` | 21/0/0 | 46.00ms | keep |
| `test/provider-usage-cursor.test.ts` | 4/0/0 | 43.00ms | keep |
| `test/provider-usage-go.test.ts` | 3/0/0 | 145.00ms | keep |
| `test/provider-usage-grok.test.ts` | 4/0/0 | 144.00ms | keep |
| `test/provider-usage-meta.test.ts` | 2/0/0 | 43.00ms | keep |
| `test/provider-usage-openai.test.ts` | 3/0/0 | 43.00ms | keep |
| `test/provider-usage-openrouter.test.ts` | 7/0/0 | 145.00ms | keep |
| `test/provider-usage-zai.test.ts` | 3/0/0 | 143.00ms | keep |
| `test/provider-usage.test.ts` | 11/0/0 | 160.00ms | keep |
| `test/provider-xai-responses.test.ts` | 1/0/0 | 19.00ms | keep |
| `test/pty/info-schema.test.ts` | 4/0/0 | 132.00ms | keep |
| `test/pty/protocol.test.ts` | 4/0/0 | 5.00ms | keep |
| `test/pty/pty-session.test.ts` | 10/0/0 | 1.61s | keep |
| `test/pty/ticket.test.ts` | 5/0/0 | 242.00ms | keep |
| `test/question.test.ts` | 4/0/0 | 407.00ms | keep |
| `test/reference-instructions.test.ts` | 4/0/0 | 370.00ms | keep |
| `test/reference.test.ts` | 3/0/0 | 385.00ms | keep |
| `test/repository-cache.test.ts` | 4/0/0 | 1100.00ms | keep |
| `test/repository.test.ts` | 5/0/0 | 41.00ms | keep |
| `test/ripgrep.test.ts` | 2/0/0 | 144.00ms | keep |
| `test/shared-schema.test.ts` | 2/0/0 | 225.00ms | keep |
| `test/shell-events.test.ts` | 1/0/0 | 435.00ms | keep |
| `test/shell-output.test.ts` | 10/0/0 | 2.91s | keep |
| `test/shell-sandbox.test.ts` | 1/0/0 | 44.00ms | keep |
| `test/shell.test.ts` | 6/0/0 | 108.00ms | keep |
| `test/skill/instructions.test.ts` | 7/0/0 | 362.00ms | keep |
| `test/skill-discovery.test.ts` | 7/0/0 | 466.00ms | keep |
| `test/skill.test.ts` | 9/0/0 | 469.00ms | keep |
| `test/snapshot.test.ts` | 6/0/0 | 1103.00ms | keep |
| `test/state.test.ts` | 5/0/0 | 48.00ms | keep |
| `test/task-reconcile.test.ts` | 2/0/0 | 410.00ms | keep |
| `test/teamview-cache-prefix.test.ts` | 1/0/0 | 59.00ms | keep |
| `test/tool-browser.test.ts` | 32/0/0 | 473.00ms | keep |
| `test/tool-conversation-compact.test.ts` | 1/0/0 | 487.00ms | keep |
| `test/tool-execute.test.ts` | 3/0/0 | 162.00ms | keep |
| `test/tool-goal.test.ts` | 1/0/0 | 388.00ms | keep |
| `test/tool-memory.test.ts` | 1/0/0 | 631.00ms | keep |
| `test/tool-output-store.test.ts` | 10/0/0 | 486.00ms | keep |
| `test/tool-project-artifact.test.ts` | 7/0/0 | 415.00ms | keep |
| `test/tool-question.test.ts` | 7/0/0 | 370.00ms | keep |
| `test/tool-read-filesystem.test.ts` | 7/0/0 | 128.00ms | keep |
| `test/tool-read.test.ts` | 19/0/0 | 486.00ms | keep |
| `test/tool-search.test.ts` | 8/0/0 | 523.00ms | keep |
| `test/tool-skill.test.ts` | 1/0/0 | 385.00ms | keep |
| `test/tool-subagent.test.ts` | 26/0/0 | 5.52s | keep |
| `test/tool-task-complete.test.ts` | 1/0/0 | 351.00ms | keep |
| `test/tool-union-root-input.test.ts` | 31/0/0 | 258.00ms | keep |
| `test/tool-webfetch.test.ts` | 15/0/0 | 1039.00ms | keep |
| `test/tool-websearch.test.ts` | 12/0/0 | 376.00ms | keep |
| `test/util/effect-flock.test.ts` | 12/0/0 | 4.94s | keep |
| `test/util/flock.test.ts` | 10/0/0 | 5.67s | keep |
| `test/util/process-lock.test.ts` | 2/0/0 | 111.00ms | keep |
| `test/util/which.test.ts` | 6/0/0 | 49.00ms | keep |
| `test/vcs-hg.test.ts` | 0/6/0 | 127.00ms | keep |
| `test/vcs.test.ts` | 8/0/0 | 723.00ms | keep |
| `test/wellknown.test.ts` | 3/0/0 | 171.00ms | keep |

**Remaining total:** 195 files, 1,790 pass / 8 skip / 0 fail; summed Bun test wall time 125.589 s (one file per process, serialized). Every listed per-file command was `bun test --cwd packages/core <relative path>`.

## Counts and focused wall time

| Files / group | Before → after | Cases before → after | Current isolated wall time (three runs) |
|---|---:|---:|---|
| Agent | 1 → 1 | 18 → 13 | 0.542 / 0.407 / 0.409 s |
| Provider adapter tests | 12 → 4 | 51 → 31 | bundled 0.642 / 0.629 / 0.625 s; Google 0.387 / 0.390 / 0.390 s; Vercel 0.412 / 0.405 / 0.418 s; xAI 0.396 / 0.406 / 0.412 s |
| Tool edit | 1 → 1 | 11 → 11 | 0.494 / 0.494 / 0.509 s |
| Tool patch | 1 → 1 | 36 → 30 | 0.648 / 0.643 / 0.608 s |
| Tool shell | 1 → 1 | 35 → 34 | 8.80 / 8.72 / 9.21 s |
| Tool write | 1 → 1 | 8 → 8 | 0.459 / 0.481 / 0.538 s |
| Watcher | 1 → 1 | 10 → 9 | 3.35 / 3.34 / 3.32 s |
| Total changed groups | 18 → 10 | 169 → 136 | Current isolated medians total approximately 16.0 s |

The changed test files contain 5,620 baseline lines and 4,178 current lines. Before-run wall times were not recorded in the restored lane inventory; no baseline timing comparison is claimed.

Each of the ten current changed test files passed three sequential isolated focused runs. A bounded loaded run with one background CPU-pressure worker passed all ten files in sequence, 136/136 cases, from `2026-10-03T03:15:21Z` to `2026-10-03T03:15:37Z`; tool shell was 8.46 s and watcher 3.35 s. The focused command `bun run lint -- packages/core/test/agent.test.ts packages/core/test/plugin/provider-bundled-sdk.test.ts packages/core/test/plugin/provider-google.test.ts packages/core/test/plugin/provider-vercel.test.ts packages/core/test/plugin/provider-xai.test.ts packages/core/test/tool-edit.test.ts packages/core/test/tool-patch.test.ts packages/core/test/tool-shell.test.ts packages/core/test/tool-write.test.ts packages/core/test/filesystem/watcher.test.ts` exited 0 with 10 warnings and no errors; the Google unused-variable warning was removed, leaving warnings in untouched existing lines. No whole Core suite was run. Package typecheck is deferred to parent integration checks; root typecheck, root lint, and `AGENTS.md` are parent-owned.

## Full Core non-Session scope totals

| Measure | Before → after |
|---|---:|
| Test files | 213 → 205 |
| Cases | 1,967 → 1,934 |
| Test lines | 66,272 → 64,830 |

The before totals combine the unchanged 195-file inventory with the pre-lean changed groups; current cases settle as 1,926 pass, 8 environment-gated skip, 0 fail. The 8 skips are the recorded Anthropic OAuth/cache case without a cassette or recording credential, one Mercurial-dependent project case, and six Mercurial VCS cases because `hg` is unavailable. All 205 test files were run individually, sequentially, using `bun test --cwd packages/core <relative path>`; the sum of Bun per-file wall times is 142.302 seconds and the serialized shell interval was `2026-10-03T03:23:17Z`–`2026-10-03T03:25:41Z`. No before-run timing evidence exists.
