/**
 * View-model contract for the remote workspace.
 *
 * The public site ships an implementation that reports remote access as
 * unavailable; a host with a live relay replaces the view model instead of
 * rendering placeholder conversations. Every field is either real relay state
 * or absent.
 */

import type { CreateEnrollmentResponse } from "@ycoding-ai/remote"
import type { FormAnswerView, FormFieldView, FormView, ShellOutputFetch, ShellOutputView } from "./projection"

export type FormDraft = Readonly<Record<string, FormAnswerView[string] | undefined>>

export function formInputState(form: FormView, draft: FormDraft) {
  return form.fields.reduce<{ fields: FormFieldView[]; answer: FormAnswerView; valid: boolean }>((state, field) => {
    if (field.type !== "external" && field.when !== undefined && !field.when.every((when) => {
      const value = state.answer[when.key]
      if (value === undefined) return false
      const equal = Array.isArray(value) ? value.includes(when.value) : value === when.value
      return when.op === "eq" ? equal : !equal
    })) return state
    const value = Object.hasOwn(draft, field.key) ? draft[field.key] : field.type === "external" ? undefined : field.default
    return {
      fields: [...state.fields, field],
      answer: value === undefined ? state.answer : { ...state.answer, [field.key]: value },
      valid: state.valid && validFormValue(field, value),
    }
  }, { fields: [], answer: {}, valid: true })
}

function validFormValue(field: FormFieldView, value: FormAnswerView[string] | undefined): boolean {
  if (field.type === "external") return value === true
  if (value === undefined) return !field.required
  if (field.type === "boolean") return typeof value === "boolean"
  if (field.type === "number" || field.type === "integer") return typeof value === "number" && Number.isFinite(value)
    && (field.type !== "integer" || Number.isInteger(value))
    && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum)
  if (field.type === "multiselect") return Array.isArray(value)
    && value.every(item => typeof item === "string" && (field.custom || field.options.some(option => option.value === item)))
    && (!field.required || value.length > 0)
    && (field.minItems === undefined || value.length >= field.minItems) && (field.maxItems === undefined || value.length <= field.maxItems)
  if (typeof value !== "string" || (field.required && value.length === 0)) return false
  if (field.minLength !== undefined && value.length < field.minLength) return false
  if (field.maxLength !== undefined && value.length > field.maxLength) return false
  if (field.options && !field.custom && !field.options.some(option => option.value === value)) return false
  if (field.pattern !== undefined) {
    try {
      if (!new RegExp(field.pattern).test(value)) return false
    } catch { return false }
  }
  if (field.format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (field.format === "uri") return URL.canParse(value)
  if (field.format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  if (field.format === "date-time") return !Number.isNaN(new Date(value).getTime())
  return true
}

export function safeFormLink(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
}

export type RemoteUnavailableReason = "not-configured" | "no-connection"

export type RemoteConnectionState =
  /** No account read has settled yet, so this browser's sign-in state is unknown. */
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: RemoteUnavailableReason }
  | { readonly kind: "signed-out" }
  | { readonly kind: "no-device-enrolled" }
  | { readonly kind: "no-device-selected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly deviceName: string }
  | { readonly kind: "offline"; readonly deviceName: string }
  | { readonly kind: "error"; readonly message: string }

export const REMOTE_CAPABILITY_NAMES = [
  "signIn",
  "deviceSelection",
  "sessionSelection",
  "sendPrompt",
  "interrupt",
  "approvals",
  "notifications",
] as const

export type RemoteCapabilityName = (typeof REMOTE_CAPABILITY_NAMES)[number]
export type RemoteCapabilities = Readonly<Record<RemoteCapabilityName, boolean>>

export type RemoteDevice = {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly online: boolean
  readonly lastSeen?: string
}

export type RemoteAutonomyMode = "normal" | "yolo" | "goal"
export type RemoteSessionStatus = "running" | "idle" | "blocked" | "archived"

export type RemoteSessionSummary = {
  readonly id: string
  readonly title: string
  readonly status: RemoteSessionStatus
  readonly agent?: string
  readonly model?: string
  readonly autonomy?: RemoteAutonomyMode
  readonly yoloLevel?: number
  readonly guardrailsEnforced?: boolean
  readonly updatedAt?: string
}

export type RemoteToolStatus = "pending" | "running" | "completed" | "failed"

export type RemoteMessagePart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly name: string
      readonly status: RemoteToolStatus
      readonly summary?: string
    }
  | { readonly kind: "file"; readonly path: string; readonly summary?: string }
  | {
      readonly kind: "approval"
      readonly tool: string
      readonly action: string
      readonly status: "pending" | "approved" | "denied"
      readonly risk?: string
    }

