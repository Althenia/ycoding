# SL inventory — `apps/web`

## Scope and method

- Inventory covers 143 test files under `apps/web/src`, `apps/web/test`, and `apps/web/verify` at `sl-web` HEAD `1141158a` (rebased onto `codebase-cleanup`): 71 source tests, 24 relay-backed tests, and 48 browser-verification tests. The final remote refresh tests use one shared test clock and an internal `RemoteStoreOptions.monotonicNow` seam; its default remains `performance.now()`, while wall-clock `now` and transport timing are unchanged. No CSS, visual, generated, or public-contract changes are in this lane.
- The web package has three layers: `src` unit/contract tests, `test` relay-backed integration/flow tests, and `verify` real-browser rendered-flow tests. Keep each layer where it detects behavior that a lower layer cannot observe; all `test` remote suites and all relevant `verify` flows remain protected.
- `test.each` rows are one behavior group with separately asserted inputs. The `rg -c` declaration count is not a reliable expanded case count; report actual case counts from JUnit. JUnit rows record individually invoked file runs; the validation ledger distinguishes earlier unchanged-file runs, corrected remote-file repetitions, and measured loaded overlap.
- Required behavior/surviving assertions and the pre-removal classification for every test group are in the following directory inventory. Unchanged files stay `keep`; no current edit is authority to remove a required assertion.
- The current tree has 149 files; the Linux completion pass below supersedes the earlier remaining-failure classification and carries the AC15 gates for this lane.

## Linux completion pass (base `d30e97bf`)

### Environment and method

- Host: Linux x64 container running as root, 4 CPUs. Browser: Playwright Chromium 1194 headless. Every command ran through the serialized lane wrapper (Bun 1.4.2), one test file per invocation, with `--timeout 30000 --reporter=junit`. `apps/web` was built with `bun run build:web` before the sweep (`test/build-output`, `verify/pwa-*` and `verify/invite` read `dist/`).
- Chromium refuses to start as root without `--no-sandbox`, so `YCODING_WEB_CHROME` pointed at a scratch launcher that adds it. Headless Linux Chromium also reports `pointer: none` and `hover: none` (probed with `matchMedia`); CDP `Emulation.setEmulatedMedia` does not override `hover` or `pointer`. A second launcher adds `--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2` (fine pointer, hover), which matches the desktop pointer profile of the earlier macOS sweep. Neither launcher is committed.
- Sweep 1 ran all 52 `verify` files with the no-pointer launcher. Every failure was rerun with the desktop-pointer launcher. The final sweep reran all 52 with the desktop-pointer launcher after the corrections.

### New files since the 143-file inventory (all `keep`)

| File | Cases | Required behavior | Layer |
|---|---:|---|---|
| `src/remote/question-history.test.ts` | 3 | Ordered human questions, typed recorded answers, truthful missing/failed answers, and parent answers only with producer metadata and matching question identity (D21) | Unit / projection |
| `test/remote-child-question.test.ts` | 1 | Team and Conversation cannot send two answers for one owned child question; exactly one outgoing operation (D21 reproduced race) | Relay-backed flow |
| `verify/conversation-reading.integration.test.ts` | 14 | Reader intent survives streaming, route entry positions, rail and Session anchors, single new-conversation landing (D20) | Real browser |
| `verify/conversation-questions.integration.test.ts` | 3 | Readable question/answer history and parent-owned child answers (D21) | Real browser |
| `verify/reader-keyboard.integration.test.ts` | 1 | Keyboard reading does not resume follow (D20 reproduced regression) | Real browser |
| `verify/upload-flow.integration.test.ts` | 5 | Upload progress, cancel, same-ID retry, Session isolation, local oversize alert (D33/G26) | Real browser |

### Browser failure classification (every `verify` file)

Files not listed passed in sweep 1 and in the final sweep. They are classified `keep`: pass on Linux Chromium.

| File / case | Sweep 1 (no pointer) | Desktop pointer | Classification and evidence |
|---|---|---|---|
| `composer-controls`: speed and context row (hover popover) | 36/37 | 37/37 | Environment-only: `onMouseEnter` opens the popover only when `matchMedia("(hover: hover)")` matches (`composer.tsx`), which headless Linux reports false |
| `scrollbar` (4 cases) | 1/5 | 5/5 | Environment-only: owned scrollbar rules are gated by `@media (pointer: fine)` (`base.css:184`); Linux headless draws 15 px classic bars |
| `office-engine`: clicking a character selects its Session | 20/21 | 21/21 | Environment-only: no-pointer profile; passes with a desktop pointer |
| `office`: activity bubbles at tablet/desktop | 18/20 | 19/20 | Environment-only: no-pointer profile; passes with a desktop pointer |
| `office`: 50 Conversation/Office switches | fail | fail | **Production defect (RED, not fixed)**: `window.officeErrors` collects `ResizeObserver loop completed with undelivered notifications` (3 in sweep 1, 6 with desktop pointer; the earlier macOS sweep saw 32). The assertion encodes the stated "no errors while switching" requirement and is retained unchanged. Candidates are the six `new ResizeObserver` owners (`office/create-game.ts:85`, `ui/shell.tsx:1237/1486`, `ui/running-sessions.tsx:40`, `ui/virtual-rows.ts:142`, `ui/transcript-nav.tsx:256`); the producing observer is not yet isolated |
| `pwa-shell`: zoom lock only when installed | 7/9 | 8/9 | Environment-blocked: `Input.synthesizePinchGesture` leaves `visualViewport.scale` at 1 on Linux Chromium, Chromium with `--enable-pinch`, and the headless shell, so the non-installed "zoomed: true" branch cannot be exercised here |
| `pwa-shell`: replaces old shell caches | 7/9 | pass after fix | **Test defect, fixed**: the zoom case unregistered workers and deleted caches only after its assertion, so its failure leaked a registered worker and `ycoding-web-shell-v1` into this case. Cleanup now runs in `finally`; the case passes while the zoom case still fails |
| `remote-shell-layout`: one screen loading placeholder; New session not left in history | 47/49 | 47/49 → 49/49 after fix | **Test defect, fixed (stale after D21)**: retained idle route panels (`route-panel--idle`, `inert`, `aria-hidden`) keep a stale placeholder or composer in the DOM. The second case already accepted an inert retained composer (line 734) yet still required none to exist. The `web-fixes.md` D21 run filtered these cases out. The assertions now require the active surface to show the composer with no live placeholder, and every retained placeholder/composer to be inert, `aria-hidden` and (for the composer) unpainted |
| `transcript`: streaming tail jump controls | 33/34 | 33/34 → 34/34 after fix | **Test defect, fixed**: `top` derives from `scrollTop()` and `bottom` from `away()`; the loop waited only for `bottom` before asserting both. It now waits (up to 2 s) for the full asserted `{ top: false, bottom: true }` state |
| `transcript`: five phone navigation destinations (loaded run) | pass | failed once under load | **G10, fixed**: the bottom-nav mount wait capped at about 4 s; it now allows 15 s with the same condition and assertions |
| `public-fidelity` (18 cases) | timeout cascade, killed at 600 s | 32/35 → 35/35 after fixes | **G10, fixed**: about 650 ms per Vite dev navigation on this host. The 150-navigation route sweep needed about 98 s against a 60 s budget, and the 20-navigation heading-scale case exceeded 10 s. Bun keeps a timed-out body running, so the stalled browser timed out every later case. Budgets are now 180 s and 60 s, with no assertion change |
| `public-fidelity`: route cross-fade; entrance animation | pass | each failed once (isolated / loaded) | **G10, fixed**: both sampled opacity one frame after mount and failed when that frame landed after the animation. They now pause the page animation timeline (`Animation.setPlaybackRate(0)`, new `cdp.ts` helper) during navigation, assert the start state is below full opacity, resume, then assert progress and settling. The cold first route gets 15 s to reach the motion gate |
| `safari-overflow` | no XML | n/a | Environment-blocked: requires `YCODING_SAFARI_PREVIEW` and `YCODING_SAFARI_DRIVER` (macOS `safaridriver`) |

