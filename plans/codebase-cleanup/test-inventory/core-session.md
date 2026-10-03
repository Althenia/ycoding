# Core Session test retention inventory

Local evidence only; never stage or commit this inventory. Scope: `sl-core-session`, `packages/core/test/session*.test.ts`, Session production only for reproduced defects, and the assigned restart spec. No other lane was rebased or edited.

## Placement and baseline

- Original base: `3962b14f`; integration target: `codebase-cleanup` `1141158a` (rebased onto main `c9a2957a`). Requested `git rebase --onto codebase-cleanup 3962b14f sl-core-session` exited 0. Restart removal `6975fbe4` became `c8ae858c`.
- Original 11-file dirty patch preserved in named stash `551e8fc7c62cdb5648c56eed2b8bb8f0fcc54f59`; exact apply exited 0 with no conflicts. Rebased patch additionally preserved in named stash `fd4ecd6e98ce9c3665bed989e230371d564fe2e3`; exact apply exited 0. Both stashes retained.
- New main test `loads every explicit skill in one prompt before the first model request` survives the rebase. Main question rules and all unrelated production changes remain untouched.
- Baseline is clean rebased lane `c8ae858c` before applying dirty tests: 65 files, 1,010 runtime cases, 35,358 lines. Isolated per-file wall sum 65.11 s including the recorded-test timeout. 1,008 pass, 2 fail. These are not a passing baseline. Corrected the preliminary line count (34,835 measured on dirty tests) by summing exact HEAD blob newline counts; the clean-baseline static assertion index independently sums to 35,358.
- Exact per-file command: `/usr/bin/time -p bun test --cwd packages/core --timeout 30000 test/<name>.test.ts --reporter=junit --reporter-outfile=/tmp/sl-core-session-evidence/baseline/<name>.xml`. One test process at a time; shell timeout 300000 ms; memory cap 8192 MiB. Logs contain process wall time and Bun assertions; JUnit contains every expanded case name and duration. Evidence root: `/tmp/sl-core-session-evidence`.
- First batch stopped at provider-request exit 1; second batch ran the remaining files, preserving both nonzero outcomes. No full Core/TUI suite, live provider, root checks, or package typecheck ran. Parent owns root checks and has deferred package typecheck for integration.
- Static assertion index: `/tmp/sl-core-session-assertions.jsonl`; each case registration has source line and its actual `expect` calls. JUnit is the authoritative expanded count for loops/tables and live test helpers.

## Retained-behavior assertion map (before additional deletion)

Every case not explicitly listed below is **keep**, with its existing assertions and setup unchanged. File groups below cover all cases in their named baseline JUnit file, including table expansions; the baseline JUnit is the complete per-case duration/name manifest. Pure rules are unit layer; actual database/projector/services are component integration; admission through runtime request/transcript consumption is flow. Provider boundaries are offline, not live network or product E2E.

