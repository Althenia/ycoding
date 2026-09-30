import { describe, expect, test } from "bun:test"
import type { AssistantPart, PendingRequestView, SessionView } from "../projection"
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
    expect(remoteSurfaceComposition("/remote", true)).toEqual({ showSessionRail: true, showComposer: true })
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
})

describe("pinned sessions", () => {
  test("lists pinned sessions first in pin order and keeps the rest in their order", () => {
    const listed = [
      session({ id: "ses_recent" }),
      session({ id: "ses_pinned_late", pinnedAt: 2_000 }),
      session({ id: "ses_older" }),
      session({ id: "ses_pinned_early", pinnedAt: 1_000 }),
    ]
    expect(filterSessions(listed, "").map((entry) => entry.id)).toEqual([
      "ses_pinned_early",
      "ses_pinned_late",
      "ses_recent",
      "ses_older",
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
      view({ autonomy: { mode: "goal", yolo: 0, goal: { text: "Ship it", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 5 } } }),
    )
    expect(summary.status).toBe("idle")
    expect(summary.autonomy).toBe("goal")
    expect(summary.guardrailsEnforced).toBe(true)
    expect(summary.agent).toBe("god")
    expect(summary.model).toBe("openai/gpt-6")
    expect(summary.updatedAt).toBe("2023-11-14T22:13:20.000Z")
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

  test("reports nothing for a session this client has not loaded", () => {
    expect(awaitsApproval(undefined, "ses_a")).toBe(false)
    expect(awaitsApproval(view({ id: "ses_other", requests: [permission] }), "ses_a")).toBe(false)
  })

  test("puts the pending approval first so compact session rows cannot hide it", () => {
    const chips = sessionChips(
      session({ running: true }),
      view({ requests: [permission], autonomy: { mode: "normal", yolo: 2 } }),
    )
    expect(chips.map((chip) => chip.label)).toEqual(["Waiting for approval", "Running", "Standard", "Guardrails enforced"])
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
