import { describe, expect, test } from "bun:test"
import type { ShellOutputFetch, ShellOutputView } from "./projection"
import {
  latestPromptProcessing,
  promptReceipt,
  telemetryConsentNoticeView,
  REMOTE_CAPABILITY_NAMES,
  accountReadState,
  accountSectionView,
  capturedChangesVisible,
  cachedSessionsView,
  connectionBanner,
  createUnavailableRemoteViewModel,
  describeUnavailableReason,
  deviceAvailabilityView,
  devicePickerNote,
  remoteEntryView,
  enrollmentInstructions,
  sessionAvailabilityView,
  hasWaitingSession,
  carouselSessionStatus,
  sessionActivityGroup,
  sessionListRefreshNotice,
  sessionStateChips,
  keepAwakeIndicator,
  attachConfirmationValid,
  dotsConnectionView,
  shellOutputPaging,
  sessionProjectLabel,
  connectionLabel,
  summarizeConnection,
  workspaceLabels,
  workspaceDestination,
  type AccountReadState,
  type RemoteConnectionState,
  type RemoteSessionSummary,
} from "./view-model"

describe("Dots connection display", () => {
  const status = { access: { enabled: true, revision: 3 }, configuration: { ready: true, profile: "native-test" }, connection: { state: "connecting" as const, hostname: "test-computer" } }
  const input = { status, online: true, loading: false, refreshing: false, pending: false }
  test("separates access, configured profile and actual transport", () => {
    for (const state of ["unavailable", "off", "connecting", "connected", "error"] as const) {
      expect(dotsConnectionView({ ...input, status: { ...status, connection: { ...status.connection, state } } })).toMatchObject({
        computer: "test-computer", profile: "native-test", configuration: "Ready", access: "On", transport: { unavailable: "Unavailable", off: "Off", connecting: "Connecting", connected: "Connected", error: "Error" }[state], action: "Disconnect", canChange: true,
      })
    }
    expect(dotsConnectionView({ ...input, status: { ...status, access: { enabled: false, revision: 3 }, connection: { state: "connected" } } })).toMatchObject({ access: "Off", transport: "Connected", action: "Connect" })
  })
  test("keeps configuration and connection errors separate and permits disconnect when configuration breaks", () => {
    expect(dotsConnectionView({ ...input, status: { ...status, configuration: { ready: false, message: "Select an OAuth profile" }, connection: { state: "error", message: "Native transport stopped" } } })).toMatchObject({
      profile: "Unreported", configuration: "Not ready", configurationMessage: "Select an OAuth profile", transport: "Error", connectionMessage: "Native transport stopped", action: "Disconnect", canChange: true,
    })
    expect(dotsConnectionView({ ...input, status: { ...status, access: { enabled: false, revision: 3 }, configuration: { ready: false } } })).toMatchObject({ action: "Connect", canChange: false })
  })
  test("missing, pending, offline and failed reads never invent current access or permit changes", () => {
    expect(dotsConnectionView({ ...input, status: undefined })).toMatchObject({ access: "Unreported", transport: "Unreported", profile: "Unreported", canChange: false })
    for (const override of [{ online: false }, { loading: true }, { pending: true }, { error: "Read failed" }]) expect(dotsConnectionView({ ...input, ...override }).canChange).toBe(false)
    expect(dotsConnectionView({ ...input, pending: true }).notice).toBe("Changing Dots access…")
    expect(dotsConnectionView({ ...input, online: false }).notice).toContain("Reconnect")
    expect(dotsConnectionView({ ...input, error: "Read failed" }).notice).toContain("Refresh")
  })
  test("a background refresh keeps retained status actionable and is reported separately", () => {
    const attachable = { ...status, computer: { state: "detached" as const } }
    const refreshed = dotsConnectionView({ ...input, status: attachable, refreshing: true })
    expect(refreshed).toMatchObject({ refreshing: true, canChange: true, canAttach: true, notice: undefined })
    expect(dotsConnectionView({ ...input, status: attachable })).toMatchObject({ refreshing: false, canChange: true, canAttach: true })
    const initial = dotsConnectionView({ ...input, status: undefined, loading: true })
    expect(initial).toMatchObject({ refreshing: false, canChange: false, canAttach: false, notice: "Loading Dots connection…" })
    const blocked = (override: Partial<typeof input> & { error?: string }) => dotsConnectionView({ ...input, status: attachable, refreshing: true, ...override })
    expect(blocked({ pending: true })).toMatchObject({ canChange: false, canAttach: false, notice: "Changing Dots access…" })
    expect(blocked({ error: "Read failed" })).toMatchObject({ canChange: false, canAttach: false })
    expect(blocked({ online: false })).toMatchObject({ canChange: false, canAttach: false })
  })
  test("an attach confirmation survives refreshes and is invalidated only by a settled change of target, access, connectivity or read", () => {
    const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
    const detached = { ...status, computer: { state: "detached" as const, target } }
    const valid = (override: Partial<Parameters<typeof attachConfirmationValid>[0]> = {}) => attachConfirmationValid({ status: detached, online: true, target, ...override })
    expect(valid()).toBe(true)
    expect(valid({ status: { ...detached, computer: { state: "detached", target: { ...target } } } })).toBe(true)
    expect(valid({ status: { ...detached, computer: { state: "detached", target: { ...target, revision: "b".repeat(64) } } } })).toBe(false)
    expect(valid({ status: { ...detached, computer: { state: "detached" } } })).toBe(false)
    expect(valid({ status: { ...detached, computer: { state: "attached", target } } })).toBe(false)
    expect(valid({ status: { ...detached, access: { enabled: false, revision: 4 } } })).toBe(false)
    expect(valid({ status: undefined })).toBe(false)
    expect(valid({ online: false })).toBe(false)
    expect(valid({ error: "Read failed" })).toBe(false)
    expect(attachConfirmationValid({ status: { ...status, computer: { state: "detached" } }, online: true })).toBe(true)
  })
  test("shows this computer's executor only while access is on", () => {
    const view = (computer: { state: "attached" | "detached" | "unavailable"; message?: string } | undefined, enabled = true) =>
      dotsConnectionView({ ...input, status: { ...status, access: { enabled, revision: 3 }, ...(computer ? { computer } : {}) } })
    expect(view({ state: "attached" }).executor).toEqual({ label: "Attached" })
    expect(view({ state: "detached" }).executor).toEqual({ label: "Not attached" })
    expect(view({ state: "unavailable", message: "Executor is starting" }).executor).toEqual({ label: "Unavailable", message: "Executor is starting" })
    expect(view({ state: "attached", message: "Ignored when healthy" }).executor).toEqual({ label: "Attached", message: "Ignored when healthy" })
    expect(view({ state: "attached" }, false).executor).toBeUndefined()
    expect(view({ state: "detached" }, false).executor).toBeUndefined()
    expect(view(undefined).executor).toBeUndefined()
    expect(dotsConnectionView({ ...input, status: undefined }).executor).toBeUndefined()
  })
  test("offers attach only when detached, idle and online, and states the consequence", () => {
    const view = (state: "attached" | "detached" | "unavailable", override: Partial<typeof input> & { error?: string } = {}, enabled = true) =>
      dotsConnectionView({ ...input, ...override, status: { ...status, access: { enabled, revision: 3 }, computer: { state } } })
    expect(view("detached")).toMatchObject({ canAttach: true, attachAction: "Use this computer for Dots tasks" })
    expect(view("detached").attachConfirmation).toContain("detach")
    expect(view("detached").attachConfirmation).toContain("other computers")
    expect(view("attached").canAttach).toBe(false)
    expect(view("unavailable").canAttach).toBe(false)
    expect(view("detached", {}, false).canAttach).toBe(false)
    for (const override of [{ online: false }, { loading: true }, { pending: true }, { error: "Read failed" }]) expect(view("detached", override).canAttach).toBe(false)
    expect(dotsConnectionView({ ...input, status: { ...status } }).canAttach).toBe(false)
    expect(dotsConnectionView({ ...input, status: undefined }).canAttach).toBe(false)
  })
})

