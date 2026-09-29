import { describe, expect, test } from "bun:test"
import { RELEASES, changeTagCounts } from "./changelog"

const TAGS = ["Added", "Changed", "Fixed"] as const

describe("release entries", () => {
  test("includes the latest TUI release at the top of the public changelog", () => {
    expect(RELEASES[0]).toEqual({
      version: "0.7.12",
      date: "2026-09-29",
      title: "File changes in remote Conversation, side-by-side diffs, and goals that decide for you",
      tags: ["Added", "Changed", "Fixed"],
      changes: [
        { tag: "Added", text: "See an Edited files card in remote Conversation and expand a file for its latest change side by side, and read captured TUI changes side by side on wide terminals." },
        { tag: "Added", text: "Set a goal with /goal, change autonomy with /yolo, and load a slash skill from the remote composer, as in the TUI." },
        { tag: "Changed", text: "Let goal mode make open decisions on your behalf until the goal is satisfied, while reviews that require a human still come to you." },
        { tag: "Changed", text: "Collapse the Sessions sidebar to a narrow strip that reopens it, show the loaded count beside the workspace title, keep the installed app from zooming, and give the app icon a small margin." },
        { tag: "Fixed", text: "Open the Autonomy level and Goal panels next to their controls, show the Goal control without empty space, and reject remote agent mentions the TUI would not offer." },
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
        { tag: "Added", text: "See the latest generation speed and a context-window ring beside the model in the remote composer, with a context bar in the phone model picker, and see generation speed in the TUI sidebar." },
        { tag: "Added", text: "See compactions as dividers with Session-wide totals in remote Conversation, and switch a model to its fast counterpart with the lightning toggle." },
        { tag: "Changed", text: "Keep the remote workspace mounted while you move between views, start Conversation history at the latest completed compaction like the TUI, and leave New session without a close button." },
        { tag: "Changed", text: "Animate pickers, sheets, dialogs, the notification center, and composer panels in and out, hide the Sessions sidebar at tablet widths, and give each effort level its own color." },
        { tag: "Fixed", text: "Show attached images as thumbnails instead of a tiny mark, attach large images from an iPhone, and offer Retry for an image that has not loaded after two minutes." },
        { tag: "Fixed", text: "Name the Session in each in-app notice, keep Team and Office subagents shown during refreshes, and keep Session rows, the carousel, and the todo panel steady while they update." },
        { tag: "Fixed", text: "Show desktop alerts before the service worker is ready, load Usage after switching machines, stop the notification center from flickering, and pad the installed app and Home Screen icon." },
        { tag: "Fixed", text: "Send TUI notifications before the terminal reports focus, clear the composer after /goal, label only cancelled tool calls as cancelled, and read local skill files through the skill tool." },
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
        { tag: "Added", text: "Choose the active machine and remove revoked devices from remote Settings, reopen Activity on your last Session after a reload, and hide the desktop Sessions sidebar." },
        { tag: "Added", text: "Switch remote Usage between UTC and local time, and see loading placeholders instead of blank areas while the remote workspace loads." },
        { tag: "Changed", text: "Keep the remote connection in the machine's background server so it stays on with no TUI open; every TUI, ycoding remote connect, and the new ycoding remote disconnect switch the same connection, and the server log records its diagnostics." },
        { tag: "Changed", text: "Show up to ten running and recently active Sessions in the Running and recent carousel, pin Conversation, Office, and Team above the scrolling workspace, and set autonomy and goals only from the Conversation status." },
        { tag: "Changed", text: "Move Office characters more calmly without emote icons, center the New session screen under the full logo, and show each alert once through the site's service worker." },
        { tag: "Fixed", text: "Load attachments of waiting prompts, open the Session chosen from New session, and show Sessions as running while their subagents work." },
        { tag: "Fixed", text: "Keep the remote status timer to the current run and clear it after a reconnect, stop repeating the YOLO level on phones, and restore dropped push subscriptions." },
        { tag: "Fixed", text: "Show Device disconnected only when the selected machine goes offline, not when this browser's relay connection drops; the connection strip keeps the latest drop's code and reason." },
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
        { tag: "Added", text: "Manage every directory YCoding knows from the TUI with Manage workspaces: open one for your next Session, delete a project copy, or forget a directory and its Sessions." },
        { tag: "Added", text: "Refresh models and providers from the TUI command palette to pick up new project configuration and provider models without restarting." },
        { tag: "Added", text: "Manage a Session's subagents, shells, and side chats from the new remote Team panel on desktop, tablet, and phone." },
        { tag: "Changed", text: "Turn remote access on and off with one Remote connection toggle in the TUI command palette, marked green when on and grey otherwise, instead of a bottom status line." },
        { tag: "Changed", text: "Open subagents read-only in the remote Conversation with Main, Previous, and Next navigation; side chats still accept prompts." },
        { tag: "Changed", text: "Show what each Office character is actually doing, keep the main agent in the Lounge while only its subagents work, and show Office only on tablets and desktops." },
        { tag: "Changed", text: "Swipe through running Sessions in a carousel, keep the Conversation sidebar on the open Session's workspace, and let the agent read local skill files by absolute path." },
        { tag: "Fixed", text: "Stop remote images and Usage cards from flickering, keep the Office scene when you select a teammate, and show only matching Sessions while searching." },
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
        { tag: "Added", text: "Turn remote access on and off from the TUI command palette, with an always-visible remote status line." },
        { tag: "Added", text: "Load long remote conversations in pages as you scroll up, and open attached and tool images as thumbnails with a full-size view." },
        { tag: "Added", text: "See every running Session from all workspaces at the top of the remote Sessions page, and exact values on the Usage charts." },
        { tag: "Changed", text: "Move Office characters to the room for their current work, send idle characters to the Lounge, and fill the canvas with the office." },
        { tag: "Changed", text: "Widen the remote transcript with Jump to top and Jump to latest on its edge, and fit phones with a one-row icon bar, a bottom Sessions sheet, and an agent and model row above the composer." },
        { tag: "Changed", text: "Hide completed todo lists and Session-state notices as the TUI does, keep Usage rows in place while pages load, and list local Today spend after provider quotas in the TUI." },
        { tag: "Fixed", text: "Keep Sessions usable when an attached file's stored copy changes, a file's format is unsupported by the provider, or a plugin hook fails." },
        { tag: "Fixed", text: "Carry the landing screen's YOLO level and goal into the new Session, and load long remote conversations without disconnecting." },
        { tag: "Fixed", text: "Show one notice per stopped Session, catch up on alerts missed while disconnected, keep push alerts working, and fix pending-prompt alignment and the blank Office on phones." },
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
        { tag: "Added", text: "Attach files to remote prompts by pasting, choosing, or dropping them on the composer, up to 20 MiB each, with previews, upload progress, and cancel." },
        { tag: "Added", text: "See the selected Session's todo list above the remote composer, collapsed to a progress summary until you expand it." },
        { tag: "Added", text: "Keep reading while a remote reply streams, return with Jump to latest, and move between your prompts from a rail on wide screens." },
        { tag: "Added", text: "Get new in-app notices as brief toasts, and sort through a notification center grouped by day with read marks, Mark all read, and Clear all." },
        { tag: "Changed", text: "Use a floating remote composer with agent, model, effort, status, and Steer or Queue controls, and rounded controls throughout the remote workspace." },
        { tag: "Changed", text: "Show subagent notices as compact rows, and redesign the Usage page with quota cards, spend tiles, charts, and a sortable breakdown." },
        { tag: "Changed", text: "Make motion on the public site, documentation, and changelog more noticeable while respecting reduced motion." },
        { tag: "Fixed", text: "Show running Sessions as running when a machine keeps Sessions from deleted folders, name workspaces by folder instead of “..”, and stop the Office list from flickering or losing subagents." },
        { tag: "Fixed", text: "List every remote autocomplete match, keep TUI autocomplete scrolling in place, and keep the remote composer's height steady on hover and focus." },
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
        { tag: "Added", text: "Open the remote Usage page to see each provider's quota meters, reset countdowns, and pace, spend for today, yesterday, and 30 days, a daily chart, and sortable breakdowns by model, Session, project, and agent." },
        { tag: "Added", text: "See the OpenRouter credit balance, Copilot AI credits, and Grok, OpenCode Go, and Z.ai quotas in the TUI and on the web, plus a separately labeled YCoding local Today spend." },
        { tag: "Added", text: "Start a remote Session from a composer with a repository, agent, model, and first prompt, and autocomplete commands, files, agents, references, and skills while you type." },
        { tag: "Added", text: "Get push alerts in a closed browser or installed app when a Session needs your decision or stops running, and review recent alerts in the notification center." },
        { tag: "Added", text: "Follow the autonomy level, current activity, elapsed time, and active goal in a status bar above the remote composer." },
        { tag: "Added", text: "Animate the public site, documentation, and changelog, respecting reduced motion." },
        { tag: "Changed", text: "List workspaces by name in a Sessions sidebar and show top-level Sessions 25 at a time, running first, then pinned, then most recent." },
        { tag: "Changed", text: "Render remote replies as Markdown with collapsible thinking and tool rows, and show only your text in prompt bubbles." },
        { tag: "Changed", text: "Show only the selected Session's family in the Office, with unique names, an Agents list, and an icon toolbar." },
        { tag: "Changed", text: "Replace bare dashes in TUI usage views with Unknown or No usage yet, and remove the ntfy tool and configuration." },
        { tag: "Fixed", text: "Skip compaction that cannot bring a request under the model's context window, reload Usage after the connection changes, and keep the desktop header inside the window at 1024–1279 px." },
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
        { tag: "Added", text: "Switch the remote workspace to Office to see the selected Session, other loaded Sessions, and its reported subagents as characters in a pixel office with CEO, Developer, Research, QA, Meeting, Relax, and entrance areas." },
        { tag: "Added", text: "Office characters work in the room for their responsibility, relax in the lounge when idle, enter and leave through the entrance, and walk to live briefings and reports without replaying history." },
        { tag: "Added", text: "Open context breakdown from the TUI command palette to see latest-request stats and an estimated split of the context window across system, tools, user, assistant, reasoning, tool calls, and other content." },
        { tag: "Added", text: "Sort every TUI usage table by any column by clicking its header or pressing its key." },
        { tag: "Added", text: "Connect Chrome from the landing command palette." },
        { tag: "Changed", text: "Group remote Sessions by workspace and load 50 rows at a time as you scroll." },
        { tag: "Changed", text: "Show remote prompts as right-aligned bubbles with Read after consumption, compact reasoning sections, and compaction-aware history." },
        { tag: "Changed", text: "Show every TUI cost estimate as a dollar amount, counting unpriced requests as $0.00." },
        { tag: "Changed", text: "Remove the live SHELLS sidebar section; running shells remain in the composer's shell tab." },
        { tag: "Changed", text: "Open Usage from the landing footer with leader+Shift+U and apply a pending model choice when /goal starts or resumes a goal." },
        { tag: "Fixed", text: "Report a machine offline when the relay has no local agent for the workspace read, and widen the desktop machine selector without wrapping names." },
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
        { tag: "Fixed", text: "Pace remote requests within relay rate limits so large Session inventories can load without a client-rate policy disconnect; the workspace still loads the complete inventory." },
        { tag: "Fixed", text: "Stop superseded Session list reads before fetching more pages and discard unsent requests when their connection closes, without replaying mutations." },
        { tag: "Fixed", text: "Wrap long machine names instead of truncating them and use compact picker text on desktop and phones while preserving keyboard controls and mobile confirmation." },
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
        { tag: "Added", text: "Create remote Sessions from previously opened repositories, including directories without a Session; check uncertain creation results with the same Session identity." },
        { tag: "Added", text: "Control macOS windows in the background and stage supported off-Space windows on a private agent display for pixel input and capture. Unstage restores the frame on the main display's current Space." },
        { tag: "Added", text: "Control Safari and Chrome tabs through native automation; JavaScript evaluation and Safari history/reload require Allow JavaScript from Apple Events." },
        { tag: "Added", text: "Control supported Electron windows through a process-owned debug bridge, with explicit debug-enabled relaunch when needed. Relaunch leaves a localhost debug port open until quit; graceful quit preserves unsaved-work prompts." },
        { tag: "Added", text: "Show a separate YCoding cursor and click ripple for Chrome agent interactions without moving the system pointer." },
        { tag: "Added", text: "Pin Sessions on the backend so every TUI and the web remote client list the same pins first; the TUI moves existing local pins to the backend once on first start." },
        { tag: "Added", text: "Show a download progress bar and the verification and installation steps during ycoding update." },
        { tag: "Changed", text: "Breaking Change: local HTTP integrations must use an Authorization: Basic header with username ycoding and the configured password; auth_token query parameters no longer authenticate requests." },
        { tag: "Changed", text: "Skip guardrail review prompts for browser and desktop actions while preserving explicit denials, tool permissions, and required operating-system or site authorization." },
        { tag: "Changed", text: "Confirm phone machine changes before switching connections; keep tablet navigation visible and let the conversation sidebar collapse and reopen." },
        { tag: "Changed", text: "Redesign usage reports and Stats: label project rows with project name and worktree, keep token columns on one line, drop cost suffixes, sort name views by tokens, and render a colored Stats graph with summary stats." },
        { tag: "Fixed", text: "Open existing remote Sessions directly in Conversation, retain drafts across remote-page navigation and same-machine reconnects, and keep late creation results from changing a dismissed dialog's route." },
        { tag: "Fixed", text: "Keep Chrome pairing codes visible and recover saved pairings after browser or YCoding restarts without another code; reload the extension after updating." },
        { tag: "Fixed", text: "Restore Daybreak discovery, show active model state, and apply landing-screen selections before the first prompt or goal." },
        { tag: "Fixed", text: "Preserve alternative provider tool argument shapes, validate JSON-encoded browser actions, and improve off-Space Electron capture and window placement." },
        { tag: "Fixed", text: "Enforce read approval for file-search contents, reject search-root symlink escapes, and approve each web-fetch redirect destination with a ten-redirect limit." },
        { tag: "Fixed", text: "Keep tablet header hit targets separate, contain mobile picker keyboard focus, and align the landing divider with the content grid." },
        { tag: "Fixed", text: "Click and scroll hidden Chrome tabs with page scripts without activating them. Scripted actions cannot open popups, use the clipboard, or open file pickers." },
        { tag: "Fixed", text: "Keep answers delivered only in a Responses completion payload without duplicate text or tool calls, recover post-output provider failures from durable history, and explain hidden provider errors by category." },
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
    expect(versions.slice(0, 10)).toEqual(["0.7.12", "0.7.11", "0.7.10", "0.7.9", "0.7.8", "0.7.7", "0.7.6", "0.7.5", "0.7.4", "0.7.3"])
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
