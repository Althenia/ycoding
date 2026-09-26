import { describe, expect, test } from "bun:test"
import { RELEASES, changeTagCounts } from "./changelog"

const TAGS = ["Added", "Changed", "Fixed"] as const

describe("release entries", () => {
  test("includes the latest TUI release at the top of the public changelog", () => {
    expect(RELEASES[0]).toEqual({
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
    expect(versions.slice(0, 10)).toEqual(["0.7.4", "0.7.3", "0.7.2", "0.7.1", "0.7.0", "0.6.10", "0.6.9", "0.6.8", "0.6.7", "0.6.6"])
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
