import { describe, expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet, readStylesheet, type Declarations, type Stylesheet } from "../../styles/css-rules"
import { readReviewItems, type AssistantPart, type PendingRequestView, type SessionView } from "../projection"
import { parseSessionStatus, readSessionInfo, type SessionInfoView } from "../store"
import { sessionStateChips } from "../view-model"
import { partKey, toolPartExpanded } from "./conversation"
import { notificationAge } from "./notifications"
import {
  awaitsApproval,
  connectionStripView,
  filterSessions,
  sessionChips,
  sessionNeedsAttention,
  remoteSurfaceComposition,
  summarizeSession,
} from "./shell-model"

/**
 * The composition rules the approved remote surface adds. Each rule is a decision the
 * workspace makes about real relay state, so it is asserted here as behavior and proved
 * again in a real browser against the fixture build
 * (`output/remote-redesign/check.ts`).
 */

const session = (patch: Partial<SessionInfoView> = {}): SessionInfoView => ({
  id: "ses_a",
  title: "Stream remote output safely",
  updatedAt: 1_700_000_000_000,
  archived: false,
  ...patch,
})

const view = (patch: Partial<SessionView> = {}): SessionView => ({
  id: "ses_a",
  status: "idle",
  messages: [],
  requests: [],
  unhandledEvents: 0,
  ...patch,
})

describe("screen-specific workspace composition", () => {
  test("keeps the session rail and composer only on a selected conversation", () => {
    expect(remoteSurfaceComposition("/remote/session", true)).toEqual({ showSessionRail: true, showComposer: true })
    expect(remoteSurfaceComposition("/remote", true)).toEqual({ showSessionRail: false, showComposer: false })
    expect(remoteSurfaceComposition("/remote", false)).toEqual({ showSessionRail: false, showComposer: false })
    expect(remoteSurfaceComposition("/remote/sessions", true)).toEqual({ showSessionRail: false, showComposer: false })
    expect(remoteSurfaceComposition("/remote/settings", true)).toEqual({ showSessionRail: false, showComposer: false })
  })
})

describe("connection strip", () => {
  test("is hidden while the connection is healthy, whatever was loaded or dropped before", () => {
    const healthy = { connection: { kind: "connected", deviceName: "Studio Mac" }, transportKind: "open", activeDeviceID: "dev_studio", advertised: 3 } as const
    expect(connectionStripView(healthy)).toBeUndefined()
    expect(connectionStripView({ ...healthy, lastRelayDrop: { code: 1012, reason: "Relay restarted" } })).toBeUndefined()
  })

  test("still states a connected device whose transport is not open", () => {
    const strip = connectionStripView({
      connection: { kind: "connected", deviceName: "Studio Mac" }, transportKind: "reconnecting", activeDeviceID: "dev_studio", advertised: 3,
    })
    expect(strip?.tone).toBe("online")
    expect(strip?.body).toContain("Studio Mac")
    expect(strip?.showReconnect).toBe(true)
  })

  test("offers Reconnect for a device that stopped reporting", () => {
    const strip = connectionStripView({
      connection: { kind: "offline", deviceName: "Studio Mac" },
      transportKind: "closed",
      activeDeviceID: "dev_studio",
      advertised: 3,
    })
    expect(strip?.tone).toBe("offline")
    expect(strip?.body).toContain("Studio Mac is not reachable")
    expect(strip?.showReconnect).toBe(true)
  })

  test("keeps the shipped retry while a connected device is re-connecting", () => {
    const strip = connectionStripView({
      connection: { kind: "connecting" },
      transportKind: "reconnecting",
      activeDeviceID: "dev_laptop",
      advertised: 3,
    })
    expect(strip?.showReconnect).toBe(true)
  })

  test("keeps the latest browser relay close code and reason in the existing connection strip", () => {
    const drop = { code: 1012, reason: "Relay restarted" }
    const reconnecting = connectionStripView({
      connection: { kind: "connecting" }, transportKind: "reconnecting", activeDeviceID: "dev_studio", advertised: 2, lastRelayDrop: drop,
    })
    expect(reconnecting?.body).toBe("Connecting — Opening the relay connection. · Last browser relay drop (1012): Relay restarted")
    expect(reconnecting?.body).not.toContain("Machine disconnected")
    const failedRead = connectionStripView({
      connection: { kind: "error", message: "Session list: the backend rejected this read" },
      transportKind: "open", activeDeviceID: "dev_studio", advertised: 2, lastRelayDrop: drop,
    })
    expect(failedRead?.body).toBe("Connection error — Session list: the backend rejected this read · Last browser relay drop (1012): Relay restarted")
    const closed = connectionStripView({
      connection: { kind: "error", message: "Relay restarted" },
      transportKind: "closed", activeDeviceID: "dev_studio", advertised: 2, lastRelayDrop: drop,
    })
    expect(closed?.body).toBe("Connection error — Relay restarted · Last browser relay drop (1012)")
  })

  test("offers nothing to retry before any device has reported", () => {
    const strip = connectionStripView({
      connection: { kind: "connecting" },
      transportKind: "connecting",
      activeDeviceID: "dev_laptop",
      advertised: 0,
    })
    expect(strip?.showReconnect).toBe(false)
  })

  test("sends a signed-in account with no enrolled machine to settings", () => {
    const strip = connectionStripView({
      connection: { kind: "no-device-enrolled" },
      transportKind: "idle",
      advertised: 0,
    })
    expect(strip?.showSettings).toBe(true)
    expect(strip?.showReconnect).toBe(false)
  })

  test("never offers a reconnect without a device to reconnect", () => {
    const strip = connectionStripView({
      connection: { kind: "signed-out" },
      transportKind: "closed",
      advertised: 0,
    })
    expect(strip?.showReconnect).toBe(false)
    expect(strip?.showSettings).toBe(false)
    expect(strip?.tone).toBe("offline")
  })

  test("reports a deployment without remote access as unavailable, not offline", () => {
    const strip = connectionStripView({
      connection: { kind: "unavailable", reason: "not-configured" },
      transportKind: "idle",
      advertised: 0,
    })
    expect(strip?.tone).toBe("attention")
    expect(strip?.showSettings).toBe(true)
    expect(strip?.body).toContain("not available yet")
  })
})