The earlier macOS failures in `compaction-checkpoint`, `invite`, `loading`, `model-replay`, `notifications`, `remote-fidelity`, `remote-inventory-feed`, `remote-relay-guardrail`, `remote-transitions` and `team` pass here (E65/E67 fixture corrections plus a fresh build).

### G10 rewrites in unit and relay suites

| File / group | Before | After | Surviving assertion |
|---|---|---|---|
| `src/remote/ui/toast-timer.test.ts` (5 cases) | Real `Bun.sleep` waits (20–300 ms); 0.932 s JUnit | `jest.useFakeTimers()` with `advanceTimersByTime` (fakes `setTimeout` and `performance.now`); 0.007 s | Exact boundaries: leaving at `duration`, not 1 ms earlier; done at `exit`; paused remainder exactly `200 - 80 = 120` ms after resume; dismiss and dispose unchanged |
| `test/remote-team.test.ts`: four family-activity cases | `Bun.sleep(3_150)` twice, a real 3 s poll waited with a 4 s ceiling, `Bun.sleep(100)`; 12.928 s file JUnit | Shared `createRemoteStoreClock` through the store's existing `schedule`/`monotonicNow` options; 0.532–0.544 s | Refresh not sent at 2,999 ms and sent at 3,000 ms; error retry at 3,000 ms; no request after leaving Office or disconnecting. Negative checks count `transport.request` calls synchronously, because the store sends inside the timer callback and relay delivery is asynchronous |
| `test/remote-store-clock.ts` | Origin `performance.now()` (fractional) | `Math.round(performance.now())` | A fractional origin made `pendingDelays()` report `2999.9999999999995` and split advances inexact (observed while probing) |

Remaining `Bun.sleep` uses in `test/` are short negative-absence waits or relay settling and were not observed to fail under load; the web package has no G10 failure left in this pass.

### Mutation probes (this pass)

Each mutation was applied to the production line, the named retained test was run through the wrapper, and the file was restored with `git checkout`. SHA-256 after restore: `toast-timer.ts` `18b59659…860fb`, `store.ts` `a52110c1…712a5`, `site.css` `edbf8da6…b1020`, all identical to the base.

| Location | Mutation | Result |
|---|---|---|
| `src/remote/ui/toast-timer.ts:27` | `remaining -= 0` (pause no longer subtracts elapsed time) | Fails "holds the remaining time while paused…". The replaced wall-clock test waited 240 ms past resume and would have passed this mutant |
| `src/remote/ui/toast-timer.ts:20` | exit timer `options.exit + 1` | 3 cases fail at the exact boundary |
| `src/remote/store.ts:957` | success refresh `3_001` | "one Office activity read…" and "disconnect cancels…" fail |
| `src/remote/store.ts:942` | error retry `3_001` | "a transient family activity error stays retryable…" fails |
| `src/remote/store.ts:923` + `:2587` | drop the `activityWatching` guard and the unwatch cancel together | "one Office activity read … stops after leaving Office" fails. Each half alone is masked by the other (redundant guards) |
| `src/remote/store.ts:2293` + `:923` | drop the disconnect cancel and the connection/open guards | Masked: no request leaves. Also removing the team-root guard fails only through a `TypeError`, so disconnect cancellation has three independent guards and no single fault is observable. The replaced real-time assertion had the same masking |
| `src/styles/site.css:91` | `.public-page-entry` animation `none` | Cross-fade case fails ("docs route entry missing") |
| `src/styles/site.css:65,71` | reveal starts visible and has no animation | Entrance case fails ("motion gate, target or entrance missing") |

No group was deleted or merged in this pass; the earlier pass's probes (above) still cover its merges.

### Stability (touched files)

Isolated: three serial wrapper runs per file, desktop-pointer launcher for browser files. Loaded: `sl-run --loaded` (forced root typecheck in parallel); the wrapper printed the measured interval for each.

| File | Cases | Isolated ×3 | Loaded |
|---|---:|---|---|
| `src/remote/ui/toast-timer.test.ts` | 5 | 0/0/0 failures (0.006–0.007 s) | 0 failures (0.017 s) |
| `test/remote-team.test.ts` | 25 | 0/0/0 (0.537–0.544 s) | 0 (1.402 s) |
| `test/remote-data.test.ts` (clock user) | 30 | 0/0/0 (0.800–0.868 s) | 0 (1.739 s) |
| `test/remote-carousel.test.ts` (clock user) | 7 | 0/0/0 (0.155–0.161 s) | 0 (0.437 s) |
| `verify/remote-shell-layout.integration.test.ts` | 49 | 0/0/0 (258–261 s) | 0 (320.6 s) |
| `verify/pwa-shell.integration.test.ts` | 9 | 1/1/1: only the environment-blocked zoom case (33.3–33.6 s) | same single case (54.3 s) |
| `verify/transcript.integration.test.ts` | 34 | 0/0/0 (77.8–78.8 s) | 0 (133.3 s; an earlier loaded run exposed the bottom-nav G10 case, fixed in `bd29bf5d`) |
| `verify/public-fidelity.integration.test.ts` | 35 | 0/0/0 (171.0–173.8 s) | 0 (232.3 s; earlier isolated/loaded runs exposed the fade/entrance G10 cases, fixed in `710cb5c2`/`bd29bf5d`) |

### Before and after (`apps/web`)