test("keep-awake chrome is absent until settled or off and distinguishes active, held, unsupported, and failed states", () => {
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", lid: "on", display: "on", activity: "error" } })).toMatchObject({ label: "keep-awake on · lid held · display on · activity error", tone: "danger" })
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", lid: "on", activity: "unsupported" } })).toMatchObject({ tone: "attention" })
  for (const read of ["idle", "loading"] as const) expect(keepAwakeIndicator({ read })).toBeUndefined()
  expect(keepAwakeIndicator({ read: "ready", status: { state: "off" } })).toBeUndefined()
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", manual: true, lid: "on" } })).toMatchObject({ label: "keep-awake on · lid held", tone: "success" })
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", manual: false, sleepHold: true, lid: "held" } })).toMatchObject({ label: "keep-awake on · lid held · sleep held", tone: "success" })
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", lid: "off" } })?.label).toBe("keep-awake on · lid off")
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on" } })?.label).toBe("keep-awake on · lid unreported")
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", lid: "error" } })).toMatchObject({ label: "keep-awake on · lid error", tone: "danger" })
  expect(keepAwakeIndicator({ read: "ready", status: { state: "on", lid: "unsupported" } })).toMatchObject({ label: "keep-awake on · lid unsupported", tone: "attention" })
  expect(keepAwakeIndicator({ read: "ready", status: { state: "error", message: "Inhibitor stopped" } })).toMatchObject({ label: "keep-awake error", tone: "danger", detail: "Inhibitor stopped" })
  expect(keepAwakeIndicator({ read: "ready", status: { state: "unsupported" } })).toMatchObject({ label: "keep-awake unsupported", tone: "attention" })
  expect(keepAwakeIndicator({ read: "error", message: "Read failed" })).toMatchObject({ label: "keep-awake error", tone: "danger", detail: "Read failed" })
})

test("Focus navigation groups Session creation and detail under Sessions", () => {
  for (const path of ["/remote", "/remote/session", "/remote/sessions"]) expect(workspaceDestination(path)).toBe("/remote/sessions")
  expect(workspaceDestination("/remote/usage")).toBe("/remote/usage")
  expect(workspaceDestination("/remote/settings")).toBe("/remote/settings")
})

test("carousel status prioritizes waiting over execution and excludes failure-only attention", () => {
  expect(carouselSessionStatus({ attention: true, running: true })).toBe("Waiting for you")
  expect(carouselSessionStatus({ attention: true })).toBe("Waiting for you")
  expect(carouselSessionStatus({ attention: true, failed: true, running: true })).toBe("Running")
  expect(carouselSessionStatus({ attention: true, failed: true })).toBeUndefined()
  expect(sessionActivityGroup({ attention: true, running: true })).toBe("waiting")
  expect(sessionActivityGroup({ running: true })).toBe("running")
  expect(sessionActivityGroup({ attention: true, failed: true })).toBe("idle")
})

test("Session list refresh notices identify unsupported anchor fields without mislabeling other failures", () => {
  for (const field of ["around", "before"])
    expect(sessionListRefreshNotice({ status: "failed", error: { code: "invalid_message", message: `Unknown input field "${field}"` } })).toContain("Update YCoding on this machine")
  expect(sessionListRefreshNotice({ status: "failed", error: { code: "internal_error", message: "Temporary inventory failure" } })).toBe("Session list refresh: Temporary inventory failure")
  expect(sessionListRefreshNotice({ status: "failed", error: { code: "invalid_message", message: "Invalid cursor" } })).toBe("Session list refresh: Invalid cursor")
})