describe("resident session filter", () => {
  const sessions = [
    session({ id: "ses_a", title: "Stream remote output safely", agent: "god", modelLabel: "openai/gpt-6" }),
    session({ id: "ses_b", title: "Archived: release notes", archived: true }),
    session({ id: "ses_c", title: "Child: fix flaky suite", agent: "tester" }),
  ]

  test("returns every resident session for an empty filter", () => {
    expect(filterSessions(sessions, "").length).toBe(3)
    expect(filterSessions(sessions, "   ").length).toBe(3)
  })

  test("matches title, agent, and model without regard to case", () => {
    expect(filterSessions(sessions, "REMOTE").map((entry) => entry.id)).toEqual(["ses_a"])
    expect(filterSessions(sessions, "tester").map((entry) => entry.id)).toEqual(["ses_c"])
    expect(filterSessions(sessions, "gpt-6").map((entry) => entry.id)).toEqual(["ses_a"])
  })

  test("returns nothing for a filter that matches nothing, so the caller can say so", () => {
    expect(filterSessions(sessions, "no such session")).toEqual([])
  })

  test("filters the backend session set by running and idle state", () => {
    const classified = [
      session({ id: "ses_running", running: true }),
      session({ id: "ses_idle", running: false }),
      session({ id: "ses_archived", archived: true }),
    ]
    expect(filterSessions(classified, "", "running").map((entry) => entry.id)).toEqual(["ses_running"])
    expect(filterSessions(classified, "", "idle").map((entry) => entry.id)).toEqual(["ses_idle"])
    expect(filterSessions(classified, "", "all")).toHaveLength(3)
  })

  test("waiting, running and idle filters are exclusive and retain activity order over pins", () => {
    const rows = [
      session({ id: "ses_wait", running: true, attention: true }),
      session({ id: "ses_running", running: true }),
      session({ id: "ses_lost", attention: true }),
      session({ id: "ses_failed", attention: true, failed: true }),
      session({ id: "ses_loss", attention: true, lost: true }),
      session({ id: "ses_idle", pinnedAt: 1 }),
      session({ id: "ses_archived", archived: true }),
    ]
    expect(filterSessions(rows, "", "waiting").map((row) => row.id)).toEqual(["ses_wait", "ses_lost"])
    expect(filterSessions(rows, "", "running").map((row) => row.id)).toEqual(["ses_running"])
    expect(filterSessions(rows, "", "idle").map((row) => row.id)).toEqual(["ses_failed", "ses_loss", "ses_idle"])
    expect(filterSessions(rows, "").map((row) => row.id)).toEqual(rows.map((row) => row.id))
  })
})