| Measure | Historical inventory (`1141158a`, macOS) | Lane base `d30e97bf` (Linux) | After this pass (Linux) |
|---|---:|---:|---:|
| Test files | 143 | 149 | 149 |
| JUnit cases (Safari's one case is never emitted) | 1,596 | 1,629 | 1,629 |
| Test-file lines (`*.test.ts(x)`) | — | 36,949 | 36,984 |
| `src` + `test` summed isolated JUnit | — | 44.57 s (97 files) | 31.25 s (97 files, 0 failures) |
| `verify` failures on Linux | 26 failed cases in 12 files (macOS) | sweep 1: 13 failed cases in 8 files, plus `public-fidelity` cascade and Safari | final sweep: 51 files emitted, 518 cases, 2 failures (`office` 50-switch RED, `pwa-shell` zoom environment-blocked), Safari environment-blocked; 1,945.2 s summed JUnit |

No case was deleted, so the case count is unchanged; the line delta is the deterministic clock and wait code.

### Final checks (Linux, lane HEAD)

| Command (through the lane wrapper) | Exit | Result |
|---|---:|---|
| `bun run test:web` | 0 | 693 pass, 0 fail, 72 files |
| `bun run test:integration:web` | 0 | 418 pass, 0 fail, 25 files |
| every `src`/`test` file alone with JUnit | 0 each | 97 files, 1,111 cases, 0 failures, 31.25 s |
| every `verify` file alone, desktop-pointer launcher | 0 except 3 | 49 files pass; `office` (RED), `pwa-shell` (zoom, environment) and `safari-overflow` (environment) as classified above |
| `bun run --cwd apps/web typecheck` | 0 | after each commit group |
| `bunx oxlint --type-aware <touched files>` | 0 | 0 errors; 2 warnings on unchanged `verify/cdp.ts` lines 20 and 31 |

Open after this pass: the `office` ResizeObserver defect needs a production owner; the pinch-zoom and Safari checks need macOS hosts.

## Current edited groups (case-level classification)

| File / group | Required behavior | Classification and surviving assertion | Layer / isolated JUnit duration |
|---|---|---|---|
| `src/content/docs/inline.test.ts`: plain prose, unpaired backtick, empty runs | Inline parsing preserves literal text and emits no empty run | `merge`: `test.each` retains exact expected segments for all three inputs; paired code and bold remain separate cases | Unit; 5 cases, 0 failures; 8.60 ms JUnit |
| `src/content/docs/registry.test.ts`: install copy | Public install instructions do not claim an unsigned/unverified installation | `keep`: retain the exact `DOC_INDEX` install-text assertion; this is release-facing public copy | Unit; 14 cases, 0 failures; 7.61 ms JUnit |
| `src/content/docs/registry.test.ts`: remote notification categories | Public guide states the three required alert categories and their triggering rules | `keep`: main-branch table row/value assertions remain intact | Unit; included above |
| `src/content/docs/search.test.ts`: empty/blank/unknown query and title search | Search handles empty input and returns the best title match without case sensitivity | `merge`: table-driven assertions retain empty/blank/unknown and named/case-varied title matches; heading, body, allowlist, result limit remain distinct | Unit; 10 cases, 0 failures; 6.32 ms JUnit |
| `src/content/site.test.ts`: approved hero and feature set | Current landing page communicates the documented terminal-first product and supported capabilities | `keep`: preserve the exact hero and feature assertions; keep install-command and footer assertions | Unit; 2 cases, 0 failures; 3.17 ms JUnit |
| `src/pwa/offline.test.ts`: cache version | A shell update changes the cache key so installed clients replace the old shell | `keep`: preserve the exact cache-version assertion; `verify/pwa-shell.integration.test.ts` also proves cache replacement in a browser | Unit; 15 cases, 0 failures; 4.63 ms JUnit |
| `src/pwa/offline.test.ts`: service-worker policy and no deferred mutation queue | Public shell caching excludes private routes and offline actions are never queued/replayed | `keep`: retain the current main tests; classify their source-text assertions as lower-confidence architecture guards, not rendered-flow proof. Browser shell test covers offline navigation/private reads | Unit; included above |
| `src/seo/llms.test.ts`: engineering docs exclusion | Public text feeds never publish internal engineering docs | `keep`: retain the explicit unpublished-slug exclusion assertion; it protects the public-content boundary | Unit; 6 cases, 0 failures; 8.31 ms JUnit |
| `src/seo/llms.test.ts`: determinism | No non-determinism requirement is specified by the self-equality assertion | `delete`: self-comparison cannot detect unstable output; `markdownAssets` content assertions remain | Unit; removal included above |
| `src/seo/metadata.test.ts`: exact titles | Public routes retain current discoverable page titles | `keep`: retain title assertions for home, docs, changelog, and a configuration route; route kind/indexing/privacy cases remain | Unit; 8 cases, 0 failures; 9.60 ms JUnit |
| `src/seo/sitemap.test.ts`: private/unpublished path exclusion | Sitemap never publishes remote/private or unapproved routes | `keep`: preserve explicit `/remote`, `/remote/sessions`, `/remote/usage`, `/remote/settings`, and unpublished-doc assertions; metadata indexability alone does not prove private paths are absent | Unit; 5 cases, 0 failures; 5.43 ms JUnit |
| `src/service-worker.push.test.ts`: worker event behavior | Push notifications are shown once; fetch handling does not intercept API/auth/socket, mutations, or public navigation incorrectly | `keep`: new main test executes the worker with fake browser boundaries and asserts registered event handlers, fetch interception, and push effects | Unit at worker boundary; 1 case, 0 failures; 7.53 ms JUnit |
| `src/theme/theme.test.ts`: supported and invalid preferences | Theme preference parsing supports the three modes and safely falls back for invalid input | `merge`: table assertions retain all seven boundary values | Unit; 15 cases, 0 failures; 3.97 ms JUnit |
| `src/theme/theme.test.ts`: accessible theme label | The visible theme control labels its current preference for assistive technology | `keep`: retain `themePreferenceLabel` light/dark/system assertions; the browser interaction test only proves that the label changes | Unit; included above |
| `src/ui/online.test.ts`: offline banner predicate | The site reports browser-offline state and suppresses the notice online | `keep`: restore this test; `shouldShowOfflineNotice` is the live predicate used by `ui/site.tsx` and no browser flow asserts the banner | Unit; 1 case, 0 failures; 3.66 ms JUnit |
| `test/remote-carousel.test.ts`: cooldown boundary and superseded running/idle reads | Newer inventory wins over superseded reads; no stale idle query/rows; recent roots refresh at the 5 s boundary | `rewrite`: retained stale-read and final-order assertions; relay fixtures run serially with the shared monotonic clock, explicit 4,999/5,000 ms boundaries, completion signals, and original test timeout | Relay integration; 7 cases, 0 failures in 3 runs; 0.130/0.130/0.133 s JUnit |
| `test/remote-data.test.ts`: status refresh coalescing and trailing reload | Status updates coalesce and one trailing reload repairs a missing root | `rewrite`: retained request-count and state assertions; the shared monotonic clock proves no refresh at 4,999 ms and the refresh at 5,000 ms; local session fixtures isolate carousel refresh from local-page reload | Relay integration; 30 cases, 0 failures in 3 runs; 0.787/0.794/0.783 s JUnit |

### Isolated JUnit ledger — changed test files

Command per file: `bun test --reporter=junit --reporter-outfile=/tmp/sl-web-junit/<file>.xml <file>` from `apps/web`; one Bun process ran at a time. These are one-run timings, not 3-run/load stability proof.

| File | Cases | Failures | JUnit duration |
|---|---:|---:|---:|
| `src/content/docs/inline.test.ts` | 5 | 0 | 8.60 ms |
| `src/content/docs/registry.test.ts` | 14 | 0 | 7.61 ms |
| `src/content/docs/search.test.ts` | 10 | 0 | 6.32 ms |
| `src/content/site.test.ts` | 2 | 0 | 3.17 ms |
| `src/pwa/offline.test.ts` | 15 | 0 | 4.63 ms |
| `src/seo/llms.test.ts` | 6 | 0 | 8.31 ms |
| `src/seo/metadata.test.ts` | 8 | 0 | 9.60 ms |
| `src/seo/sitemap.test.ts` | 5 | 0 | 5.43 ms |
| `src/service-worker.push.test.ts` | 1 | 0 | 7.53 ms |
| `src/theme/theme.test.ts` | 15 | 0 | 3.97 ms |
| `src/ui/online.test.ts` | 1 | 0 | 3.66 ms |
| `test/remote-carousel.test.ts` | 7 | 0 | 0.136 s |
| `test/remote-data.test.ts` | 30 | 0 | 0.815 s |
| **Total** | **119** | **0** | **1.000 s** |

### Mutation probes — removed/merged groups

Each temporary edit targeted the named invariant, produced the listed expected test failures, and was then reversed exactly. The eight content/theme probes restored their source digests. The two clock probes separately restored `store.ts` to SHA-256 `cd1e992259e428a912185ae123692ba00f9fa639ef380e5b1285dcc783ed7af5`; the remaining production diff is only the approved default-preserving monotonic-clock seam.

| Production location | Temporary mutation | Observed failure in surviving assertion |
|---|---|---|
| `src/content/docs/inline.ts:19` | Keep empty split runs instead of dropping them | `inline.test.ts`: `cli.json` table row and bold/code case failed (3 pass, 2 fail) |
| `src/content/docs/inline.ts:10` | Invert prose/code classification | `inline.test.ts`: plain prose, unpaired backtick, code spans, and bold/code assertions failed (0 pass, 5 fail) |
| `src/content/docs/search.ts:16` | Return no results for nonempty queries instead of empty queries | `search.test.ts`: empty/blank and four title rows plus heading/body/limit cases failed (1 pass, 9 fail) |
| `src/content/docs/search.ts:15` | Remove case folding from the normalized query | `search.test.ts`: uppercase `GUARDRAILS`, `Notifications`, and body-query assertions failed (7 pass, 3 fail) |
| `src/content/docs/search.ts:25` | Demote title matches below headings/descriptions | `search.test.ts`: all four title-ranking rows failed (6 pass, 4 fail) |
| `src/content/docs/search.ts:26` | Admit score-zero pages instead of discarding unmatched queries | `search.test.ts`: unknown-term row failed with 12 results (9 pass, 1 fail) |
| `src/theme/theme.ts:14` | Normalize supported values to `system` | `theme.test.ts`: light/dark accepted-value rows and stored dark preference failed (12 pass, 3 fail) |
| `src/theme/theme.ts:14` | Fall back to `light` instead of `system` | `theme.test.ts`: all four fallback inputs and absent-storage fallback failed (10 pass, 5 fail) |
| `src/remote/store.ts:1788` | Temporarily ignore injected monotonic time and use `performance.now()` directly | `remote-data.test.ts`: controlled refresh failed to run at the 5,000 ms boundary |
| `src/remote/store.ts` cooldown scheduling | Change the carousel delay from 5,000 to 5,001 ms | `remote-data.test.ts`: expected boundary refresh timed out after advancing exactly 5,000 ms |

## Before/after measurements for changed-file set

Baseline is `HEAD` before applying the preserved SL edits, tested by materializing each `git show HEAD:apps/web/<file>` test beside its original and running only that baseline file with JUnit. Final timings use the corresponding after file run alone. The full web inventory remains 143 files; this measured subset stays at 13 files.

| Measure | Before | After |
|---|---:|---:|
| Test files in measured subset | 13 | 13 |
| Expanded cases | 113 | 119 |
| Test source lines | 1,753 | 1,842 |
| Total isolated JUnit duration | 25.928 s | 1.008 s median across three individually invoked per-file repetitions |
| Failures | 0 | 0 |

The larger expanded case count is from parameterized inputs retained as independent cases in the merged groups; the only deleted behavior was the vacuous `markdownAssets() === markdownAssets()` self-comparison. After the clock correction, all 13 files remain at 119 cases, and individually invoked per-file repetitions sum to 1.025 s, 1.008 s, and 1.000 s. The other 11 files are unchanged from the earlier three serial repetitions; the two remote files have three new serial repetitions each. Durations are descriptive JUnit sums, not statistical performance evidence.

## Unchanged web test groups — retain

Each listed file and every case in it is classified `keep`. Assertions guard a public content/asset contract, browser storage/PWA boundary, remote behavior, trust/ownership boundary, actual cross-component flow, or rendered output. No removal is proposed in these files.

### Public content, documentation, SEO, branding, storage, and PWA units (`src`)

| Files | Required behavior and surviving assertions | Layer / isolated JUnit duration |
|---|---|---|
| `src/brand-assets.test.ts`; `src/content/boundary.test.ts`; `src/content/changelog.test.ts`; `src/content/docs/registry.test.ts`; `src/content/docs/search.test.ts`; `src/content/site.test.ts`; `src/content/docs/inline.test.ts` | Brand assets and curated public routes/content are valid; changelog/version and links match release content; docs allowlisting, page links and search results resolve; inline content is segmented as required | Unit; see per-file JUnit ledger below |
| `src/lib/storage.test.ts`; `src/pwa/install.test.ts`; `src/pwa/offline.test.ts`; `src/service-worker.push.test.ts` | Browser persistence is safe; PWA install state, manifest/shell URLs, private-route cache policy, offline fallback and push interactions remain correct | Unit / worker boundary; see per-file JUnit ledger below |
| `src/seo/llms.test.ts`; `src/seo/markdown.test.ts`; `src/seo/metadata.test.ts`; `src/seo/sitemap.test.ts` | Published machine-readable content contains only public material; markdown and metadata are valid; remote routes remain non-indexable and the sitemap exposes only public routes | Unit; see per-file JUnit ledger below |
| `src/theme/theme.test.ts`; `src/ui/online.test.ts` | Theme preference persistence, first paint, accessible control label, and browser offline notice behavior remain correct | Unit; see per-file JUnit ledger below |
| `src/styles/composition.test.ts`; `contrast.test.ts`; `cursors.test.ts`; `design-md.test.ts`; `docs-overflow.test.ts`; `tokens.test.ts`; `typography.test.ts` | Shared layout, color and contrast, cursor, design-token drift, public docs overflow, and typography contracts stay within the documented design | Unit/design drift; keep all assertions; see per-file JUnit ledger below |

### Remote pure contracts, projection, ownership, and browser UI models (`src/remote`)

| Files | Required behavior and surviving assertions | Layer / isolated JUnit duration |
|---|---|---|
| `src/remote/attachment-upload.test.ts`; `catalog.test.ts`; `file-change-diff.test.ts`; `form-contract.test.ts`; `form-view.test.ts`; `image-cache.test.ts`; `invite-http.test.ts`; `invite.test.ts`; `keep-awake.test.ts` | Upload bounds and acknowledgement, catalog mapping, file-change diff, validated forms, image-cache ownership, invite request secrecy/error mapping, and keep-awake lifecycle | Unit / request-contract; see per-file JUnit ledger below |
| `src/remote/notifications.test.ts`; `preferences.test.ts`; `projection.test.ts`; `push-http.test.ts`; `push.test.ts`; `queries.test.ts`; `query.test.ts`; `session-info.test.ts`; `transport-liveness.test.ts`; `transport.test.ts`; `view-model.test.ts` | Session notices, browser alert ownership/deduplication, user preferences, event projection, push transport/envelopes, rate-limited query behavior, Session read models, transport lifetime, and view-model state transitions | Unit / contract; see per-file JUnit ledger below; retain all notification, query pacing, transport-lifetime, and ownership assertions |
| `src/remote/office/adapter.test.ts`; `characters.test.ts`; `director.test.ts`; `environment.test.ts`; `leisure.test.ts`; `map.test.ts`; `model-activity.test.ts`; `model-family.test.ts`; `model-team.test.ts`; `model.test.ts`; `open-plan.test.ts`; `storage.test.ts` | Office projection, family scoping, character identity, motion/interaction states, offline behavior, and persistence | Unit / projection; see per-file JUnit ledger below |
| `src/remote/ui/composer-action.test.ts`; `composer-attachment.test.ts`; `composer-logic.test.ts`; `image-key.test.ts`; `markdown.test.ts`; `notifications.test.ts`; `remote-redesign.test.ts`; `route-panel.test.ts`; `subagent-bar.test.ts`; `team-model.test.ts`; `toast-timer.test.ts`; `todo-panel.test.ts`; `transcript-nav.test.ts`; `usage-model.test.ts`; `virtual-rows.test.ts` | User-visible web remote controls and view-model contracts: safe prompt/actions, attachment/image identity, notifications, ownership, team/todo state, transcript navigation, usage, and list virtualization | Unit / view-model; see per-file JUnit ledger below |

### Relay-backed remote flows (`test`)

Every file in this group is explicitly retained by SL. Assertions execute the real web store/client against a relay double or live local relay and cover ownership, authenticated requests, event order, cancellation, retry/recovery, or visible remote behavior; no remote flow is classified for deletion.

| Files | Required behavior and surviving assertions | Layer / isolated JUnit duration |
|---|---|---|
| `test/remote-account.test.ts`; `remote-activity-order.test.ts`; `remote-carousel.test.ts`; `remote-data.test.ts`; `remote-file-changes.test.ts`; `remote-guardrail.test.ts`; `remote-http.test.ts`; `remote-keep-awake.test.ts` | Account/device state and ownership, ordered activity, root carousel inventory and stale-read suppression, query coalescing, file change reads, guardrail decisions, HTTP authentication/limits, keep-awake lifecycle | Relay-backed integration; see per-file JUnit ledger below |
| `test/remote-liveness.integration.test.ts`; `remote-notice-sync.test.ts`; `remote-notifications.test.ts`; `remote-rate-limit.test.ts`; `remote-remembered-machine.test.ts` | Real transport recovery without replaying mutations; multi-browser notice ownership/read sync; notice alert routing; request pacing; remembered-device selection | Relay/browser integration; see per-file JUnit ledger below |
| `test/remote-session-send.test.ts`; `remote-session.test.ts`; `remote-shell-output.test.ts`; `remote-store-container.test.ts`; `remote-sync.test.ts`; `remote-team.test.ts`; `remote-todo.test.ts`; `remote-transport.test.ts`; `remote-usage.test.ts`; `remote-workspaces.test.ts` | Session prompts and durable UI projection, message/history sync, shell output paging, connection-scoped store ownership, team/subagent state, TODOs, authenticated transport, quota display, and workspace state | Relay-backed integration; see per-file JUnit ledger below |
| `test/build-output.test.ts` | Production build contains required public assets and metadata | Build artifact contract; see per-file JUnit ledger below |

### Real-browser product, interaction, accessibility, and design flows (`verify`)

All browser suites are retained as rendered-flow evidence. They must not be represented by source-text assertions or replaced by model-only unit checks. Browser availability is a prerequisite; for the full SL inventory, run each browser file individually and record unavailable prerequisites and failed results without inferring causes.

| Files | Required behavior and surviving assertions | Layer / isolated JUnit duration |
|---|---|---|
| `verify/compaction-checkpoint.integration.test.ts`; `composer-controls.integration.test.ts`; `cursors.integration.test.ts`; `design-contract.integration.test.ts`; `device-picker.integration.test.ts`; `docs-layout.integration.test.ts`; `file-change-card.integration.test.ts`; `guardrail-family.integration.test.ts`; `invite.integration.test.ts`; `keep-awake-settings.integration.test.ts`; `light-office.integration.test.ts`; `loading.integration.test.ts`; `modal-close.integration.test.ts`; `model-replay.integration.test.ts`; `new-session.integration.test.ts` | Rendered session controls, compaction, cursor behavior, documented design, device ownership and unavailable states, docs layout, file-change presentation, guardrails, invites, settings, office states, loading, focus restoration, model replay, and session creation | Real-browser verify; see per-file JUnit ledger below |
| `verify/notifications.integration.test.ts`; `office-engine.integration.test.ts`; `office.integration.test.ts`; `overlay-motion.integration.test.ts`; `prompt-feedback.integration.test.ts`; `public-fidelity.integration.test.ts`; `push-settings.integration.test.ts`; `pwa-install.integration.test.ts`; `pwa-shell.integration.test.ts` | Rendered notices and notification controls, office scenes, motion, prompt receipts, public routes and responsive presentation, push preferences, install, cache upgrade, offline navigation/private read handling | Real-browser verify; see per-file JUnit ledger below; PWA flows remain required when worker/cache assertions change |
| `verify/remote-fidelity.integration.test.ts`; `remote-interactions.integration.test.ts`; `remote-inventory-feed.integration.test.ts`; `remote-navigation.integration.test.ts`; `remote-relay-guardrail.integration.test.ts`; `remote-scenarios.test.ts`; `remote-shell-layout.integration.test.ts`; `remote-system-alert.integration.test.ts`; `remote-tablet-navigation.integration.test.ts`; `remote-tool-output.integration.test.ts`; `remote-transitions.integration.test.ts` | Authenticated remote layouts and states, keyboard interactions, inventory freshness, navigation, relay guardrails, scenario contract, responsive shell, one-alert delivery, tablet behavior, tool output, and transitions | Real-browser verify; see per-file JUnit ledger below; all remote flows retained |
| `verify/router.integration.test.ts`; `running-sessions.integration.test.ts`; `safari-overflow.integration.test.ts`; `scrollbar.integration.test.ts`; `session-lifecycle.integration.test.ts`; `status-panel-motion.integration.test.ts`; `team.integration.test.ts`; `todo.integration.test.ts`; `transcript-stability.integration.test.ts`; `transcript.integration.test.ts`; `typography.integration.test.ts`; `usage-page.integration.test.ts`; `workspace-scroll-cue.integration.test.ts` | Routing, running Session projection, browser overflow, visible scrollbar rendering, Session lifecycle, reduced motion, team/task behavior, transcript stability/rendering, typography, quota display, and workspace scrolling | Real-browser verify; see per-file JUnit ledger below |

## Validation ledger

| Check | Required result | Result |
|---|---|---|
| `bun test --reporter=junit --reporter-outfile=<per-file.xml> <file>` for each changed test file | Capture exact case count, duration, exit status; run isolated | Pass: 13 files, 119 cases, 0 failures; latest remote files individually pass; updated XML at `/tmp/sl-web-clock-repeat/r{1,2,3}_*.xml` |
| Three serial per-file repetitions | All pass with stable case counts | Pass: 13 files / 119 cases each, 0 failures per run; combined JUnit sums 1.025 s, 1.008 s, 1.000 s. Eleven unchanged files use their prior repeated XML; corrected remote files use `/tmp/sl-web-clock-repeat/r{1,2,3}_*.xml` |
| Measured loaded run for corrected remote files | All pass while a bounded heavy process overlaps; record actual intervals | Pass: one CPU-bound worker (30 s, 512 MiB aggregate process-tree cap); load UTC `2026-10-03T04:51:21.095626Z–04:51:51.095905Z`; test UTC `04:51:21.095759Z–04:51:21.999575Z`; overlap 0.903816 s; carousel 7/7 and remote-data 30/30. Full 13-file loaded overlap remains pending parent integration/returnownership |
| Bounded load harness setup | No failed or partial test evidence is counted as a pass | First FIFO-start attempt timed out before any test output; inspection found no surviving process and only the temporary FIFO, which was removed. Replaced with a ready-line worker handshake; the measured run above completed |
| Web build required by standalone suites | Build output and built PWA suites pass | `bun run build` exit 0; `test/build-output.test.ts` rerun 7/7 and `verify/pwa-shell.integration.test.ts` rerun 9/9 after build |
| 130 untouched per-file JUnit runs | Capture case counts, durations, and outcomes without a package-wide command | 130 individual Bun commands; UTC 2026-10-03T03:29:35Z–03:49:30Z; 129 XML files, 1,477 cases, 26 failures, 0 errors, 44,591 assertions, 1,219.132 s summed JUnit time; 118 final file passes, 12 failures/unavailable; full table below |
| Safari overflow integration prerequisite | Use configured local preview/driver only | `YCODING_SAFARI_PREVIEW` and `YCODING_SAFARI_DRIVER` unset; case failed at module load, no JUnit XML; inventory records 3 ms process duration |
| Web package typecheck | Pass after parent releases memory gate | Deferred by parent; package check was explicitly reserved for parent integration checks |
| Touched-file lint | No errors and no new warnings | `bun run lint -- apps/web/src/remote/store.ts apps/web/test/remote-store-clock.ts apps/web/test/remote-carousel.test.ts apps/web/test/remote-data.test.ts` exit 0; 5 pre-existing warnings in unchanged `store.ts` regions; no warnings on changed test lines |
| Clock seam regression and boundary mutations | Removing the monotonic clock seam or delaying refresh by 1 ms makes the targeted assertion fail; reverse both mutations exactly | Pass: coalescing test timed out at the expected refresh after temporarily restoring `performance.now()` instead of injected time; it passed with the seam. A temporary 5,001 ms carousel delay failed the at-5,000 ms assertion. Both exact reversions restored `store.ts` SHA-256 `cd1e992259e428a912185ae123692ba00f9fa639ef380e5b1285dcc783ed7af5` |
| Mutations for every removed/merged required group | Targeted surviving assertion fails; exact patch then reversed | Pass: eight content/theme probes in the table above, plus the two clock probes above; each temporary mutation was reversed exactly |
| Final diff/status and accepted test inventory | All removed groups mapped, no CSS/visual changes, preserve uncommitted plan | Prior test-leaning commit: `bc69c432`; clock correction committed as `67da0db4` (`test(web): control remote refresh cooldown timing`). The worktree is clean, the named pre-rebase stash remains intact, and this root inventory remains untracked/uncommitted. The only production edit is the authorized default-preserving monotonic test-clock seam; package typecheck remains parent-owned. Unmodified browser suites were run individually for the requested inventory, not as proof of changed rendered behavior. Full SL acceptance remains incomplete: the 13-file loaded run awaits parent integration/returnownership, and 12 untouched browser-test files still fail or lack prerequisites as detailed below. |

## Per-file JUnit ledger — 130 unchanged tests

The 130 unchanged files were invoked individually, one Bun file per command, never through a package-wide test command. Source and relay tests used `bun test --reporter=junit --reporter-outfile=<file>.xml <file>`; verify files additionally used `YCODING_WEB_CHROME` pointing at the installed headless Chromium. The sweep ran from 2026-10-03T03:29:35Z to 2026-10-03T03:49:30Z (1,195 s). Exact overlap with other Sessions was not recorded, so these are per-file JUnit durations, not a verified no-load or loaded run.

| File | Cases | Failed | JUnit duration | Result |
|---|---:|---:|---:|---|
| `src/brand-assets.test.ts` | 2 | 0 | 8.34 ms | Pass |
| `src/content/boundary.test.ts` | 3 | 0 | 8.52 ms | Pass |
| `src/content/changelog.test.ts` | 20 | 0 | 4.28 ms | Pass |
| `src/lib/storage.test.ts` | 6 | 0 | 2.61 ms | Pass |
| `src/pwa/install.test.ts` | 10 | 0 | 8.31 ms | Pass |
| `src/remote/attachment-upload.test.ts` | 6 | 0 | 29.27 ms | Pass |
| `src/remote/catalog.test.ts` | 4 | 0 | 5.66 ms | Pass |
| `src/remote/file-change-diff.test.ts` | 4 | 0 | 2.81 ms | Pass |
| `src/remote/form-contract.test.ts` | 3 | 0 | 4.42 ms | Pass |
| `src/remote/form-view.test.ts` | 6 | 0 | 3.44 ms | Pass |
| `src/remote/image-cache.test.ts` | 5 | 0 | 36.02 ms | Pass |
| `src/remote/invite-http.test.ts` | 2 | 0 | 3.07 ms | Pass |
| `src/remote/invite.test.ts` | 3 | 0 | 2.85 ms | Pass |
| `src/remote/keep-awake.test.ts` | 7 | 0 | 3.21 ms | Pass |
| `src/remote/notifications.test.ts` | 36 | 0 | 15.02 ms | Pass |
| `src/remote/office/adapter.test.ts` | 11 | 0 | 6.07 ms | Pass |
| `src/remote/office/characters.test.ts` | 5 | 0 | 362.68 ms | Pass |
| `src/remote/office/director.test.ts` | 20 | 0 | 17.43 ms | Pass |
| `src/remote/office/environment.test.ts` | 6 | 0 | 113.30 ms | Pass |
| `src/remote/office/leisure.test.ts` | 3 | 0 | 5.44 ms | Pass |
| `src/remote/office/map.test.ts` | 9 | 0 | 23.55 ms | Pass |
| `src/remote/office/model-activity.test.ts` | 1 | 0 | 3.43 ms | Pass |
| `src/remote/office/model-family.test.ts` | 4 | 0 | 4.24 ms | Pass |
| `src/remote/office/model-team.test.ts` | 8 | 0 | 4.45 ms | Pass |
| `src/remote/office/model.test.ts` | 32 | 0 | 18.40 ms | Pass |
| `src/remote/office/open-plan.test.ts` | 4 | 0 | 30.28 ms | Pass |
| `src/remote/office/storage.test.ts` | 5 | 0 | 3.84 ms | Pass |
| `src/remote/preferences.test.ts` | 13 | 0 | 7.15 ms | Pass |
| `src/remote/projection.test.ts` | 77 | 0 | 28.59 ms | Pass |
| `src/remote/push-http.test.ts` | 2 | 0 | 3.08 ms | Pass |
| `src/remote/push.test.ts` | 13 | 0 | 5.12 ms | Pass |
| `src/remote/queries.test.ts` | 4 | 0 | 7.04 ms | Pass |
| `src/remote/query.test.ts` | 1 | 0 | 41.68 ms | Pass |
| `src/remote/session-info.test.ts` | 3 | 0 | 11.47 ms | Pass |
| `src/remote/transport-liveness.test.ts` | 6 | 0 | 5.90 ms | Pass |
| `src/remote/transport.test.ts` | 9 | 0 | 7.04 ms | Pass |
| `src/remote/ui/composer-action.test.ts` | 4 | 0 | 3.98 ms | Pass |
| `src/remote/ui/composer-attachment.test.ts` | 2 | 0 | 3.56 ms | Pass |
| `src/remote/ui/composer-logic.test.ts` | 13 | 0 | 4.42 ms | Pass |
| `src/remote/ui/image-key.test.ts` | 2 | 0 | 14.91 ms | Pass |
| `src/remote/ui/markdown.test.ts` | 1 | 0 | 4.82 ms | Pass |
| `src/remote/ui/notifications.test.ts` | 13 | 0 | 13.78 ms | Pass |
| `src/remote/ui/remote-redesign.test.ts` | 36 | 0 | 15.90 ms | Pass |
| `src/remote/ui/route-panel.test.ts` | 2 | 0 | 4.66 ms | Pass |
| `src/remote/ui/subagent-bar.test.ts` | 3 | 0 | 4.99 ms | Pass |
| `src/remote/ui/team-model.test.ts` | 9 | 0 | 4.69 ms | Pass |
| `src/remote/ui/toast-timer.test.ts` | 5 | 0 | 933.00 ms | Pass |
| `src/remote/ui/todo-panel.test.ts` | 2 | 0 | 5.97 ms | Pass |
| `src/remote/ui/transcript-nav.test.ts` | 5 | 0 | 28.13 ms | Pass |
| `src/remote/ui/usage-model.test.ts` | 12 | 0 | 10.55 ms | Pass |
| `src/remote/ui/virtual-rows.test.ts` | 2 | 0 | 4.85 ms | Pass |
| `src/remote/view-model.test.ts` | 64 | 0 | 4.50 ms | Pass |
| `src/seo/markdown.test.ts` | 12 | 0 | 4.89 ms | Pass |
| `src/styles/composition.test.ts` | 22 | 0 | 18.18 ms | Pass |
| `src/styles/contrast.test.ts` | 24 | 0 | 7.18 ms | Pass |
| `src/styles/cursors.test.ts` | 2 | 0 | 7.57 ms | Pass |
| `src/styles/design-md.test.ts` | 2 | 0 | 8.54 ms | Pass |
| `src/styles/docs-overflow.test.ts` | 2 | 0 | 4.23 ms | Pass |
| `src/styles/tokens.test.ts` | 13 | 0 | 6.16 ms | Pass |
| `src/styles/typography.test.ts` | 3 | 0 | 4.54 ms | Pass |
| `test/build-output.test.ts` | 7 | 0 | 232.08 ms | Pass after `bun run build` (initial run lacked `dist/`) |
| `test/remote-account.test.ts` | 10 | 0 | 212.21 ms | Pass |
| `test/remote-activity-order.test.ts` | 4 | 0 | 76.19 ms | Pass |
| `test/remote-file-changes.test.ts` | 5 | 0 | 327.31 ms | Pass |
| `test/remote-guardrail.test.ts` | 9 | 0 | 136.92 ms | Pass |
| `test/remote-http.test.ts` | 14 | 0 | 12.42 ms | Pass |
| `test/remote-keep-awake.test.ts` | 14 | 0 | 64.83 ms | Pass |
| `test/remote-liveness.integration.test.ts` | 2 | 0 | 296.76 ms | Pass |
| `test/remote-notice-sync.test.ts` | 24 | 0 | 1.90 s | Pass |
| `test/remote-notifications.test.ts` | 29 | 0 | 2.48 s | Pass |
| `test/remote-rate-limit.test.ts` | 3 | 0 | 10.58 s | Pass |
| `test/remote-remembered-machine.test.ts` | 5 | 0 | 49.98 ms | Pass |
| `test/remote-session-send.test.ts` | 24 | 0 | 512.11 ms | Pass |
| `test/remote-session.test.ts` | 108 | 0 | 4.03 s | Pass |
| `test/remote-shell-output.test.ts` | 10 | 0 | 656.57 ms | Pass |
| `test/remote-store-container.test.ts` | 3 | 0 | 37.56 ms | Pass |
| `test/remote-sync.test.ts` | 39 | 0 | 1.51 s | Pass |
| `test/remote-team.test.ts` | 25 | 0 | 12.92 s | Pass |
| `test/remote-todo.test.ts` | 6 | 0 | 191.86 ms | Pass |
| `test/remote-transport.test.ts` | 15 | 0 | 430.42 ms | Pass |
| `test/remote-usage.test.ts` | 13 | 0 | 1.84 s | Pass |
| `test/remote-workspaces.test.ts` | 11 | 0 | 191.25 ms | Pass |
| `verify/compaction-checkpoint.integration.test.ts` | 1 | 1 | 2.53 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_compaction-checkpoint.integration.test.ts.log`) |
| `verify/composer-controls.integration.test.ts` | 37 | 0 | 78.29 s | Pass |
| `verify/cursors.integration.test.ts` | 3 | 0 | 3.14 s | Pass |
| `verify/design-contract.integration.test.ts` | 5 | 0 | 33.85 s | Pass |
| `verify/device-picker.integration.test.ts` | 11 | 0 | 24.16 s | Pass |
| `verify/docs-layout.integration.test.ts` | 2 | 0 | 80.16 s | Pass |
| `verify/file-change-card.integration.test.ts` | 6 | 0 | 8.65 s | Pass |
| `verify/guardrail-family.integration.test.ts` | 6 | 0 | 3.84 s | Pass |
| `verify/invite.integration.test.ts` | 1 | 1 | 6.15 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_invite.integration.test.ts.log`) |
| `verify/keep-awake-settings.integration.test.ts` | 4 | 0 | 4.89 s | Pass |
| `verify/light-office.integration.test.ts` | 5 | 0 | 36.99 s | Pass |
| `verify/loading.integration.test.ts` | 8 | 4 | 5.28 s | Fail (4 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_loading.integration.test.ts.log`) |
| `verify/modal-close.integration.test.ts` | 16 | 0 | 8.33 s | Pass |
| `verify/model-replay.integration.test.ts` | 6 | 1 | 6.31 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_model-replay.integration.test.ts.log`) |
| `verify/new-session.integration.test.ts` | 5 | 0 | 13.10 s | Pass |
| `verify/notifications.integration.test.ts` | 16 | 10 | 18.20 s | Fail (10 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_notifications.integration.test.ts.log`) |
| `verify/office-engine.integration.test.ts` | 21 | 0 | 21.98 s | Pass |
| `verify/office.integration.test.ts` | 20 | 2 | 75.48 s | Fail (2 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_office.integration.test.ts.log`) |
| `verify/overlay-motion.integration.test.ts` | 6 | 0 | 54.04 s | Pass |
| `verify/prompt-feedback.integration.test.ts` | 7 | 0 | 5.43 s | Pass |
| `verify/public-fidelity.integration.test.ts` | 35 | 0 | 90.91 s | Pass |
| `verify/push-settings.integration.test.ts` | 5 | 0 | 5.26 s | Pass |
| `verify/pwa-install.integration.test.ts` | 13 | 0 | 7.39 s | Pass |
| `verify/pwa-shell.integration.test.ts` | 9 | 0 | 25.25 s | Pass after `bun run build` (initial run lacked `dist/`) |
| `verify/remote-fidelity.integration.test.ts` | 31 | 1 | 35.86 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_remote-fidelity.integration.test.ts.log`) |
| `verify/remote-interactions.integration.test.ts` | 1 | 0 | 7.14 s | Pass |
| `verify/remote-inventory-feed.integration.test.ts` | 5 | 3 | 33.94 s | Fail (3 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_remote-inventory-feed.integration.test.ts.log`) |
| `verify/remote-navigation.integration.test.ts` | 14 | 0 | 66.90 s | Pass |
| `verify/remote-relay-guardrail.integration.test.ts` | 2 | 1 | 4.54 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_remote-relay-guardrail.integration.test.ts.log`) |
| `verify/remote-scenarios.test.ts` | 4 | 0 | 5.03 ms | Pass |
| `verify/remote-shell-layout.integration.test.ts` | 49 | 0 | 171.53 s | Pass |
| `verify/remote-system-alert.integration.test.ts` | 2 | 0 | 3.62 s | Pass |
| `verify/remote-tablet-navigation.integration.test.ts` | 4 | 0 | 3.52 s | Pass |
| `verify/remote-tool-output.integration.test.ts` | 1 | 0 | 1.33 s | Pass |
| `verify/remote-transitions.integration.test.ts` | 6 | 1 | 18.00 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_remote-transitions.integration.test.ts.log`) |
| `verify/router.integration.test.ts` | 8 | 0 | 4.26 s | Pass |
| `verify/running-sessions.integration.test.ts` | 7 | 0 | 26.11 s | Pass |
| `verify/safari-overflow.integration.test.ts` | not emitted | n/a | 3 ms | Fail: `YCODING_SAFARI_PREVIEW` and `YCODING_SAFARI_DRIVER` are unset; no JUnit XML |
| `verify/scrollbar.integration.test.ts` | 5 | 0 | 5.57 s | Pass |
| `verify/session-lifecycle.integration.test.ts` | 2 | 0 | 1.90 s | Pass |
| `verify/status-panel-motion.integration.test.ts` | 2 | 0 | 12.50 s | Pass |
| `verify/team.integration.test.ts` | 23 | 1 | 26.98 s | Fail (1 failed assertions, 0 errors; see `/tmp/sl-web-remaining/verify_team.integration.test.ts.log`) |
| `verify/todo.integration.test.ts` | 4 | 0 | 12.95 s | Pass |
| `verify/transcript-stability.integration.test.ts` | 7 | 0 | 13.60 s | Pass |
| `verify/transcript.integration.test.ts` | 34 | 0 | 58.65 s | Pass |
| `verify/typography.integration.test.ts` | 9 | 0 | 8.32 s | Pass |
| `verify/usage-page.integration.test.ts` | 15 | 0 | 37.55 s | Pass |
| `verify/workspace-scroll-cue.integration.test.ts` | 6 | 0 | 4.07 s | Pass |