| Case/group | Classification and reason | Surviving assertions |
| --- | --- | --- |
| create: child Daybreak blue/off and fork Daybreak reset | merge duplicated setup, retain all 3 scenarios | scenario expected Daybreak on returned and reloaded derived Session |
| create: generated-ID and caller-ID Created event persistence | merge setup, retain both ID branches | event array exactly one current versioned Created type; `data.sessionID === created.id` |
| create: current projection after direct SQL update | delete implementation-coupled duplicate | `returns the current Session projection after projected updates`: durable AgentSelected event then repeated create returns current projection |
| daybreak: event-only change, no transcript/pending writes | merge into durable projection setter case | exact aggregate event types, zero SessionMessage rows, zero SessionPending rows |
| model-switch: smaller model fits and no compaction/provider request | merge 3 identical transcripts into fitting-switch case | switch result, target model, retained S1/R1 compaction and hello user, zero compaction pending/Started/Ended, zero requests |
| model-switch: cross-model/provider continuation invalidation ledger | merge into provider-request diagnostics at ledger owner | model and provider changes yield `model-switched`; absent versus named default yields `model-variant-switched`; cache-reset precedence retained |
| model-switch: prompt-cache model/provider/variant/stability identity | merge into runner-cache at cache owner (always-kept cache suite) | `isolates every cache sharing dimension`; `shares subagent prefixes only when every model-visible dimension is equal`; canonical pinned digest; absent/default inequality moved explicitly |
| orchestration: orchestration Service exists; notifier Service exists | delete existence-only checks, not behavior requirements | all durable orchestration projection cases and real notifier success/failure tests retained unchanged |
| prompt: active registry delegate | delete mock-only delegation check | real coordinator active snapshots and cleanup, execution lifecycle, Session runner flows retained; no claims that lower tests check a forwarding mock |
| prompt: resume delegate | delete mock-only call count | every Session runner flow resumes through public Session API; real coordinator joining preserved |
| prompt: interrupt delegates for known/missing Session | delete mock-only calls | real active/idle coordinator interruption and execution restart boundaries retained; public unknown Session rejection is a Protocol/Server contract owned outside this lane |
| prompt: reattached data URL and managed reference after external change | merge setup, retain distinct recovery/reference paths | content identity, MIME/name, read restored data URL bytes, unknown managed reference AttachmentError |
| prompt: omitted/true/false resume flag | merge duplicated setup, retain 3 branches | advisory wake list by flag; no synchronous resume; admission/promotion tests retained |
| runner-model: compatible chat default/settings responses/model responses/model chat override | merge setup, retain 4 branches | actual resolver route ID for each source/precedence scenario |
| runner-model: Daybreak blue/red route-default body checks | delete lower-value duplicates of actual wire flow | `routes a <blue/red> selection over <http/websocket> with explicit access selection`: 4 encoded-request cases assert access_programs, route and preserved unrelated overlay |
| runner-model: API-key/no-advertisement/unset selection Daybreak omission | merge setup, retain 3 distinct gates | resolver defaults lack access_programs; custom provider/non-Codex/other-provider actual-wire exclusion cases retained |
| runner: continuation fallback errors | merge 4 bodies into 2 errors × thrown/streamed table | 3 physical requests, stale previous ID on 2nd and absent on 3rd, same logical request ID, exactly Started/Ended settlement, attempts/full/fallback ledger |
| runner: second invalid continuation request must not retry | merge 2 error branches | LLM failure, 3 requests, continuation removed, attempts 1/2 and full/fallback ledger |
| runner: agent prompt plus initial instructions only | delete exact duplicate of effective default agent case | `includes the effective default agent system before durable context`: exact two-element system array; agent-switch cases also retain both prompts |
| runner-tool-registry: only materialization API shape | delete private service-shape assertion, not execution behavior | materialized request execution, codec/identity/settlement/output/progress/retention/interruption/registration-lifetime assertions all retained |
| provider-request: legacy default variant expectation | rewrite stale expectation from intentional `d407835c` contract | named default is ordinary variant; direct optional variant comparison guards inequality. Production unchanged. RED baseline expected provider-not-reported but observed model-variant-switched |
| runner-recorded: fixed namespace digest | rewrite stale pin only if evidence proves fixture request differs solely by intentional absent-variant identity | recorded HTTP body/headers, Session-scoped cache key, promoted user/system/assistant, exact durable event sequence remain; offline matcher gates every provider request |
| execution: resumeSuspendedSessions at-most-once | delete dead action case in existing `c8ae858c`, not atomic suspension contract | `atomically consumes each suspension at most once` and `suspension survives teardown interruption and clears when a drain finishes on its own` retained |

## All-file baseline case-group inventory

Each row classifies every expanded case in its file except the explicit changed groups above. The surviving assertion reference is the named test in the linked source plus its unchanged `expect` calls (static index records lines). `B/<name>` means baseline `<name>.xml` and `<name>.log` in the evidence root, recording every case duration and exact command outcome. Case names define the observable requirement, not a coverage target. Always-kept categories are marked **required gate** and are never discarded.

