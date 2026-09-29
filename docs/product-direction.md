# Product direction

YCoding is a standalone coding agent. The terminal application is the primary supported surface; the responsive remote web client controls the same local runtime. This document specifies maintained product scope; it is not a roadmap and does not promise unimplemented features.

## Product identity

YCoding owns its runtime, terminal experience, package names, configuration, storage, protocol, client, plugin API, and release artifact.

The product goal is a dependable, highly customizable coding-agent runtime with durable execution state, explicit orchestration, and provider-efficient model usage.

## Priorities

### Concepts at a glance

| Concept                    | Purpose                                                                                                                 | Read more                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Session                    | Durable intent, history, pending input, and execution state.                                                            | [Runtime](./runtime.md)                              |
| Location                   | The folder-scoped runtime environment for configuration, tools, and model resolution.                                   | [Architecture](./architecture.md)                    |
| Agent and subagent         | Configured behavior and durable background delegation with inherited limits.                                            | [Repository resources](./repository-resources.md)    |
| Autonomy                   | Explicit control over automatic answers, approvals, and goal continuation.                                              | [Runtime](./runtime.md)                              |
| Permission and guardrail   | Tool authority and family-wide review of high-impact actions.                                                           | [Operator guide](./guardrails-and-provider-usage.md) |
| Browser and computer tools | Paired Chrome-profile tabs including the active tab, owned tabs, and bounded macOS window control in the local runtime. | [Runtime](./runtime.md)                              |
| Skill and project artifact | Loadable guidance and managed reusable agent customization.                                                             | [Repository resources](./repository-resources.md)    |
| Workspace memory           | Explicit linked knowledge, separate from transcripts and prompt caches.                                                 | [Memory](./memory.md)                                |
| Provider cache and quota   | Provider-owned reuse telemetry and read-only usage reporting.                                                           | [Provider efficiency](./provider-efficiency.md)      |

### 1. Terminal-first delivery

The terminal application is the primary product and release surface.

Changes that affect sessions, prompts, tools, permissions, subagents, skills, project artifacts, cache diagnostics, or transcript history must be proven through the CLI/TUI path.

Supported presentation surfaces are the terminal application and the SolidJS remote web client. The public site and remote client share `ycoding.althenia.app`. The public site publishes its documentation both as pages and as Markdown for AI agents (`/llms.txt`, `/llms-full.txt`, `/docs/<slug>.md`). Opening the remote client while signed out shows only an OAuth sign-in screen; Google is the supported provider. The browser and relay own no repository, shell, tool, model, or Session execution authority. There is no hosted-agent runtime, Electron shell, or native office client in the current product.

### 2. Current runtime architecture

Supported contracts are the current session, configuration, plugin, client, event, and TUI paths.

New changes extend current contracts; there is one current runtime. Changing stored data requires an explicit, tested migration.

### 3. Durable execution

Sessions preserve user intent and execution state across ordinary process lifecycle boundaries.

Durable state owns prompt admission, session history, instructions, compaction results, orchestration records, autonomy state, and project artifacts. Process-local coordinators may optimize execution but cannot become the sole owner of user-visible state.

### 4. Explicit autonomy

The runtime supports three explicit modes:

- `normal`: standard interactive execution;
- `yolo` (`0-3`): tiered autonomous execution — `1` questions/forms, `2` + permissions (`true` → `2`), `3` + guardrail reviews; `goal` active also auto-answers questions/permissions at `0` but guardrails still require `3`;
- `goal`: repeated progress toward a durable goal until completion, stop, or a bounded no-progress terminal state.

Autonomy remains visible, inspectable, interruptible, and subject to permission ceilings and Session guardrails. Only effective YOLO 3 auto-approves ordinary guardrail reviews; `normal`, YOLO 0-2, and active `goal` below YOLO 3 keep reviews enforced. Hard reviews always require a fresh human decision and cannot be bypassed by autonomy or reusable approval. The expanded AUTONOMY sidebar reports Guardrails as `auto · YOLO 3` only at effective YOLO 3 and as `enforced` otherwise, with Hard reviews separately marked `human only`. Completion claims require verification evidence.

### 5. Durable background orchestration

Subagents are durable child sessions and run in the background. Parent sessions receive lifecycle updates and can inspect child state after reconnect or restart.

Orchestration preserves explicit agent selection, bounded nesting, permission ceilings, and parent-child ownership. An in-memory task list is not a substitute for durable orchestration.

### 6. Repository-native customization

Customization is a product capability. Supported domains include:

- agents and subagents;
- commands;
- skills and instruction sources;
- hooks and plugins;
- TUI slots;
- MCP servers and tools;
- project and global artifacts;
- model providers;
- Session guardrails and provider-usage sources.

