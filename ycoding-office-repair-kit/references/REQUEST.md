# YCoding Desktop Office — Audit, Repair, and Completion Handoff

Use the provided plugin/tools to inspect, run, review, and modify the codebase located at:

`/Users/viadz/Workspace/Project/ycoding`

## Objective

Complete the **YCoding Desktop — Office Workspace** implementation.

The current desktop implementation has been reported as "complete" by previous agents, but it is not actually complete. The implementation does not adequately follow the agreed design, the UX/UI quality is poor, several functions do not work, the real AI provider connection is broken, and mock/demo behavior still exists where production behavior should be used.

Do **not** trust previous completion claims.

Treat the existing implementation as something that must be independently audited against:

1. The existing YCoding TUI behavior and functionality.
2. The intended Desktop Office design.
3. The reference screenshots/images I provide.
4. The actual provider integration and real runtime behavior.
5. The existing plans/specifications/design decisions in the repository.

The goal is not to create another prototype.

The goal is to leave the Desktop Office in a genuinely usable, production-like state.

---

# Reference Images

I will provide reference images/screenshots separately.

Use them as **visual requirements**, not loose inspiration.

References may include:

- Current broken YCoding Desktop render.
- Existing YCoding TUI.
- ChatGPT Desktop/App UI references.
- Gather-style office/workspace references.
- Previous agreed YCoding design references.
- Specific screenshots showing layout, spacing, composer, sidebar, dialogs, settings, office scene, etc.

When references conflict, prioritize:

1. Explicit requirements in this prompt.
2. Previously agreed YCoding design/specification.
3. Functional parity with the TUI.
4. Reference screenshots.
5. Existing desktop implementation.

Do not blindly copy ChatGPT or Gather. They are references for **interaction quality, layout discipline, polish, hierarchy, spacing, and visual fidelity**.

YCoding must retain its own identity, particularly the **8-bit/pixel-art Office workspace**.

---

# Core Product Layout

The desktop application should primarily follow this structure:

```text
┌───────────────┬──────────────────────────────────────────┐
│               │                                          │
│               │                                          │
│   Sidebar     │            8-bit Office                  │
│               │                                          │
│               │                                          │
│               │                                          │
│               │          ┌────────────────────┐          │
│               │          │      Composer      │          │
│               │          └────────────────────┘          │
└───────────────┴──────────────────────────────────────────┘

```

Requirements:

- Persistent application sidebar on the **left**.
- Main Office workspace occupies the remaining application area.
- The Office should feel expansive/full-height inside the content region.
- The composer should be horizontally centered near the **bottom of the Office**, not attached incorrectly to the sidebar or stretched unnecessarily.
- The Office remains visible around/behind the composer where appropriate.
- Do not turn the entire app into a generic chat UI.
- The Office is the primary spatial workspace.
- Chat/agent interaction should coexist with the Office instead of replacing it.
- Layout must remain coherent during resizing.

The current implementation reportedly has incorrect:

- sidebar dimensions/positioning,
- composer positioning,
- workspace proportions,
- full-screen behavior,
- hierarchy,
- spacing,
- component alignment.

Audit all of these rather than applying isolated cosmetic patches.

---

# UX/UI Quality Target

The desktop application should feel comparable in polish to high-quality native desktop applications such as ChatGPT Desktop while retaining YCoding's pixel-office concept.

Pay close attention to:

- visual hierarchy,
- consistent spacing,
- component sizing,
- alignment,
- typography,
- hover states,
- pressed states,
- selected states,
- keyboard focus,
- tooltips,
- menus,
- transitions,
- empty states,
- loading states,
- errors,
- disabled states,
- scroll behavior,
- overflow,
- window resizing,
- dialogs,
- dropdowns,
- command menus,
- sidebar interactions,
- composer behavior.

Do not settle for "technically rendered."

The UI should look deliberate.

Avoid:

- arbitrary margins,
- oversized panels,
- inconsistent radii,
- accidental floating elements,
- excessive borders,
- placeholder-looking controls,
- uneven spacing,
- disconnected visual styles,
- unfinished debug UI,
- demo labels,
- fake data.

---

# Settings

The current desktop implementation is missing or has incomplete settings.

Audit the TUI and repository for existing settings/features and implement the appropriate Desktop equivalents.

Settings should include everything required to operate the application properly, particularly anything involving:

- providers,
- models,
- API/provider configuration,
- behavior/preferences,
- desktop-specific preferences,
- themes/display where applicable,
- application state that users need to control.

Do not invent settings unnecessarily.

Derive them from actual YCoding functionality, existing configuration, TUI behavior, and repository specifications.

Settings must be reachable from the UI and actually work.

A settings screen that merely renders controls without wiring them to application state/configuration is not complete.