| File stem (`test/<stem>.test.ts`) | Cases | Wall s | Layer / case-group requirement | Decision / surviving assertion | Baseline evidence |
| --- | ---: | ---: | --- | --- | --- |
| session-active-migration | 1 | 0.09 | DB integration: terminal activity migration | keep required migration gate; exact backfilled rows | B/session-active-migration, exit 0 |
| session-archive | 2 | 0.51 | component: not-found and idempotent durable archive | keep; typed failures and exact event/projection | B/session-archive, exit 0 |
| session-attachment-read | 2 | 0.40 | component: Session file ownership/size/reference boundary | keep security gate; own bytes, missing/invalid/oversized results | B/session-attachment-read, exit 0 |
| session-autonomy | 19 | 0.34 | component/unit: user-owned goals, durable modes, ABA/concurrent reports | keep release gate; goal state/revision/budget/terminal reminders | B/session-autonomy, exit 0 |
| session-cache-diagnostics | 14 | 0.12 | unit: cache telemetry/occupancy/speed/provider mechanism | keep cache gate; reported versus absent/zero and bounded request metrics | B/session-cache-diagnostics, exit 0 |
| session-cache-runtime | 7 | 0.17 | component: low-hit generation/streak policy | keep cache gate; exact durable generation/reset/skipped-evidence results | B/session-cache-runtime, exit 0 |
| session-command | 5 | 0.46 | component: command admission retry and concurrent ID effects | keep; admitted identity, shell result/effect count, rejection boundaries | B/session-command, exit 0 |
| session-compact | 8 | 0.51 | flow: compaction lease recovery, settlement, cancellation, state race | keep; terminal job/event/output and no premature return or lost continuation | B/session-compact, exit 0 |
| session-compaction-constraints | 4 | 0.01 | unit: ordered whole constraint blocks, budget and digest | keep; exact bounded output and hidden-content digest change | B/session-compaction-constraints, exit 0 |
| session-compaction-gate-estimate | 2 | 0.20 | unit: stateless Responses and Copilot effective span estimate | keep; input span/token estimate | B/session-compaction-gate-estimate, exit 0 |
| session-compaction-job | 12 | 0.44 | component: admission/lease/heartbeat/settlement owner fences | keep durability gate; exact pending/running/terminal state/events and stale-owner refusal | B/session-compaction-job, exit 0 |
| session-compaction | 41 | 2.44 | flow: remote opaque state, local helper, protected authority, canonical immutability | keep trust/durable/cache gates; requests, manifests, canonical rows and activated context | B/session-compaction, exit 0 |
| session-context-budget | 9 | 0.04 | unit: capabilities, hard budgets, component totals/estimate | keep; boundary cap and exact token values | B/session-context-budget, exit 0 |
| session-context-cap | 19 | 0.52 | flow: admission to hard-cap handling and compaction | keep; exact provider execution or context failure and durable boundaries | B/session-context-cap, exit 0 |
| session-context-exclusion-cleanup | 2 | 0.38 | component: inactive exclusion pruning preserves canonical history | keep data gate; only stale rows pruned and history intact | B/session-context-exclusion-cleanup, exit 0 |
| session-context-manifest | 23 | 0.44 | unit/component: strict candidate/selector/authority/dependency/transaction fences | keep trust/data/contract gate; invalid candidates rejected, valid history lowered atomically | B/session-context-manifest, exit 0 |
| session-context-pressure | 7 | 0.25 | unit: advisory versus mandatory cap, policy, image estimate | keep; exact pressure classifications at boundaries | B/session-context-pressure, exit 0 |
| session-continuation | 9 | 0.18 | component: provider continuation ownership/model/variant/context identity | keep cache gate; recorded continuation fingerprints and selection | B/session-continuation, exit 0 |
| session-create | 36 | 2.15 | component: creation/adoption/settings/ceilings/replay/fork/location | mixed map above; keep all other identity, validation and durable event assertions | B/session-create, exit 0 |
| session-daybreak | 4 | 0.39 | component: durable setting/idempotency/not-found/event-only writes | merge event-only group; keep projection/idempotency/typed error | B/session-daybreak, exit 0 |
| session-error | 7 | 0.17 | unit: public classified errors and cause preservation | keep; exact error shape, message and cause | B/session-error, exit 0 |
| session-execution | 50 | 0.76 | flow/component: completion, active ownership, suspension, goals, background work | keep release gate; exact completion receipts/terminals, suspension and noncertification fences | B/session-execution, exit 0 |
| session-file-change-cleanup | 3 | 0.37 | component: file-change retention with canonical history | keep data gate; retained versus deleted rows and history | B/session-file-change-cleanup, exit 0 |
| session-generate | 4 | 0.45 | flow: helper generation transport/usage/variant/error | keep; model request and bounded settled result/usage | B/session-generate, exit 0 |
| session-goal | 14 | 0.48 | flow: goal synthesis, continuation, interruption and user ownership | keep autonomy gate; model result or typed failure and no late admission/state corruption | B/session-goal, exit 0 |
| session-guardrail-counter | 2 | 0.05 | unit: guardrail accounting limits | keep security gate; exact counters/boundaries | B/session-guardrail-counter, exit 0 |
| session-guardrail-service | 20 | 0.42 | component: root-family guardrail decisions and exact approval reuse | keep security gate; requested/replied decisions, metadata equality, hard review boundaries | B/session-guardrail-service, exit 0 |
| session-guardrail | 44 | 0.01 | unit: guardrail matching/normalization/rule precedence | keep security gate; exact matches and prohibited approvals | B/session-guardrail, exit 0 |
| session-helper-policy | 5 | 0.16 | unit: helper model/policy and prompt boundaries | keep; selected helper and policy outcomes | B/session-helper-policy, exit 0 |
| session-info | 2 | 0.12 | unit: explicit/absent variant projection | keep contract gate; no variant versus explicit variant | B/session-info, exit 0 |
| session-instructions | 7 | 0.46 | component: durable delta/blob/state/epoch/replay | keep durability/cache gate; exact chronological instruction values and replay/epoch fences | B/session-instructions, exit 0 |
| session-live-state | 4 | 0.28 | component: trusted live Session-state request observation | keep authority gate; current state and durable system message payload | B/session-live-state, exit 0 |
| session-log | 11 | 0.62 | component: typed durable logs/order/blob attachments | keep contract/trust gate; exact log projection and rejected/redacted/bounded payloads | B/session-log, exit 0 |
| session-model-request-permissions | 2 | 0.26 | unit: request permission identities | keep security/cache gate; effective permission arrays and identity | B/session-model-request-permissions, exit 0 |
| session-model-switch | 28 | 0.77 | flow/unit: context fitting/compaction/failure/in-flight boundary | mixed map above; retained outcome/context/transcript/request assertions | B/session-model-switch, exit 0 |
| session-orchestration-notifier | 3 | 0.21 | component: durable parent notification delivery/scheduling | keep flow gate; delivered notification content and failure retention | B/session-orchestration-notifier, exit 0 |
| session-orchestration | 14 | 0.46 | component/unit: task projection/identity/model precedence | delete 2 existence-only checks; keep durable task/notification and explicit agent/model rules | B/session-orchestration, exit 0 |
| session-outstanding | 7 | 0.44 | component: outstanding Session family/job/work status | keep shutdown gate; exact outstanding rows/family status | B/session-outstanding, exit 0 |
| session-permission-ceiling | 3 | 0.04 | unit: inherited effective permission ceiling | keep security gate; exact inherited/restricted rules | B/session-permission-ceiling, exit 0 |
| session-pin | 2 | 0.38 | component: not-found and idempotent durable pin/unpin | keep; typed errors and exact events/projection | B/session-pin, exit 0 |
| session-projector | 15 | 0.48 | component: ordered durable event projection, reset/replay | keep data/event gate; exact message/part/task/settings projection | B/session-projector, exit 0 |
| session-prompt | 39 | 0.63 | component: admission/attachments/retry identity/wake/pending ordering | mixed map above; preserve all nonduplicate admission, ownership and attachment assertions | B/session-prompt, exit 0 |
| session-provider-request | 13 | 0.46 | component: durable ledger/attempts/usage/cost/compaction/identity | required cache/usage gate; stale default expectation rewrite, add provider-switch branch | B/session-provider-request, exit 1 |
| session-remove | 2 | 0.41 | component: removal and not-found | keep data gate; canonical Session removal and error | B/session-remove, exit 0 |
| session-run-coordinator | 30 | 0.25 | component: concurrent runs/wakes/transitions/interruption/ownership lifetime | keep concurrency gate; active sets, starts, completion ordering, joined errors and wake continuation | B/session-run-coordinator, exit 0 |
| session-runner-cache | 24 | 0.13 | unit/wire: canonical namespaces/session keys/provider cache options | required cache gate; add absent/default variant guard from model-switch | B/session-runner-cache, exit 0 |
| session-runner-message | 16 | 0.18 | unit: chronological typed model history/file/tool/provider lowering | keep contract/security/cache gate; exact lowered messages and omitted secrets/provider state boundaries | B/session-runner-message, exit 0 |
| session-runner-model | 63 | 0.27 | component/wire: route/package/credential/variant/Daybreak/cache options | mixed map above; preserve all selection, body, HTTP/WebSocket and exclusion assertions | B/session-runner-model, exit 0 |
| session-runner-observations | 1 | 0.35 | unit: visible versus empty observation semantics | keep; exact observations classification | B/session-runner-observations, exit 0 |
| session-runner-recorded | 1 | 30.37 | recorded flow: admission through request/HTTP transcript/events | keep always-required recorded/wire guard; stale pin investigation | B/session-runner-recorded, exit 1 timeout |
| session-runner-tool-events | 11 | 0.21 | unit: typed tool input/result/progress/error provider event conversion | keep contract gate; exact typed event sequence and failure boundaries | B/session-runner-tool-events, exit 0 |
| session-runner-tool-registry | 19 | 0.39 | component/wire: scoped registration/materialized execution/settlement | delete private shape-only case; keep actual execution/identity/codec/retention assertions | B/session-runner-tool-registry, exit 0 |
| session-runner | 239 | 11.13 | flow: skills/prompt ordering/tool/retry/cache/instructions/step lifetime | mixed map above; preserve new main skill case and all other required flow assertions | B/session-runner, exit 0 |
| session-skill-invocation | 19 | 0.19 | unit: explicit skill invocation syntax | keep activation gate; exact parsed identities and malformed exclusion | B/session-skill-invocation, exit 0 |
| session-skill-status | 10 | 0.20 | unit: activation/deactivation/duplicate/replay/conflict projections | keep durable skill gate; exact current state and invalid-state rejection | B/session-skill-status, exit 0 |
| session-skill | 8 | 0.46 | component: durable activation/conflict/reload/deactivation | keep authority gate; exact snapshots, instructions, winners/losers and no duplicate mutation | B/session-skill, exit 0 |
| session-summary-toon | 22 | 0.05 | unit: summary encoding/strict parsing/authority supersession | keep contract gate; round trips, invalid document rejection and required-text preservation | B/session-summary-toon, exit 0 |
| session-team-observation | 4 | 0.12 | unit: authoritative TeamView ordering/selection/updates | keep authority/cache gate; exact view and chronological update shape | B/session-team-observation, exit 0 |
| session-title | 6 | 0.42 | flow: local/model/off/title ownership/provider fallback | keep; generated title and permitted/no provider request, child/second-user fences | B/session-title, exit 0 |
| session-todo | 1 | 0.37 | component: persisted todo order/event publication | keep durable contract gate; exact persisted list/update events | B/session-todo, exit 0 |
| session-tool-progress | 1 | 0.24 | component: invocation-scoped durable tool progress | keep event gate; identity/bounds and exact progress publication | B/session-tool-progress, exit 0 |
| session-usage-cleanup | 1 | 0.37 | component: stale inactive usage projection pruning | keep usage/data gate; only stale projections deleted | B/session-usage-cleanup, exit 0 |
| session-usage-migration | 1 | 0.06 | DB integration: usage backfill | keep migration/usage gate; exact migrated usage | B/session-usage-migration, exit 0 |
| session-usage | 5 | 0.05 | unit: normalized categories/timings/prices/cache accounting | keep usage gate; exact reported/absent categories, independent timing and price sums | B/session-usage, exit 0 |
| session-wait | 1 | 0.37 | component: known/unknown idle-wait Session | keep API gate; known result/unknown error | B/session-wait, exit 0 |

