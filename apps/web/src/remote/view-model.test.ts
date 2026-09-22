import { describe, expect, test } from "bun:test"
import type { ShellOutputFetch, ShellOutputView } from "./projection"
import {
  REMOTE_CAPABILITY_NAMES,
  accountReadState,
  accountSectionView,
  connectionBanner,
  createUnavailableRemoteViewModel,
  describeUnavailableReason,
  deviceAvailabilityView,
  enrollmentInstructions,
  sessionAvailabilityView,
  sessionStateChips,
  shellOutputPaging,
  summarizeConnection,
  type AccountReadState,
  type RemoteConnectionState,
  type RemoteSessionSummary,
} from "./view-model"

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
    expect(viewModel.activity).toHaveLength(0)
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
    guardrailsEnforced: true,
    ...overrides,
  })

  test("always reports mode and guardrail state when it is known", () => {
    const labels = sessionStateChips(session({})).map((chip) => chip.label)
    expect(labels).toContain("Standard")
    expect(labels).toContain("Guardrails enforced")
    expect(labels).not.toContain("Goal")
  })

  test("surfaces goal, yolo level, agent, and model when present", () => {
    const labels = sessionStateChips(
      session({ autonomy: "yolo", yoloLevel: 3, agent: "god", model: "openai/gpt-5", status: "running" }),
    ).map((chip) => chip.label)
    expect(labels).toContain("YOLO 3")
    expect(labels).toContain("god")
    expect(labels).toContain("openai/gpt-5")
    expect(labels).toContain("Running")
    expect(sessionStateChips(session({ autonomy: "goal" })).map((chip) => chip.label)).toContain("Goal")
  })

  test("marks automatic guardrails and blocked sessions as attention", () => {
    const chips = sessionStateChips(session({ guardrailsEnforced: false, status: "blocked" }))
    expect(chips.find((chip) => chip.label === "Guardrails auto")?.tone).toBe("attention")
    expect(chips.find((chip) => chip.label === "Waiting for approval")?.tone).toBe("attention")
  })

  test("omits unknown fields instead of inventing values", () => {
    const labels = sessionStateChips({ id: "session-2", title: "Untitled", status: "idle" }).map((chip) => chip.label)
    expect(labels).toEqual([])
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
  test("offers sign-in only after a definitive signed-out answer", () => {
    const reads: readonly AccountReadState[] = [
      { kind: "checking" },
      { kind: "unresolved", detail: "The account service could not be reached" },
      { kind: "unavailable", reason: "not-configured" },
      { kind: "signed-in", expiresAt: 1 },
    ]
    for (const read of reads) {
      const view = accountSectionView(read)
      expect(view.kind === "message" ? view.actions : []).not.toContain("sign-in")
    }
    const signedOut = accountSectionView({ kind: "signed-out" })
    expect(signedOut.kind === "message" ? signedOut.actions : []).toContain("sign-in")
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
        expect(text).not.toMatch(/no device is enrolled|no device enrolled/i)
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
    expect(view.title).toBe("No device is enrolled")
    expect(view.hint).toBe("No device is enrolled to this account yet.")
    expect(view.placeholder).toBe("No device enrolled")
    expect(view.selectable).toBe(false)
    expect(view.showSettings).toBe(true)
  })

  test("asks for a machine to be chosen when the account already has one", () => {
    const view = deviceAvailabilityView({ kind: "signed-in", expiresAt: 1 }, 2)
    expect(view.title).toBe("No device selected")
    expect(view.body).toMatch(/machine/i)
    expect(view.placeholder).toBe("Select a device")
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
    expect(view.title).toBe("No devices online")
    expect(view.body).toMatch(/not responding|offline|running YCoding/i)
    expect(view.placeholder).toBe("No devices online")
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
  test("keeps connection progress distinct from an empty connected backend", () => {
    expect(sessionAvailabilityView({ kind: "connecting" }, 0)).toEqual({
      title: "Loading sessions",
      body: "Connecting to the selected machine and loading its sessions.",
      loading: true,
    })
    expect(sessionAvailabilityView({ kind: "connected", deviceName: "Studio Mac" }, 0)).toEqual({
      title: "No sessions",
      body: "Start YCoding in your project folder on this machine.",
      loading: false,
    })
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