export type RemoteMessage =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly parts: readonly RemoteMessagePart[] }
  | { readonly kind: "system"; readonly id: string; readonly text: string }

export type RemoteActivityItem = {
  readonly id: string
  readonly kind: "tool" | "terminal" | "file" | "approval"
  readonly title: string
  readonly detail?: string
  readonly status: RemoteToolStatus
}

export type RemoteApproval = {
  readonly id: string
  readonly tool: string
  readonly action: string
  readonly risk?: string
}

export type RemotePromptInput = {
  readonly text: string
  readonly delivery: "steer" | "queue"
}

export type RemoteActionFailureReason =
  | RemoteUnavailableReason
  | "empty-prompt"
  | "no-active-device"
  | "no-active-session"

export type RemoteActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: RemoteActionFailureReason }

export type RemoteActions = {
  readonly signIn: () => RemoteActionResult
  readonly reconnect: () => RemoteActionResult
  readonly selectDevice: (deviceId: string) => RemoteActionResult
  readonly selectSession: (sessionId: string) => RemoteActionResult
  readonly sendPrompt: (input: RemotePromptInput) => RemoteActionResult
  readonly interrupt: () => RemoteActionResult
  readonly replyToApproval: (approvalId: string, decision: "once" | "always" | "reject") => RemoteActionResult
}

export type RemoteViewModel = {
  readonly connection: RemoteConnectionState
  readonly capabilities: RemoteCapabilities
  readonly devices: readonly RemoteDevice[]
  readonly sessions: readonly RemoteSessionSummary[]
  readonly activeDeviceId?: string
  readonly activeSessionId?: string
  readonly messages: readonly RemoteMessage[]
  readonly activity: readonly RemoteActivityItem[]
  readonly approvals: readonly RemoteApproval[]
  readonly actions: RemoteActions
}

export type ConnectionTone = "online" | "offline" | "pending" | "attention"
export type ConnectionSummary = {
  readonly label: string
  readonly detail: string
  readonly tone: ConnectionTone
}

export type SessionChip = {
  readonly label: string
  readonly tone: "neutral" | "attention" | "success"
}

export function sessionProjectLabel(session: { readonly projectID?: string; readonly directory?: string }): string {
  const directory = session.directory?.replace(/[\\/]+$/, "")
  if (directory !== undefined && directory.length > 0) return directory.split(/[\\/]/).at(-1) ?? directory
  return session.projectID ?? "Not reported"
}

export function createUnavailableRemoteViewModel(
  reason: RemoteUnavailableReason = "not-configured",
): RemoteViewModel {
  const fail = (): RemoteActionResult => ({ ok: false, reason })
  return {
    connection: { kind: "unavailable", reason },
    capabilities: REMOTE_CAPABILITY_NAMES.reduce<Record<RemoteCapabilityName, boolean>>(
      (capabilities, name) => {
        capabilities[name] = false
        return capabilities
      },
      {} as Record<RemoteCapabilityName, boolean>,
    ),
    devices: [],
    sessions: [],
    messages: [],
    activity: [],
    approvals: [],
    actions: {
      signIn: fail,
      reconnect: fail,
      selectDevice: fail,
      selectSession: fail,
      sendPrompt: (input) => (input.text.trim().length === 0 ? { ok: false, reason: "empty-prompt" } : fail()),
      interrupt: fail,
      replyToApproval: fail,
    },
  }
}