## Restart removal evidence

`resumeSuspendedSessions` and `listSuspended` have no live references in Core, Server, CLI, assigned tests, restart spec or runtime docs. Parent commit source scan and clean rebased lane confirm only the removed test called the dead action. Active callers in `packages/server/src/process.ts` invoke reconciliation then register suspend finalizer. `consumeSuspended` remains the conditional UPDATE/RETURNING owner in `session/store.ts`; `session/execution.ts` clears suspension on lifecycle commit. No schema, durable event, database column/index or public wire operation changed. Baseline `session-execution` has 50 passing cases. Contract distinguishes manual Session resume from the deleted mass-resume action.

## Pending acceptance evidence

No SL-wide completion claimed. Root checks and package typecheck are parent integration gates.

### Assertion-loss correction

The initial dirty fitting-switch merge lost the removed smaller-context case's exact compaction-count assertion. Restored `messages.filter(message => message.type === "compaction")).toHaveLength(1)` in the surviving fitting-switch case before final runs. The other removed assertion groups map above; no other required assertion loss was found. Provider/model/cache identity checks live at their owning ledger/cache layer; actual Daybreak transport assertions subsume route-default-only checks.

### Independent recorded namespace verification

Loaded `provider-wire-shape-verification`. Did not regenerate or edit the recorded cassette. Independently computed SHA-256 with Python standard-library `hashlib` over `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()`; did not use production canonicalization or copy observed runtime output.

