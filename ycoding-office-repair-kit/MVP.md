# Repair MVP — a usable application, not a demonstration

**Goal:** complete the existing desktop office so the user can operate normal YCoding sessions from a polished Godot client without switching to the TUI to recover basic broken workflows.

**Users:** the existing local YCoding user; preserve the TUI as a parallel supported client. No new multi-user service, account system or collaboration backend is required.

## Core flows

1. Launch production mode; connect to the configured local service or receive an actionable connection/configuration error. Select an actual workspace/session.
2. Select an available provider/model where supported, type an ordinary prompt, send it once, see real streaming or the provider's supported response behavior, stop when applicable, and reopen the persisted result.
3. Observe actual root/child work as coherent office actions. Click a worker/bubble to inspect its source-linked instruction, activity and report. Reply to real questions/reviews without invented conversation.
4. Open settings; change a supported setting; save/apply through its owning configuration path; restart and verify the effective value. Surface configuration precedence and validation failures.
5. Recover from service disconnect, authentication/config error, provider rate limit or cancellation without fabricated success, lost drafts or duplicate work.

## Must-have / completion scope

| Area | Required result |
|---|---|
| Layout | Persistent left sidebar, expansive office content, bottom-centered constrained composer, coherent resizing and scaling |
| Fidelity | Keep/improve actual pixel assets, sprite animation, depth, navigation and useful office interactions; sharp world and readable app UI |
| Operation | Real provider-backed prompt, visible response, cancellation, errors, current session, history, appropriate tools/permissions |
| Settings | Reachable, wired, validated, persistent controls derived from existing TUI/configuration; no decorative controls |
| Selection | Actual configured providers/models, supported optional model controls, effective selection used by the request |
| Truthfulness | Production never silently uses replay, fixtures, fake agents or fake responses |
| Quality | Mouse/keyboard, focus/IME, long text, loading/empty/busy/error states, light/dark themes and safe overlay behavior |
| Delivery | Existing CLI + Godot build/install chain, native candidate verification, GitHub Release assets and Office download page on existing Pages site |
| Verification | Native screenshots/footage, real-provider evidence, targeted tests and regression evidence |

## Priority / debt

**Must fix now:** provider failure path; demo fallback; lost/duplicated prompts; inaccessible settings; broken input; layout obscuring the office; wrong configuration/selection; unsafe approval behavior; fabricated state.

**Should fix before release:** inconsistent focus, spacing or themes; history/source navigation gaps; resize/scale problems; semantic animation backlog; recovery defects; required TUI parity.

**Acceptable only when documented and user-approved:** cosmetic animation variations or advanced non-core TUI capability with a safe discoverable alternative. This is not permission to drop difficult required features. Unknown support is an audit item, not a reason to hide a broken existing control.

## Later / not silently added

Multiplayer, cloud sync, office furniture editor, more floors, a full embedded terminal/IDE rewrite, provider billing management, voice, pets, arbitrary plugins, pull-request workflows or scheduling copied from another product's screenshot. Existing working implementations of these must be audited before any removal; new ones need an actual YCoding requirement.

## Risks

The inspected source may differ from all earlier plans. GUI service processes may not inherit shell credentials. Layout may combine device scale, root stretch and scaled theme sizes. History/event contracts may not match old assumptions. A real provider failure cannot be fixed by more animation. Asset quality alone cannot fix oversized opaque panels.

## Success criteria

All R0–R10 gates pass with actual evidence; the user approves the important rendered states; supported provider/model smoke evidence identifies the tested configuration without secrets; no unresolved production-demo path or blocker remains. Any unresolved external limitation keeps the affected gate blocked. A screenshot, a successful API admission, or an agent saying “complete” is not sufficient.

## Additional required scope

Multi-project/folder isolation, per-project drafts/view state, a walkable user avatar, multipage Sessions/Settings/Statistics, complete settings inventory/coverage, provider quota freshness and honest budgets are required. See references/ADDENDUM.md and the corresponding design documents.