export function summarizeConnection(state: RemoteConnectionState): ConnectionSummary {
  if (state.kind === "loading") {
    return { label: "Checking account", detail: "Checking whether this browser is signed in.", tone: "pending" }
  }
  if (state.kind === "connected") {
    return { label: "Connected", detail: `Relay session active for ${state.deviceName}.`, tone: "online" }
  }
  if (state.kind === "connecting") {
    return { label: "Connecting", detail: "Opening the relay connection.", tone: "pending" }
  }
  if (state.kind === "signed-out") {
    return { label: "Signed out", detail: "Sign in to reach your machines.", tone: "offline" }
  }
  if (state.kind === "no-device-enrolled") {
    return {
      label: "Not connected",
      detail: "This account is signed in, but no machine is enrolled to it yet.",
      tone: "offline",
    }
  }
  if (state.kind === "no-device-selected") {
    return {
      label: "Not connected",
      detail: "This account is signed in; choose an enrolled machine to connect.",
      tone: "offline",
    }
  }
  if (state.kind === "offline") {
    return { label: "Device offline", detail: `${state.deviceName} is not reachable right now.`, tone: "offline" }
  }
  if (state.kind === "error") {
    return { label: "Connection error", detail: state.message, tone: "attention" }
  }
  return { label: "Not available", detail: describeUnavailableReason(state.reason), tone: "attention" }
}

export function sessionStateChips(session: RemoteSessionSummary): readonly SessionChip[] {
  const chips: SessionChip[] = []
  if (session.status === "running") chips.push({ label: "Running", tone: "success" })
  if (session.status === "blocked") chips.push({ label: "Waiting for approval", tone: "attention" })
  if (session.status === "archived") chips.push({ label: "Archived", tone: "neutral" })

  if (session.autonomy === "goal") chips.push({ label: "Goal", tone: "neutral" })
  else if (session.autonomy === "yolo") {
    chips.push({ label: session.yoloLevel === undefined ? "YOLO" : `YOLO ${session.yoloLevel}`, tone: "attention" })
  } else if (session.autonomy === "normal") chips.push({ label: "Standard", tone: "neutral" })

  if (session.guardrailsEnforced === true) chips.push({ label: "Guardrails enforced", tone: "neutral" })
  if (session.guardrailsEnforced === false) chips.push({ label: "Guardrails auto", tone: "attention" })
  return chips
}

export function describeUnavailableReason(reason: RemoteUnavailableReason): string {
  if (reason === "no-connection") {
    return "This browser cannot reach a relay right now, so the workspace cannot load remote sessions."
  }
  return "Remote access is not enabled on this deployment yet, so there is no signed-in account or paired device to show."
}

export function connectionBanner(state: RemoteConnectionState): {
  readonly title: string
  readonly body: string
  readonly showReconnect: boolean
  /** Whether the fix for this state is on the settings page. */
  readonly showSettings: boolean
} | undefined {
  if (state.kind === "connected" || state.kind === "connecting" || state.kind === "loading") return undefined
  if (state.kind === "unavailable") {
    return {
      title: "Remote access is not available yet",
      body: describeUnavailableReason(state.reason),
      showReconnect: false,
      showSettings: true,
    }
  }
  if (state.kind === "signed-out") {
    return {
      title: "Signed out",
      body: "Sign in to list your machines and continue a session from this browser.",
      showReconnect: false,
      showSettings: false,
    }
  }
  if (state.kind === "no-device-enrolled") {
    return {
      title: "No machine enrolled",
      body: "Your account is signed in, but no machine is enrolled to it yet. Create an enrollment code here and enroll the machine running YCoding.",
      showReconnect: false,
      showSettings: true,
    }
  }
  if (state.kind === "no-device-selected") {
    return {
      title: "No machine selected",
      body: "Your account is signed in. Choose one of your enrolled machines to load the sessions it shares.",
      showReconnect: false,
      showSettings: false,
    }
  }
  if (state.kind === "offline") {
    return {
      title: `${state.deviceName} is not reachable`,
      body: "The machine may be asleep or YCoding may not be running there. Reconnect after it is back online.",
      showReconnect: true,
      showSettings: false,
    }
  }
  return { title: "Connection error", body: state.message, showReconnect: true, showSettings: false }
}