The initial 130-file sweep had 116 zero-exit files and 14 nonzero exits. After building `apps/web`, the two `dist/` prerequisite failures passed on individual rerun. Current remaining outcomes are 118 passing files and 12 failing/unavailable files; across available final JUnit files: 1,477 cases, 26 failed assertions, 0 errors, 44,591 assertions, 1,219.132 s summed JUnit duration. The Safari-specific case emitted no XML because its required local origins/driver were not configured.

### Read-only classification of remaining failures

Classified from the saved per-file logs and source at stable `sl-web` HEAD `67da0db4`; no test was rerun and no cause is treated as proven without direct evidence.

| Group | Exact observed failure | Setup/cause and new-fixture relevance | Minimal decisive next check |
|---|---|---|---|
| Remote fixture startup: `verify/remote-inventory-feed.integration.test.ts` (3 cases), `verify/remote-transitions.integration.test.ts` (1) | Inventory tests expected one workspace request but observed two identical `workspace` inputs (`rows: 25` remained correct); the transitions tour found duplicate `notice.subscribe null` and `workspace.list {"sessionsOnly":true}` reads. | Duplicate requests are confirmed. Stable source has `App` → `RemoteProvider` calling `store.load()` (`src/remote/context.tsx:62`), while `verify/remote-fixture.tsx:1047–1049` calls `store.load()` and `store.connect("dev_studio")` again in `openFixtureWorkspace`. This is a strong candidate cause, not yet proven by a post-correction run; these checks may be invalidated by removing the duplicate fixture startup. | After the fixture correction lands, rerun these four failed cases. Confirm one initial workspace request and unique cold-load read keys; retain the existing row, filter, and warmed-route assertions. |
| Same remote fixture, hard-review flow: `verify/remote-fidelity.integration.test.ts`; `verify/remote-relay-guardrail.integration.test.ts` | The once decision in remote fidelity left the hard-review card pending and emitted no `session.guardrail.reply`; relay guardrail observed `requests: []` after clicking Approve once. | Both use `verify/remote.html` and its `App`/`RemoteProvider` startup, so the correction may affect them. The saved logs confirm the missing reply, but do not establish that startup duplication caused it. | After correction, rerun both exact hard-review cases; verify one browser reply, one relay receipt with the expected request ID/reply, and card settlement. |
| Same remote fixture, office/team: `verify/office.integration.test.ts` (2), `verify/team.integration.test.ts` (1) | Office’s 50-switch case recorded 32 `ResizeObserver loop completed with undelivered notifications` errors; the unknown-prompt case found one retry button instead of two. Team’s phone subagent case did not find the expected child task text in Conversation after opening `ses_child` (first loop width is 320 px). | These also use `verify/remote.html`, so rerun after its startup correction; however, neither observed symptom directly demonstrates duplicate connection as its cause. | Recheck these three assertions after correction. If still failing, record ResizeObserver errors per switch and count the two retry-button selectors separately; for Team inspect the selected child’s resident transcript/read result at 320 px. |
| Independent fixture: `verify/compaction-checkpoint.integration.test.ts` (1) | The synthetic transcript render threw `TypeError: Cannot read properties of undefined (reading 'get')` in Solid `useSelector` during the test’s dynamic render at line 31. | Runtime exception confirmed; exact Solid/store-context cause unknown. It uses `/verify/transcript.html` and a synthetic store, not `remote.html`; remote startup correction does not apply. | Inspect the dynamic Solid renderer/module and `RemoteProvider`/`TranscriptNavigation` context composition before changing the expected assertion. |
| Preview setup: `verify/invite.integration.test.ts` (suite setup) | `vite preview` did not satisfy the test’s root-origin `fetch(...).ok` readiness check within 60 attempts; preview stdout/stderr are discarded. | Readiness failure confirmed, underlying process/asset cause unknown. `verify/invite` runs against built output, so missing `dist` is a possibility, not established by this log; unrelated to remote fixture startup. | Confirm the built preview serves the root origin, retaining preview stderr on failure, then run the invite cases. |
| Static loading fixture: `verify/loading.integration.test.ts` (4) | At line 44 the Team loading placeholder was absent; at line 92 the history placeholder was absent; at line 119 placeholder shape height differed from settled task height by 5 px (limit 1); at line 160 the Office canvas top moved by 67 px (limit 1). | These failures use `/verify/loading-fixture.html`; exact fixture/layout cause unknown. They do not use the remote store fixture. | Inspect `startLoading`/`startHistory`/finish transitions and the paired DOM measurements at those four assertions; preserve the geometry and loading checks. |
| Model replay fixture: `verify/model-replay.integration.test.ts` (1) | After refusing the Model A switch and sending the retained prompt, the wait for a `kind: "model", state: "failed"` mutation timed out at line 146. | Timeout confirmed; refusal-to-mutation-state cause unknown. `model-replay-fixture.html` uses its own `RemoteProvider`/relay path and does not call `openFixtureWorkspace`; not invalidated by the remote fixture correction. | Trace the refusal response through `session.switchModel` handling to the expected durable/local mutation state in this single browser case. |
| Synthetic notification fixture: `verify/notifications.integration.test.ts` (10) | Six assertions found missing notice rows/toasts, unread badge/label, or sync-error badge; four later probes encountered absent panel/toast/dismiss elements (`focus`, `getAttribute`, `getComputedStyle`, `getBoundingClientRect`). | Missing UI is confirmed; cause unknown. `notifications-fixture.tsx` supplies an in-memory initial state, overrides `load` as a no-op, and throws if transport is created. It does not use `remote.html` or connect, so the remote startup correction does not apply. | In the first failing empty-notice and seeded-panel cases, compare fixture `store.state().notifications` with the mounted NotificationCenter/ToastLayer immediately before the assertion; identify whether `publish` reaches subscribers. Keep all UI assertions. |
| Environment prerequisite: `verify/safari-overflow.integration.test.ts` | No JUnit XML; module setup throws because `YCODING_SAFARI_PREVIEW` and `YCODING_SAFARI_DRIVER` are unset. | Missing prerequisites confirmed; no behavioral result exists and the remote fixture correction is irrelevant. | Run only when both required local origins/driver are configured; do not count this as a passing or behavioral failure case. |

These classifications do not waive or remove any of the 12 remaining checks; each actual failure still requires its focused next check and surviving assertions.