Canonical namespace object fields: `namespace: session-prompt-cache/v2`, `projectID: global`, `directory: /project`, absent workspace/variant/scope, `providerID: openai`, `modelID: gpt-4o-mini`, `policyRevision: provider-native/v8`, permissions in Agent.Info.empty order (`*/*/allow`, `external_directory/*/ask`), two text system parts (raw `plugin/system-prompt/gpt.txt`, including trailing newline; artifact content plus two newlines plus memory content), tools `[]`. Inputs follow `session/model-request.ts:241-251`, `Agent.Info.empty`, and the recorded test's inert instruction/catalog/tool layers.

- Absent-variant digest: `2b63e4f5188e14c7cc338f931b964c57aff442c57b2b7bc67b67a84b21fa9ea3`.
- Identical object plus `variant: default`: `b262c30baea8fc90ee7f7d4d335518f539c2d84701e3ae4fe84c49d543d89696` (exact previous pin). This isolates intentional `d407835c` sentinel removal as the stale pin cause.
- Wire formula fields `namespace: session-prompt-cache-generation/v1`, `sessionID: ses_runner_recorded`, new baselineKey, `generation: 0`: `eaa9811fa937659c029683afb828ee569f335c0e453a3fc5e35cb1cfa1021b02`.
- Current GPT text trimmed equals the recorded fixture's system prompt trimmed. GPT source, artifact instructions and memory instructions byte-identical to `codebase-cleanup`; source SHA-256 respectively `3a99cb54f3484e09ce7b6c3b37fa4730690ca012805ad2bd4244402deb42716d`, `2ba78f692425183101ffad492cb591ac9c9160a960148d3858353d740b7476d7`, `df8a7c9f15a23e9d63952abad17b4e70d08ea269cc104e51e59c47262f8f8c3d`.
- Existing matcher owns normalization for added artifact/memory instructions, trusted Session-state system message and Session-scoped wire key. All full-body/headers and transcript/event assertions retained. Revised recorded test exit 0 in 0.47 s, not a regenerated golden or a weakened matcher.