test("carousel status shows lost background results as a loss warning that waiting still outranks", () => {
  expect(carouselSessionStatus({ lost: true })).toBe("Background result lost")
  expect(carouselSessionStatus({ lost: true, running: true })).toBe("Background result lost")
  expect(carouselSessionStatus({ attention: true, lost: true })).toBe("Background result lost")
  expect(carouselSessionStatus({ attention: true })).toBe("Waiting for you")
  expect(sessionActivityGroup({ attention: true, lost: true })).toBe("idle")
  expect(sessionActivityGroup({ attention: true, lost: true, running: true })).toBe("running")
})

test("only attention that is neither failed nor lost counts as a waiting Session", () => {
  const status = (attention: string[], failed: string[], lost: string[]) => ({ attention: new Set(attention), failed: new Set(failed), lost: new Set(lost) })
  expect(hasWaitingSession(status(["ses_a"], [], ["ses_a"]))).toBe(false)
  expect(hasWaitingSession(status(["ses_a", "ses_b"], ["ses_a"], ["ses_b"]))).toBe(false)
  expect(hasWaitingSession(status(["ses_a", "ses_b"], [], ["ses_b"]))).toBe(true)
})

test("prompt receipts distinguish sending from failed and unknown delivery", () => {
  expect(promptReceipt("pending", "steer", { state: "sending" }).label).toBe("Sending prompt")
  expect(promptReceipt("pending", "queue", { state: "unknown" }).label).toBe("Outcome unknown")
  expect(promptReceipt("pending", "queue", { state: "failed" }).label).toBe("Send failed")
})

test("telemetry consent notice appears only for connected undecided machines", () => {
  expect(telemetryConsentNoticeView({ status: "undecided" }, true)).toBe(true)
  expect(telemetryConsentNoticeView({ status: "undecided", error: "failure" }, true)).toBe(true)
  for (const status of ["enabled", "disabled", "unsupported", "failed", "loading"])
    expect(telemetryConsentNoticeView({ status }, true)).toBe(false)
  expect(telemetryConsentNoticeView({ status: "undecided" }, false)).toBe(false)
})

test("prompt receipts preserve queue and read facts over late send outcomes", () => {
  expect(promptReceipt("pending", "queue").text).toBe("Queued")
  expect(promptReceipt("pending", "steer").text).toBe("Processing · steer")
  expect(promptReceipt("promoted", "steer").label).toBe("Sent, not yet read")
  for (const state of ["sending", "failed", "unknown"] as const) {
    expect(promptReceipt("consumed", "steer", { state })).toEqual({ label: "Read by YCoding", text: "Read", mark: "✓✓" })
  }
})

test("the latest user prompt keeps a processing receipt while the session runs", () => {
  const messages = [{ kind: "user", id: "older" }, { kind: "assistant", id: "reply" }, { kind: "user", id: "latest" }]
  expect(latestPromptProcessing("running", messages, "latest")).toBe(true)
  expect(latestPromptProcessing("running", messages, "older")).toBe(false)
  for (const status of ["idle", "failed", "interrupted", undefined] as const) expect(latestPromptProcessing(status, messages, "latest")).toBe(false)
  expect(promptReceipt("pending", "steer", { state: "sending" }, true)).toMatchObject({ label: "Sending prompt", text: "Sending" })
  expect(promptReceipt("pending", "steer", undefined, true).text).toBe("Processing · steer")
  expect(promptReceipt("pending", "queue", undefined, true)).toMatchObject({ label: "Queued for processing", text: "Queued" })
  expect(promptReceipt("promoted", "steer", undefined, true)).toEqual({ label: "Processing prompt", text: "Processing", mark: "◷" })
  expect(promptReceipt("consumed", "steer", undefined, true)).toEqual({ label: "Processing prompt", text: "Processing", mark: "◷" })
  expect(promptReceipt("promoted", "queue", undefined, false).text).toBe("Sent")
  expect(promptReceipt("consumed", "steer", undefined, false)).toEqual({ label: "Read by YCoding", text: "Read", mark: "✓✓" })
})

const connectionStates: readonly RemoteConnectionState[] = [
  { kind: "loading" },
  { kind: "unavailable", reason: "not-configured" },
  { kind: "unavailable", reason: "no-connection" },
  { kind: "signed-out" },
  { kind: "no-device-enrolled" },
  { kind: "no-device-selected" },
  { kind: "connecting" },
  { kind: "connected", deviceName: "Studio Mac" },
  { kind: "offline", deviceName: "Studio Mac" },
  { kind: "error", message: "Relay closed the connection." },
]