Project artifacts provide managed scope, lifecycle, validation, provenance, and rollback for reusable agent behavior.

### 7. Provider efficiency and correctness

Provider integration optimizes cost and cache reuse without changing semantic behavior.

Priorities include stable prompt prefixes, provider-specific cache controls, accurate cache telemetry, normalized usage and quota reporting, bounded retries, and explicit incompatibility handling. A cache optimization is incomplete if it lowers correctness or hides provider errors. Provider-usage diagnostics must not block model execution or expose credentials.

OpenCode Zen and OpenCode Go remain named as such only because they are external provider identities.

### 8. Documentation and distribution

The terminal executable is distributed as native release archives with SHA-256 checksums; each release also attaches the `LICENSE` and `NOTICE` files as separate assets listed in the checksum file, never as archive entries. Source archives are provided by GitHub Releases. A `v<version>` tag verifies the TUI and web application, builds and smoke-tests native artifacts, deploys web to Cloudflare after required checks, and publishes one TUI GitHub Release only after deployment succeeds. Deployment requires a `CLOUDFLARE_API_TOKEN` GitHub Actions secret. A manual workflow run prepares artifacts without publishing or deploying. Each release ships one shared note at `docs/releases/v<version>.md`, which is also attached to the GitHub Release.

The public web build publishes a landing page, curated user documentation, a changelog, the generated configuration JSON Schema, an example `ycoding.jsonc`, and the shell installer. Public content contains usage, configuration, and troubleshooting guidance, not engineering architecture, internal infrastructure, database schemas, or implementation plans.

### 9. Remote ingress boundary

Remote access preserves the local runtime as the only execution authority. The Cloudflare Worker and its per-device Durable Object coordinate an outbound local-agent connection with authenticated browser clients. D1 stores authentication and device metadata, never conversation history, model reasoning, streamed output, or tool events.

Remote control requires an authenticated user, an authenticated enrolled device, and ownership of that device. Running `ycoding remote connect` grants that owner access to all existing and future Sessions on the connected local backend. The backend determines each Session's working directory; the browser cannot choose an arbitrary local Location. The operation set is closed; clients cannot proxy arbitrary local requests. Uncertain mutation outcomes must not trigger automatic replay. Reconnection preserves Session identity and reconciles against the existing local durable history.

The owner can create a Session from the connected machine's available, previously opened repositories, optionally choosing its agent and model; omitted choices use the machine's local defaults. The machine derives those choices from its recorded project directories and Session Locations, validates the selected directory, and creates an idle root Session. The new-session composer then opens that Session and submits its first prompt or command, if one was written; opening an existing Session goes to Conversation without submitting anything. A creation with an unknown outcome retains its Session ID for an explicit check or retry instead of creating another Session automatically.

Sessions and the conversation sidebar list root Sessions by workspace. Each workspace is a scroll-driven feed backed by cursor pages, not an eagerly downloaded full inventory. Search and status filters operate within the selected workspace before paging; running Session families appear first, then pinned Sessions, then the most recently updated. The browser keeps a bounded three-page window and can retrieve evicted rows when scrolling back. Switching the feed's group or filter does not switch the active conversation.

The remote workspace presents the selected Session as Conversation, the default, or Office. Office is available when the viewport is at least 768px wide and either at least 600px tall or has a fine primary pointer. Otherwise Conversation appears regardless of the stored Office preference, and the Conversation–Office switch and Settings → Office section are hidden. The view switch sits above the workspace and marks waiting decisions on Conversation; Team is a compact icon with its active count beside Notifications in the header at every width. Resize preserves the selected Session and unsent draft.

Office is a shared pixel workspace with varied, personalized desk clusters, lounge seating, a meeting area, a pantry and a perimeter entrance. Up to sixteen characters keep exclusive workstation claims and stable human names. Only the selected Session's family appears: its root and that root's reported direct child tasks, never unrelated loaded Sessions. Each character follows its own Session execution rather than the root family's running mark. One bounded family-activity read supplies short truthful actions such as “Reading store.ts”, “Running bun test”, “Editing usage.css” or “Thinking”; a waiting member shows “Needs your decision”, while idle and terminal members have no state-word bubble. Missing activity support produces an update-required note. The accessible Agents roster shows names, agents, locations and current actions, including characters outside the camera view.

Characters edit, read, test and coordinate at separate spots within their own workstation claim, retargeting immediately when activity changes. Their routes never cross another agent's claim. Idle members may visit shared seating; renewed work cancels an idle trip. Newly shown children enter through the entrance and departing or terminal children leave after any active report cue. Live, corroborated delegation and report cues appear in place, without replay on hydration, reconnect or visibility restoration. Reduced motion settles characters without travel. Selection within one family preserves identities, names, positions, walks, connection and drafts; a different family starts its own scene.

