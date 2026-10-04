# Authorized web scope evidence — never commit

## Ownership and outcome

- Edit only `.worktrees/codebase-cleanup/apps/web` and this ORIGINAL evidence file. Parent owns Git, root documentation/specifications, CLI/recorder work and final cleanup integration. No Git mutations, dependency changes, schema/API changes, live external writes or child delegation were performed.
- Preserve manual reader intent through streaming, tool progress, snapshots and virtual resizing; enter Sessions/Usage/Settings at top and Conversation at latest before visible paint; restore sidebar and per-Session reader anchors; expose readable question/answer history and owned pending child answers; navigate to the existing single landing without losing drafts or creating a Session.
- Keep the current runtime, provider/cache/usage paths, selected native Form ownership and Team answer operation. Browser fixtures mock account, provider and backend responses, not the application/store/projection/rendering path.

## Changed lane paths

All paths below are under the cleanup worktree's `apps/web/`:

- `DESIGN.md`: W22 manual intent and Usage/Settings entry; W35 rail/start/draft ownership; W36 readable questions and parent child controls, with existing tokens/components.
- `src/remote/ui/transcript-nav.tsx`, `transcript-nav.test.ts`, `virtual-rows.ts`: one reader-intent signal, input clocks and listener cleanup, latest follow only for followers, measured/hidden-row preservation, one keyed position handoff.
- `src/remote/ui/shell.tsx`, `new-session.tsx`, `src/styles/remote.css`: route entry, per-Session key/viewport-offset capture, rail focus/offset restoration, accessible New conversation action, one lazily retained device-scoped landing, attachment admission settlement, scoped idle/empty landing rules.
- `src/remote/question-history.ts`, `question-history.test.ts`, `src/remote/ui/conversation.tsx`: actual question inputs and recorded answers; parent text plus structured data; stable readable cards and truthful missing/failure/cancelled states.
- `src/remote/store.ts`, `test/remote-child-question.test.ts`: one in-flight answer per parent/child/question across Team and Conversation; preserve existing connection/selection/family fences; clear obsolete question fields from authoritative answer/cancel results.
- `verify/conversation-reading.integration.test.ts`, `conversation-questions.integration.test.ts`, `reader-keyboard.integration.test.ts`, `remote-fixture.tsx`, `team.integration.test.ts`: focused real-render regressions and wire-flow proof. Team's oldest-message assertion is retained and reached with the product Jump to top instead of assuming every virtual row is mounted.

## Producer and ownership trace

- `packages/core/src/tool/question.ts` declares `input.questions` (`header`, `question`, `options`, optional `multiple`) and `output.answers: string[][]`; `toField` creates native Forms with metadata `{kind:"question", tool:{messageID,callID}}`.
- `packages/core/src/session/runner/publish-llm-event.ts` publishes structured tool results into durable `session.tool.success`; the existing web projection reads `ToolState.structured` from live events and snapshots.
- `packages/core/src/tool/subagent-report.ts` declares `{action:"question",text,data?}` and returns the task question. `packages/schema/src/session-orchestration.ts` declares waiting task questions and optional answer text/data.
- `packages/core/src/session/orchestration.ts` validates parent-child ownership and question identity/state, records `Parent answer:\n<JSON>` with metadata source `subagent_parent`, kind `answer`, and questionID, then wakes the child. Task paging orders waiting tasks first.
- Existing Protocol endpoints are `session.subagent.answer` and `session.form.reply`; the closed remote operation validates parent/child/question/text. The web reuses `answerSubagent`; it does not proxy child Forms through the selected Session's Form reply.
- Reader intent and touch position belong to one mounted transcript; inactive/disposed transcripts release listeners/observers. Shell anchor maps and landing residency belong to the shell/device lifetime. In-flight child answers belong to the store and captured parent/child/question until request settlement; replacement still yields unknown rather than replay.

## Reproduced RED and chosen corrections