---

# Real Provider Integration

This is a critical requirement.

The Desktop version must work with **actual configured providers**.

Previous agents apparently left mock/demo paths or provider integration that fails when connecting to a real provider.

Audit the entire provider path from UI to backend/runtime.

Verify:

```text
User Input
   ↓
Desktop Composer
   ↓
Application State / Command
   ↓
Provider Configuration
   ↓
Provider Client
   ↓
Actual API Request
   ↓
Streaming / Response Handling
   ↓
Agent / Office State
   ↓
Rendered Response

```

Check:

- provider selection,
- model selection,
- configuration loading,
- API key handling,
- environment/config precedence,
- request construction,
- endpoint selection,
- authentication,
- streaming,
- cancellation,
- timeout handling,
- retry/error behavior,
- malformed responses,
- provider-specific differences,
- conversation persistence/state,
- tool execution where supported,
- UI state during generation,
- failure feedback.

Do not simply inspect types and conclude that integration exists.

Actually exercise the real runtime path.

If credentials are available through the environment/configuration, use them to perform a minimal real-provider verification.

Do not print or expose credentials.

---

# Remove Mock / Demo Behavior

Production Desktop Office must not silently fall back to demo behavior.

Search the entire relevant desktop/backend implementation for things such as:

```text
mock
demo
fixture
fake
stub
sample
placeholder
hardcoded response
fake agent
fake conversation
fake provider
development fallback
seed response
simulated streaming

```

Determine whether each occurrence is:

- legitimate test-only code,
- development tooling,
- or incorrectly reachable production behavior.

Remove or isolate inappropriate mock/demo behavior.

Tests can of course use mocks.

Production runtime should not.

If the actual provider fails, show a proper error state. Do not substitute a fake response to make the app appear functional.

---

# TUI Parity

The YCoding TUI is the functional baseline.

Inspect the TUI implementation deeply.

Create a parity matrix covering at minimum:

| CapabilityTUIDesktopGapAction |   |   |   |   |
| ----------------------------- | - | - | - | - |
| Start conversation            |   |   |   |   |
| Send prompt                   |   |   |   |   |
| Stream response               |   |   |   |   |
| Provider selection            |   |   |   |   |
| Model selection               |   |   |   |   |
| Agent state                   |   |   |   |   |
| Tool execution                |   |   |   |   |
| Session/history               |   |   |   |   |
| Settings                      |   |   |   |   |
| Errors                        |   |   |   |   |
| Cancellation                  |   |   |   |   |
| Keyboard controls             |   |   |   |   |
| Office agent representation   |   |   |   |   |

Expand this based on what actually exists in the repository.

Do not assume Desktop must visually reproduce the terminal.

Replicate the **behavior and capability**, while adapting it properly to a graphical desktop experience.

---

# Office Workspace

The Office is not decorative background art.

It is a core part of the product.

Audit:

- office rendering,
- pixel scaling,
- character rendering,
- character positions,
- movement,
- desks/workstations,
- rooms/zones,
- agent status,
- active agent visualization,
- interaction points,
- selection,
- hover states,
- tooltips,
- animations,
- task/activity states,
- camera/viewport behavior if applicable,
- resize behavior,
- overlays,
- composer coexistence,
- sidebar coexistence.

The Office should remain visually coherent even while agent/chat activity occurs.

Avoid covering most of the office with opaque generic panels.

---

# Composer

The composer is a major interaction surface and must be treated accordingly.

Expected characteristics:

- centered toward the bottom of the Office workspace,
- constrained sensible maximum width,
- visually separated from the scene without looking disconnected,
- multiline support,
- correct Enter / Shift+Enter behavior,
- send action,
- disabled/busy states,
- cancellation/stop when applicable,
- provider/model information or controls where appropriate,
- attachment/tool affordances only if supported by YCoding,
- keyboard focus behavior,
- proper resizing as text grows,
- no accidental overlap with critical Office UI.

Take UX inspiration from modern AI desktop applications, but adapt it to YCoding rather than copying them.

---

# Sidebar

Audit and redesign the sidebar as necessary.

The sidebar should contain the navigation and persistent application controls that make sense for YCoding.

Possible responsibilities should be derived from the existing application, such as:

- workspace/session navigation,
- conversations,
- agents,
- projects,
- provider/model context,
- settings entry point,
- account/application controls.

Avoid turning it into a dumping ground.

It should have strong visual hierarchy and compact information density.

---

# Audit Before Modification

Before making large changes:

1. Inspect repository structure.
2. Locate the Desktop implementation.
3. Locate the TUI implementation.
4. Locate existing specifications/plans.
5. Locate provider/runtime implementation.
6. Locate configuration/settings.
7. Locate any previous audit/handoff documents.
8. Run the current Desktop application.
9. Compare current runtime behavior with provided screenshots.
10. Run or inspect the TUI for functional comparison.