### Mutation probes (all restored by precise patch)

Commands: `bun test --cwd packages/core --timeout 30000 test/<file>.test.ts -t '<filter>'`; each process memory 8192 MiB, shell timeout 120000 or 180000 ms, no concurrent tests. Every probe command below exited **1**, from intended behavioral failures rather than setup or syntax. Logs under `/tmp/sl-core-session-evidence/probes/`. Source references are pre-probe lines in rebased lane; all source mutations temporary.

| Guarded removed/merged group | Production mutation | Filter / observed surviving failures | Evidence |
| --- | --- | --- | --- |
| child blue/off and fork reset | projector.ts:765 replace inherited child Daybreak with red; projectFork insert inherits parent Daybreak | create `a child\|a fork...`: 3 named scenario failures | create.log |
| create current projection | session.ts:840 return caller input agent instead of current recorded agent | create `current Session projection after projected`: expected build, observed undefined | create.log |
| generated/caller Created persistence | session.ts after create publication: rewrite only test DB aggregate event type to session.created.1 | create `persists.*creation`: both surviving event-type assertions fail | create.log |
| Daybreak event-only writes | session.ts:1689 admit a false-resume prompt in setter | daybreak `persists a Daybreak`: exact aggregate event array fails on extra admitted event; rerun isolated from Created-version mutation confirms only extra admitted event differs | daybreak-isolated.log (supersedes composite daybreak.log) |
| attachment managed reference recovery | session.ts:2111 drop managed attachment name | prompt `admits a resent`: managed URI expected notes.txt but omitted; data URL case still passes | prompt.log |
| reattached data URL exact bytes | session.ts:2118 truncate decoded bytes with subarray(1) | prompt `admits a resent data URL`: expected restored notes, observed truncated otes | prompt-data-url.log |
| omitted/true/false prompt wake | session.ts:1380 wake only when resume exactly true | prompt `wakes execution after`: omitted-default case fails; explicit true/false still pass | prompt.log |
| model/provider ledger invalidation and absent/default variant | provider-request.ts:231 disable identity comparison; :233 coalesce absent to default | provider-request `prioritizes compaction`: exact invalidation sequence fails | provider-identity.log |
| cache sharing dimensions and named-default isolation | runner/cache.ts:106-108 omit provider/model/variant fields | runner-cache `isolates every cache\|hashes an absent\|shares subagent prefixes`: all 3 surviving guards fail | cache-identity.log |
| exact system prompt and initial instructions | model-request.ts:91 ignore agent override | runner `includes the effective default agent system`: exact two-part system array fails | agent-system.log |
| compatible route precedence | runner/model.ts:326 prefer settings.api over model api | runner-model `OpenAI-compatible endpoint`: model override case fails, other 3 pass | model-route-daybreak.log |
| blue/red route-default checks replaced by actual encoded wire assertions | runner/model.ts:511 omit cyber value | runner-model `routes a .* selection over`: all 4 HTTP/WebSocket blue/red cases fail actual body assertions | model-route-daybreak.log |
| Daybreak omission gates | runner/model.ts:503 remove selection/credential/advertisement/Codex route guards | runner-model `omits access_programs for`: all 3 omission cases fail | model-route-daybreak.log |
| fitting smaller context/no compaction | model-switch.ts:81 disable fitting-context success | model-switch `applies a fitting switch without`: surviving fitting-switch fails | model-switch-fit.log |
| 4 continuation fallback error/delivery permutations | runner/llm.ts:795 disable continuation fallback | runner `falls back once from (thrown\|streamed)`: all 4 error/delivery cases fail | continuation-fallback.log |
| second invalid request must not retry, both error branches | runner/llm.ts:795 remove continuation-used guard | runner `does not retry a second .* after the continuation fallback`: both expected LLMError assertions receive provider-invalid-output recovery error | continuation-fallback-once.log |
| atomic suspension consumption retained after dead restart action deletion | store.ts:62 omit non-null suspension UPDATE condition | execution `atomically consumes each suspension`: second consume unexpectedly true | suspension.log |