| Boundary | Observed RED | Correction / GREEN assertion |
| --- | --- | --- |
| Usage route entry | inherited scrollTop 136px | first visible samples at top, all four route entries within 1px |
| Sessions route entry | 35px measured-list end correction | non-following lists disable virtual end-follow; entry remains at top |
| Rail reopen | visible virtual row shifted 275px; hidden fallback correction later 30px | freeze hidden layout and retain cached/typical size; restore offset and prevent focus scrolling; same row and offset within 1px |
| Tablet rail resize | transcript row shifted 26px after backward scroll | compensate measured rows above the viewport even after backward input; same visible row within 1px |
| Reader above pending decisions | trusted wheel160px up followed by new tool/progress shifted row53px | reactive reader ownership disables the virtualizer's local-list tail follow while reading |
| Small manual gestures | wheel12px and touch40px snapped26px on growth | explicit upward intent; paused proximity does not resume follow; wheel/touch visible-row checks pass |
| Keyboard input | ArrowUp resumed follow at an initial at-bottom scroll event and snapped35px | leaving phase holds intent until manual movement lands; native scrollend bounds measurement; focused code node retained |
| Session revisit | prior anchor disappeared from virtual window during restore | capture outgoing key/offset before selection and consume one position handoff after mounted history; no 220ms restore loop |
| New conversation navigation | no named action | native keyboard activation opens the existing landing; zero session.create calls |
| Landing draft / attachments | new text became empty after navigation; unknown creation lost scope.txt | keep interacted-with landing component through navigation; await create's boolean settlement so unknown keeps attachments |
| Retained landing cascade | idle pane still painted because :has display:flex overrode idle display:none | guard composition selector by non-idle state; retained pane remains inert and non-painted |
| No-selection landing | hero ratio0.5357 below existing0.6 bound | update the existing empty placement's 640px owner selector to the single route panel |
| Question history | only collapsed Completed rows and parent description | human questions, native answers and parent text/data are readable without expanding raw tool output |
| Child answer race | concurrent second answer returned ok | real store/transport rejects duplicate, exactly one outgoing operation, stale question clears |
| Parent answer data | text+data discarded data | preserve both, render structured data with existing Markdown code treatment |
| Cold fixture sequence | HEAD overlay also repeated notice.subscribe and workspace.list(sessionsOnly), isolated case passed | fixture reuses the Studio connection already restored by store.load; strict existing request-count assertions remain intact |

Setup failures were not counted as behavioral RED: escaped JavaScript newline, synchronous fixture handler using await, private virtualizer method access, and native Enter without carriage-return text. Each was corrected before relying on its check.

## Exact checks and exits

Commands run from `.worktrees/codebase-cleanup`. Browser commands use:

```sh
export YCODING_WEB_CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
export TMPDIR="$PWD/.cache/tmp/web-reading"
```

New browser suites use ephemeral Node HTTP listeners over Vite middleware with independent lane cache directories and HMR WebSockets disabled. Existing suites' fixed ports were checked free; each file ran in its own process. Browser runs used finite 90/120/180s command bounds and 4096MiB process caps.

| Exact focused command | Last verified result |
| --- | --- |
| `bun test --cwd apps/web verify/conversation-reading.integration.test.ts` | exit0; 11 pass, 0 fail, 92 assertions |
| `bun test --cwd apps/web verify/conversation-questions.integration.test.ts` | exit0; 3 pass, 0 fail, 26 assertions |
| `bun test --cwd apps/web verify/reader-keyboard.integration.test.ts` | exit0; 1 pass, 0 fail, 3 assertions |
| `bun test --cwd apps/web src/remote/question-history.test.ts src/remote/ui/transcript-nav.test.ts src/remote/ui/virtual-rows.test.ts src/remote/ui/route-panel.test.ts src/remote/form-view.test.ts src/styles/design-md.test.ts src/styles/contrast.test.ts src/styles/composition.test.ts src/styles/tokens.test.ts test/remote-child-question.test.ts test/remote-team.test.ts` | exit0; 105 pass, 0 fail, 875 assertions; includes real listening relay/store integration, not unit-only |
| `bun test --cwd apps/web verify/transcript-stability.integration.test.ts` | exit0; 7 pass, 0 fail, 128 assertions |
| `bun test --cwd apps/web verify/new-session.integration.test.ts` | exit0; 5 pass, 0 fail, 185 assertions |
| `bun test --cwd apps/web verify/team.integration.test.ts --test-name-pattern 'answer\|controls\|family\|subagent\|readonly\|read-only\|tabs\|real remote Team'` | exit0; 15 pass, 8 unrelated filtered, 144 assertions |
| `bun test --cwd apps/web verify/remote-navigation.integration.test.ts --test-name-pattern 'routes retain\|swaps\|new-session swap\|known selected\|entering Sessions\|managed child view\|Conversation re-enters'` | exit0; 7 pass, 7 unrelated filtered, 230 assertions |
| `bun test --cwd apps/web verify/remote-transitions.integration.test.ts` | exit0; 6 pass, 0 fail, 18 assertions |
| `bun test --cwd apps/web verify/remote-shell-layout.integration.test.ts --test-name-pattern 'scrolls Settings\|no-selection Sessions\|draft through rotation\|presentation bar\|collapses the selected\|selected-subagent bar\|mobile composer compact'` | exit0; 7 pass, 42 unrelated filtered, 594 assertions |
| `bun run --cwd apps/web typecheck` | exit0; final source at 2026-10-03T06:55:22Z, cap8192MiB |
| `bunx oxlint --type-aware --threads=1 <15 touched TS/TSX files>` | exit0; 130 enabled rules, 0 errors, 11 unchanged warnings at06:55:22–23Z, cap8192MiB |
| `YCODING_WEB_VERIFY=0 bun run --cwd apps/web build --outDir ../../.cache/tmp/web-reading/production-final` | exit0; 333 modules, 06:55:23–26Z, cap8192MiB; default dist untouched |
| `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint apps/web/DESIGN.md --strict` | exit0; 0 errors, 0 warnings |
| `bun test --cwd apps/web src/styles/design-md.test.ts src/styles/contrast.test.ts src/styles/composition.test.ts` | exit0; 48 pass, 639 assertions |
| Emitted CSS bounded source check | exit0; idle order, guarded landing selector, empty landing cap and breadcrumb action all true |
| `git diff --check -- apps/web` | exit0 |