/**
 * What this browser knows about its account, which is independent of whether a
 * relay is reachable. The store leaves `owner` absent both while the account read
 * is open and after a read that failed, so the connection kind decides whether an
 * absent owner means signed out or simply unanswered.
 */
export type AccountReadState =
  | { readonly kind: "checking" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "unresolved"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly reason: RemoteUnavailableReason }
  | { readonly kind: "signed-in"; readonly expiresAt: number }

export function accountReadState(input: {
  readonly connection: RemoteConnectionState
  readonly owner?: { readonly expiresAt: number }
}): AccountReadState {
  if (input.owner !== undefined) return { kind: "signed-in", expiresAt: input.owner.expiresAt }
  const connection = input.connection
  if (connection.kind === "unavailable") return { kind: "unavailable", reason: connection.reason }
  if (connection.kind === "signed-out") return { kind: "signed-out" }
  if (connection.kind === "loading") return { kind: "checking" }
  return {
    kind: "unresolved",
    detail: connection.kind === "error" ? connection.message : unreadableAccountDetail,
  }
}

/** A read that failed before the account was known must not be reported as signed out. */
const unreadableAccountDetail = "The account check did not finish, so this browser's sign-in state is unknown."

const checkingAccountDetail = "Checking account. This browser's sign-in state is not known yet."

/**
 * A definitive signed-out answer replaces the workspace with the sign-in screen. Every
 * other read keeps the workspace, so a slow or failed account check never looks like a
 * sign-out.
 */
export function remoteEntryView(read: AccountReadState): "sign-in" | "workspace" {
  return read.kind === "signed-out" ? "sign-in" : "workspace"
}

export type AccountAction = "retry"

/** The account section either shows the account it knows or one message about why it cannot. */
export type AccountSectionView =
  | { readonly kind: "signed-in"; readonly expiresAt: number }
  | { readonly kind: "message"; readonly detail: string; readonly actions: readonly AccountAction[] }

export function accountSectionView(read: AccountReadState, authError?: string): AccountSectionView {
  if (read.kind === "signed-in") return { kind: "signed-in", expiresAt: read.expiresAt }
  if (read.kind === "signed-out") {
    return {
      kind: "message",
      detail: authError ?? "This browser is not signed in, so no device or session is available.",
      actions: [],
    }
  }
  if (read.kind === "checking") {
    return {
      kind: "message",
      detail: authError === undefined ? checkingAccountDetail : `${authError} ${checkingAccountDetail}`,
      actions: [],
    }
  }
  if (read.kind === "unavailable") {
    return { kind: "message", detail: describeUnavailableReason(read.reason), actions: [] }
  }
  return { kind: "message", detail: authError ?? read.detail, actions: ["retry"] }
}

/**
 * What the device surfaces can truthfully say. The session panel, the settings
 * device list, and the header device select all read this so none of them claims
 * an account has no machine before the account read has answered.
 */
export type DeviceAvailabilityView = {
  /** Session panel empty-state title. */
  readonly title: string
  /** Session panel empty-state body. */
  readonly body: string
  /** Settings device-list hint, and the device section's empty state. */
  readonly hint: string
  /** Header device select placeholder while no device is selected. */
  readonly placeholder: string
  /** Whether the header device select accepts a choice. */
  readonly selectable: boolean
  /** Whether the session panel offers the settings entry point. */
  readonly showSettings: boolean
  /** A command to run on the machine, shown as a copyable block. */
  readonly command?: string
}

export type DeviceAvailabilityContext = {
  readonly devices: readonly Readonly<Pick<import("@ycoding-ai/remote").RemoteDeviceInfo, "id" | "name" | "status" | "online">>[]
  readonly activeDeviceID?: string
  readonly sessionCount?: number
  /** The selected machine's local agent did not answer, whatever its listed presence. */
  readonly unreachable?: boolean
}