describe("createUnavailableRemoteViewModel", () => {
  test("reports the unavailable connection with no fabricated data", () => {
    const viewModel = createUnavailableRemoteViewModel()
    expect(viewModel.connection).toEqual({ kind: "unavailable", reason: "not-configured" })
    expect(viewModel.devices).toHaveLength(0)
    expect(viewModel.sessions).toHaveLength(0)
    expect(viewModel.messages).toHaveLength(0)
    expect(viewModel.approvals).toHaveLength(0)
    expect(viewModel.activeDeviceId).toBeUndefined()
    expect(viewModel.activeSessionId).toBeUndefined()
  })

  test("marks every capability unavailable so no control claims to work", () => {
    const viewModel = createUnavailableRemoteViewModel()
    for (const capability of REMOTE_CAPABILITY_NAMES) {
      expect(viewModel.capabilities[capability]).toBe(false)
    }
  })

  test("answers every action with the unavailable reason", () => {
    const viewModel = createUnavailableRemoteViewModel()
    expect(viewModel.actions.signIn()).toEqual({ ok: false, reason: "not-configured" })
    expect(viewModel.actions.reconnect()).toEqual({ ok: false, reason: "not-configured" })
    expect(viewModel.actions.selectDevice("device-1")).toEqual({ ok: false, reason: "not-configured" })
    expect(viewModel.actions.selectSession("session-1")).toEqual({ ok: false, reason: "not-configured" })
    expect(viewModel.actions.interrupt()).toEqual({ ok: false, reason: "not-configured" })
    expect(viewModel.actions.replyToApproval("approval-1", "once")).toEqual({ ok: false, reason: "not-configured" })
  })

  test("rejects an empty prompt before the unavailable check", () => {
    const viewModel = createUnavailableRemoteViewModel()
    expect(viewModel.actions.sendPrompt({ text: "   ", delivery: "steer" })).toEqual({
      ok: false,
      reason: "empty-prompt",
    })
    expect(viewModel.actions.sendPrompt({ text: "Continue the migration", delivery: "steer" })).toEqual({
      ok: false,
      reason: "not-configured",
    })
  })

  test("carries an explicit reason for hosts that cannot reach a relay at all", () => {
    expect(createUnavailableRemoteViewModel("no-connection").connection).toEqual({
      kind: "unavailable",
      reason: "no-connection",
    })
  })
})

describe("capturedChangesVisible", () => {
  const messages = [{ id: "msg_user_1", kind: "user" }, { id: "msg_reply_1", kind: "assistant" }, { id: "msg_user_2", kind: "user" }, { id: "msg_reply_2", kind: "assistant" }]
  test("holds only the unfinished prompt segment's card while the Session runs", () => {
    expect(capturedChangesVisible("running", messages, "msg_reply_2")).toBe(false)
    expect(capturedChangesVisible("running", messages, "msg_reply_1")).toBe(true)
    expect(capturedChangesVisible("running", messages, "msg_missing")).toBe(false)
  })
  test("shows every segment once the Session settles and nothing before its status is known", () => {
    for (const status of ["idle", "interrupted", "failed"] as const) {
      expect(capturedChangesVisible(status, messages, "msg_reply_2")).toBe(true)
      expect(capturedChangesVisible(status, messages, "msg_reply_1")).toBe(true)
    }
    expect(capturedChangesVisible(undefined, messages, "msg_reply_1")).toBe(false)
  })
})

describe("connectionLabel", () => {
  const connected = { kind: "connected", deviceName: "Studio Mac" } as const

  test("appends the measured round trip to the connected label", () => {
    expect(connectionLabel(connected, { kind: "open", rttMs: 42 })).toBe("Connected · 42 ms")
  })

  test("leaves the label unchanged without a sample or an open transport", () => {
    expect(connectionLabel(connected, { kind: "open" })).toBe("Connected")
    expect(connectionLabel(connected, { kind: "reconnecting", attempt: 1, delayMs: 500 })).toBe("Connected")
    expect(connectionLabel({ kind: "connecting" }, { kind: "open", rttMs: 42 })).toBe("Connecting")
  })
})

describe("summarizeConnection", () => {
  test("returns a text label and detail for every state", () => {
    for (const state of connectionStates) {
      const summary = summarizeConnection(state)
      expect(summary.label.length).toBeGreaterThan(0)
      expect(summary.detail.length).toBeGreaterThan(0)
      expect(["online", "offline", "pending", "attention"]).toContain(summary.tone)
    }
  })

  test("distinguishes connected, pending, and failure states", () => {
    expect(summarizeConnection({ kind: "connected", deviceName: "Studio Mac" })).toMatchObject({ tone: "online" })
    expect(summarizeConnection({ kind: "connecting" })).toMatchObject({ tone: "pending" })
    expect(summarizeConnection({ kind: "loading" })).toMatchObject({ tone: "pending" })
    expect(summarizeConnection({ kind: "signed-out" })).toMatchObject({ tone: "offline" })
    expect(summarizeConnection({ kind: "offline", deviceName: "Studio Mac" })).toMatchObject({ tone: "offline" })
    expect(summarizeConnection({ kind: "error", message: "boom" })).toMatchObject({ tone: "attention" })
    expect(summarizeConnection({ kind: "unavailable", reason: "not-configured" })).toMatchObject({
      tone: "attention",
    })
  })
})