Create probe: 6/6 fail; isolated Daybreak: 1/1 fail; prompt: 2 fail/3 pass; data URL: 1/1 fail; ledger: 1/1 fail; cache identity: 3/3 fail; agent system: 1/1 fail; route/Daybreak: 8 fail/3 pass; fitting switch: 1/1 fail; fallback: 4/4 fail; fallback-once: 2/2 fail; suspension: 1/1 fail. Non-required existence/mock/private-shape checks and dead-action-only behavior require no replacement mutation; real behavior suites stay retained. Checks of `git diff --exit-code` for restored production files exited 0 after each probe batch. Final `git diff --exit-code -- packages/core/src` exited 0: no production edits beyond the pre-existing restart removal commit.

### Final stability and affected gates

All 12 touched files (11 dirty files plus the committed restart execution test) pass 3 consecutive isolated runs and 1 loaded run: 511 cases per round, 2,044 successful case executions, no failures or timeouts. Exact command is the baseline command with evidence folder `isolated-1`, `isolated-2`, `isolated-3`, or `loaded`. Each file is its own Bun process. Test process cap 8192 MiB; shell timeout 120000/180000 ms. Later warning-only fixes invalidated only create/model-switch/prompt runs; repeated all 3 isolated runs and the loaded run for those exact files. The table records final runs, not superseded results.

| File | Cases before → after | Isolated 1 s | Isolated 2 s | Isolated 3 s | Loaded s |
| --- | ---: | ---: | ---: | ---: | ---: |
| session-create | 36 → 35 | 1.91 | 1.76 | 1.88 | 2.52 |
| session-daybreak | 4 → 3 | 0.40 | 0.41 | 0.40 | 0.40 |
| session-execution | 50 → 50 | 1.53 | 1.40 | 1.31 | 0.88 |
| session-model-switch | 28 → 20 | 0.76 | 0.74 | 0.74 | 1.15 |
| session-orchestration | 14 → 12 | 0.45 | 0.46 | 0.45 | 0.47 |
| session-prompt | 39 → 35 | 0.60 | 0.62 | 0.63 | 0.78 |
| session-provider-request | 13 → 13 | 0.46 | 0.48 | 0.46 | 0.48 |
| session-runner | 239 → 238 | 11.82 | 11.58 | 11.20 | 11.15 |
| session-runner-cache | 24 → 25 | 0.15 | 0.13 | 0.13 | 0.14 |
| session-runner-model | 63 → 61 | 0.27 | 0.31 | 0.29 | 0.29 |
| session-runner-recorded | 1 → 1 | 0.47 | 0.48 | 0.46 | 0.48 |
| session-runner-tool-registry | 19 → 18 | 0.41 | 0.40 | 0.39 | 0.41 |
| Total touched | 530 → 511 | 19.23 | 18.77 | 18.34 | 19.15 |

Loaded verification: initial 12-file loop overlapped the parent's CLI baseline load. For the final create/model-switch/prompt edits, parent granted one test loop at 4096 MiB concurrent with fresh Core package typecheck at 8192 MiB; no other parent heavy typecheck ran. Nanosecond timestamps prove every final loaded test fully overlaps typecheck:

- Typecheck: `[1790996664338290000, 1790996669011671000]`.
- Create: `[1790996664338299000, 1790996666883371000]`, exit 0.
- Model-switch: `[1790996666897916000, 1790996668071917000]`, exit 0.
- Prompt: `[1790996668086284000, 1790996668885972000]`, exit 0.

`bun run --cwd packages/core typecheck` (fresh `tsgo --noEmit`), timeout 120000 ms, cap 8192 MiB: exit 0, real 4.65 s, user 20.03 s, sys 1.55 s; `typecheck.log`.

Touched-file lint: `bun run lint --threads=1 <12 named touched test paths> --format json`, timeout 120000 ms, cap 8192 MiB: exit 0, 0 errors, 131 warnings, 0 new warnings against same-path clean-HEAD baseline. Baseline and final JSON in `lint-baseline.json` and `lint-final.json`; exact filename/rule/message multiset comparison. The first 2048 MiB default-thread lint call was memory-killed before output; inspected mandatory type-aware config/workload, reduced threads to 1, obtained parent's 8192 MiB gate, and reran without disabling any rules. Initial revised lint added 3 warnings; removed only the unused SessionTable import, unnecessary scenario template, and generator inconsistent return, then repeated invalidated checks. Same-path baseline temporarily used named stash `53190d69d4e0e7e5bf083b9ea1294a51ef82ef3c`; exact apply/cmp verified no lost edits; stash retained.

