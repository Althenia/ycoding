import { describe, expect, test } from "bun:test"
import { RELEASES, changeTagCounts } from "./changelog"

const TAGS = ["Added", "Changed", "Fixed"] as const

describe("release entries", () => {
  test("lists v0.10.10 shell command queue, self-contained commits, and waiting for another database writer first", () => {
    expect(RELEASES[0]).toEqual({
      version: "0.10.10",
      date: "2026-10-14",
      title: "Sleep mode, shell command queue, and faster web",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "The shell tool has a queue channel for expensive commands such as typechecks, builds, and package-wide test suites. Queued commands from every YCoding process on the machine share running limits (two at once and one per Session by default), wait for enough free memory and a low enough CPU load, and report completion like background commands. Set the limits under shell_queue; the TUI and the web Team view show queued commands and their position." },
        { tag: "Added", text: "/sleep lets the agent keep working while you are away: the root Session family answers its own questions and forms, settles guardrail reviews with the decision model, and keeps the machine awake. /wake or any message you send in the family ends sleep and restores your earlier review setting." },
        { tag: "Added", text: "/guardrail-decision toggles decision-model review for a root Session family. A review is approved once when the model approves with confidence 0.8 or higher and rejected otherwise; explicit denies still apply and YOLO levels are unchanged." },
        { tag: "Added", text: "Before a standard guardrail review reaches you, the decision model checks whether the action really matches the rule, and a confident false match is dismissed without a review." },
        { tag: "Added", text: "/keep-awake toggles keeping the machine awake, also from web Settings → Machine. On macOS it keeps the Mac awake with the lid closed where lid control is available. Sleep holds keep-awake on until the last sleeping Session family wakes." },
        { tag: "Added", text: "Unanswered questions, forms, and subagent questions time out after question_timeout_seconds (default 300; 0 disables). The agent then proceeds on its own judgment, and a late answer is rejected." },
        { tag: "Changed", text: "Built-in agents commit only complete, self-contained changes: each commit includes its code, tests, docs, and release-note entries, is made after its checks pass, and has a summary that states its intent and a body that states why it exists, what behavior changed, and how it was verified." },
        { tag: "Changed", text: "Built-in agents reply and write documentation, instruction files, code comments, and commit messages as directives and facts from verified evidence in the reader's own terms, without unrequested explanations, copying the request's wording, or mentioning the request or its style instructions." },
        { tag: "Changed", text: "The Usage page shows the monthly provider total and its unit inside the donut ring. A total too wide for the ring is shortened to one decimal with a k, m, or b suffix, such as $2.0k; the exact total stays available on hover, on keyboard focus, and to screen readers, and the legend keeps each provider's exact value." },
        { tag: "Changed", text: "Primary built-in agents start every remaining task that does not depend on running background work instead of waiting for it, and name the dependency of each task they hold back; a queued typecheck, build, or test suite delays only other heavy checks, not code-writing or review work." },
        { tag: "Fixed", text: "A shell command that runs git push and later another command with -f, such as rm -f or grep -f, no longer asks for a force-push hard review. Destructive Git and force-push checks now read each command of a compound command separately." },
        { tag: "Fixed", text: "The web client opens and refreshes Sessions with fewer requests. Selecting a Session reads its transcript without waiting for the subscription to be confirmed; a Session-list change rereads the open transcript only when it missed events; list refreshes keep the visible rows instead of showing loading and run at most once per 750 ms; captured changes for a Session with many subagents are read once and shared; and Usage reads only when its page opens." },
        { tag: "Fixed", text: "Usage reports no longer stall other requests. Each report reads through a separate read-only database connection in steps of at most 10,000 requests, so the TUI, web, and running Sessions keep responding while it runs; on a 9 GB database the summary report dropped from about 7.8 seconds to under half a second. Startup adds three usage indexes once." },
        { tag: "Fixed", text: "The TUI no longer shows an UnexpectedStatus error while another YCoding process, such as ycoding run or a second TUI, writes to the same local database. Saving local telemetry samples now waits for the other writer to finish instead of failing at once." },
      ],
    })
  })

  test("lists v0.10.9 Muse quota on the usage dashboard first", () => {
    expect(RELEASES[1]).toEqual({
      version: "0.10.9",
      date: "2026-10-14",
      title: "Muse quota on the usage dashboard",
      tags: ["Fixed"],
      changes: [
        { tag: "Fixed", text: "Muse (Meta) subscription quota now appears on the usage dashboard (the TUI Usage screen and the web Usage page) and survives quota refreshes, instead of disappearing after a quota was reported from a Muse response. Quota is still reported only after a Muse response and is retained in memory." },
      ],
    })
  })

  test("lists v0.10.8 smaller database and eval run controls first", () => {
    expect(RELEASES[2]).toEqual({
      version: "0.10.8",
      date: "2026-10-14",
      title: "Smaller database and eval run controls",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "A capabilities configuration object turns capabilities off for a run: global or project AGENTS.md files (or individual files by path pattern), including nested files the read tool injects, built-in instruction blocks by name, skills, tools, MCP servers, and external plugins by allow and deny lists, managed project artifacts, the ~/.agents and ~/.claude roots, and it can pin the websearch provider. It works in any configuration layer, including YCODING_CONFIG_CONTENT." },
        { tag: "Added", text: "ycoding run --config <file> applies a JSON/JSONC configuration document as the highest-priority layer of a private server for that run." },
        { tag: "Added", text: "ycoding run --isolated runs on a private server with a temporary data directory and database that are removed afterwards, so the run never touches your Sessions or database. Stored credentials are unavailable in an isolated run; provide provider keys through environment variables or configuration." },
        { tag: "Added", text: "ycoding run --format json reports metrics for evaluation harnesses: step_start includes the agent and model, step_finish includes the context limit, context breakdown, and provider cache diagnostics when reported, and one final run_finish line gives the status, duration, steps, turns, tokens, cost, context size, and models, plus the usage, steps, and turns of the whole run including subagents and helper Sessions. Default text output is unchanged." },
        { tag: "Changed", text: "History that a finished local compaction removed from model context is deleted by the startup and hourly retention sweep, shrinking the database. Sessions compacted by Codex remote compaction keep their full history. Copy and export start at the compaction checkpoint summary. Forking or reverting to a message in removed history reports an error and changes nothing. Failure events from the removed range are kept for 7 days." },
        { tag: "Fixed", text: "Opening the shared database from another YCoding process, such as ycoding run --standalone or serve --stdio, no longer marks a running service's active child tasks as lost. Each active child task records its owning process, and only tasks whose owner process has exited are marked lost when a process starts." },
        { tag: "Fixed", text: "Built-in guidance for a tool the agent cannot use, such as workspace memory while memory is disabled or decision while it is denied, is no longer included in the instructions." },
      ],
    })
  })

  test("lists v0.10.7 background Chrome and computer use first", () => {
    expect(RELEASES[3]).toEqual({
      version: "0.10.7",
      date: "2026-10-13",
      title: "Background Chrome and computer use",
      tags: ["Changed"],
      changes: [
        { tag: "Changed", text: "Chrome control keeps working in the background with real input: clicks and scrolls on a background tab or in an unfocused or minimized window are trusted mouse input that carry user activation, so popups, clipboard access, and file pickers work without bringing the tab forward. While YCoding controls a tab, the page reports itself visible and is not background-throttled; detaching ends this." },
        { tag: "Changed", text: "Browser action results no longer include the input field." },
        { tag: "Changed", text: "macOS computer use runs one persistent YCoding Computer Use helper per YCoding process over a private local socket instead of launching the helper for every operation." },
        { tag: "Changed", text: "When a background app brings itself to the front in response to a computer-use click or key press, YCoding puts your original app and window back in front within the same action." },
      ],
    })
  })

  test("lists v0.10.6 Muse (Meta) subscriptions, quota, and built-in agent updates first", () => {
    expect(RELEASES[4]).toEqual({
      version: "0.10.6",
      date: "2026-10-13",
      title: "Muse (Meta) subscriptions and quota",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "Muse (Meta) provider: connect a Meta Muse Code subscription through /connect with a device-code login, or use a Meta Model API key or META_API_KEY. YCoding lists the models your account can use, with their context limits and effort levels, and runs them with tools and reasoning." },
        { tag: "Added", text: "Muse subscription quota appears in provider usage as live 5-hour window and weekly percentages with reset times, updated from each Muse response." },
        { tag: "Changed", text: "Built-in agents use checkpoint-based testing guidance: plan required tests before building, then run focused tests at feature checkpoints and full checks at integration or merge checkpoints." },
        { tag: "Changed", text: "Built-in agent display names are capitalized; their IDs remain unchanged." },
        { tag: "Fixed", text: "Claude Sonnet 5.5 and Haiku 5.5 use their 512-token prompt-cache minimum and supported one-hour cache TTL in diagnostics and adaptive cache selection." },
      ],
    })
  })

  test("lists v0.10.5 MCP protocol 2026-07-28, lasting MCP sign-ins, and quieter guardrails first", () => {
    expect(RELEASES[5]).toEqual({
      version: "0.10.5",
      date: "2026-10-13",
      title: "MCP protocol 2026-07-28, lasting MCP sign-ins, and quieter guardrails",
      tags: ["Changed", "Fixed"],
      changes: [
        { tag: "Changed", text: "Tabs controlled by YCoding through the Chrome extension show the Ⓨ mark before the page title instead of the [YCoding] text, and the in-page cursor label shows the YCoding mark." },
        { tag: "Changed", text: "The worktree tool no longer asks for permission by default; the read-only BTW advisor still asks." },
        { tag: "Changed", text: "Guardrails review fewer harmless commands: read-only commands (including after cd or || exit), read-only parts of mixed commands, interpreter script paths such as python3 ~/script.py, and program text in python3 heredocs no longer trigger an outside-repository review. Hard reviews and real outside writes are unchanged." },
        { tag: "Changed", text: "A shell started while the session family already runs its maximum number of shells waits up to 60 seconds for a free slot, in arrival order, instead of failing at once. Change the wait with guardrails.shell_wait_seconds. When the wait ends without a slot, the error names the limit and the running shells." },
        { tag: "Changed", text: "MCP servers connect with protocol revision 2026-07-28 over stdio and Streamable HTTP when the server supports it, and fall back to the 2025-11-25 handshake otherwise. MCP OAuth sign-in validates the authorization server's issuer, and a stored MCP credential is used only with the authorization server that issued it." },
        { tag: "Fixed", text: "OAuth-authorized remote MCP servers stay signed in when their authorization server rotates refresh tokens, including when several connections or Locations share the same sign-in." },
      ],
    })
  })

  test("lists v0.10.4 Session retention, directory-wide guardrail approvals, and bounded reads first", () => {
    expect(RELEASES[6]).toEqual({
      version: "0.10.4",
      date: "2026-10-12",
      title: "Automatic Session retention and directory-wide guardrail approvals",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "Idle Sessions are deleted automatically. A root Session and all of its subagents are removed, with their history, once every member has been idle for more than 7 days. Pinned Sessions, Sessions with an active goal, suspended or running Sessions, Sessions with unsent input, and Sessions another Session was forked from are kept. Change the number of days with session_retention.days in your global configuration. Freed database space is returned to disk in small batches, and attachment files are not deleted." },
        { tag: "Changed", text: "Choosing Allow for this session on an outside-repository guardrail review now approves that request's outside directory (and everything inside it) for the Session and its subagents, and is remembered after a restart. Hard reviews still always ask." },
        { tag: "Changed", text: "Guardrails ask about work outside the repository less often: heredoc text, commit and PR message text, and URLs are no longer treated as paths, and the repository's main checkout and its other worktrees count as inside the repository." },
        { tag: "Changed", text: "Long Sessions and large databases stay faster: starting each run, goal continuation, subagent completion, outstanding-failure status, and remote-compaction steps read only the messages they need, and SQLite keeps its query statistics up to date." },
        { tag: "Fixed", text: "Shell redirections written without a space, such as cmd>/path/file, or next to 2>&1 are reviewed when they write outside the repository." },
      ],
    })
  })

  test("lists v0.10.3 bounded derived reads, output delivery, and parent-session question answers first", () => {
    expect(RELEASES[7]).toEqual({
      version: "0.10.3",
      date: "2026-10-12",
      title: "Bounded reads and parent-session subagent answers",
      tags: ["Changed", "Fixed"],
      changes: [
        { tag: "Changed", text: "Answer a waiting subagent's full question from its parent Session's notice or the open Subagents list. Your literal answer is sent to the child question—not as a prompt or command—and resumes the child; your ordinary draft is kept and pending approvals still take precedence." },
        { tag: "Changed", text: "Large Session skill, diagnostic, usage, and captured-change reads now use bounded batches while preserving their complete results and totals. This does not limit full model context or canonical transcript copy and export." },
        { tag: "Fixed", text: "Captured shell output stays ordered and drains before command completion, even when output consumers fall behind." },
        { tag: "Changed", text: "Live Session updates are admitted only for the matching event type and Location, so unrelated project events do not accumulate in the Session listener." },
      ],
    })
  })

  test("lists v0.10.2 prompt drafts, guardrail exemptions, and mobile fixes first", () => {
    expect(RELEASES[8]).toEqual({
      version: "0.10.2",
      date: "2026-10-12",
      title: "Prompt drafts, quieter guardrails, and mobile fixes",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "Turn a rough intent into a full prompt with /prompt <intent> in the TUI or web composer. A dialog lets you choose Start a task, Steer, Queue follow-up, or Goal objective (Steer and Queue follow-up appear inside a Session) and include Project memory (this repository) or Global memory (shared knowledge). The draft fills an empty composer for review and is never sent automatically: Goal objective fills /goal …, and Queue follow-up marks the draft so it is sent as queued. On the landing or new-session screen, Start a task and Goal objective create the Session first. Choose the helper model with efficiency.helper_models.prompt; its requests appear in usage as prompt." },
        { tag: "Changed", text: "Guardrails no longer ask to review work outside the repository when it touches YCoding's own config, data, cache, state, temporary, bin, log, or repos directories, or a path your external_directory permission allows. Paths set to ask or deny are still reviewed, and hard reviews such as deleting the project or destructive Git still always ask." },
        { tag: "Changed", text: "Session lists, today's spend, usage reports, and the start of each model request read faster on large histories. The first start after upgrading builds the new database indexes once." },
        { tag: "Fixed", text: "Instructions updated notices stay where the instructions changed, just before the reply that first used them, instead of sticking to the bottom of the transcript. This holds live and after reopening a Session, and the remote web shows the same notices." },
        { tag: "Fixed", text: "On phones and tablets, web sheets and dropdowns such as Agent and model, the model list, Select Color Scheme, and the command palette size to their content instead of filling the screen, and their options keep a normal row height." },
        { tag: "Fixed", text: "With the on-screen keyboard open, the web composer sits directly above the keyboard, and the Sessions, Usage, and Settings bar no longer takes space between them." },
        { tag: "Fixed", text: "The web Hide composer control has its own row and no longer covers the text you are typing." },
        { tag: "Fixed", text: "Opening the web model list with hundreds of models no longer freezes the page." },
        { tag: "Fixed", text: "The web Sessions screen no longer reserves empty space beneath the loading cards." },
      ],
    })
  })

  test("retains v0.10.1 on-demand suggestions and read receipts", () => {
    expect(RELEASES[9]).toEqual({
      version: "0.10.1",
      date: "2026-10-11",
      title: "On-demand suggestions and read receipts",
      tags: ["Changed", "Fixed"],
      changes: [
        { tag: "Changed", text: "Ask for a suggested next message with /suggest in the TUI or web composer, optionally followed by text to steer it, for example /suggest focus on the failing tests. A dialog lets you include Project memory (this repository) and Global memory (shared knowledge); both start unselected, and a selected scope is read when the agent may read memory with or without asking. Suggestions appear only on request, never automatically after a reply, and you are told when no suggestion can be made for the latest reply. Running /suggest shows a fresh suggestion even after you dismissed one. The prediction.enabled and prediction.memory settings are removed; existing configurations that still set them keep working, and Status lists the ignored keys." },
        { tag: "Changed", text: "The TUI receipt beneath your prompt animates a dot trail while sending, shows ✓ once the prompt is accepted (✓ Queued for queued input), and shows ✓✓ once the model has read it, both while the Session runs and after it finishes. The web keeps its static receipt labels." },
        { tag: "Fixed", text: "After compaction, the TUI transcript restarts at the compaction divider, whether you watched the compaction finish or reopened the Session. Returning from a subagent no longer leaves an old divider below newer messages, and the divider numbers each compression and totals the saved tokens across the Session's full history." },
      ],
    })
  })

  test("retains v0.10.0 merged profiles, Meeting, prediction, and Focus workspace", () => {
    expect(RELEASES[10]).toMatchObject({
      version: "0.10.0",
      date: "2026-10-11",
      title: "Concurrent profiles, Meeting, prediction, and a Focus workspace",
      tags: ["Added", "Changed", "Fixed"],
    })
    expect(RELEASES[10]?.changes).toContainEqual({
      tag: "Fixed",
      text: "Remote web requests no longer wait on each other in the relay: independent requests are authorized without holding one another back. Reads, including several reads of one Session, proceed independently; mutations keep arrival order per Session; a cancel waits only for its own request; and agent responses are not held behind status or event processing. Every request is still authorized.",
    })
    expect(RELEASES[10]?.changes).toContainEqual({
      tag: "Changed",
      text: "Prompts show a receipt beneath the bubble. The web shows a static receipt: Sending until the prompt is admitted, Processing while the Session is running, Queued for queued input, and Sent or Read when the Session is idle. The TUI animates a dot trail while sending, shows ✓ once the prompt is admitted (✓ Queued for queued input), and ✓✓ once the model has read it, both while running and after the Session settles.",
    })
    expect(RELEASES[10]?.changes.map((change) => change.text).join("\n")).not.toContain("Load earlier child changes")
    expect(RELEASES[10]?.changes.map((change) => change.text).join("\n")).not.toContain("scope tool")
  })

  test("retains v0.9.5 model decisions and remote recovery", () => {
    expect(RELEASES[11]).toEqual({
      version: "0.9.5",
      date: "2026-10-08",
      title: "Model-powered decisions and resilient remote access",
      tags: ["Added", "Fixed"],
      changes: [
        { tag: "Added", text: "Use an existing configured model for classification, fixed-option choices, and rubric scores through the decision tool. Select its helper model with agents.decision.model or efficiency.helper_models.decision; results use validated TOON and estimated confidence, not native probabilities." },
        { tag: "Added", text: "Opt into model-based guardrail classification, initial agent/model routing, and goal continuation with min_confidence. Native OpenAI Decisions and TypeSafe Jev retain min_probability; deterministic denials, explicit selections, and human-only reviews remain authoritative." },
        { tag: "Fixed", text: "Keep enabled remote access recovering after startup failures, connector-lock contention, socket outages, and failed credential rotation. Authentication and connection attempts have 30-second deadlines; rejected credentials still require attention. Update the connected machine to apply these recovery changes." },
        { tag: "Fixed", text: "Turn Remote connection off while connecting, errored, or waiting for enablement. Disabling aborts pending authentication and cancels recovery; late replies cannot turn it back on." },
        { tag: "Fixed", text: "Read failure messages in expanded generic tool responses while sensitive response details remain redacted." },
      ],
    })
  })

  test("retains v0.9.4 independent Claude profiles and native decisions", () => {
    expect(RELEASES[12]).toEqual({
      version: "0.9.4",
      date: "2026-10-07",
      title: "Independent Claude accounts and native decisions",
      tags: ["Added", "Changed"],
      changes: [
        { tag: "Added", text: "Connect several Claude accounts as independent named profiles. Model requests, token refresh, and subscription usage stay with the selected account, while the ordinary Claude CLI login remains separate." },
        { tag: "Added", text: "Use native OpenAI Decisions or TypeSafe Jev for bounded classification and scoring through the decision tool, with native answers, probabilities, and reported usage. These integrations require API keys rather than subscription authentication." },
        { tag: "Added", text: "Opt into decision policies for guardrail risk classification, initial agent/model routing, and goal continuation. Explicit selections, deterministic denials, and human-only hard reviews remain authoritative; automatic goal stopping records stopped, never completed." },
        { tag: "Changed", text: "Reconnect existing linked Claude profiles after upgrading to sign in to each account independently; profile names remain available. Claude account sign-in requires the claude executable on PATH." },
        { tag: "Added", text: "Enter an authorization code in the terminal while a capable browser sign-in attempt keeps polling. Each attempt accepts one manual submission; Escape cancels the pending attempt." },
      ],
    })
  })

  test("retains v0.9.3 remote navigation, attention refresh, transcript recovery, and terminal OAuth layout", () => {
    expect(RELEASES[13]).toEqual({
      version: "0.9.3",
      date: "2026-10-07",
      title: "Session navigation and attachment fixes",
      tags: ["Changed", "Fixed"],
      changes: [
        { tag: "Changed", text: "Use five remote destinations—Sessions, Conversation for the logo and new-session landing, Session for the selected transcript, Usage, and Settings. Session links use `/remote/session?session_id=<id>&device_id=<id>`; project plus buttons keep their repository and origin in the URL and lock repository choice, while Conversation lets you choose a repository. The Session breadcrumb has no New conversation action; drafts and reader position remain available when moving between routes." },
        { tag: "Fixed", text: "Keep first-prompt image and command file uploads intact when opening a newly created Session; opening the selected Session does not repeat the selection." },
        { tag: "Fixed", text: "Open System alerts on the owning active online machine, even without a notice ID; an unknown, revoked, or offline machine is unavailable and never falls back to the currently selected machine. Sign-in redirects retain the Session and device query." },
        { tag: "Fixed", text: "Match the Running and recent loading skeletons to the Session cards they replace, preserving the carousel's reserved layout." },
        { tag: "Fixed", text: "Ignore an older Session snapshot without a warning while preserving the live reply; report genuine snapshot read failures." },
        { tag: "Fixed", text: "Refresh cached connector attention after execution succeeds, fails, or is interrupted so resolved requests do not leave a Session marked Waiting for you; update the connected machine to apply the change." },
        { tag: "Fixed", text: "Center terminal OAuth authorization details so the authorization URL, instructions or code, waiting status, copy hint, and Escape control remain visible in short, narrow terminals." },
      ],
    })
  })

  test("retains v0.9.2 submitted prompt visibility", () => {
    expect(RELEASES[14]).toEqual({
      version: "0.9.2",
      date: "2026-10-06",
      title: "Keep submitted prompts visible",
      tags: ["Fixed"],
      changes: [
        { tag: "Fixed", text: "Keep submitted Web prompts and commands visible when an older pending-input refresh arrives after the send acknowledgement. Admission and promotion update the same bubble without duplicating or resending the input, and the composer keeps focus." },
      ],
    })
  })

  test("retains v0.9.1 Cursor models and machine-local Web diagnostics", () => {
    expect(RELEASES[15]).toEqual({
      version: "0.9.1",
      date: "2026-10-05",
      title: "Cursor models and machine-local Web diagnostics",
      tags: ["Added", "Changed"],
      changes: [
        { tag: "Added", text: "Inspect and copy anonymous Web latency timings in Settings, including local queue time, remote settlement time, and supported browser long tasks. While connected, bounded batches are saved in the selected machine's local SQLite for seven-day readout; the hosted relay does not store them. Update YCoding on the connected machine to enable saved reports; an older machine keeps the tab-local report and shows an unsupported state." },
        { tag: "Changed", text: "Cursor's request context follows YCoding project and global configuration for rules and available skills, and advertises only permitted subagents. Existing Cursor credentials and model execution remain available." },
        { tag: "Changed", text: "Choose Cursor context sizes as separate models, including 500k and 1M when offered, with low, medium, high, and xhigh effort choices. A saved variant label that Cursor no longer offers needs a fresh selection." },
        { tag: "Changed", text: "Choose models on the web from recent valid choices first, then the selected model's provider and remaining providers. Recents stay in this browser and do not change a Session's selected model." },
        { tag: "Changed", text: "Identify Claude Code subscription requests as CLI version 2.1.289 by default; an explicit version override still applies." },
      ],
    })
  })

  test("retains the v0.9.0 runtime and remote cutover", () => {
    expect(RELEASES[16]).toEqual({
      version: "0.9.0",
      date: "2026-10-04",
      title: "Reliable shell recovery and remote protocol v4",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "Reconcile verified background shells after a managed server crash and mark an owed completion notice as lost Session attention, without replaying the command. Process listing must be available to verify ownership." },
        { tag: "Changed", text: "Upgrade the remote connector and managed local server together for WebSocket v4, then refresh open browser tabs after the matching relay and web deployment. Older v3 clients cannot connect; existing device enrollment stays valid." },
        { tag: "Changed", text: "Update `ycoding api` operation IDs and permission/question event subscribers to the current unprefixed names; regenerate Client integrations. The old names have no aliases." },
        { tag: "Changed", text: "Use the semantic `theme` surface in custom TUI theme consumers. Built-in palettes retain their values, and selected endpoint actions have readable contrast." },
        { tag: "Changed", text: "Back up the local database before upgrading: inactive account/share tables are removed and a shell ledger is added. Rollback requires a backup if shell rows still need reconciliation." },
        { tag: "Changed", text: "`ycoding update --force` restarts the server after a failed outstanding-work read and reports that running work may be interrupted; without force, it leaves the server running." },
        { tag: "Changed", text: "Remove imports of the unproduced IDE event subpath and the non-resolving CLI daemon export; neither has a replacement alias." },
        { tag: "Fixed", text: "Describe local tool-result images to text-only models instead of forwarding unsupported image parts." },
        { tag: "Fixed", text: "Keep a rejected terminal shell command in the editor with explicit Retry and Discard choices, without replaying a second Enter." },
        { tag: "Fixed", text: "Keep repeated Conversation–Office switches and viewport changes from triggering virtual-row ResizeObserver loop errors." },
      ],
    })
  })

  test("retains the previous TUI release after v0.9.0", () => {
    expect(RELEASES[17]).toEqual({
      version: "0.8.12",
      date: "2026-10-03",
      title: "Large images and actionable input requests",
      tags: ["Changed", "Fixed"],
      changes: [
        { tag: "Fixed", text: "Fix valid large images being rejected when attached from the terminal or remote web. Resizing and existing attachment size limits remain enforced. Update the connected machine to apply this fix remotely." },
        { tag: "Changed", text: "Improve agent guidance to request missing information, decisions, and required reviews through actionable questions, so pending requests use the existing attention alerts instead of ending with a text-only request. Permission and guardrail approvals keep their existing rules." },
      ],
    })
    expect(RELEASES[18]).toEqual({
      version: "0.8.11",
      date: "2026-10-02",
      title: "Specific and reliable System alerts",
      tags: ["Added", "Fixed"],
      changes: [
        { tag: "Added", text: "Turn on System alerts from the notification center. When alerts cannot reach this device, the bell panel says why and offers Turn on System alerts or Re-enable." },
        { tag: "Fixed", text: "Reopen a Session whose edited-file changes are still loaded without crashing the terminal app." },
        { tag: "Fixed", text: "Name the Session and what it needs in every System alert, such as \"YCoding — approval needed\" with the Session title. Alerts cover permission requests, questions, guardrail reviews, guardrail blocks, failed runs, and finished work. Update the connected machine to include Session titles." },
        { tag: "Fixed", text: "Mark a notice read when you open its System alert." },
        { tag: "Fixed", text: "Stop a remote reconnect from alerting every failed Session again at once." },
        { tag: "Fixed", text: "Send one summary alert when more than 20 alerts arrive in a minute, instead of dropping the rest." },
        { tag: "Fixed", text: "Alert again when a Session with an unread notice needs something new, or at least 10 minutes after its last alert." },
        { tag: "Fixed", text: "Keep push alerts working after occasional delivery failures, and hold a work-finished push for up to an hour while the device is asleep." },
        { tag: "Fixed", text: "Show the alert from an open page when push does not confirm delivery, and keep shown alerts when the workspace reconnects to the same machine or closes." },
        { tag: "Fixed", text: "Alert on guardrail blocks while YCoding is closed." },
        { tag: "Fixed", text: "Keep a second YCoding connector on the same machine from repeatedly taking over the remote connection." },
        { tag: "Fixed", text: "Show \"YCoding — alerts paused\" when the browser drops push alerts for this device and they cannot be renewed." },
      ],
    })
    expect(RELEASES[19]).toEqual({
      version: "0.8.10",
      date: "2026-10-02",
      title: "Keep working while background tasks run",
      tags: ["Changed"],
      changes: [
        { tag: "Changed", text: "Keep working on the remaining tasks in the main session while a subagent or background shell is still running, instead of waiting idle until it finishes. Background work still notifies you when it completes." },
        { tag: "Changed", text: "Always choose a model variant when starting a subagent if that model offers variants. Match the variant to the task, and use a stronger variant only when the task needs it." },
      ],
    })
    expect(RELEASES[20]).toEqual({
      version: "0.8.9",
      date: "2026-10-02",
      title: "Skills follow the prompt that invokes them",
      tags: ["Fixed"],
      changes: [
        { tag: "Fixed", text: "Show a skill invoked with $skill directly after the prompt that requested it, from the landing screen and inside a Session, in the terminal, web, and model history. Update the connected machine to use this behavior remotely." },
        { tag: "Fixed", text: "Give an explicitly invoked skill the same content as a skill the agent loads itself: its name, instructions, base directory, and supporting files, so the agent can use the skill's references without loading it again." },
        { tag: "Fixed", text: "Show an invoked skill's Loaded row in the terminal transcript as soon as the skill activates." },
      ],
    })
    expect(RELEASES[21]).toEqual({
      version: "0.8.8",
      date: "2026-10-01",
      title: "Responsive prompts and reliable model selection",
      tags: ["Changed", "Fixed"],
      changes: [
        { tag: "Fixed", text: "Recover pending approval notifications when terminal notification support becomes ready, focus moves away, or the connection returns, without repeating a sound that already played." },
        { tag: "Fixed", text: "Keep permission and guardrail decisions visible while reviewing large commands. Command details scroll inside a bounded terminal panel instead of pushing approval choices off-screen." },
        { tag: "Fixed", text: "Choose agents and models on desktop and mobile even when the connected machine offers more than 500 models. Catalog failures show their reason and a Retry action." },
        { tag: "Fixed", text: "Keep the web and terminal composers editable while prompts are sending. Delivery outcomes and safe retries stay with the submitted message without erasing a newer draft. Retrying an admitted command reuses its original input without rerunning its template." },
        { tag: "Fixed", text: "Load explicitly invoked local $skill instructions in the runtime before the first model request across CLI, terminal, and web prompts, without relying on the model to choose a tool. Queued skills wait for their prompt, and configured permission denies stop activation." },
        { tag: "Changed", text: "Show web prompt delivery through a static receipt beneath the message instead of a loading animation beside its text." },
        { tag: "Changed", text: "Allow explicit shell timeouts up to one hour. The default remains ten minutes, and foreground commands still move to the background after five minutes." },
      ],
    })
    expect(RELEASES[22]).toEqual({
      version: "0.8.7",
      date: "2026-10-01",
      title: "Cursor cache reporting",
      tags: ["Fixed"],
      changes: [
        {
          tag: "Fixed",
          text: "Report Cursor's cache read and write as portions of the context total on the Usage rail, so a warm Cursor turn shows its cache hit percentage instead of leaving cache unreported. A real zero stays 0% and a step with no cache ratio stays unreported rather than showing zero.",
        },
      ],
    })
    expect(RELEASES[23]).toEqual({
      version: "0.8.6",
      date: "2026-10-01",
      title: "Quieter attention notifications",
      tags: ["Fixed"],
      changes: [
        {
          tag: "Fixed",
          text: "Keep one unread Needs your attention notice per Session across retries, reconnects, and relay restarts, instead of repeating alerts. Marking it read allows a fresh alert the next time that Session needs attention; other Sessions and work-completion notices stay independent.",
        },
      ],
    })
    expect(RELEASES[24]).toEqual({
      version: "0.8.5",
      date: "2026-10-01",
      title: "Machine memory and steadier Session status",
      tags: ["Fixed"],
      changes: [
        {
          tag: "Fixed",
          text: "Reconnect the workspace to the machine it last used after a reload, instead of asking again whenever more than one machine is online. An explicit disconnect or sign-out clears it.",
        },
        {
          tag: "Fixed",
          text: "Stop treating a connection heartbeat as a reconnect, so a Session's status dots and the running and recent lists are no longer cleared and re-read about twice a minute, and stored notices are not re-synced on each heartbeat.",
        },
      ],
    })
    expect(RELEASES[25]).toEqual({
      version: "0.8.4",
      date: "2026-10-01",
      title: "Forced update restarts and steadier Session catalogs",
      tags: ["Added", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Restart the background server while Sessions are running with `ycoding update --force` (`-f`), which reports how many running Sessions it interrupted.",
        },
        {
          tag: "Fixed",
          text: "Keep the composer's agent and model pickers usable: a connection heartbeat is no longer mistaken for a reconnect, so the Session catalog is kept while connected, and a missing catalog is requested again.",
        },
        {
          tag: "Fixed",
          text: "Report in `ycoding update` how many Sessions are actually running, instead of counting every Session with queued input, an undelivered subagent notice, or an active goal.",
        },
        {
          tag: "Fixed",
          text: "Settle a Session whose execution was ended by a stopped server as interrupted on the next start and raise attention, instead of leaving it silently reading as idle. It is never resumed or retried automatically.",
        },
      ],
    })
    expect(RELEASES[26]).toEqual({
      version: "0.8.3",
      date: "2026-10-01",
      title: "Cursor models and quotas",
      tags: ["Added", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Report Cursor plan quotas on the Usage screen: the Included, Auto, and API share of the current billing period, when it resets, and the plan name beside the provider label.",
        },
        {
          tag: "Fixed",
          text: "List the models of a connected Cursor account even when it was connected by another YCoding process or before the provider started listening for connection changes.",
        },
        {
          tag: "Fixed",
          text: "Keep the Cursor models already published when a later model sync fails, and retry that sync, instead of emptying the model list until the next connection change.",
        },
        {
          tag: "Fixed",
          text: "Keep the model and agent pickers usable for a Session whose catalog read failed, because the failed read is retried on the next selection instead of being kept as the answer.",
        },
      ],
    })
    expect(RELEASES[27]).toEqual({
      version: "0.8.2",
      date: "2026-10-01",
      title: "Cursor provider",
      tags: ["Added"],
      changes: [
        {
          tag: "Added",
          text: "Run models from a Cursor subscription through the built-in cursor provider, connected by Cursor browser sign-in, a crsr_ API key, or CURSOR_API_KEY; use it only with a Cursor account you own.",
        },
        {
          tag: "Added",
          text: "Discover the account's Cursor models with effort, thinking, and Fast choices as variants, long-context models as separate 1M entries, and separately priced Fast entries for Composer and Grok.",
        },
        {
          tag: "Added",
          text: "Run Cursor models with YCoding's own tools, permissions, and guardrails, report failed or rejected tool results to Cursor as errors, and leave usage Cursor does not report unreported.",
        },
      ],
    })
    expect(RELEASES[28]).toEqual({
      version: "0.8.1",
      date: "2026-10-01",
      title: "Instant remote view transitions",
      tags: ["Changed"],
      changes: [
        {
          tag: "Changed",
          text: "Admit 120 browser requests per 10 seconds on the relay so opening a Session and visiting Usage and Settings never queue behind the request window.",
        },
        {
          tag: "Changed",
          text: "Render Usage, Settings, and New session at once while their reads are in flight and keep the previous data visible during a refresh instead of showing a blank panel.",
        },
        {
          tag: "Changed",
          text: "Key Usage reads by day and time zone and keep them fresh for a minute, so returning to Usage shows the cached report immediately and refreshes it in the background.",
        },
        {
          tag: "Changed",
          text: "Preload a remote view's reads on hover, focus, or touch of its navigation link, and warm up Usage, keep-awake, and workspace reads once the selected Session is ready.",
        },
        {
          tag: "Changed",
          text: "Show the loading placeholder on a cold load until the Session list arrives instead of flashing the New session composer, and drop duplicate workspace and Session list reads.",
        },
      ],
    })
    expect(RELEASES[29]).toEqual({
      version: "0.8.0",
      date: "2026-10-01",
      title: "Multiplexed remote delivery and windowed transcripts",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Carry control frames, per-Session event batches, and large reads on one relay connection so one Session's stream or long read never blocks another; cancel reads you leave and let the visible Session win while a tab is in the background.",
        },
        {
          tag: "Added",
          text: "Mount only the transcript and Session rows near the reader, keep the visible row in place when paging older history, and keep focus on the focused row through scrolling.",
        },
        {
          tag: "Added",
          text: "Report each window's Space placement in desktop.list and name the exact cause of an off-Space staging failure.",
        },
        {
          tag: "Changed",
          text: "Build the web app on TanStack Router, Store, Query, Virtual, and Pacer with the same URLs; discard connection-scoped reads when the connection ends and pace scroll, resize, and composer work.",
        },
        {
          tag: "Changed",
          text: "Choose reasoning effort on a fluid pill slider whose fill follows the pointer live and snaps to the nearest offered effort, with reduced motion removing the animation.",
        },
        {
          tag: "Changed",
          text: "Show a filled accent bolt while the paired fast model is active and a muted outline bolt otherwise.",
        },
        {
          tag: "Changed",
          text: "Settle /compact from the compaction job's durable completion or failure instead of a request timeout, so a long compaction shows no timeout warning while it runs.",
        },
        {
          tag: "Changed",
          text: "Offer only a model's own effort variants everywhere, report models without variants as having none, and reject an effort the model does not offer.",
        },
        {
          tag: "Changed",
          text: "Reload every open remote tab or installed web app after deployment; the relay protocol adds frames the previous client does not accept.",
        },
        {
          tag: "Fixed",
          text: "Switch to a model without effort variants without blocking the composer with a saved-effort warning.",
        },
        {
          tag: "Fixed",
          text: "Show the phone image lightbox as a fixed-height sheet with the caption and close controls at the top and the image fitting within it.",
        },
        {
          tag: "Fixed",
          text: "Keep a loaded tool image mounted when the first text of its assistant message arrives.",
        },
        {
          tag: "Fixed",
          text: "Keep computer-use desktop revisions stable across decorative Accessibility frame drift so a mutation issued a few seconds after its inspect is accepted.",
        },
      ],
    })
  })

  test("retains the 0.7.18 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.18")).toEqual({
      version: "0.7.18",
      date: "2026-09-30",
      title: "Stable model choices, recoverable changes, and Keep Awake",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Keep machine awake from the TUI command palette or web Settings → Machine on macOS; the control starts off and lasts until the backend stops.",
        },
        {
          tag: "Added",
          text: "Compact the selected Session's context with /compact in the remote composer without sending an ordinary prompt.",
        },
        {
          tag: "Added",
          text: "Let idle Office agents play table tennis, with new work interrupting play and reduced motion using still poses.",
        },
        {
          tag: "Changed",
          text: "Enter Sessions at the top and Conversation at the latest message; preserve per-Session reading positions when switching inside Conversation.",
        },
        {
          tag: "Changed",
          text: "Sort Session lists and Running and recent by running families first, then latest reported activity, without pin priority overriding activity order.",
        },
        {
          tag: "Changed",
          text: "Use compact Team cards, named subagent navigation, and icon controls for New session and the Conversation–Office switch.",
        },
        {
          tag: "Changed",
          text: "Keep subagent chats compact on phones, with task and usage details in a sheet and waiting questions directly answerable.",
        },
        {
          tag: "Changed",
          text: "Use neutral icon-control borders and focus indicators while retaining visible keyboard focus.",
        },
        {
          tag: "Changed",
          text: "Use shared design-system cursor roles for actions, text, disabled and busy controls, sliders, image expansion, and Office panning.",
        },
        {
          tag: "Changed",
          text: "Use self-hosted Geist Sans and Geist Mono in the web app and embedded Geist fonts in the Chrome extension, without changing terminal font settings.",
        },
        {
          tag: "Changed",
          text: "Reload web tabs and installed web apps after this update's one-time push-registration reset; save drafts first and restore Push to this device in Settings if needed.",
        },
        {
          tag: "Changed",
          text: "Show agent-name headings on text replies rather than tool- or reasoning-only blocks.",
        },
        {
          tag: "Changed",
          text: "Mark a sending prompt with a small ring instead of a success toast; keep failed and uncertain send feedback and retry controls.",
        },
        {
          tag: "Changed",
          text: "Move push test alerts from Settings to an admin-authenticated API targeting one registered account and browser subscription.",
        },
        {
          tag: "Fixed",
          text: "Raise Work finished only after an explicit completion declaration and successful final settlement, not an ordinary reply or idle status; prevent duplicate notices after reconnects.",
        },
        {
          tag: "Fixed",
          text: "Count live background shells as running in Session lists and Team, while excluding settled shells from running activity.",
        },
        {
          tag: "Fixed",
          text: "Inspect and answer pending family guardrail reviews from the current Session, keep phone actions reachable, and preserve human-only approval rules.",
        },
        {
          tag: "Fixed",
          text: "Recover silent remote connections and check connectivity when returning to the app or network, without automatically replaying actions.",
        },
        {
          tag: "Fixed",
          text: "Recognize ycoding service commands, including restart, in the installed executable instead of treating service as a repository directory.",
        },
        {
          tag: "Fixed",
          text: "Load resources from an active skill after an earlier compaction or agent switch, retaining path and permission checks.",
        },
        {
          tag: "Fixed",
          text: "Answer the specific waiting subagent question from the TUI Enter answer field, and expose waiting questions without requiring the parent's sidebar.",
        },
        {
          tag: "Fixed",
          text: "Wait for Office's initial family state before placing agents and retain their positions through background reads and navigation.",
        },
        {
          tag: "Fixed",
          text: "Retain displayed transcript, todo, Team content, and reported usage during background refreshes instead of briefly clearing them.",
        },
        {
          tag: "Fixed",
          text: "Keep streaming code and refreshed file controls mounted so focus, open diffs, and the visible reading position survive updates.",
        },
        {
          tag: "Fixed",
          text: "Retain available TUI captured files when a child transcript read fails, label incomplete totals, and offer targeted retry.",
        },
        {
          tag: "Fixed",
          text: "Restore each model's valid effort when switching back and forth, follow confirmed Session selections on ordinary sends, and keep models without effort variants from inheriting another model's effort.",
        },
      ],
    })
  })

  test("retains the 0.7.16 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.16")).toEqual({
      version: "0.7.16",
      date: "2026-09-29",
      title: "Scoped file changes, compact controls, and visible browser control",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Show a control indicator, marked tab title, and action cursor in paired Chrome, with exclusive control of each profile tab by one Session.",
        },
        {
          tag: "Added",
          text: "Keep shared Session notices until read, synchronize dismissals across browsers viewing the same machine, and load older stored notices on demand.",
        },
        {
          tag: "Added",
          text: "Add Send test alert and Re-enable in Settings to check push-service acceptance and restore an expired device subscription.",
        },
        {
          tag: "Changed",
          text: "Give Office varied personal desks, lounge seating, a meeting area and a coffee corner, with a readable opening scale, floor panning and a Fit view that survives resize.",
        },
        {
          tag: "Changed",
          text: "Keep Sessions, Conversation, Usage and Settings navigation; move Team into the header, float jump controls, collapse Edited files, and hide the extra healthy-connection row.",
        },
        {
          tag: "Changed",
          text: "Keep captured changes with each prompt's reply, aggregate repeated edits by file, and attribute resumed subagent work to the request that dispatched it.",
        },
        {
          tag: "Changed",
          text: "Keep the user's Git author and committer identity, omit co-author trailers, and report a missing identity instead of inventing one.",
        },
        {
          tag: "Changed",
          text: "Sign macOS computer-use apps with a stable release identity so future signed updates can retain privacy grants.",
        },
        {
          tag: "Fixed",
          text: "Add Close to composer suggestions, bound the popup to available space, and dismiss without changing the draft or immediately reopening it.",
        },
        {
          tag: "Fixed",
          text: "Keep full provider totals and long names inside Usage cards, with one provider legend instead of a duplicate table.",
        },
        {
          tag: "Fixed",
          text: "Apply System switches to closed-app pushes, preserve choices during registration and across Settings tabs, and report Machine offline only after a confirmed outage.",
        },
        {
          tag: "Fixed",
          text: "Keep goal setup nonblocking, confirm only its own successful response, and restore failed or uncertain objectives without overwriting newer drafts.",
        },
        { tag: "Fixed", text: "Show a Session whose last run failed as Failed rather than waiting for your decision." },
        {
          tag: "Fixed",
          text: "Preserve typed Anthropic tool arguments for union-root schemas, referenced branches and root constraints.",
        },
        {
          tag: "Fixed",
          text: "Accept the files each update needs, retain the archive layout supported by installed updaters, and report the local helper's actual signing identity.",
        },
      ],
    })
  })

  test("retains the 0.7.15 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.15")).toEqual({
      version: "0.7.15",
      date: "2026-09-29",
      title: "Outcome toasts below the header and exact agent edits",
      tags: ["Fixed"],
      changes: [
        {
          tag: "Fixed",
          text: "Show outcome and notification toasts below the header and Team row, and close outcome toasts after about six seconds unless hovered or focused, as notification toasts do.",
        },
        {
          tag: "Fixed",
          text: "Insert agent edit replacement text exactly as written, so dollar-sign replacement patterns no longer corrupt the edited file.",
        },
      ],
    })
  })

  test("retains the 0.7.14 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.14")).toEqual({
      version: "0.7.14",
      date: "2026-09-29",
      title: "Installable app, restored pending prompts, and Work finished alerts for the whole Session family",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Install the remote workspace as an app from Settings → App, with browser install dialogs in Chrome and Edge and Home Screen or Dock steps in Safari.",
        },
        {
          tag: "Added",
          text: "Keep accepted prompts across a reload or reconnect, with Processing and Queued labels, Retry send on failed or unknown sends, and dismissible outcome toasts.",
        },
        {
          tag: "Changed",
          text: "Relicense YCoding under AGPL-3.0-only, keep the upstream MIT notice in NOTICE, and ship LICENSE and NOTICE in release archives and the CLI, AI, and client npm packages.",
        },
        {
          tag: "Changed",
          text: "Reduce notification settings to Work finished, Needs your attention, and Machine offline, with Work finished waiting for subagents, background shells, and goals to finish.",
        },
        {
          tag: "Changed",
          text: "Redesign Office as one open floor with a block per agent, show Edited files once a Session stops, show Last active on Running and recent cards, and fade the Workspaces list while more are below.",
        },
        {
          tag: "Changed",
          text: "Have built-in agents commit only when a task, phase, or complete piece of functionality is finished, and cache the app's fingerprinted assets for a year.",
        },
        {
          tag: "Changed",
          text: "Restart an idle background server after ycoding update, and leave a busy one running until you run ycoding service restart.",
        },
        {
          tag: "Fixed",
          text: "Let remote goal setup finish with a Setting goal status, keep Retrying limited to the retrying assistant step, and retry failed machine status reads so running state and Work finished alerts stay current.",
        },
        {
          tag: "Fixed",
          text: "Keep the machine connected during busy Sessions instead of closing on the relay's message rate limit.",
        },
        { tag: "Fixed", text: "Return keyboard focus to the opening button when any dialog or sheet closes." },
        {
          tag: "Fixed",
          text: "Neutralize the light-mode landing hero, sharpen light composer edges, fill tall landing pages, and tidy the phone Team sheet and Settings.",
        },
      ],
    })
  })

  test("retains the 0.7.13 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.13")).toEqual({
      version: "0.7.13",
      date: "2026-09-29",
      title: "Invite links with access keys, matching file-change counts, and honest generation speeds",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Join a remote workspace from a single-use invite link, then sign in on your other devices with the access key it gives you.",
        },
        {
          tag: "Changed",
          text: "Show slim, brand-styled scrollbars in desktop browsers, and keep room for them so remote content no longer shifts when one appears.",
        },
        {
          tag: "Fixed",
          text: "Match Edited files counts to the changes you expand in remote Conversation and the TUI, include completed subagent edits, and fill the full Conversation width.",
        },
        {
          tag: "Fixed",
          text: "Hide generation speeds measured from a single burst instead of showing impossible values such as 30,000 tok/s.",
        },
      ],
    })
  })

  test("retains the 0.7.12 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.12")).toEqual({
      version: "0.7.12",
      date: "2026-09-29",
      title: "File changes in remote Conversation, side-by-side diffs, and goals that decide for you",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "See an Edited files card in remote Conversation and expand a file for its latest change side by side, and read captured TUI changes side by side on wide terminals.",
        },
        {
          tag: "Added",
          text: "Set a goal with /goal, change autonomy with /yolo, and load a slash skill from the remote composer, as in the TUI.",
        },
        {
          tag: "Changed",
          text: "Let goal mode make open decisions on your behalf until the goal is satisfied, while reviews that require a human still come to you.",
        },
        {
          tag: "Changed",
          text: "Collapse the Sessions sidebar to a narrow strip that reopens it, show the loaded count beside the workspace title, keep the installed app from zooming, and give the desktop app icon a small margin.",
        },
        {
          tag: "Fixed",
          text: "Open the Autonomy level and Goal panels next to their controls, show the Goal control without empty space, and reject remote agent mentions the TUI would not offer.",
        },
        {
          tag: "Fixed",
          text: "Keep the Sessions page still when Running and recent loads, and scroll Settings from the window edge on wide screens.",
        },
      ],
    })
  })

  test("retains the 0.7.11 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.11")).toEqual({
      version: "0.7.11",
      date: "2026-09-28",
      title: "Speed and context in the remote composer, visible image attachments, and steadier remote views",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "See the latest generation speed and a context-window ring beside the model in the remote composer, with a context bar in the phone model picker, and see generation speed in the TUI sidebar.",
        },
        {
          tag: "Added",
          text: "See compactions as dividers with Session-wide totals in remote Conversation, and switch a model to its fast counterpart with the lightning toggle.",
        },
        {
          tag: "Changed",
          text: "Keep the remote workspace mounted while you move between views, start Conversation history at the latest completed compaction like the TUI, and leave New session without a close button.",
        },
        {
          tag: "Changed",
          text: "Animate pickers, sheets, dialogs, the notification center, and composer panels in and out, hide the Sessions sidebar at tablet widths, and give each effort level its own color.",
        },
        {
          tag: "Fixed",
          text: "Show attached images as thumbnails instead of a tiny mark, attach large images from an iPhone, and offer Retry for an image that has not loaded after two minutes.",
        },
        {
          tag: "Fixed",
          text: "Name the Session in each in-app notice, keep Team and Office subagents shown during refreshes, and keep Session rows, the carousel, and the todo panel steady while they update.",
        },
        {
          tag: "Fixed",
          text: "Show desktop alerts before the service worker is ready, load Usage after switching machines, stop the notification center from flickering, and pad the installed app and Home Screen icon.",
        },
        {
          tag: "Fixed",
          text: "Send TUI notifications before the terminal reports focus, clear the composer after /goal, label only cancelled tool calls as cancelled, and read local skill files through the skill tool.",
        },
      ],
    })
  })

  test("retains the 0.7.10 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.10")).toEqual({
      version: "0.7.10",
      date: "2026-09-28",
      title: "Machine-wide remote connection, Running and recent Sessions, and local-time Usage",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Choose the active machine and remove revoked devices from remote Settings, reopen Activity on your last Session after a reload, and hide the desktop Sessions sidebar.",
        },
        {
          tag: "Added",
          text: "Switch remote Usage between UTC and local time, and see loading placeholders instead of blank areas while the remote workspace loads.",
        },
        {
          tag: "Changed",
          text: "Keep the remote connection in the machine's background server so it stays on with no TUI open; every TUI, ycoding remote connect, and the new ycoding remote disconnect switch the same connection, and the server log records its diagnostics.",
        },
        {
          tag: "Changed",
          text: "Show up to ten running and recently active Sessions in the Running and recent carousel, pin Conversation, Office, and Team above the scrolling workspace, and set autonomy and goals only from the Conversation status.",
        },
        {
          tag: "Changed",
          text: "Move Office characters more calmly without emote icons, center the New session screen under the full logo, and show each alert once through the site's service worker.",
        },
        {
          tag: "Fixed",
          text: "Load attachments of waiting prompts, open the Session chosen from New session, and show Sessions as running while their subagents work.",
        },
        {
          tag: "Fixed",
          text: "Keep the remote status timer to the current run and clear it after a reconnect, stop repeating the YOLO level on phones, and restore dropped push subscriptions.",
        },
        {
          tag: "Fixed",
          text: "Show Device disconnected only when the selected machine goes offline, not when this browser's relay connection drops; the connection strip keeps the latest drop's code and reason.",
        },
      ],
    })
  })

  test("retains the 0.7.9 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.9")).toEqual({
      version: "0.7.9",
      date: "2026-09-28",
      title: "Remote Team panel, live Office activity, and TUI workspaces",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Manage every directory YCoding knows from the TUI with Manage workspaces: open one for your next Session, delete a project copy, or forget a directory and its Sessions.",
        },
        {
          tag: "Added",
          text: "Refresh models and providers from the TUI command palette to pick up new project configuration and provider models without restarting.",
        },
        {
          tag: "Added",
          text: "Manage a Session's subagents, shells, and side chats from the new remote Team panel on desktop, tablet, and phone.",
        },
        {
          tag: "Changed",
          text: "Turn remote access on and off with one Remote connection toggle in the TUI command palette, marked green when on and grey otherwise, instead of a bottom status line.",
        },
        {
          tag: "Changed",
          text: "Open subagents read-only in the remote Conversation with Main, Previous, and Next navigation; side chats still accept prompts.",
        },
        {
          tag: "Changed",
          text: "Show what each Office character is actually doing, keep the main agent in the Lounge while only its subagents work, and show Office only on tablets and desktops.",
        },
        {
          tag: "Changed",
          text: "Swipe through running Sessions in a carousel, keep the Conversation sidebar on the open Session's workspace, and let the agent read local skill files by absolute path.",
        },
        {
          tag: "Fixed",
          text: "Stop remote images and Usage cards from flickering, keep the Office scene when you select a teammate, and show only matching Sessions while searching.",
        },
      ],
    })
  })

  test("retains the 0.7.8 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.8")).toEqual({
      version: "0.7.8",
      date: "2026-09-27",
      title: "Paged remote history, images, and TUI remote toggle",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Turn remote access on and off from the TUI command palette, with an always-visible remote status line.",
        },
        {
          tag: "Added",
          text: "Load long remote conversations in pages as you scroll up, and open attached and tool images as thumbnails with a full-size view.",
        },
        {
          tag: "Added",
          text: "See every running Session from all workspaces at the top of the remote Sessions page, and exact values on the Usage charts.",
        },
        {
          tag: "Changed",
          text: "Move Office characters to the room for their current work, send idle characters to the Lounge, and fill the canvas with the office.",
        },
        {
          tag: "Changed",
          text: "Widen the remote transcript with Jump to top and Jump to latest on its edge, and fit phones with a one-row icon bar, a bottom Sessions sheet, and an agent and model row above the composer.",
        },
        {
          tag: "Changed",
          text: "Hide completed todo lists and Session-state notices as the TUI does, keep Usage rows in place while pages load, and list local Today spend after provider quotas in the TUI.",
        },
        {
          tag: "Fixed",
          text: "Keep Sessions usable when an attached file's stored copy changes, a file's format is unsupported by the provider, or a plugin hook fails.",
        },
        {
          tag: "Fixed",
          text: "Carry the landing screen's YOLO level and goal into the new Session, and load long remote conversations without disconnecting.",
        },
        {
          tag: "Fixed",
          text: "Show one notice per stopped Session, catch up on alerts missed while disconnected, keep push alerts working, and fix pending-prompt alignment and the blank Office on phones.",
        },
      ],
    })
  })

  test("retains the 0.7.7 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.7")).toEqual({
      version: "0.7.7",
      date: "2026-09-27",
      title: "Remote attachments, todo list, and notifications",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Attach files to remote prompts by pasting, choosing, or dropping them on the composer, up to 20 MiB each, with previews, upload progress, and cancel.",
        },
        {
          tag: "Added",
          text: "See the selected Session's todo list above the remote composer, collapsed to a progress summary until you expand it.",
        },
        {
          tag: "Added",
          text: "Keep reading while a remote reply streams, return with Jump to latest, and move between your prompts from a rail on wide screens.",
        },
        {
          tag: "Added",
          text: "Get new in-app notices as brief toasts, and sort through a notification center grouped by day with read marks, Mark all read, and Clear all.",
        },
        {
          tag: "Changed",
          text: "Use a floating remote composer with agent, model, effort, status, and Steer or Queue controls, and rounded controls throughout the remote workspace.",
        },
        {
          tag: "Changed",
          text: "Show subagent notices as compact rows, and redesign the Usage page with quota cards, spend tiles, charts, and a sortable breakdown.",
        },
        {
          tag: "Changed",
          text: "Make motion on the public site, documentation, and changelog more noticeable while respecting reduced motion.",
        },
        {
          tag: "Fixed",
          text: "Show running Sessions as running when a machine keeps Sessions from deleted folders, name workspaces by folder instead of “..”, and stop the Office list from flickering or losing subagents.",
        },
        {
          tag: "Fixed",
          text: "List every remote autocomplete match, keep TUI autocomplete scrolling in place, and keep the remote composer's height steady on hover and focus.",
        },
      ],
    })
  })

  test("retains the 0.7.6 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.6")).toEqual({
      version: "0.7.6",
      date: "2026-09-27",
      title: "Remote usage, composer, and push alerts",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Open the remote Usage page to see each provider's quota meters, reset countdowns, and pace, spend for today, yesterday, and 30 days, a daily chart, and sortable breakdowns by model, Session, project, and agent.",
        },
        {
          tag: "Added",
          text: "See the OpenRouter credit balance, Copilot AI credits, and Grok, OpenCode Go, and Z.ai quotas in the TUI and on the web, plus a separately labeled YCoding local Today spend.",
        },
        {
          tag: "Added",
          text: "Start a remote Session from a composer with a repository, agent, model, and first prompt, and autocomplete commands, files, agents, references, and skills while you type.",
        },
        {
          tag: "Added",
          text: "Get push alerts in a closed browser or installed app when a Session needs your decision or stops running, and review recent alerts in the notification center.",
        },
        {
          tag: "Added",
          text: "Follow the autonomy level, current activity, elapsed time, and active goal in a status bar above the remote composer.",
        },
        { tag: "Added", text: "Animate the public site, documentation, and changelog, respecting reduced motion." },
        {
          tag: "Changed",
          text: "List workspaces by name in a Sessions sidebar and show top-level Sessions 25 at a time, running first, then pinned, then most recent.",
        },
        {
          tag: "Changed",
          text: "Render remote replies as Markdown with collapsible thinking and tool rows, and show only your text in prompt bubbles.",
        },
        {
          tag: "Changed",
          text: "Show only the selected Session's family in the Office, with unique names, an Agents list, and an icon toolbar.",
        },
        {
          tag: "Changed",
          text: "Replace bare dashes in TUI usage views with Unknown or No usage yet, and remove the ntfy tool and configuration.",
        },
        {
          tag: "Fixed",
          text: "Skip compaction that cannot bring a request under the model's context window, reload Usage after the connection changes, and keep the desktop header inside the window at 1024–1279 px.",
        },
      ],
    })
  })

  test("retains the 0.7.5 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.5")).toEqual({
      version: "0.7.5",
      date: "2026-09-27",
      title: "Office view, context breakdown, and usage sorting",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Switch the remote workspace to Office to see the selected Session, other loaded Sessions, and its reported subagents as characters in a pixel office with CEO, Developer, Research, QA, Meeting, Relax, and entrance areas.",
        },
        {
          tag: "Added",
          text: "Office characters work in the room for their responsibility, relax in the lounge when idle, enter and leave through the entrance, and walk to live briefings and reports without replaying history.",
        },
        {
          tag: "Added",
          text: "Open context breakdown from the TUI command palette to see latest-request stats and an estimated split of the context window across system, tools, user, assistant, reasoning, tool calls, and other content.",
        },
        { tag: "Added", text: "Sort every TUI usage table by any column by clicking its header or pressing its key." },
        { tag: "Added", text: "Connect Chrome from the landing command palette." },
        { tag: "Changed", text: "Group remote Sessions by workspace and load 50 rows at a time as you scroll." },
        {
          tag: "Changed",
          text: "Show remote prompts as right-aligned bubbles with Read after consumption, compact reasoning sections, and compaction-aware history.",
        },
        {
          tag: "Changed",
          text: "Show every TUI cost estimate as a dollar amount, counting unpriced requests as $0.00.",
        },
        {
          tag: "Changed",
          text: "Remove the live SHELLS sidebar section; running shells remain in the composer's shell tab.",
        },
        {
          tag: "Changed",
          text: "Open Usage from the landing footer with leader+Shift+U and apply a pending model choice when /goal starts or resumes a goal.",
        },
        {
          tag: "Fixed",
          text: "Report a machine offline when the relay has no local agent for the workspace read, and widen the desktop machine selector without wrapping names.",
        },
      ],
    })
  })

  test("retains the 0.7.4 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.4")).toEqual({
      version: "0.7.4",
      date: "2026-09-26",
      title: "Remote request pacing and readable machine names",
      tags: ["Fixed"],
      changes: [
        {
          tag: "Fixed",
          text: "Pace remote requests within relay rate limits so large Session inventories can load without a client-rate policy disconnect; the workspace still loads the complete inventory.",
        },
        {
          tag: "Fixed",
          text: "Stop superseded Session list reads before fetching more pages and discard unsent requests when their connection closes, without replaying mutations.",
        },
        {
          tag: "Fixed",
          text: "Wrap long machine names instead of truncating them and use compact picker text on desktop and phones while preserving keyboard controls and mobile confirmation.",
        },
      ],
    })
  })

  test("retains the 0.7.3 release content", () => {
    expect(RELEASES.find((item) => item.version === "0.7.3")).toEqual({
      version: "0.7.3",
      date: "2026-09-26",
      title: "Remote sessions and background desktop control",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        {
          tag: "Added",
          text: "Create remote Sessions from previously opened repositories, including directories without a Session; check uncertain creation results with the same Session identity.",
        },
        {
          tag: "Added",
          text: "Control macOS windows in the background and stage supported off-Space windows on a private agent display for pixel input and capture. Unstage restores the frame on the main display's current Space.",
        },
        {
          tag: "Added",
          text: "Control Safari and Chrome tabs through native automation; JavaScript evaluation and Safari history/reload require Allow JavaScript from Apple Events.",
        },
        {
          tag: "Added",
          text: "Control supported Electron windows through a process-owned debug bridge, with explicit debug-enabled relaunch when needed. Relaunch leaves a localhost debug port open until quit; graceful quit preserves unsaved-work prompts.",
        },
        {
          tag: "Added",
          text: "Show a separate YCoding cursor and click ripple for Chrome agent interactions without moving the system pointer.",
        },
        {
          tag: "Added",
          text: "Pin Sessions on the backend so every TUI and the web remote client list the same pins first; the TUI moves existing local pins to the backend once on first start.",
        },
        {
          tag: "Added",
          text: "Show a download progress bar and the verification and installation steps during ycoding update.",
        },
        {
          tag: "Changed",
          text: "Breaking Change: local HTTP integrations must use an Authorization: Basic header with username ycoding and the configured password; auth_token query parameters no longer authenticate requests.",
        },
        {
          tag: "Changed",
          text: "Skip guardrail review prompts for browser and desktop actions while preserving explicit denials, tool permissions, and required operating-system or site authorization.",
        },
        {
          tag: "Changed",
          text: "Confirm phone machine changes before switching connections; keep tablet navigation visible and let the conversation sidebar collapse and reopen.",
        },
        {
          tag: "Changed",
          text: "Redesign usage reports and Stats: label project rows with project name and worktree, keep token columns on one line, drop cost suffixes, sort name views by tokens, and render a colored Stats graph with summary stats.",
        },
        {
          tag: "Fixed",
          text: "Open existing remote Sessions directly in Conversation, retain drafts across remote-page navigation and same-machine reconnects, and keep late creation results from changing a dismissed dialog's route.",
        },
        {
          tag: "Fixed",
          text: "Keep Chrome pairing codes visible and recover saved pairings after browser or YCoding restarts without another code; reload the extension after updating.",
        },
        {
          tag: "Fixed",
          text: "Restore Daybreak discovery, show active model state, and apply landing-screen selections before the first prompt or goal.",
        },
        {
          tag: "Fixed",
          text: "Preserve alternative provider tool argument shapes, validate JSON-encoded browser actions, and improve off-Space Electron capture and window placement.",
        },
        {
          tag: "Fixed",
          text: "Enforce read approval for file-search contents, reject search-root symlink escapes, and approve each web-fetch redirect destination with a ten-redirect limit.",
        },
        {
          tag: "Fixed",
          text: "Keep tablet header hit targets separate, contain mobile picker keyboard focus, and align the landing divider with the content grid.",
        },
        {
          tag: "Fixed",
          text: "Click and scroll hidden Chrome tabs with page scripts without activating them. Scripted actions cannot open popups, use the clipboard, or open file pickers.",
        },
        {
          tag: "Fixed",
          text: "Keep answers delivered only in a Responses completion payload without duplicate text or tool calls, recover post-output provider failures from durable history, and explain hidden provider errors by category.",
        },
      ],
    })
  })

  test("retains the 0.7.2 and earlier release content", () => {
    const release072 = RELEASES.find((item) => item.version === "0.7.2")
    expect(release072).toMatchObject({
      version: "0.7.2",
      date: "2026-09-26",
      title: "Provider compaction, remote sign-in, and agent-readable docs",
      tags: ["Added", "Changed", "Fixed"],
    })
    expect(release072?.changes.map((change) => change.text)).toEqual([
      "Run provider-native compaction on the owner request with a bounded local fallback; persist private compaction items across model switches; enable Copilot Responses compaction and Claude Chat cache markers.",
      "Ship the ad-hoc signed YCoding Computer Use app beside release executables; resolve desktop windows by CG window ID, probe other Spaces, and request Accessibility/Screen Recording/Automation access. Re-allow the app in Privacy & Security after each update; clear com.apple.quarantine on browser-downloaded archives.",
      "Install and update the paired Chrome extension alongside the CLI release with a fixed manifest public key.",
      "Show provider usage by profile in the TUI: one quota snapshot per stored credential profile, hide providers without usable credentials, render unreported values as '-'. Add built-in git worktree guidance to core instructions.",
      "Sign in to the remote workspace from a dedicated OAuth screen (Google); read the documentation as Markdown for AI agents at /llms.txt, /llms-full.txt, and /docs/<page>.md.",
      "Agents search workspace memory before substantive work and save verified durable facts afterward.",
      "Remove standard hard guardrail reviews for desktop access, Chrome owned opens, and Chrome profile mutations; site permissions and custom rules still apply.",
      "Scope prompt_cache_key per Session on key-carrying routes while keeping shared ledger namespace; OpenRouter Responses replay reasoning under the openai metadata key; request encrypted reasoning for GPT-5.6+.",
      "Redesign the remote workspace around one conversation column with pending requests after the transcript, one composer box, and hard reviews marked Human only; an offline machine keeps its last session list read-only.",
      "Rewrite every documentation page with exact commands, full configuration examples, and verification steps on one aligned layout.",
      "Send tool result images and files as provider-native content; reusing a prompt message ID returns the first admitted record instead of failing.",
      "Avoid deadlock when a child asks its parent during session coordination; keep shell sidebar accurate for fast exits and unloaded owners.",
    ])
    const previous = RELEASES.find((item) => item.version === "0.7.1")
    expect(previous).toMatchObject({
      date: "2026-09-25",
      title: "Chrome and desktop control",
      tags: ["Added", "Changed", "Fixed"],
    })
    expect(previous?.changes.map((change) => change.text)).toEqual([
      "Pair Chrome from the Mini or full Session and use eligible open tabs, including the active tab.",
      "Open Session-owned background Chrome tabs and group or ungroup eligible inactive profile tabs.",
      "Inspect, capture, and control one targeted macOS app window with Accessibility and Screen Recording authorization.",
      "Record Runpod Ollama cached-input and request-timing diagnostics in Session usage when reported by the worker.",
      "Select refreshed Muse Spark models, including the 1.3 contributor entry, with updated catalog pricing.",
      "Read and capture paired Chrome tabs with site permission but without a hard access review; profile mutations still require hard human review.",
      "Use isolated browsing with installed Chrome 152 or newer on macOS arm64.",
      "Use the GSD agent for direct or delegated delivery with verification.",
      "Install or update the macOS CLI with a signed computer-helper app and replacement rollback.",
      "Keep model-visible tool definitions stable across eligible provider-cache requests; reuse remains provider-controlled.",
      "Reload the Chrome extension with the matching 0.7.1 backend for bridge protocol 3; re-pair if its connection is lost.",
      "Keep the selected model and variant in sync across the Session header and variant picker.",
      "Start landing-screen goals against the returned Session ID.",
      "Restore paired Chrome tabs after reconnect and clean up incomplete pairing attempts.",
    ])
    const release = RELEASES.find((item) => item.version === "0.7.0")
    expect(release).toMatchObject({
      date: "2026-09-24",
      title: "A clearer remote workspace",
      tags: ["Added", "Changed", "Fixed"],
    })
    expect(release?.changes.map((change) => change.text)).toEqual([
      "Open recorded file patches from remote Activity; long diffs scroll within their row.",
      "Use a responsive remote workspace for Sessions, conversation, Activity, approvals, and Settings across phone, tablet, and desktop layouts.",
      "Navigate refreshed landing, documentation, changelog, and offline pages in light and dark themes.",
      "Keep the selected machine and reconnect action when an account refresh reports it offline.",
      "Show a Session's project and directory only when the backend reports them.",
    ])
  })

  test("are unique and ordered newest first", () => {
    const versions = RELEASES.map((release) => release.version)
    expect(versions.slice(0, 30)).toEqual([
      "0.10.10",
      "0.10.9",
      "0.10.8",
      "0.10.7",
      "0.10.6",
      "0.10.5",
      "0.10.4",
      "0.10.3",
      "0.10.2",
      "0.10.1",
      "0.10.0",
      "0.9.5",
      "0.9.4",
      "0.9.3",
      "0.9.2",
      "0.9.1",
      "0.9.0",
      "0.8.12",
      "0.8.11",
      "0.8.10",
      "0.8.9",
      "0.8.8",
      "0.8.7",
      "0.8.6",
      "0.8.5",
      "0.8.4",
      "0.8.3",
      "0.8.2",
      "0.8.1",
      "0.8.0",
    ])
    expect(new Set(versions).size).toBe(versions.length)
    const sorted = [...versions].sort((a, b) => compare(b, a))
    expect(versions).toEqual(sorted)
  })

  test("carry a title, at least one tagged change, and a well-formed date", () => {
    for (const release of RELEASES) {
      expect(release.title.length).toBeGreaterThan(0)
      expect(release.changes.length).toBeGreaterThan(0)
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const change of release.changes) {
        expect(TAGS).toContain(change.tag)
        expect(change.text.trim().length).toBeGreaterThan(10)
      }
      expect(release.tags.length).toBe(new Set(release.tags).size)
      for (const tag of release.tags) expect(TAGS).toContain(tag)
    }
  })

  test("counts changes per tag", () => {
    const counts = changeTagCounts(RELEASES)
    const total = RELEASES.flatMap((release) => release.changes).length
    expect(counts.Added + counts.Changed + counts.Fixed).toBe(total)
  })
})

function compare(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