describe("sessionStateChips", () => {
  const session = (overrides: Partial<RemoteSessionSummary>): RemoteSessionSummary => ({
    id: "session-1",
    title: "Migrate the storage layer",
    status: "idle",
    autonomy: "normal",
    ...overrides,
  })

  const manualAll = { permissions: "manual", guardrails: "manual", answers: "manual" } as const

  test("always reports the Autonomous state when autonomy is known and never invents a guardrail chip", () => {
    const labels = sessionStateChips(session(manualAll)).map((chip) => chip.label)
    expect(labels).toContain("Autonomous Manual")
    expect(labels).not.toContain("goal")
    expect(labels.some((label) => label.startsWith("Guardrails"))).toBe(false)
  })

  test("reports effective category modes in heading order before goal and sleep", () => {
    expect(sessionStateChips(session({ permissions: "yolo", guardrails: "yolo", answers: "yolo", goalActive: true, asleep: true })))
      .toEqual([{ label: "Autonomous YOLO", tone: "attention" }, { label: "goal", tone: "neutral" }, { label: "asleep", tone: "success" }])
    expect(sessionStateChips(session({ permissions: "auto", guardrails: "auto", answers: "auto" }))).toEqual([{ label: "Autonomous Auto", tone: "neutral" }])
    expect(sessionStateChips(session({ permissions: "auto", guardrails: "yolo", answers: "manual", asleep: true })))
      .toEqual([{ label: "Permissions Auto", tone: "neutral" }, { label: "Guardrails YOLO", tone: "attention" }, { label: "Answers Manual", tone: "neutral" }, { label: "asleep", tone: "success" }])
    expect(sessionStateChips(session({ ...manualAll, asleep: true })).map((chip) => chip.label)).toEqual(["Autonomous Manual", "asleep"])
    expect(sessionStateChips(session({ autonomy: undefined }))).toEqual([])
    expect(sessionStateChips(session({}))).toEqual([])
  })

  test("keeps session state chips separate from agent and model metadata", () => {
    const labels = sessionStateChips(
      session({ permissions: "yolo", guardrails: "yolo", answers: "yolo", agent: "god", model: "openai/gpt-5", status: "running" }),
    ).map((chip) => chip.label)
    expect(labels).toContain("Autonomous YOLO")
    expect(labels).not.toContain("god")
    expect(labels).not.toContain("openai/gpt-5")
    expect(labels).toContain("Running")
    expect(sessionStateChips(session({ goalActive: true })).map((chip) => chip.label)).toContain("goal")
  })

  test("marks blocked sessions as attention without a guardrail chip", () => {
    const chips = sessionStateChips(session({ status: "blocked" }))
    expect(chips.find((chip) => chip.label === "Waiting for approval")?.tone).toBe("attention")
    expect(chips.some((chip) => chip.label.startsWith("Guardrails"))).toBe(false)
  })

  test("leads a failed Session with a neutral Failed chip", () => {
    const chips = sessionStateChips(session({ ...manualAll, status: "failed", goalActive: true }))
    expect(chips[0]).toEqual({ label: "Failed", tone: "neutral" })
    expect(chips.map((chip) => chip.label)).toEqual(["Failed", "Autonomous Manual", "goal"])
  })

  test("only attention roots outside the failed set make the Sessions navigation wait", () => {
    const status = (attention: readonly string[], failed: readonly string[]) => ({ attention: new Set(attention), failed: new Set(failed), lost: new Set<string>() })
    expect(hasWaitingSession(undefined)).toBe(false)
    expect(hasWaitingSession(status([], []))).toBe(false)
    expect(hasWaitingSession(status(["ses_a", "ses_b"], ["ses_a", "ses_b"]))).toBe(false)
    expect(hasWaitingSession(status(["ses_a", "ses_b"], ["ses_a"]))).toBe(true)
  })

  test("omits unknown fields instead of inventing values", () => {
    const labels = sessionStateChips({ id: "session-2", title: "Untitled", status: "idle" }).map((chip) => chip.label)
    expect(labels).toEqual([])
  })
})

describe("sessionProjectLabel", () => {
  test("uses the basename of the reported directory without inventing a project name", () => {
    expect(sessionProjectLabel({ projectID: "prj_auth", directory: "/work/ycoding-engine/auth" })).toBe("auth")
    expect(sessionProjectLabel({ projectID: "prj_auth", directory: "/work/ycoding-engine/auth/" })).toBe("auth")
  })

  test("falls back only to reported identity", () => {
    expect(sessionProjectLabel({ projectID: "prj_auth" })).toBe("prj_auth")
    expect(sessionProjectLabel({})).toBe("Not reported")
  })
})

describe("workspaceLabels", () => {
  test("names each workspace by its reported name or folder, never its project hash", () => {
    const labels = workspaceLabels([
      { id: "w1", projectID: "12fd42415fd3fa9c65332dd8ad2128cc83499df6", directory: "/Users/me/.agents" },
      { id: "w2", projectID: "3e5803fe818b6335dfb7f71ec17671f3fa4cd538", directory: "/Users/me/Project/ycoding/", name: "YCoding" },
    ])
    expect(labels.get("w1")).toBe(".agents")
    expect(labels.get("w2")).toBe("YCoding")
  })

  test("adds the parent folder only where two workspaces would share a label", () => {
    const labels = workspaceLabels([
      { id: "w1", projectID: "p1", directory: "/Users/me/Project/ycoding" },
      { id: "w2", projectID: "p1", directory: "/Users/me/.local/share/ycoding/worktrees/repo_abc/office" },
      { id: "w3", projectID: "p2", directory: "/Users/me/Archive/ycoding" },
      { id: "w4", projectID: "p1", directory: "/Users/me/Project/ycoding/packages/schema" },
    ])
    expect(labels.get("w1")).toBe("ycoding (Project)")
    expect(labels.get("w2")).toBe("office")
    expect(labels.get("w3")).toBe("ycoding (Archive)")
    expect(labels.get("w4")).toBe("schema")
  })
})

describe("describeUnavailableReason", () => {
  test("explains each reason without claiming the feature works", () => {
    const configured = describeUnavailableReason("not-configured")
    const connection = describeUnavailableReason("no-connection")
    expect(configured.length).toBeGreaterThan(20)
    expect(connection.length).toBeGreaterThan(20)
    expect(configured).not.toBe(connection)
    expect(configured.toLowerCase()).toContain("not")
    expect(connection.toLowerCase()).toContain("not")
  })
})

describe("an account that has not answered yet", () => {
  test("never tells the browser it is signed out while the account read is still open", () => {
    const summary = summarizeConnection({ kind: "loading" })
    expect(summary.label).not.toMatch(/\bsigned out\b/i)
    expect(summary.detail).not.toMatch(/\bsign in\b/i)
    expect(summary.tone).toBe("pending")
    // A pending read is not a condition that needs the user's attention, so it shows
    // no banner; the signed-out banner belongs to a read that actually said so.
    expect(connectionBanner({ kind: "loading" })).toBeUndefined()
  })
})