Then document the actual gaps.

Do not base your work exclusively on old audit documents. Verify them against the current codebase.

---

# Preserve Good Existing Work

Do not rewrite working systems merely because rewriting is easier.

For each subsystem, determine whether it should be:

- kept,
- repaired,
- refactored,
- replaced,
- removed.

Prefer the smallest architectural change that produces a clean and maintainable result.

However, do not preserve broken architecture purely to minimize diff size.

---

# Do Not Paper Over Problems

Examples of unacceptable "fixes":

- hardcoding provider output,
- hardcoding layout for one screenshot size,
- hiding broken controls,
- removing features because they are difficult,
- displaying fake success states,
- leaving TODO comments instead of implementation,
- replacing real provider calls with demo responses,
- disabling error paths,
- declaring a feature complete because the component exists,
- creating buttons that do nothing,
- adding placeholders for missing settings,
- implementing only the happy path.

Fix root causes.

---

# Verification

Every important feature must be verified through actual runtime behavior.

Use appropriate automated tests where practical, but tests alone are not sufficient for visual and integration work.

Perform:

## Static verification

- build/typecheck,
- compiler checks,
- linting,
- relevant unit tests,
- integration tests.

## Runtime verification

Launch the application and exercise the actual UI.

Verify at least:

1. Application startup.
2. Sidebar navigation.
3. Office rendering.
4. Composer focus/input.
5. Prompt submission.
6. Real provider request.
7. Streaming/response rendering.
8. Provider/model configuration.
9. Settings navigation and persistence.
10. Error behavior.
11. Cancellation where supported.
12. Session/conversation state.
13. Window resizing.
14. Relevant keyboard interactions.

---

# Visual Verification

Compare implementation screenshots against the supplied references.

Do not rely purely on reading CSS/components.

Review the rendered result.

For each important screen/state, inspect:

- geometry,
- spacing,
- component placement,
- hierarchy,
- proportions,
- overflow,
- clipping,
- pixel alignment,
- typography,
- contrast,
- interaction states.

Important screenshots/states should include at least:

- normal Office,
- composer focused,
- conversation active,
- streaming/generating,
- sidebar expanded/default state,
- settings,
- provider/model selection,
- error state,
- relevant dialogs/menus.

If the rendered result looks wrong, continue iterating.

Passing the build is not equivalent to completing the task.

---

# Completion Standard

Do not report this task as complete until all of the following are true:

- Desktop launches normally.
- Desktop Office layout matches the agreed composition.
- Sidebar is correctly positioned and designed.
- Office occupies the intended main workspace.
- Composer is correctly centered near the bottom.
- Settings exist and function.
- Real provider configuration works.
- A real prompt can be sent to an actual provider.
- Responses render correctly.
- Streaming works where supported.
- Errors are surfaced properly.
- Production runtime does not depend on mock/demo responses.
- Core TUI capabilities required by Desktop have working Desktop equivalents.
- Important interactions work via mouse and keyboard.
- Window resizing does not destroy the layout.
- Major visual states have been runtime-reviewed.
- No obvious placeholder/debug UI remains.
- Existing tests/build checks pass, aside from explicitly documented unrelated pre-existing failures.

---

# Handoff / Tracking

Maintain a durable implementation handoff/tracking document inside the repository.

It should contain:

## 1. Current State

What currently works and does not work.

## 2. Confirmed Architecture

Important components and data flow.

## 3. TUI → Desktop Parity Matrix

Functionality and gaps.

## 4. UX/UI Gap Matrix

Reference requirement → current state → implementation action → verification.

## 5. Provider Integration Status

Real provider flow and verified providers/models.

## 6. Mock/Demo Audit

Every production-relevant mock/demo path found and what happened to it.

## 7. Work Completed

Files/features changed and why.

## 8. Remaining Work

Only genuinely unfinished items.

## 9. Verification Evidence

Commands/tests/runtime scenarios/screenshots used to verify completion.

## 10. Known Issues

Actual remaining limitations without disguising them as completed work.

Update this document as work progresses so another agent can reliably continue from it.

---

# Working Style

You have ownership of solving the implementation, not merely reviewing it.

Do not stop after producing an audit.

The workflow is:

```text
Inspect
→ Run
→ Compare
→ Audit
→ Plan
→ Implement
→ Run
→ Verify
→ Visually compare
→ Fix remaining gaps
→ Re-test
→ Update handoff

```

Continue through this loop until the Desktop Office meets the completion standard.

Do not claim completion based on code appearance.

**The rendered application and actual runtime behavior are the source of truth.**