const devicePanelBody =
  "Remote access needs an account and a machine running YCoding. Add a device code from settings, then enroll the machine."

export function deviceAvailabilityView(
  read: AccountReadState,
  deviceCount: number,
  context?: DeviceAvailabilityContext,
): DeviceAvailabilityView {
  if (read.kind === "signed-in") {
    const selected = context?.devices.find((device) => device.id === context.activeDeviceID)
    if (selected?.status === "revoked") {
      return {
        title: `${selected.name} access was revoked`,
        body: "Choose another online machine or enroll this machine again in settings.",
        hint: "The selected machine is revoked and cannot accept a connection.",
        placeholder: selected.name,
        selectable: context?.devices.some((device) => device.status === "active" && device.online) ?? false,
        showSettings: true,
      }
    }
    if (selected?.status === "active" && (!selected.online || context?.unreachable === true)) {
      return {
        title: `${selected.name} is not reachable`,
        body: "The selected machine is offline or YCoding is not running there. Reconnect after it is available.",
        hint: "The selected machine is enrolled but not online.",
        placeholder: selected.name,
        selectable: context?.devices.some((device) => device.status === "active" && device.online) ?? false,
        showSettings: false,
      }
    }
    const onlineDevices = context?.devices.filter((device) => device.status === "active" && device.online)
    if (onlineDevices !== undefined && onlineDevices.length === 0 && deviceCount > 0) {
      const hasActiveEnrollment = context?.devices.some((device) => device.status === "active") ?? false
      if (hasActiveEnrollment) {
        return {
          title: "No machines online",
          body: "Your enrolled machines are offline. Run this command on a machine to make it available.",
          hint: "No enrolled machines are online right now.",
          placeholder: "No machines online",
          selectable: false,
          showSettings: false,
          command: "ycoding remote connect",
        }
      }
    }
    if ((onlineDevices?.length ?? deviceCount) > 0) {
      return {
        title: "No machine selected",
        body: "Choose a machine above to load its sessions.",
        hint: "",
        placeholder: "Select a machine",
        selectable: true,
        showSettings: false,
      }
    }
    return {
      title: "No machine is enrolled",
      body: devicePanelBody,
      hint: "No machine is enrolled to this account yet.",
      placeholder: "No machine enrolled",
      selectable: false,
      showSettings: true,
    }
  }
  if (read.kind === "checking") {
    return {
      title: "Checking account",
      body: "Enrolled machines appear once this browser's account check finishes.",
      hint: "Checking this browser's account before listing enrolled machines.",
      placeholder: "Checking machines",
      selectable: false,
      showSettings: false,
    }
  }
  if (read.kind === "signed-out") {
    return {
      title: "Signed out",
      body: "Sign in to list this account's enrolled machines and reach them from this browser.",
      hint: "Sign in to list this account's enrolled machines.",
      placeholder: "Sign in to select a machine",
      selectable: false,
      showSettings: true,
    }
  }
  if (read.kind === "unavailable") {
    return {
      title: "Remote access is not available",
      body: describeUnavailableReason(read.reason),
      hint: describeUnavailableReason(read.reason),
      placeholder: "Remote access unavailable",
      selectable: false,
      showSettings: false,
    }
  }
  return {
    title: "Account not confirmed",
    body: "This browser's account check did not finish, so enrolled machines cannot be listed yet. Retry the account check in settings.",
    hint: "The account check did not finish, so enrolled machines cannot be listed yet.",
    placeholder: "Account not confirmed",
    selectable: false,
    showSettings: true,
  }
}

export type SessionAvailabilityView = {
  readonly title: string
  readonly body: string
  /** What the signed-in owner can reach on this machine. */
  readonly note?: string
  readonly loading: boolean
}