describe("connectionBanner", () => {
  test("shows a banner with an explanation for every state that needs attention", () => {
    const needingBanner = connectionStates.filter(
      (state) => state.kind !== "connected" && state.kind !== "connecting" && state.kind !== "loading",
    )
    expect(needingBanner.length).toBe(connectionStates.length - 3)
    for (const state of needingBanner) {
      const banner = connectionBanner(state)
      expect(banner).toBeDefined()
      expect(banner?.title.length).toBeGreaterThan(0)
      expect(banner?.body.length).toBeGreaterThan(0)
    }
  })

  test("renders no banner while the connection is healthy or still opening", () => {
    expect(connectionBanner({ kind: "connected", deviceName: "Studio Mac" })).toBeUndefined()
    expect(connectionBanner({ kind: "connecting" })).toBeUndefined()
    expect(connectionBanner({ kind: "loading" })).toBeUndefined()
  })

  test("offers reconnect only where a retry is meaningful", () => {
    expect(connectionBanner({ kind: "offline", deviceName: "Studio Mac" })?.showReconnect).toBe(true)
    expect(connectionBanner({ kind: "error", message: "boom" })?.showReconnect).toBe(true)
    expect(connectionBanner({ kind: "unavailable", reason: "not-configured" })?.showReconnect).toBe(false)
  })

  test("offers the settings entry point only where the fix lives there", () => {
    expect(connectionBanner({ kind: "unavailable", reason: "not-configured" })?.showSettings).toBe(true)
    expect(connectionBanner({ kind: "no-device-enrolled" })?.showSettings).toBe(true)
    expect(connectionBanner({ kind: "signed-out" })?.showSettings).toBe(false)
    expect(connectionBanner({ kind: "offline", deviceName: "Studio Mac" })?.showSettings).toBe(false)
    expect(connectionBanner({ kind: "error", message: "boom" })?.showSettings).toBe(false)
  })
})

describe("a signed-in account with no usable device", () => {
  const deviceLess: readonly RemoteConnectionState[] = [{ kind: "no-device-enrolled" }, { kind: "no-device-selected" }]

  test("never asks a signed-in user to sign in", () => {
    for (const state of deviceLess) {
      const summary = summarizeConnection(state)
      const banner = connectionBanner(state)
      expect(summary.label).toBe("Not connected")
      expect(summary.tone).toBe("offline")
      expect(summary.detail).not.toMatch(/\bsign in\b/i)
      expect(banner).toBeDefined()
      expect(banner?.title === "Signed out").toBe(false)
      expect(banner?.body ?? "").not.toMatch(/\bsign in\b/i)
      expect(banner?.showReconnect).toBe(false)
    }
  })

  test("sends an account with no machine to enrollment", () => {
    expect(summarizeConnection({ kind: "no-device-enrolled" }).detail).toMatch(/enroll/i)
    expect(connectionBanner({ kind: "no-device-enrolled" })?.title).toBe("No machine enrolled")
    expect(connectionBanner({ kind: "no-device-enrolled" })?.body).toMatch(/enroll/i)
  })

  test("asks for a machine to be chosen when the account already has one", () => {
    expect(connectionBanner({ kind: "no-device-selected" })?.title).toBe("No machine selected")
    expect(connectionBanner({ kind: "no-device-selected" })?.body).toMatch(/machine/i)
  })
})

describe("accountReadState", () => {
  const readOf = (connection: RemoteConnectionState, owner?: { expiresAt: number }) =>
    accountReadState({ connection, owner })

  test("keeps the account unknown while the read is still open", () => {
    expect(readOf({ kind: "loading" })).toEqual({ kind: "checking" })
  })

  test("takes only an explicit signed-out answer as signed out", () => {
    expect(readOf({ kind: "signed-out" })).toEqual({ kind: "signed-out" })
    for (const state of connectionStates.filter((state) => state.kind !== "signed-out")) {
      expect(readOf(state).kind).not.toBe("signed-out")
    }
  })

  test("reports a failed read as unresolved instead of signed out", () => {
    expect(readOf({ kind: "error", message: "The account service could not be reached" })).toEqual({
      kind: "unresolved",
      detail: "The account service could not be reached",
    })
  })

  test("keeps the deployment's own unavailable reason", () => {
    expect(readOf({ kind: "unavailable", reason: "not-configured" })).toEqual({
      kind: "unavailable",
      reason: "not-configured",
    })
  })

  test("prefers a settled account over the connection state behind it", () => {
    expect(readOf({ kind: "offline", deviceName: "Studio Mac" }, { expiresAt: 42 })).toEqual({
      kind: "signed-in",
      expiresAt: 42,
    })
  })
})

describe("accountSectionView", () => {
  test("opens the sign-in screen only after a definitive signed-out answer", () => {
    const reads: readonly AccountReadState[] = [
      { kind: "checking" },
      { kind: "unresolved", detail: "The account service could not be reached" },
      { kind: "unavailable", reason: "not-configured" },
      { kind: "signed-in", expiresAt: 1 },
    ]
    expect(reads.map(remoteEntryView)).toEqual(["workspace", "workspace", "workspace", "workspace"])
    expect(remoteEntryView({ kind: "signed-out" })).toBe("sign-in")
  })

  test("says the account is still being checked instead of signing the browser out", () => {
    const view = accountSectionView({ kind: "checking" })
    const message = view.kind === "message" ? view : undefined
    expect(message?.detail).toMatch(/checking account/i)
    expect(message?.detail).not.toMatch(/not signed in|signed out/i)
    expect(message?.actions).toEqual([])
  })

  test("discloses an unresolved account and offers a meaningful retry", () => {
    const view = accountSectionView({ kind: "unresolved", detail: "The account service could not be reached" })
    const message = view.kind === "message" ? view : undefined
    expect(message?.detail).toContain("The account service could not be reached")
    expect(message?.detail).not.toMatch(/not signed in|signed out/i)
    expect(message?.actions).toEqual(["retry"])
  })

  test("keeps a failed sign-in callback visible while the account is unknown or signed out", () => {
    const authError = "Google sign-in did not complete."
    for (const read of [{ kind: "checking" }, { kind: "signed-out" }] as const) {
      const view = accountSectionView(read, authError)
      expect(view.kind === "message" ? view.detail : "").toContain(authError)
    }
  })

  test("keeps the configured unavailable screen for a deployment without remote access", () => {
    const view = accountSectionView({ kind: "unavailable", reason: "not-configured" })
    const message = view.kind === "message" ? view : undefined
    expect(message?.detail).toBe(describeUnavailableReason("not-configured"))
    expect(message?.actions).toEqual([])
  })

  test("returns the signed-in account with its session expiry", () => {
    expect(accountSectionView({ kind: "signed-in", expiresAt: 4_102_444_800_000 })).toEqual({
      kind: "signed-in",
      expiresAt: 4_102_444_800_000,
    })
  })
})