Office opens near the selected agent at a readable working scale. Camera controls zoom, fit, follow and return to Conversation. Drag, wheel and trackpad pan the zoomed floor; Shift-wheel pans horizontally and arrow keys pan when the floor has focus. Manual navigation suspends following without switching Sessions. Fit shows the entire floor and keeps that overview through resize, with centered margins when aspect ratios differ. The canvas uses the height left after headers and notices; the roster scrolls beside it on desktop and below it on tablets. Pending requests and the composer remain in Conversation. Settings → Office stores presentation, motion, bubbles, labels, following and rendering quality in the browser; reset changes only these cosmetic choices. The engine loads only while Office is shown, and Conversation remains usable if it cannot start.

The transcript distinguishes right-aligned user bubbles from left-aligned YCoding responses. Read indicators reflect consumed prompts, not delivery acknowledgements. Compact reasoning disclosures omit empty parts and mount their formatted content on demand. Successful compaction releases covered older messages from the browser view while preserving durable history and showing the latest compaction lifecycle. Subagent notifications render as compact status notices rather than raw payloads. The transcript follows new output only while the reader is at its bottom, and the selected Session's todo list sits above the composer in document flow, so it never covers the transcript.

The responsive layout reflows at desktop, tablet, and mobile breakpoints. Navigation consistently names Sessions, Conversation, Usage, and Settings; tablets keep these routes visible, and on tablets and desktops the selected conversation's session sidebar collapses to a narrow strip that reopens it. When the workspace runs as an installed app, page zoom is locked: pinch gestures do not zoom and focusing a text field does not zoom the page, while a browser tab keeps normal zoom. Public and remote routes expose a main landmark and mark the current navigation destination; dialogs retain keyboard focus inside their controls, and Settings radio groups support arrow, Home, and End selection with one tab stop per group. Light and dark themes, keyboard-accessible approvals, bounded tool/terminal output, and an accessible composer are required on each surface. Unsent prompt drafts belong to their selected Session and remain available through remote-route navigation and reconnects; switching machines, disconnecting explicitly, signing out, or leaving the remote workspace clears them. Drafts are not stored across page reloads. Offline mode never queues remote mutations.

The cached offline page provides Home, Documentation, and Changelog navigation and a **Retry** link to `/remote`. It follows the browser's light or dark color preference. Service-worker caching is limited to the public static shell, including its built entry script and stylesheet before activation; API, authentication, and WebSocket traffic is excluded. Activating a new shell-cache version removes prior YCoding shell caches while retaining unrelated origin caches, so the updated public shell remains usable when connectivity drops immediately afterward. An install prompt alone does not establish native PWA installation or standalone launch; those remain browser- and platform-managed operations. An installed app starts at the remote workspace, `/remote`.

Remote questions use the runtime's native Forms. The workspace renders string, multiselect, number, integer, boolean, and external-step fields, preserves defaults and conditional visibility, and submits typed answers or explicit cancellation. External steps expose HTTP(S) links and require acknowledgement. Only pending Forms owned by the selected Session can be answered; the local runtime validates every answer.

The machine picker lists online, active enrollments and states how many offline or revoked machines Settings manages. Wide desktop layouts expand the selector and its popover; machine names stay on one line and truncate with an ellipsis when necessary. Option text uses the same compact size as the selection control. On phones, selection is staged in a keyboard-contained sheet until **Confirm Selection**; dismissing the sheet keeps the current machine. Wider layouts select directly from the popover. When the selected machine goes offline, the workspace preserves its name, reconnect action, and last session list; that list stays read-only until the machine reconnects, rather than switching to another machine. Settings retains offline and revoked enrollments and exposes notification preferences for Work finished, Needs your attention, and Machine offline with independent In app and System channels, plus an opt-in Web Push subscription for this device that sends the categories whose System switch is on to a closed browser or installed app, and a test alert that reports whether the push service accepted it.

## Compatibility policy

- **Durable data:** preserve current data or provide an explicit tested migration.
- **Protocol and client:** generated Client output must match the assembled public `HttpApi`.
- **Plugins:** current contracts only; breaking changes require Schema, API, tests, and documentation updates.
- **Configuration:** current Schema is authoritative; rejected keys are not accepted through hidden fallback paths.
- **External providers:** preserve provider-owned IDs, URLs, credentials, and names required for interoperability.

## Definition of complete

A product change is complete only when:

- the real runtime path is implemented;
- targeted regression tests pass;
- affected packages typecheck;
- generated output is regenerated through its owning command;
- TUI-visible behavior is verified in the terminal path;
- documentation matches the final behavior;
- no placeholder, mock-only path, stale product reference, or invented external endpoint is presented as production behavior.
