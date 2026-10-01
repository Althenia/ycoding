import { describe, expect, test } from "bun:test"
import { RELEASES, changeTagCounts } from "./changelog"

const TAGS = ["Added", "Changed", "Fixed"] as const

describe("release entries", () => {
  test("includes the latest TUI release at the top of the public changelog", () => {
    expect(RELEASES[0]).toEqual({
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
    expect(RELEASES[1]).toEqual({
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
    expect(RELEASES[2]).toEqual({
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
    expect(RELEASES[3]).toEqual({
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
    expect(RELEASES[4]).toEqual({
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
    expect(RELEASES[5]).toEqual({
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
    expect(RELEASES[6]).toEqual({
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
    expect(RELEASES[7]).toEqual({
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
    expect(versions.slice(0, 15)).toEqual([
      "0.8.7",
      "0.8.6",
      "0.8.5",
      "0.8.4",
      "0.8.3",
      "0.8.2",
      "0.8.1",
      "0.8.0",
      "0.7.18",
      "0.7.16",
      "0.7.15",
      "0.7.14",
      "0.7.13",
      "0.7.12",
      "0.7.11",
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