/** Distinguishes an in-progress list read from a connected machine that returned no Sessions. */
export function sessionAvailabilityView(
  connection: RemoteConnectionState,
  sessionCount: number,
): SessionAvailabilityView | undefined {
  if (sessionCount > 0) return undefined
  if (connection.kind === "loading" || connection.kind === "connecting") {
    return {
      title: "Loading sessions",
      body: "Connecting to the selected machine and loading its sessions.",
      loading: true,
    }
  }
  if (connection.kind === "connected") {
    return {
      title: "No sessions",
      body: "Start YCoding in your project folder on this machine.",
      note: "Every existing and future session on this machine appears here while it is connected.",
      loading: false,
    }
  }
  return undefined
}

/**
 * The handoff shown after the account creates a device enrollment. The one-use
 * code stays separate: the CLI reads it from a hidden prompt, so it must never
 * reach the command line or shell history.
 */
export type EnrollmentInstructions = {
  readonly enrollmentID: string
  readonly command: string
  readonly code: string
  readonly expiresAt: number
}

export function enrollmentInstructions(enrollment: CreateEnrollmentResponse, relayOrigin: string): EnrollmentInstructions {
  return {
    enrollmentID: enrollment.enrollmentID,
    command: `ycoding remote enroll ${enrollment.enrollmentID} --relay ${relayOrigin}`,
    code: enrollment.code,
    expiresAt: enrollment.expiresAt,
  }
}

/**
 * What the last explicit page request did, shown beside the page control. It is display
 * state only: the device's own bytes always come from `ShellOutputView`.
 */
export type ShellOutputStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "stalled"; readonly label: string }
  | { readonly kind: "error"; readonly label: string }

/**
 * The explicit page request for one shell capture. "Show more" stays a client-side
 * expansion of the text already held; this is the separate decision to ask the device
 * for one more page, so the control never stands in for output the device did not send
 * and never becomes an automatic loop.
 */
export type ShellOutputPaging = {
  readonly hasMore: boolean
  readonly canRequest: boolean
  readonly label: string
  readonly status: ShellOutputStatus
}

const shellOutputLoadingLabel = "Loading output from the device…"
const shellOutputStalledLabel =
  "The device held back an incomplete character, so this page added no output."

export function shellOutputPaging(
  output: ShellOutputView | undefined,
  fetch: ShellOutputFetch | undefined,
): ShellOutputPaging {
  const loading = fetch?.state === "loading"
  // A shell whose page has never been read may still hold output on the device.
  const hasMore = output === undefined || output.cursor < output.size
  const failed = fetch?.state === "error" || fetch?.state === "stalled"
  return {
    hasMore,
    canRequest: hasMore && !loading,
    label: failed ? "Retry" : output === undefined ? "Load output" : "Load more output",
    status: shellOutputStatus(fetch),
  }
}

function shellOutputStatus(fetch: ShellOutputFetch | undefined): ShellOutputStatus {
  if (fetch === undefined) return { kind: "idle" }
  if (fetch.state === "loading") return { kind: "loading", label: shellOutputLoadingLabel }
  if (fetch.state === "error") return { kind: "error", label: fetch.message }
  if (fetch.state === "stalled") return { kind: "stalled", label: shellOutputStalledLabel }
  return { kind: "idle" }
}

/** The machine picker lists only online machines, so it names where the others are managed. */
export function devicePickerNote(devices: DeviceAvailabilityContext["devices"]): string | undefined {
  const hidden = devices.filter((device) => device.status !== "active" || !device.online).length
  if (hidden === 0) return undefined
  return hidden === 1
    ? "1 offline or revoked machine is managed in Settings → Devices."
    : `${hidden} offline or revoked machines are managed in Settings → Devices.`
}

/** An offline machine's last session list stays visible but cannot be opened or prompted. */
export function cachedSessionsView(connection: RemoteConnectionState, sessionCount: number): { readonly note: string } | undefined {
  if (connection.kind !== "offline" || sessionCount === 0) return undefined
  return { note: `Last session list from ${connection.deviceName}. Sessions are read-only until it reconnects.` }
}
