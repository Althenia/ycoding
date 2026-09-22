/**
 * Curated public changelog.
 *
 * Authored from the per-version release notes shipped with each release. It
 * describes user-visible behavior only and omits removed or internal surfaces.
 */

export type ChangeTag = "Added" | "Changed" | "Fixed"

export type ChangeEntry = {
  readonly tag: ChangeTag
  readonly text: string
}

export type ReleaseEntry = {
  readonly version: string
  readonly date: string
  readonly title: string
  readonly tags: readonly ChangeTag[]
  readonly changes: readonly ChangeEntry[]
}

export const RELEASES: readonly ReleaseEntry[] = [
  {
    version: "0.6.3",
    date: "2026-09-22",
    title: "Toggle Daybreak security access per Session",
    tags: ["Added", "Changed"],
    changes: [
      { tag: "Added", text: "A per-Session Daybreak toggle in the command palette and the /daybreak slash command with blue, red, or off arguments; without one it cycles off → blue → red → off and offers only the programs the active model advertises." },
      { tag: "Added", text: "ChatGPT OAuth Sessions on a program-advertising model send access_programs.cyber to the Codex backend for reduced-refusal security work. API-key and custom-provider requests omit it, unadvertised models fail closed, and provider authorization still applies." },
      { tag: "Changed", text: "Daybreak availability appears through the per-Session toggle instead of separate Daybreak Blue and Daybreak Red model-picker entries, keeping one entry per model in the list." },
      { tag: "Changed", text: "Sessions that selected a removed daybreak model entry re-select the base model once." },
    ],
  },
  {
    version: "0.6.2",
    date: "2026-09-22",
    title: "Usage reports and deliberate updates",
    tags: ["Added", "Changed", "Fixed"],
    changes: [
      { tag: "Added", text: "A dedicated terminal Usage screen with retained backend totals, model and time-based reports, Sessions, projects, agents, and an activity calendar." },
      { tag: "Added", text: "Reopen BTW conversations from a separate Side chats tab with distinct parent navigation." },
      { tag: "Changed", text: "Background update checks only notify. Run ycoding update explicitly to install a release." },
      { tag: "Changed", text: "The GSD orchestration-only agent replaces TLDR. Update configured TLDR agent references to GSD or another maintained primary agent." },
      { tag: "Changed", text: "Goal steers and automatic ntfy attention messages use Session context without granting human approval." },
      { tag: "Fixed", text: "Show quota status for every available connected provider using its active profile, and preserve successful results when another provider fails." },
      { tag: "Fixed", text: "Keep recorded usage available for deleted historical workspaces without inventing missing cost estimates." },
      { tag: "Fixed", text: "Apply model changes on prompt submission, retain drafts after failed switches, refresh subagent status after reconnect, and show child Session todos." },
      { tag: "Fixed", text: "Use maintained YCoding branding in shared UI components and local OAuth callback pages." },
    ],
  },
  {
    version: "0.6.1",
    date: "2026-09-22",
    title: "Answer native forms remotely",
    tags: ["Fixed", "Changed"],
    changes: [
      { tag: "Fixed", text: "Show and answer the questions created by the local agent in the remote workspace." },
      { tag: "Fixed", text: "Render typed forms with defaults, conditional fields, multiple selections, external-step acknowledgement, and cancellation." },
      { tag: "Fixed", text: "Keep form replies scoped to their owning Session and track live creation and settlement in the request queue and notifications." },
      { tag: "Changed", text: "Upgrade the local connector and reload the remote workspace for the coordinated protocol update. Existing sign-ins and device enrollments remain valid." },
    ],
  },
  {
    version: "0.6.0",
    date: "2026-09-21",
    title: "Remote access to every Session",
    tags: ["Changed", "Fixed"],
    changes: [
      { tag: "Changed", text: "Running ycoding remote connect grants the device owner access to all existing and future Sessions on that backend. Per-Session allow and deny commands are not supported." },
      { tag: "Changed", text: "Upgrade connectors and refresh browser tabs for the remote protocol update. Existing enrollments and browser sign-ins remain valid." },
      { tag: "Changed", text: "A responsive landing page and remote workspace with custom device, delivery, and autonomy menus and independent notification channels." },
      { tag: "Fixed", text: "Discover every backend Session page and update the list as Sessions are created, moved, or deleted." },
      { tag: "Fixed", text: "Preserve an unreachable selected machine, distinguish empty backends from missing devices, and restore live subscriptions after connector replacement." },
      { tag: "Fixed", text: "Recover the inventory stream without a selected Session and keep status chips and keyboard-accessible menus within their containers." },
    ],
  },
  {
    version: "0.5.2",
    date: "2026-09-21",
    title: "Landing goal activation",
    tags: ["Fixed"],
    changes: [
      { tag: "Fixed", text: "Landing /goal with text now creates a session, sets the goal durably, and navigates to the transcript instead of only toggling a local hint." },
    ],
  },
  {
    version: "0.5.1",
    date: "2026-09-21",
    title: "Remote workspace and reliable browser shutdown",
    tags: ["Added", "Fixed"],
    changes: [
      { tag: "Added", text: "A responsive web workspace for shared Sessions, prompts, streamed output, approvals, interruption, and autonomy controls." },
      { tag: "Added", text: "Google sign-in, device enrollment, and explicit Session sharing through ycoding remote. Execution stays on the enrolled machine." },
      { tag: "Fixed", text: "Isolated browser shutdown terminates owned renderer processes even when Chrome is suspended." },
      { tag: "Fixed", text: "Offline status text meets normal-text contrast requirements in both themes." },
      { tag: "Fixed", text: "Terminal-output pages preserve Unicode, and revoked sharing blocks subsequent remote Session access." },
    ],
  },
  {
    version: "0.4.2",
    date: "2026-09-20",
    title: "Terminal-only product surface",
    tags: ["Changed", "Fixed"],
    changes: [
      { tag: "Changed", text: "The terminal application is the primary and only product surface." },
      { tag: "Fixed", text: "Removed stale references to a second presentation surface from product and contributor guides." },
    ],
  },
  {
    version: "0.4.1",
    date: "2026-09-20",
    title: "Attention notifications and catalog resilience",
    tags: ["Added", "Fixed"],
    changes: [
      { tag: "Added", text: "Attention notifications post from session lifecycle events when notification configuration and permissions allow it." },
      { tag: "Added", text: "Discover MCP-served skills through the Skills extension and load their content lazily after approval." },
      { tag: "Fixed", text: "Routine subagent completion stays silent while pending human input still alerts." },
      { tag: "Fixed", text: "Reconnecting the terminal preserves execution events received while session status loads." },
      { tag: "Fixed", text: "Repeated managed skill, command, and subagent invocations keep stable activation timestamps." },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-09-20",
    title: "Workspace memory and offline knowledge graphs",
    tags: ["Added", "Changed", "Fixed"],
    changes: [
      { tag: "Added", text: "On-demand repository memory and shared knowledge stored as linked Markdown, shared across the checkout and its worktrees." },
      { tag: "Added", text: "Self-contained offline knowledge graphs with search, type filtering, keyboard selection, and a concept reader." },
      { tag: "Added", text: "Recoverable knowledge deletion with collection-local trash and digest-guarded permanent removal." },
      { tag: "Changed", text: "Selecting another model in an existing session interrupts active work, settles it, and checks the target context budget before committing." },
      { tag: "Changed", text: "Goals keep one user-owned objective: ordinary chat and agent tools cannot rewrite it." },
      { tag: "Changed", text: "Goal calculation always uses a configured model; the previous local synthesis switch is gone." },
      { tag: "Fixed", text: "Long prompts and pasted documents render at full wrapped height." },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-09-19",
    title: "Provider profiles and reliable updates",
    tags: ["Added", "Fixed"],
    changes: [
      { tag: "Added", text: "A provider can hold several named profiles: multiple accounts or API keys, with exactly one active." },
      { tag: "Added", text: "The active profile appears above the provider in the context sidebar and in the model selector." },
      { tag: "Fixed", text: "Automatic update resolves the newest release from GitHub Releases and installs it with the checksum-verified installer." },
      { tag: "Fixed", text: "Interrupting a session during provider retry backoff now settles the step." },
      { tag: "Fixed", text: "A multi-line prompt renders in full instead of showing only its first lines." },
    ],
  },
  {
    version: "0.2.5",
    date: "2026-09-16",
    title: "Composer clipboard fidelity",
    tags: ["Fixed"],
    changes: [
      { tag: "Fixed", text: "The composer pastes a clipboard image with the platform modifier key on macOS as well as the terminal paste gesture." },
    ],
  },
  {
    version: "0.2.4",
    date: "2026-09-14",
    title: "Responsive prompts and visible reviews",
    tags: ["Added", "Changed", "Fixed"],
    changes: [
      { tag: "Added", text: "Send and steer now admits a prompt, interrupts the active step so the next boundary is immediate, and wakes the session." },
      { tag: "Changed", text: "Guardrail and permission review rows render whenever a request still awaits a reply." },
      { tag: "Fixed", text: "A pending guardrail review surfaces in every view it can block, including subagent chats." },
      { tag: "Fixed", text: "Sending a prompt is no longer held behind a model or variant switch." },
    ],
  },
  {
    version: "0.2.3",
    date: "2026-09-14",
    title: "Guardrail review visibility",
    tags: ["Changed", "Fixed"],
    changes: [
      { tag: "Changed", text: "Recursive deletion of multiple narrow targets is an ordinary guardrail review; deletion directly below the home directory requires a human decision." },
      { tag: "Fixed", text: "Pending guardrail approvals surface and pause the composer instead of waiting invisibly." },
      { tag: "Fixed", text: "Sidebar sections expand again, with expand state preserved across session navigation." },
    ],
  },
  {
    version: "0.2.2",
    date: "2026-09-14",
    title: "Transcript presentation",
    tags: ["Changed", "Fixed"],
    changes: [
      { tag: "Changed", text: "Only session, context, and todo sections expand by default; every other section stays behind its header summary." },
      { tag: "Fixed", text: "Session-state notices stay in the message store but never render in the transcript." },
    ],
  },
  {
    version: "0.2.1",
    date: "2026-09-13",
    title: "Bounded team observations",
    tags: ["Changed", "Fixed"],
    changes: [
      { tag: "Changed", text: "Automatic team observations use a bounded projection that omits task revisions and timestamps." },
      { tag: "Fixed", text: "Timestamp and revision-only updates no longer grow model history or reorder observed children." },
      { tag: "Fixed", text: "Long team snapshots stay bounded with an omitted-child count." },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-09-13",
    title: "Terminal inspection, browser control, and explicit YOLO levels",
    tags: ["Added", "Changed", "Fixed"],
    changes: [
      { tag: "Added", text: "Session-owned terminal inspection with explicit control transfer and bounded output replay." },
      { tag: "Added", text: "Isolated browser sessions with semantic actions, permission checks, and session guardrails." },
      { tag: "Added", text: "An optional Chrome extension that attaches only to tabs you explicitly share." },
      { tag: "Added", text: "Native macOS operations for exact iTerm sessions and Finder paths, fenced by session ownership." },
      { tag: "Changed", text: "Autonomy uses explicit YOLO levels 0-3 instead of a boolean switch." },
      { tag: "Changed", text: "Hard guardrail reviews require a fresh human decision at every autonomy level." },
      { tag: "Fixed", text: "Active provider event streams no longer end when a retry directive arrives." },
    ],
  },
  {
    version: "0.1.2",
    date: "2026-09-09",
    title: "Grapheme-safe truncation",
    tags: ["Fixed"],
    changes: [
      { tag: "Fixed", text: "Truncated Thai titles, labels, and tool output keep combining marks with their base character." },
    ],
  },
  {
    version: "0.1.1",
    date: "2026-09-09",
    title: "Session archiving and startup reclamation",
    tags: ["Added", "Changed"],
    changes: [
      { tag: "Added", text: "Reversible session archiving that never deletes history or changes last-activity time." },
      { tag: "Changed", text: "SQLite space reclamation runs automatically at startup without deleting records." },
      { tag: "Changed", text: "Retry status distinguishes scheduled backoff, in-flight retry, and terminal states." },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-09-09",
    title: "First terminal release",
    tags: ["Added"],
    changes: [
      { tag: "Added", text: "Terminal distribution with native release archives and SHA-256 checksums." },
    ],
  },
]

export function changeTagCounts(releases: readonly ReleaseEntry[]): Record<ChangeTag, number> {
  return releases
    .flatMap((release) => release.changes)
    .reduce<Record<ChangeTag, number>>(
      (counts, change) => ({ ...counts, [change.tag]: counts[change.tag] + 1 }),
      { Added: 0, Changed: 0, Fixed: 0 },
    )
}

export function releaseYears(releases: readonly ReleaseEntry[]): readonly string[] {
  return [...new Set(releases.map((release) => release.date.slice(0, 4)))].sort().reverse()
}