Lint retained warnings: 3 existing navigation floating promises; 2 existing store loop conditions; 3 existing store unsafe assertions; 1 existing transcript focus-target assertion; 2 existing fixture unsafe assertions. No rule was disabled. Production build retained the large-chunk warning and the intentional scratch outDir-not-emptied warning.

## Mutation proof and captures

Verbatim filtered and lint commands (the table escapes pipe characters only for Markdown):

```sh
bun test --cwd apps/web verify/team.integration.test.ts --test-name-pattern 'answer|controls|family|subagent|readonly|read-only|tabs|real remote Team'
bun test --cwd apps/web verify/remote-navigation.integration.test.ts --test-name-pattern 'routes retain|swaps|new-session swap|known selected|entering Sessions|managed child view|Conversation re-enters'
bun test --cwd apps/web verify/remote-shell-layout.integration.test.ts --test-name-pattern 'scrolls Settings|no-selection Sessions|draft through rotation|presentation bar|collapses the selected|selected-subagent bar|mobile composer compact'
bunx oxlint --type-aware --threads=1 apps/web/src/remote/store.ts apps/web/src/remote/question-history.ts apps/web/src/remote/question-history.test.ts apps/web/src/remote/ui/conversation.tsx apps/web/src/remote/ui/new-session.tsx apps/web/src/remote/ui/shell.tsx apps/web/src/remote/ui/transcript-nav.tsx apps/web/src/remote/ui/transcript-nav.test.ts apps/web/src/remote/ui/virtual-rows.ts apps/web/test/remote-child-question.test.ts apps/web/verify/conversation-reading.integration.test.ts apps/web/verify/conversation-questions.integration.test.ts apps/web/verify/reader-keyboard.integration.test.ts apps/web/verify/remote-fixture.tsx apps/web/verify/team.integration.test.ts
```

Five precise mutants were introduced individually, targeted checks failed with exit1, and production files were restored byte-for-byte (SHA-256 comparison): wrong question text; removed cross-surface in-flight guard; unconditional virtual end threshold (53px drift); unguarded retained landing display; default backward resize compensation (26px drift, focus remained on Show sessions sidebar). Restored GREEN runs followed. Initial baseline RED also discriminated missing New conversation, lost text/attachments and stale answered-question fields.

Inspected captures in lane `.cache/tmp/web-reading/`: `questions-390-light.png`, `questions-1440-dark.png`, `start-390.png`, `start-1440.png`, `child-question-sending.png`. Actual question/answer cards and the single landing render; the early capture exposed the idle cascade defect and was regenerated after correction. Fixture chrome is removed for final history/start captures.

## Parent documentation statement and limits

Parent-owned product/runtime documentation should state: remote screen transitions enter Sessions, Usage and Settings at top and Conversation at latest before paint; deliberate manual input pauses follow until actual bottom or Jump to latest; the sidebar and revisited Session retain their reader anchors; New conversation opens the single existing start surface without creating a Session or losing Session/landing drafts; uncertain creation retains attachments; recorded question text/answers remain inline; parent Conversations expose task-backed pending direct-child questions through the existing parent-owned Team answer operation, with no duplicate in-flight send or automatic unknown-outcome replay. Native Forms retain selected-Session ownership.

Live backend/provider/auth deployment, Safari/iOS, real on-screen keyboard, installed-app lifecycle, native browser scrollbar drag and comprehensive screen-reader behavior were not exercised. Chrome headless phone/touch emulation is not proof of those platforms. No full web, TUI or repository suite was run; no default-dist integration package script was run because its output is parent/shared. Parent owns root checks, final docs/spec review and Git integration. No memo ID was supplied; no memo update was made. This evidence is not a cleanup-completion claim.