`bun run lint --threads=1 packages/core/src/session/execution/restart.ts packages/core/src/session/store.ts --format json`, same cap/timeout: exit 0, 2 files, 0 diagnostics. `git diff --check`: exit 0. Final scope/diff review confirms only assigned tests plus existing restart source/spec commit; no probe remains and no recording, Schema, durable event, stored-data, public wire, dependency, or unrelated main behavior changed. Main's new explicit-multiple-skill case remains.

Aggregate owned family: **65 files unchanged; cases 1,010 → 991; newline-count lines 35,358 → 34,838 (-520)**. Touched 12-file lines 18,151 → 17,631. Before total isolated wall 65.11 s; after 36.43 s combines final fresh touched runs with unchanged-file baseline runs. Not a fresh simultaneous 65-file run and not a statistical performance claim: most apparent improvement is removal of the recorded baseline's 30 s stale-pin timeout; touched non-timeout suites otherwise remain about 19 s. All 991 retained cases have passing per-file evidence; the 53 untouched files reuse their baseline successes because their files and production inputs were unchanged. No full Core/TUI suite or live provider used. Root typecheck/lint/effect-pattern checks and final integration/rebase belong to parent; no whole-SL completion claim.

### Commits and handoff

Existing coherent restart removal: `c8ae858c` (rebased `6975fbe4`). New coherent Session test slice: `55ec95b7 test(core): consolidate Session test coverage`, 11 assigned test files, +228/-748 lines. Both commits use existing Git identity, no attribution or trailers. Commit, cached diff check and final unstaged/staged diff checks exited 0; lane working tree clean. Branch freezes at `55ec95b7` for parent's rebase/FF integration onto the current cleanup branch; no other lane or cleanup branch changed here. Scope against initial integration base `1141158a`: 15 assigned paths only (12 test files, 2 restart source files, 1 restart spec). Inventory stays only in ORIGINAL root `plans/codebase-cleanup/test-inventory/core-session.md`, never staged or committed. No push, deployment, dependency change, other-lane rebase, memo update (no user ID), or child delegation.

Remaining integration gates: parent rebase/FF onto the advanced cleanup branch and parent-owned root checks. No child-owned validation blocker remains. No claim of all SL completion. Separately observed documentation mismatch outside this lane's edit ownership: `docs/configuration.md:392` still describes default/none sentinel behavior, while `d407835c`, Schema optional variant, Session runner availability checks and preserved tests treat named variants directly; reported for parent ownership rather than editing shared documentation.

## Core completion pass (AC15, lane `core`, base `d30e97bf`)

Re-verified on Linux x64 (4 CPU, uid 0) with Bun 1.4.2, one Bun process per file, `bun test <file> --timeout 30000 --reporter=junit`, serialized through the shared SL runner. Raw JUnit/logs stay in lane scratch and are not committed.

- **Stale baseline failures:** `session-provider-request` (13 pass) and `session-runner-recorded` (1 pass) both pass at `d30e97bf` and at the lane head. The two documented stale failures no longer reproduce.
- **Per-case classification:** all 65 `test/session*.test.ts` files are covered by the table above. Current JUnit count is 993 cases: the 991 recorded after the Session lane plus the parent's two `session-runner` image-analyzer wire cases (`8dfbd7ee`), classified **keep** (provider wire contract for text-only models analyzing local tool-result images).
- **Fresh per-file evidence replaces reused baseline successes:** every Session file ran individually at `d30e97bf` and again at the lane head: 65 files, 993 cases, 0 fail, 0 skip both times; summed per-process wall 119.1 s before and 118.4 s after on this host (includes Bun start-up per file; not comparable with the earlier macOS sums).
- **G10 (timing):** no `test/session*.test.ts` file contains a success-path wall-clock wait; the one sleep (`session-compaction` 40 s `beforeResponse`) runs under `TestClock`. The loaded sweep ran `session-compaction`, `session-guardrail-service` and `session-runner-model` while a forced root typecheck loaded the host: all passed. No Session test file changed in this pass.
- **Mutation probes:** all removed or merged Session groups were probed in the table above; no new Session removal happened in this pass, so no new probe was required.
- **Remaining:** root typecheck/lint are parent integration gates.
