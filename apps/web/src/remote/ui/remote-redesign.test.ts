import { describe, expect, test } from "bun:test"
import type { AssistantPart, PendingRequestView, SessionView } from "../projection"
import type { SessionInfoView } from "../store"
import { partKey, toolPartExpanded } from "./conversation"
import {
  awaitsApproval,
  connectionStripView,
  filterSessions,
  queueRowView,
  reportedEvents,
  sessionChips,
  showsSessionRow,
  summarizeSession,
} from "./shell"

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
  fileChanges: [],
  activity: [],
  unhandledEvents: 0,
  ...patch,
})

describe("selected session row", () => {
  test("keeps its own row on the surfaces that carry the workspace", () => {
    expect(showsSessionRow("/remote", true)).toBe(true)
    expect(showsSessionRow("/remote/sessions", true)).toBe(true)
    expect(showsSessionRow("/remote/activity", true)).toBe(true)
  })

  test("is absent for settings, which names itself in the page head alone", () => {
    expect(showsSessionRow("/remote/settings", true)).toBe(false)
  })

  test("is absent without a selected session", () => {
    expect(showsSessionRow("/remote", false)).toBe(false)
  })
})

describe("reserved connection strip", () => {
  test("states the live connection and offers no recovery control while it is open", () => {
    const strip = connectionStripView({
      connection: { kind: "connected", deviceName: "Studio Mac" },
      transportKind: "open",
      activeDeviceID: "dev_studio",
      advertised: 3,
    })
    expect(strip.tone).toBe("online")
    expect(strip.body).toContain("Connected")
    expect(strip.body).toContain("Studio Mac")
    expect(strip.showReconnect).toBe(false)
    expect(strip.showSettings).toBe(false)
  })

  test("offers Reconnect for a device that stopped reporting", () => {
    const strip = connectionStripView({
      connection: { kind: "offline", deviceName: "Studio Mac" },
      transportKind: "closed",
      activeDeviceID: "dev_studio",
      advertised: 3,
    })
    expect(strip.tone).toBe("offline")
    expect(strip.body).toContain("Studio Mac is not reachable")
    expect(strip.showReconnect).toBe(true)
  })

  test("keeps the shipped retry while a connected device is re-connecting", () => {
    const strip = connectionStripView({
      connection: { kind: "connecting" },
      transportKind: "reconnecting",
      activeDeviceID: "dev_laptop",
      advertised: 3,
    })
    expect(strip.showReconnect).toBe(true)
  })

  test("offers nothing to retry before any device has reported", () => {
    const strip = connectionStripView({
      connection: { kind: "connecting" },
      transportKind: "connecting",
      activeDeviceID: "dev_laptop",
      advertised: 0,
    })
    expect(strip.showReconnect).toBe(false)
  })

  test("sends a signed-in account with no enrolled machine to settings", () => {
    const strip = connectionStripView({
      connection: { kind: "no-device-enrolled" },
      transportKind: "idle",
      advertised: 0,
    })
    expect(strip.showSettings).toBe(true)
    expect(strip.showReconnect).toBe(false)
  })

  test("never offers a reconnect without a device to reconnect", () => {
    const strip = connectionStripView({
      connection: { kind: "signed-out" },
      transportKind: "closed",
      advertised: 0,
    })
    expect(strip.showReconnect).toBe(false)
    expect(strip.showSettings).toBe(false)
    expect(strip.tone).toBe("offline")
  })

  test("reports a deployment without remote access as unavailable, not offline", () => {
    const strip = connectionStripView({
      connection: { kind: "unavailable", reason: "not-configured" },
      transportKind: "idle",
      advertised: 0,
    })
    expect(strip.tone).toBe("attention")
    expect(strip.showSettings).toBe(true)
    expect(strip.body).toContain("not available yet")
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

describe("waiting request row", () => {
  test("summarises a permission request", () => {
    const row = queueRowView({
      kind: "permission",
      id: "per_1",
      action: "shell",
      resources: ["bun test *"],
      askedAt: 0,
    } satisfies PendingRequestView)
    expect(row.icon).toBe("shield")
    expect(row.kind).toBe("Permission")
    expect(row.title).toBe("shell on bun test *")
    expect(row.detail).toBe("waits for a decision")
  })

  test("names a hard guardrail review as a human decision", () => {
    const row = queueRowView({
      kind: "guardrail",
      id: "grq_1",
      sessionID: "ses_a",
      action: "rm -rf build",
      resources: ["build"],
      reason: "Recursive deletion needs a human decision",
      hardReview: true,
      askedAt: 0,
    } satisfies PendingRequestView)
    expect(row.icon).toBe("alert")
    expect(row.kind).toBe("Guardrail review (human decision required)")
    expect(row.title).toBe("rm -rf build")
    expect(row.detail).toBe("Recursive deletion needs a human decision")
  })

  test("summarises a question form", () => {
    const row = queueRowView({
      kind: "form",
      id: "frm_1",
      form: { id: "frm_1", sessionID: "ses_a", title: "Scope", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", title: "Reload what?" }] },
      askedAt: 0,
    } satisfies PendingRequestView)
    expect(row.icon).toBe("chat")
    expect(row.kind).toBe("Question")
    expect(row.title).toBe("Scope")
    expect(row.detail).toBe("waits for your answer")
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

  test("adds the attention chip after the reported status without changing it", () => {
    const chips = sessionChips(
      session({ running: true }),
      view({ requests: [permission], autonomy: { mode: "normal", yolo: 2 } }),
    )
    expect(chips.map((chip) => chip.label)).toEqual(["Running", "Standard", "Guardrails enforced", "Waiting for approval"])
    expect(chips.at(-1)?.tone).toBe("attention")
  })

  test("keeps the unloaded session's chips exactly as the device reported them", () => {
    const chips = sessionChips(session({ running: true }), undefined)
    expect(chips.map((chip) => chip.label)).toEqual(["Running"])
  })
})

describe("reported events", () => {
  const assistant = {
    kind: "assistant" as const,
    id: "msg_a",
    created: 20,
    parts: [
      { kind: "text" as const, ordinal: 0, text: "done" },
      { kind: "tool" as const, callID: "call_read", name: "read", status: "completed" as const, content: [] },
    ],
  }
  const shell = {
    kind: "shell" as const,
    id: "msg_shell",
    shellID: "sh_1",
    command: "bun test ./src",
    status: "exited",
    exit: 0,
    created: 30,
  }

  test("reports the events a snapshot-loaded session holds, not an empty panel", () => {
    const events = reportedEvents(
      view({
        messages: [assistant, shell],
        fileChanges: [{ path: "src/remote/store.ts", patch: "@@", additions: 18, deletions: 4 }],
        updatedAt: 40,
      }),
    )
    expect(events.map((event) => event.id)).toEqual(["tool-call_read", "shell-sh_1", "file-src/remote/store.ts"])
    expect(events.map((event) => event.kind)).toEqual(["tool", "terminal", "file"])
    expect(events[2]?.title).toBe("src/remote/store.ts")
    expect(events[2]?.detail).toBe("+18 −4")
    expect(events[1]?.detail).toBe("exited")
  })

  test("keeps the live row where the stream already reported the same event", () => {
    const events = reportedEvents(
      view({
        messages: [assistant],
        activity: [
          { id: "tool-call_read", kind: "tool", title: "read", status: "failed", at: 25 },
        ],
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe("failed")
  })

  test("orders the reported events the way they happened", () => {
    const events = reportedEvents(view({ messages: [shell, assistant], activity: [{ id: "late", kind: "status", title: "later", at: 40 }] }))
    expect(events.map((event) => event.id)).toEqual(["tool-call_read", "shell-sh_1", "late"])
  })

  test("reports nothing for a workspace with no selected session", () => {
    expect(reportedEvents(undefined)).toEqual([])
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
  test("opens a settled tool and leaves a running one closed", () => {
    expect(toolPartExpanded({ touched: false, manual: false, status: "completed" })).toBe(true)
    expect(toolPartExpanded({ touched: false, manual: true, status: "running" })).toBe(false)
  })

  test("keeps the reader's explicit toggle across a status change", () => {
    expect(toolPartExpanded({ touched: true, manual: false, status: "completed" })).toBe(false)
    expect(toolPartExpanded({ touched: true, manual: true, status: "running" })).toBe(true)
  })
})