describe("pinned sessions", () => {
  test("keeps pinned sessions in the reported activity order", () => {
    const listed = [
      session({ id: "ses_recent" }),
      session({ id: "ses_pinned_late", pinnedAt: 2_000 }),
      session({ id: "ses_older" }),
      session({ id: "ses_pinned_early", pinnedAt: 1_000 }),
    ]
    expect(filterSessions(listed, "").map((entry) => entry.id)).toEqual([
      "ses_recent",
      "ses_pinned_late",
      "ses_older",
      "ses_pinned_early",
    ])
  })

  test("labels a pinned session", () => {
    expect(sessionStateChips(summarizeSession(session({ pinnedAt: 1_000 }), undefined))).toContainEqual({
      label: "Pinned",
      tone: "neutral",
    })
    expect(sessionStateChips(summarizeSession(session(), undefined)).map((chip) => chip.label)).not.toContain("Pinned")
  })

  test("reads the server pin time from the session list", () => {
    expect(readSessionInfo({ id: "ses_a", time: { updated: 5, pinned: 3 } })?.pinnedAt).toBe(3)
    expect(readSessionInfo({ id: "ses_a", time: { updated: 5 } })?.pinnedAt).toBeUndefined()
  })
})

describe("session summary", () => {
  test("keeps archived ahead of the live report", () => {
    expect(summarizeSession(session({ archived: true, running: true }), undefined).status).toBe("archived")
  })

  test("takes the running report the device published", () => {
    expect(summarizeSession(session({ running: true }), undefined).status).toBe("running")
    expect(summarizeSession(session({ running: false }), undefined).status).toBe("idle")
  })

  test("merges the selected session's autonomy, agent, and model", () => {
    const summary = summarizeSession(
      session({ agent: "god", modelLabel: "openai/gpt-6" }),
      view({ autonomy: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", goal: { text: "Ship it", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 5 } } }),
    )
    expect(summary.status).toBe("idle")
    expect(summary.autonomy).toBe("normal")
    expect(summary.goalActive).toBe(true)
    expect([summary.permissions, summary.guardrails, summary.answers]).toEqual(["manual", "manual", "manual"])
    expect("guardrailsEnforced" in summary).toBe(false)
    expect(summary.agent).toBe("god")
    expect(summary.model).toBe("openai/gpt-6")
    expect(summary.updatedAt).toBe("2023-11-14T22:13:20.000Z")
  })

  test("summary modes and sleep come from effective values, naming inherited automation instead of Manual", () => {
    const summary = summarizeSession(session({}), view({ autonomy: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "yolo", effective: { permissions: "auto", guardrails: "manual", answers: "yolo", inherited: { permissions: "ses_parent" }, asleep: true, guardrailsEnabled: true } } }))
    expect([summary.permissions, summary.guardrails, summary.answers]).toEqual(["auto", "manual", "yolo"])
    expect(summary.asleep).toBe(true)
  })

  test("does not take another session's live view", () => {
    const summary = summarizeSession(session({ id: "ses_other" }), view({ id: "ses_a", status: "running" }))
    expect(summary.status).toBe("idle")
    expect(summary.autonomy).toBeUndefined()
  })
})

describe("waiting for a decision", () => {
  const permission: PendingRequestView = {
    kind: "permission",
    id: "per_1",
    action: "shell",
    resources: ["bun test *"],
    askedAt: 0,
  }
  const form: PendingRequestView = {
    kind: "form",
    id: "frm_1",
    form: { id: "frm_1", sessionID: "ses_a", title: "Scope", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", title: "Reload what?" }] },
    askedAt: 0,
  }

  test("counts an unanswered approval the loaded view reports", () => {
    expect(awaitsApproval(view({ requests: [permission] }), "ses_a")).toBe(true)
  })

  test("does not count a form as an approval decision", () => {
    expect(awaitsApproval(view({ requests: [form] }), "ses_a")).toBe(false)
  })

  test("badges the open family's root and the item's member Session with its review count", () => {
    const items = readReviewItems({ data: ["ses_a", "ses_child"].map((sessionID, index) => ({ itemID: `rvw_${index}`, sessionID, rootSessionID: "ses_a", sessionTitle: "T", created: 1, reason: "free_text",
      kind: "subagent_question", origin: { questionID: "qst_1" }, payload: { type: "subagent_question", text: "?" } })) })!
    const loaded = view({ review: { status: "ready", items }, autonomy: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual" } })
    expect(sessionChips(session({}), loaded).map((chip) => chip.label)).toEqual(["review 2", "Autonomous Manual"])
    expect(sessionChips(session({ id: "ses_child" }), loaded)[0]).toEqual({ label: "review 1", tone: "attention" })
    expect(sessionChips(session({ id: "ses_b" }), loaded).map((chip) => chip.label)).not.toContain("review 2")
    expect(sessionChips(session({}), { ...loaded, requests: [permission] })[0]?.label).toBe("Waiting for approval")
  })

  test("reports nothing for a session this client has not loaded", () => {
    expect(awaitsApproval(undefined, "ses_a")).toBe(false)
    expect(awaitsApproval(view({ id: "ses_other", requests: [permission] }), "ses_a")).toBe(false)
  })

  test("puts the pending approval first so compact session rows cannot hide it", () => {
    const chips = sessionChips(
      session({ running: true }),
      view({ requests: [permission], autonomy: { mode: "normal", permissions: "yolo", guardrails: "yolo", answers: "yolo" } }),
    )
    expect(chips.map((chip) => chip.label)).toEqual(["Waiting for approval", "Running", "Autonomous YOLO"])
    expect(chips[0]?.tone).toBe("attention")
  })

  test("keeps the unloaded session's chips exactly as the device reported them", () => {
    const chips = sessionChips(session({ running: true }), undefined)
    expect(chips.map((chip) => chip.label)).toEqual(["Running"])
  })

  test("leads with a waiting chip for a Session the device reports waiting on a human", () => {
    const chips = sessionChips(session({ running: true, attention: true }), undefined)
    expect(chips.map((chip) => chip.label)).toEqual(["Waiting for you", "Running"])
    expect(chips[0]?.tone).toBe("attention")
  })

  test("shows a failure-only Session as Failed without a waiting dot or chip until it runs again", () => {
    const failed = session({ attention: false, failed: true })
    expect(sessionNeedsAttention(failed, undefined)).toBe(false)
    const chips = sessionChips(failed, undefined)
    expect(chips.map((chip) => chip.label)).toEqual(["Failed"])
    expect(chips[0]?.tone).toBe("neutral")
    expect(sessionChips(session({ attention: false, failed: false, running: true }), undefined).map((chip) => chip.label)).toEqual(["Running"])
  })

  test("shows a lost background result as a loss chip without a waiting dot, ahead of Running and behind a real wait", () => {
    const lost = session({ attention: false, lost: true })
    expect(sessionNeedsAttention(lost, undefined)).toBe(false)
    expect(sessionNeedsAttention(session({ attention: true, lost: true }), undefined)).toBe(false)
    const chips = sessionChips(lost, undefined)
    expect(chips.map((chip) => chip.label)).toEqual(["Background result lost"])
    expect(chips[0]?.tone).toBe("attention")
    expect(sessionChips(session({ lost: true, running: true }), undefined).map((chip) => chip.label)).toEqual(["Background result lost", "Running"])
    expect(sessionChips(lost, view({ requests: [form] })).map((chip) => chip.label)).toEqual(["Waiting for you", "Background result lost"])
    expect(sessionChips(session({ failed: true }), undefined).map((chip) => chip.label)).toEqual(["Failed"])
  })

  test("reads the lost subset of a session.status body and treats it as absent when omitted", () => {
    const body = { running: [], attention: ["ses_a", "ses_b"], lost: ["ses_b"] }
    expect(parseSessionStatus(body)?.lost).toEqual(new Set(["ses_b"]))
    expect(parseSessionStatus({ data: body })?.lost).toEqual(new Set(["ses_b"]))
    expect(parseSessionStatus({ running: [], attention: [] })?.lost).toEqual(new Set())
    expect(parseSessionStatus({ ...body, lost: ["nope"] })).toBeUndefined()
    expect(parseSessionStatus({ ...body, lost: "ses_b" })).toBeUndefined()
  })

  test("keeps the waiting dot and chip for a Session that also has a pending request", () => {
    const waiting = session({ attention: true, failed: false })
    expect(sessionNeedsAttention(waiting, undefined)).toBe(true)
    expect(sessionChips(waiting, undefined).map((chip) => chip.label)).toEqual(["Waiting for you"])
  })

  test("reads the failed subset of a session.status body and treats it as absent when omitted", () => {
    const body = { running: [], attention: ["ses_a", "ses_b"], failed: ["ses_b"] }
    expect(parseSessionStatus(body)?.failed).toEqual(new Set(["ses_b"]))
    expect(parseSessionStatus({ data: body })?.failed).toEqual(new Set(["ses_b"]))
    expect(parseSessionStatus({ running: [], attention: [] })?.failed).toEqual(new Set())
    expect(parseSessionStatus({ ...body, failed: ["nope"] })).toBeUndefined()
  })

  test("flags a loaded Session with an open question as needing attention", () => {
    expect(sessionNeedsAttention(session({}), view({ requests: [form] }))).toBe(true)
    expect(sessionChips(session({}), view({ requests: [form] })).map((chip) => chip.label)[0]).toBe("Waiting for you")
    expect(sessionNeedsAttention(session({}), view({ id: "ses_other", requests: [form] }))).toBe(false)
    expect(sessionNeedsAttention(session({ attention: false }), undefined)).toBe(false)
  })
})

describe("notification age", () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0)
  test("counts minutes and hours, then falls back to the date", () => {
    expect(notificationAge(now - 20_000, now)).toBe("now")
    expect(notificationAge(now - 5 * 60_000, now)).toBe("5m")
    expect(notificationAge(now - 3 * 3_600_000, now)).toBe("3h")
    expect(notificationAge(now - 3 * 86_400_000, now)).toBe(new Date(now - 3 * 86_400_000).toLocaleDateString())
  })
})

describe("part identity", () => {
  test("keys a tool call by the call ID the device published", () => {
    const part: AssistantPart = { kind: "tool", callID: "call_read", name: "read", status: "completed", content: [] }
    expect(partKey(part)).toBe("tool:call_read")
  })

  test("keys text and reasoning by their ordinal without collision", () => {
    expect(partKey({ kind: "text", ordinal: 0, text: "hi" })).toBe("text:0")
    expect(partKey({ kind: "reasoning", ordinal: 0, text: "why" })).toBe("reasoning:0")
  })
})

describe("tool body expansion", () => {
  test("keeps untouched tool rows collapsed whether running or settled", () => {
    expect(toolPartExpanded({ touched: false, manual: false, status: "completed" })).toBe(false)
    expect(toolPartExpanded({ touched: false, manual: true, status: "running" })).toBe(false)
  })

  test("keeps the reader's explicit toggle across a status change", () => {
    expect(toolPartExpanded({ touched: true, manual: false, status: "completed" })).toBe(false)
    expect(toolPartExpanded({ touched: true, manual: true, status: "running" })).toBe(true)
  })
})

const shell = () => Bun.file(new URL("./shell.tsx", import.meta.url)).text()
const invite = () => Bun.file(new URL("./invite.tsx", import.meta.url)).text()
const declared = (sheet: Stylesheet, selector: string, wrapped = false): Declarations =>
  declarationsWhere(sheet, (rule) => (wrapped ? rule.conditions.length > 0 : rule.conditions.length === 0) && rule.header.split(",").map((part) => part.trim()).includes(selector))
const boundaryFree = (declarations: Declarations) => {
  expect(declarations.border === undefined || declarations.border === "0" || declarations.border === "none").toBe(true)
  expect(declarations["border-radius"] === undefined || declarations["border-radius"] === "0").toBe(true)
}

describe("tonal sidebar and phone navigation", () => {
  test("uses a borderless sidebar and a soft active destination pill", async () => {
    const css = await readStylesheet("remote.css")
    expect(declared(css, ".workspace__rail").background).toBe("var(--yc-surface)")
    expect(declared(css, ".workspace__rail")["border-inline-end"]).toBe("0")
    expect(declared(css, ".workspace__rail-body > .pane")["border-block-start"]).toBeUndefined()
    expect(declared(css, ".workspace__rail-footer")["border-block-start"]).toBeUndefined()
    const active = declared(css, ".remote-nav__link--active")
    expect(active["box-shadow"]).toBe("none")
    expect(active.background).toBe("var(--yc-green-soft)")
    expect(active.color).toBe("var(--yc-text)")
    expect(active["font-weight"]).toBe("var(--yc-weight-semibold)")
    expect(declared(css, ".remote-nav__link--active > svg").color).toBe("var(--yc-green-strong)")
    expect(declared(css, ".remote-nav__link")["min-block-size"]).toBe("var(--yc-hit-min)")
    expect(declared(css, ".remote-nav__link")["min-inline-size"]).toBe("var(--yc-hit-min)")
    expect(declared(css, ".remote-nav__link")["border-radius"]).toBe("var(--yc-radius-pill)")
  })

  test("keeps three labeled phone targets with the label under the icon and a heavier active label", async () => {
    const css = await readStylesheet("remote.css")
    const item = declared(css, ".bottom-nav__item")
    expect(item["font-size"]).toBe("var(--yc-size-2xs)")
    expect(item["min-height"]).toBe("var(--yc-bottom-nav-h)")
    expect(declared(css, ".bottom-nav__item--active .bottom-nav__label")["font-weight"]).toBe("var(--yc-weight-bold)")
    expect(await shell()).toContain('<span class="bottom-nav__label" aria-hidden="true">{item.label}</span>')
  })

  test("restores the phone grid after desktop rules and makes coarse landscape navigation vertical", async () => {
    const css = await readStylesheet("remote.css")
    const phone = "@media (max-width: 767px), (max-height: 599px) and (pointer: coarse)"
    const landscape = "@media (max-height: 599px) and (pointer: coarse) and (orientation: landscape)"
    const at = (selector: string, condition: string) => declarationsWhere(css, (rule) => rule.header === selector && rule.conditions.includes(condition))
    expect(at(":root", phone)["--yc-phone-layout"]).toBe("1")
    expect(at(".app", phone)["grid-template-columns"]).toBe("minmax(0, 1fr)")
    expect(at(".app", phone)["grid-template-areas"]).toBe('"header" "workspace" "navigation"')
    expect(at(".workspace__rail", phone).display).toBe("none")
    expect(at(".bottom-nav", phone).display).toBe("grid")
    expect(css.rules.findIndex((rule) => rule.header === ".app" && rule.conditions.includes(phone))).toBeGreaterThan(css.rules.findIndex((rule) => rule.header === ".app" && rule.conditions.includes("@media (min-width: 768px)")))
    expect(at(".app", landscape)["grid-template-areas"]).toBe('"navigation header" "navigation workspace"')
    expect(at(".app", landscape)["grid-template-columns"]).toBe("var(--yc-bottom-nav-h) minmax(0, 1fr)")
    expect(at(".bottom-nav", landscape)["inline-size"]).toBe("var(--yc-bottom-nav-h)")
    expect(at(".bottom-nav__new", landscape).display).toBe("grid")
    expect(declared(css, ".bottom-nav__new").display).toBe("none")
    expect(declared(css, ".app[data-keyboard-open] > .bottom-nav").display).toBe("none")
    expect(await shell()).toContain('<Link to="/remote" class="bottom-nav__new" ariaLabel="New session" title="New session"><Icon name="plus" /></Link>')
  })

  test("keeps translucent portrait navigation legible and provides all opaque fallbacks", async () => {
    const css = await readStylesheet("remote.css")
    expect(declared(css, ".bottom-nav").background).toBe("color-mix(in srgb, var(--yc-surface) 92%, transparent)")
    expect(declared(css, ".bottom-nav")["backdrop-filter"]).toBe("blur(16px) saturate(1.4)")
    for (const condition of ["@supports not (backdrop-filter: blur(1px))", "@media (prefers-reduced-transparency: reduce)", "@media (forced-colors: active)"]) {
      const fallback = declarationsWhere(css, (rule) => rule.header === ".bottom-nav" && rule.conditions.includes(condition))
      expect(fallback.background).toBe("var(--yc-surface)")
      expect(fallback["backdrop-filter"]).toBe("none")
    }
  })

  test("retains separate borderless header owners and the existing focus and toast handoffs", async () => {
    const css = await readStylesheet("remote.css")
    for (const selector of [".app > .app-header", ".workspace__topbar"]) {
      expect(declared(css, selector).background).toBe("var(--yc-bg)")
      expect(declared(css, selector)["border-block-end"]).toBeUndefined()
    }
    const source = await shell()
    expect(source).toContain('<header class="app-header" data-toast-clearance>')
    expect(source).toContain(".workspace__topbar:not([inert]) .conversation-breadcrumb")
    expect(source).toContain("focusAfterSelection")
    expect(declared(css, ".workspace__rail")["overflow-anchor"]).toBe("none")
    expect(declared(css, ".workspace__scroll")["overflow-anchor"]).toBe("none")
  })

  test("keeps the Team count in the mono metadata role", async () => {
    const count = declared(await readStylesheet("remote.css"), ".app-header__team-count")
    expect(count["font-family"]).toBe("var(--yc-font-mono)")
    expect(count["font-variant-numeric"]).toBe("tabular-nums")
  })
})

describe("tonal status strips", () => {
  test("presents connection, notice and consent strips without rules or inline bars", async () => {
    const css = await readStylesheet("remote.css")
    for (const selector of [".app .status-strip", ".app .notice-strip", ".telemetry-consent"]) {
      const strip = declared(css, selector)
      expect(strip["border-radius"]).toBe("var(--yc-radius-lg)")
      expect(strip["border-inline-start"]).toBeUndefined()
      expect(strip["border-block-end"]).toBeUndefined()
    }
    expect(declared(css, ".app .status-strip--attention").background).toBe("var(--yc-yellow-soft)")
    expect(declared(css, ".app .status-strip--offline").background).toBe("var(--yc-danger-soft)")
    expect(declared(css, ".app .notice-strip--warning").background).toBe("var(--yc-yellow-soft)")
  })

  test("keeps the strip text and actions", async () => {
    const source = await shell()
    expect(source).toContain("Help improve YCoding")
    expect(source).toContain("onClick={() => void remote.store.setTelemetryConsent(true)}")
    expect(source).toContain("Open settings")
  })
})

describe("W89 flat sign-in and invitation column", () => {
  test("lifts the top bar out of the panel and keeps the single-line access key field", async () => {
    const [source, invitePage] = await Promise.all([shell(), invite()])
    const screen = source.slice(source.indexOf("function SignInScreen"), source.indexOf("const noSessionTitle"))
    expect(screen.indexOf('class="sign-in__bar"')).toBeGreaterThan(-1)
    expect(screen.indexOf('class="sign-in__bar"')).toBeLessThan(screen.indexOf('class="sign-in__panel"'))
    expect(screen.slice(screen.indexOf('class="sign-in__panel"'))).not.toContain("sign-in__bar")
    expect(screen).toContain('class="sign-in__or"')
    expect(screen).toContain('id="remote-access-key"')
    expect(screen).toContain('autocapitalize="characters"')
    expect(screen).not.toContain("<textarea")
    expect(invitePage.indexOf('class="sign-in__bar"')).toBeLessThan(invitePage.indexOf('class="sign-in__panel"'))
    expect(invitePage).toContain("Accept to create your remote account and its access key.")
  })

  test("draws no panel boundary and shows errors as rounded tonal notes with an icon", async () => {
    const css = await readStylesheet("remote.css")
    const panel = declared(css, ".sign-in__panel")
    boundaryFree(panel)
    expect(panel.background).toBeUndefined()
    expect(panel["inline-size"]).toContain("420px")
    expect(declared(css, ".sign-in__bar")["border-block-end"]).toBeUndefined()
    const error = declared(css, ".sign-in__error")
    expect(error["border-radius"]).toBe("var(--yc-radius-lg)")
    expect(error["border-inline-start"]).toBeUndefined()
    expect(error.background).toBe("var(--yc-danger-soft)")
    expect(await invite()).toContain('<Icon name="alert" size={16} />')
  })
})

describe("open Sessions rows", () => {
  test("draws the Sessions table without enclosing frames or row rules", async () => {
    const css = await readStylesheet("remote.css")
    boundaryFree(declared(css, ".sessions-results"))
    expect(declared(css, ".sessions-table__row").background).toBe("transparent")
    const head = declared(css, ".sessions-table__head")
    expect(head.background).toBe("transparent")
    expect(head["border-block-end"]).toBeUndefined()
    expect(declared(css, ".sessions-table__row")["border-block-end"]).toBeUndefined()
    expect(declared(css, ".sessions-table__row")["border-radius"]).toBe("var(--yc-radius-lg)")
    expect(declared(css, ".session-row--active").background).toBe("var(--yc-green-soft)")
    expect(declared(css, ".session-row--active")["border-radius"]).toBe("var(--yc-radius-lg)")
  })

  test("keeps windowed rows keyed and measured so they grow with their content", async () => {
    const source = await shell()
    expect(source).toContain("createRowVirtualizer")
    expect(source).toContain("ref={props.measure}")
    const css = await readStylesheet("remote.css")
    expect(declared(css, ".sessions-table__row")["min-block-size"] ?? "").not.toMatch(/^\d+px$/)
    expect(declared(css, ".sessions-table__row").height).toBeUndefined()
  })

  test("shows status filters as tonal segmented pills", async () => {
    const css = await readStylesheet("remote.css")
    const option = declared(css, ".session-filters__option")
    expect(option["border-radius"]).toBe("var(--yc-radius-pill)")
    expect(option["border-block-end"]).toBeUndefined()
    const active = declared(css, ".session-filters__option--active")
    expect(active["border-block-end-color"]).toBeUndefined()
    expect(active.background).toBe("var(--yc-green-soft)")
  })
})

describe("W90 new-session outcome strip", () => {
  test("states failed or unknown creation on a rounded semantic plane", async () => {
    const css = await readStylesheet("remote.css")
    const outcome = declared(css, ".new-session__outcome")
    expect(outcome["border-radius"]).toBe("var(--yc-radius-lg)")
    expect(outcome["border-inline-start"]).toBeUndefined()
    expect(declared(css, '.new-session__outcome[role="alert"]').background).toBe("var(--yc-danger-soft)")
    expect(declared(css, ".new-session__outcome.new-session__outcome--unknown[role=\"alert\"]").background).toBe("var(--yc-yellow-soft)")
  })
})

describe("W83 flat request forms", () => {
  test("draws question choices as borderless rounded tonal options", async () => {
    const css = await readStylesheet("remote.css")
    const option = declared(css, ".question__option")
    expect(option.border).toBe("0")
    expect(option["border-radius"]).toBe("var(--yc-radius-lg)")
    expect(option["border-block-end"]).toBeUndefined()
    expect(option["min-block-size"]).toBe("var(--yc-hit-min)")
    expect(declared(css, ".question__option + .question__option")["margin-block-start"]).toBeUndefined()
    expect(declared(css, ".question__option:first-of-type")["border-start-start-radius"]).toBeUndefined()
    expect(declared(css, ".question__option:last-of-type")["border-end-end-radius"]).toBeUndefined()
    const checked = declared(css, ".question__option:has(input:checked)")
    expect(checked.background).toBe("var(--yc-green-soft)")
    expect(checked["box-shadow"]).toBeUndefined()
    expect(checked["border-inline-start-color"]).toBeUndefined()
    expect(checked["font-weight"]).toBe("var(--yc-weight-semibold)")
  })

  test("separates questions with whitespace and keeps the field boundary and 44px target", async () => {
    const css = await readStylesheet("remote.css")
    boundaryFree(declared(css, ".question"))
    boundaryFree(declared(css, ".fieldset"))
    expect(declared(css, ".question + .question")["border-block-start"]).toBeUndefined()
    const field = declared(css, ".question__custom input")
    expect(field.border).toBe("var(--yc-border-width) solid var(--yc-border-strong)")
    expect(field["min-block-size"]).toBe("var(--yc-control-h)")
  })

  test("draws decision grades as tonal rows and leaves the hard-review outline alone", async () => {
    const css = await readStylesheet("remote.css")
    const grade = declared(css, ".decision-grades li")
    expect(grade.border).toBe("0")
    expect(grade["border-radius"]).toBe("var(--yc-radius-lg)")
    expect(grade["border-block-end"]).toBeUndefined()
    expect(declared(css, '.decision-grades li[data-selected="true"]').background).toBe("var(--yc-green-soft)")
    const hard = declared(css, ".request--hard")
    expect(hard.border).toBe("2px solid var(--yc-danger)")
    expect(hard["box-shadow"]).toBe("0 0 0 3px color-mix(in srgb, var(--yc-danger) 18%, transparent)")
  })
})

describe("tonal Sessions status labels", () => {
  test("shows status words inside soft pills without changing shared chip behavior", async () => {
    const css = await readStylesheet("remote.css")
    for (const selector of [".sessions-table__status .chip", ".session-row__status .chip"]) {
      const chip = declared(css, selector)
      expect(chip.border).toBe("0")
      expect(chip["border-radius"]).toBe("var(--yc-radius-pill)")
      expect(chip.background).toBe("var(--yc-surface)")
      expect(chip.padding).toBe("var(--yc-space-1) var(--yc-space-2)")
      expect(chip["font-weight"]).toBe("var(--yc-weight-semibold)")
    }
    const shared = await Bun.file(new URL("../../styles/base.css", import.meta.url)).text()
    expect(shared).toContain("border-radius: var(--yc-radius-pill);")
  })

  test("keeps the status label non-interactive so no boundary is owed", async () => {
    const chip = await Bun.file(new URL("../../ui/chip.tsx", import.meta.url)).text()
    expect(chip).toContain("<span class={`chip${tone()}`}>")
    expect(chip).not.toContain("<button")
  })
})

describe("borderless remote component planes", () => {
  test("keeps carousel cells, autonomy rows, notification rows and Office chrome free of spreadsheet rules", async () => {
    for (const [file, selectors] of [
      ["running-sessions.css", [".running-sessions__list", ".running-sessions__list li", ".running-sessions__item"]],
      ["autonomous-panel.css", [".autonomous__row", ".autonomous__failure"]],
      ["notifications.css", [".yc-notification", ".yc-notification-panel__head", ".yc-notification-panel__foot"]],
      ["dots-connection.css", [".dots-connection__facts > div"]],
      ["../office/office.css", [".office-roster", ".office-roster__list", ".office-roster__row", ".office-attention"]],
    ] as const) {
      const css = parseStylesheet(file, await Bun.file(new URL(file, import.meta.url)).text())
      for (const selector of selectors) {
        const plane = declared(css, selector)
        expect(plane["border-block"]).toBeUndefined()
        expect(plane["border-block-start"]).toBeUndefined()
        expect(plane["border-block-end"]).toBeUndefined()
        expect(plane["border-inline-start"]).toBeUndefined()
      }
      if (file === "running-sessions.css") {
        expect(declared(css, ".running-sessions__list").gap).toBe("var(--yc-space-3)")
        expect(declared(css, ".running-sessions__item").background).toBe("var(--yc-surface)")
        expect(declared(css, ".running-sessions__item")["border-radius"]).toBe("var(--yc-radius-lg)")
      }
    }
  })
})