describe("deviceAvailabilityView", () => {
  const unansweredAccount: readonly AccountReadState[] = [
    { kind: "checking" },
    { kind: "unresolved", detail: "The account service could not be reached" },
    { kind: "unavailable", reason: "not-configured" },
    { kind: "signed-out" },
  ]

  test("never claims no machine is enrolled before the account answers", () => {
    for (const read of unansweredAccount) {
      const view = deviceAvailabilityView(read, 0)
      for (const text of [view.title, view.body, view.hint, view.placeholder]) {
        expect(text).not.toMatch(/no (device|machine) is enrolled|no (device|machine) enrolled/i)
      }
      expect(view.selectable).toBe(false)
    }
  })

  test("says the account is still being checked while the read is open", () => {
    const view = deviceAvailabilityView({ kind: "checking" }, 0)
    expect(view.placeholder).toMatch(/checking/i)
    expect(view.hint).toMatch(/checking/i)
    expect(view.showSettings).toBe(false)
  })

  test("keeps the enrolled-device copy once the account is known and has no machine", () => {
    const view = deviceAvailabilityView({ kind: "signed-in", expiresAt: 1 }, 0)
    expect(view.title).toBe("No machine is enrolled")
    expect(view.hint).toBe("No machine is enrolled to this account yet.")
    expect(view.placeholder).toBe("No machine enrolled")
    expect(view.selectable).toBe(false)
    expect(view.showSettings).toBe(true)
  })

  test("asks for a machine to be chosen when the account already has one", () => {
    const view = deviceAvailabilityView({ kind: "signed-in", expiresAt: 1 }, 2)
    expect(view.title).toBe("No machine selected")
    expect(view.body).toMatch(/machine/i)
    expect(view.placeholder).toBe("Select a machine")
    expect(view.selectable).toBe(true)
  })

  test("keeps a selected active enrollment that loses presence distinct from no selection", () => {
    const view = deviceAvailabilityView(
      { kind: "signed-in", expiresAt: 1 },
      2,
      {
        devices: [
          { id: "dev_studio", name: "Studio Mac", status: "active", online: false },
          { id: "dev_laptop", name: "Laptop", status: "active", online: true },
        ],
        activeDeviceID: "dev_studio",
      },
    )
    expect(view.title).toBe("Studio Mac is not reachable")
    expect(view.body).toMatch(/not reachable|offline|asleep/i)
    expect(`${view.title} ${view.body}`).not.toMatch(/no device selected|no sessions/i)
  })

  test("reports a listed-online selected machine whose local agent is unavailable as not reachable", () => {
    const view = deviceAvailabilityView(
      { kind: "signed-in", expiresAt: 1 },
      1,
      {
        devices: [{ id: "dev_studio", name: "Studio Mac", status: "active", online: true }],
        activeDeviceID: "dev_studio",
        unreachable: true,
      },
    )
    expect(view.title).toBe("Studio Mac is not reachable")
    expect(view.placeholder).toBe("Studio Mac")
  })

  test("distinguishes enrolled machines that are all offline from no enrollment", () => {
    const view = deviceAvailabilityView(
      { kind: "signed-in", expiresAt: 1 },
      2,
      {
        devices: [
          { id: "dev_studio", name: "Studio Mac", status: "active", online: false },
          { id: "dev_old", name: "Old Mac", status: "revoked", online: false },
        ],
      },
    )
    expect(view.title).toBe("No machines online")
    expect(view.body).toMatch(/not responding|offline|running YCoding/i)
    expect(view.body).not.toContain("ycoding remote connect")
    expect(view.command).toBe("ycoding remote connect")
    expect(view.placeholder).toBe("No machines online")
    expect(view.selectable).toBe(false)
  })

  test("names a selected enrollment whose access was revoked", () => {
    const view = deviceAvailabilityView(
      { kind: "signed-in", expiresAt: 1 },
      2,
      {
        devices: [
          { id: "dev_studio", name: "Studio Mac", status: "revoked", online: false },
          { id: "dev_laptop", name: "Laptop", status: "active", online: true },
        ],
        activeDeviceID: "dev_studio",
      },
    )
    expect(view.title).toBe("Studio Mac access was revoked")
    expect(view.body).toMatch(/choose another|enroll/i)
    expect(`${view.title} ${view.body}`).not.toMatch(/no device selected|no sessions/i)
  })
})

describe("sessionAvailabilityView", () => {
  test("keeps a connected empty-looking inventory pending until its first page settles", () => {
    expect(sessionAvailabilityView({ kind: "connected", deviceName: "Studio Mac" }, 0, "loading")?.title).toBe("Loading sessions")
    expect(sessionAvailabilityView({ kind: "error", message: "Session list failed" }, 0, "error")?.title).toBe("Session list unavailable")
  })
  test("keeps connection progress distinct from an empty connected backend", () => {
    expect(sessionAvailabilityView({ kind: "connecting" }, 0)).toEqual({
      title: "Loading sessions",
      body: "Connecting to the selected machine and loading its sessions.",
      loading: true,
    })
    expect(sessionAvailabilityView({ kind: "connected", deviceName: "Studio Mac" }, 0)).toEqual({
      title: "No sessions",
      body: "Start YCoding in your project folder on this machine.",
      note: "Every existing and future session on this machine appears here while it is connected.",
      loading: false,
    })
  })
})

describe("devicePickerNote", () => {
  test("points offline and revoked machines to device settings", () => {
    expect(
      devicePickerNote([
        { id: "dev_studio", name: "Studio Mac", status: "active", online: true },
        { id: "dev_sleep", name: "Sleeping Mac", status: "active", online: false },
        { id: "dev_old", name: "Old Mac", status: "revoked", online: false },
      ]),
    ).toBe("2 offline or revoked machines are managed in Settings → Devices.")
    expect(devicePickerNote([{ id: "dev_old", name: "Old Mac", status: "revoked", online: false }])).toBe(
      "1 offline or revoked machine is managed in Settings → Devices.",
    )
  })

  test("adds no note when every enrolled machine can be selected", () => {
    expect(devicePickerNote([{ id: "dev_studio", name: "Studio Mac", status: "active", online: true }])).toBeUndefined()
  })
})

describe("cachedSessionsView", () => {
  test("keeps an offline machine's last session list read-only until it reconnects", () => {
    expect(cachedSessionsView({ kind: "offline", deviceName: "Studio Mac" }, 3)).toEqual({
      note: "Last session list from Studio Mac. Sessions are read-only until it reconnects.",
    })
  })

  test("leaves a reachable machine's list interactive and an empty offline list to the offline state", () => {
    expect(cachedSessionsView({ kind: "connected", deviceName: "Studio Mac" }, 3)).toBeUndefined()
    expect(cachedSessionsView({ kind: "offline", deviceName: "Studio Mac" }, 0)).toBeUndefined()
  })
})

describe("enrollmentInstructions", () => {
  const enrollment = { enrollmentID: "enr_abc123", code: "AAAA-BBBB-CCCC-DDDD", expiresAt: 4_102_444_800_000 }

  test("pairs the enrollment id with the CLI command and keeps the one-use code separate", () => {
    const handoff = enrollmentInstructions(enrollment, "https://relay.example")
    expect(handoff.enrollmentID).toBe("enr_abc123")
    expect(handoff.code).toBe("AAAA-BBBB-CCCC-DDDD")
    expect(handoff.expiresAt).toBe(4_102_444_800_000)
    expect(handoff.command).toBe("ycoding remote enroll enr_abc123 --relay https://relay.example")
    expect(handoff.command).not.toContain("AAAA-BBBB-CCCC-DDDD")
  })

  test("keeps the code out of the command even when its groups resemble the enrollment id", () => {
    const handoff = enrollmentInstructions({ enrollmentID: "enr_A", code: "AAAA-BBBB-CCCC-DDDD-EEEE", expiresAt: 1 }, "https://another.example")
    expect(handoff.command).toContain("--relay https://another.example")
    expect(handoff.command).toContain("enr_A")
    for (const group of handoff.code.split("-")) {
      expect({ group, inCommand: handoff.command.includes(group) }).toEqual({ group, inCommand: false })
    }
  })
})

describe("shell output paging", () => {
  const page = (text: string, cursor: number, size: number): ShellOutputView => ({ text, cursor, size, truncated: false })
  const fetch = (state: ShellOutputFetch["state"]): ShellOutputFetch =>
    state === "idle" || state === "loading" || state === "stalled" ? { state } : { state, message: "not available" }

  test("offers a first read for a shell whose capture has never been read", () => {
    expect(shellOutputPaging(undefined, undefined)).toEqual({
      hasMore: true,
      canRequest: true,
      label: "Load output",
      status: { kind: "idle" },
    })
  })

  test("asks for the next page while the device holds more and stops at the captured end", () => {
    expect(shellOutputPaging(page("first", 5, 11), { state: "idle" })).toEqual({
      hasMore: true,
      canRequest: true,
      label: "Load more output",
      status: { kind: "idle" },
    })
    // A settled capture reports cursor equal to size, so nothing offers to read further.
    expect(shellOutputPaging(page("done", 4, 4), { state: "idle" })).toEqual({
      hasMore: false,
      canRequest: false,
      label: "Load more output",
      status: { kind: "idle" },
    })
  })

  test("shows a request in flight and refuses a second one before it settles", () => {
    const paging = shellOutputPaging(page("first", 5, 11), fetch("loading"))
    expect(paging.canRequest).toBe(false)
    expect(paging.hasMore).toBe(true)
    expect(paging.status).toEqual({ kind: "loading", label: "Loading output from the device…" })
  })

  test("turns the control into a retry when a page request failed", () => {
    const paging = shellOutputPaging(page("first", 5, 11), { state: "error", message: "This device does not offer paged terminal output." })
    expect(paging.label).toBe("Retry")
    expect(paging.canRequest).toBe(true)
    expect(paging.status).toEqual({ kind: "error", label: "This device does not offer paged terminal output." })
  })

  test("explains a page that added nothing while the device still holds bytes", () => {
    const paging = shellOutputPaging(page("first", 5, 11), fetch("stalled"))
    expect(paging.label).toBe("Retry")
    expect(paging.canRequest).toBe(true)
    expect(paging.status.kind).toBe("stalled")
    expect(paging.status.kind === "stalled" ? paging.status.label : "").toContain("incomplete character")
  })
})
