import { describeOutcome } from "./outcome"
import type { RemoteRequestOutcome } from "./transport"

export type KeepAwakeStatus = { readonly state: "off" | "on" | "unsupported" | "error"; readonly lid?: "off" | "on" | "held" | "unsupported" | "error"; readonly system?: "off" | "on" | "held" | "setup" | "unsupported" | "error"; readonly sleepHold?: boolean; readonly manual?: boolean; readonly message?: string }

type KeepAwakeChange = {
  readonly state: "sending" | "failed" | "unknown"
  readonly enabled: boolean
  readonly message?: string
}

export type KeepAwakeState = {
  readonly read: "idle" | "loading" | "ready" | "outdated" | "unanswered" | "error"
  readonly status?: KeepAwakeStatus
  readonly message?: string
  readonly change?: KeepAwakeChange
}

const maxMessageLength = 200

export function readKeepAwakeStatus(payload: unknown): KeepAwakeStatus | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data: unknown = Reflect.get(payload, "data")
  if (typeof data !== "object" || data === null) return undefined
  const state = Reflect.get(data, "state")
  const message = Reflect.get(data, "message")
  if (state !== "off" && state !== "on" && state !== "unsupported" && state !== "error") return undefined
  if (message !== undefined && (typeof message !== "string" || message.length > maxMessageLength)) return undefined
  const lid = Reflect.get(data, "lid")
  const system = Reflect.get(data, "system")
  const sleepHold = Reflect.get(data, "sleepHold")
  const manual = Reflect.get(data, "manual")
  return {
    state,
    ...(lid === "off" || lid === "on" || lid === "held" || lid === "unsupported" || lid === "error" ? { lid } : {}),
    ...(system === "off" || system === "on" || system === "held" || system === "setup" || system === "unsupported" || system === "error" ? { system } : {}),
    ...(typeof sleepHold === "boolean" ? { sleepHold } : {}),
    ...(typeof manual === "boolean" ? { manual } : {}),
    ...(message === undefined ? {} : { message }),
  }
}

export function keepAwakeAnswer(outcome: RemoteRequestOutcome, kept: Pick<KeepAwakeState, "change">): KeepAwakeState {
  if (outcome.status === "ok") {
    const status = readKeepAwakeStatus(outcome.value)
    return status === undefined
      ? { read: "error", message: "Keep machine awake: the machine returned an unreadable answer.", ...kept }
      : { read: "ready", status, ...kept }
  }
  if (outcome.status === "failed" && outcome.error.code === "unknown_operation") return { read: "outdated", ...kept }
  if (outcome.status === "unknown") return { read: "unanswered", ...kept }
  return { read: "error", message: describeOutcome(outcome, "Keep machine awake"), ...kept }
}

export type KeepAwakeView = {
  readonly label: "On" | "Off" | "Checking" | "Unavailable" | "Unsupported" | "Error"
  readonly checked: boolean
  readonly disabled: boolean
  readonly busy: boolean
  readonly detail: string
  readonly caveat: string
  readonly tone: "neutral" | "attention" | "danger"
  readonly alert: boolean
  readonly retry: boolean
}

const caveat =
  "Available on macOS. Controls idle sleep and lid-closed sleep when each part reports On; an unreported lid part is unconfirmed. Choosing Sleep still sleeps unless system sleep is On; with system sleep On, a closed lid on battery stays awake until the battery dies and Sleep does not sleep. On battery this drains the battery and a closed lid traps heat. The manual preference resets when YCoding stops or restarts; sleeping families rehydrate their holds. Verify lid behavior on this Mac."
const systemText = {
  off: "System sleep control off.",
  on: "System sleep disabled: a closed lid on battery stays awake until the battery dies, and Sleep does not sleep.",
  held: "System sleep held by another YCoding process.",
  setup: "System sleep control not installed; run ycoding keep-awake setup.",
  unsupported: "System sleep control unsupported.",
  error: "System sleep control could not be applied or restored.",
} as const
const updateAdvice = "Update YCoding on this machine to keep it awake from here."

export function keepAwakeView(input: {
  readonly keepAwake: KeepAwakeState
  readonly reachable: boolean
}): KeepAwakeView {
  const result = baseView(input)
  const system = input.reachable && input.keepAwake.read === "ready" ? input.keepAwake.status?.system : undefined
  if (system === undefined || input.keepAwake.change !== undefined) return result
  return {
    ...result,
    detail: `${result.detail} ${systemText[system]}`,
    ...(system === "error" && result.tone !== "danger" ? { tone: "attention" as const, alert: true } : {}),
  }
}

function baseView(input: {
  readonly keepAwake: KeepAwakeState
  readonly reachable: boolean
}): KeepAwakeView {
  const view = (value: Partial<KeepAwakeView> & Pick<KeepAwakeView, "label" | "detail">): KeepAwakeView => ({
    checked: false,
    disabled: true,
    busy: false,
    tone: "neutral",
    alert: false,
    retry: false,
    caveat,
    ...value,
  })
  const keepAwake = input.keepAwake
  if (!input.reachable) return view({ label: "Unavailable", detail: "Select an online machine to use this setting." })
  switch (keepAwake.read) {
    case "idle":
    case "loading":
      return view({ label: "Checking", busy: true, detail: "Checking this machine…" })
    case "outdated":
      return view({ label: "Unavailable", detail: updateAdvice })
    case "unanswered":
      return view({ label: "Unavailable", retry: true, detail: `This machine did not answer. ${updateAdvice}` })
    case "error":
      return view({
        label: "Unavailable",
        retry: true,
        alert: true,
        tone: "danger",
        detail: keepAwake.message ?? "Keep machine awake could not be read.",
      })
    case "ready":
      break
  }
  const status = keepAwake.status
  if (status === undefined) return view({ label: "Checking", busy: true, detail: "Checking this machine…" })
  const change = keepAwake.change
  if (status.state === "unsupported")
    return view({ label: "Unsupported", detail: status.message ?? "This machine cannot be kept awake from YCoding." })
  const checked = status.manual ?? status.state === "on"
  const base = {
    label: status.state === "error" ? ("Error" as const) : status.state === "on" ? ("On" as const) : ("Off" as const),
    checked,
    disabled: false,
  }
  if (change?.state === "sending")
    return view({ ...base, disabled: true, busy: true, detail: change.enabled ? "Turning on…" : "Turning off…" })
  if (change?.state === "failed")
    return view({ ...base, tone: "danger", alert: true, detail: change.message ?? "The change was not applied." })
  if (change?.state === "unknown")
    return view({
      ...base,
      tone: "attention",
      alert: true,
      detail: change.message ?? "The result of that change is unconfirmed.",
    })
  if (status.state === "error")
    return view({ ...base, tone: "danger", alert: true, detail: status.message ?? "This machine reported a problem." })
  if (status.state === "on" && status.sleepHold)
    return view({
      ...base,
      tone: "attention",
      alert: status.lid === "error",
      detail: `Idle ${status.state}; lid ${status.lid === "held" ? "held by another YCoding process" : status.lid ?? "unreported"}. Held on by a sleeping session. The switch sets your manual preference only; the machine stays awake until the last sleeping session wakes.${status.lid === "error" ? " Closing the lid may sleep this machine." : ""}`,
    })
  if (status.lid === "error")
    return view({
      ...base,
      tone: "attention",
      alert: true,
      detail:
        status.message ??
        "Idle sleep is held off, but lid-closed keep-awake could not be armed; closing the lid may sleep this machine.",
    })
  return view({
    ...base,
    detail:
      status.message ??
      (checked
        ? status.lid === "on"
          ? "This machine is being kept awake, lid closed too."
          : "This machine is being kept awake."
        : "This machine may sleep when idle.") + ` Idle ${status.state}; lid ${status.lid === "held" ? "held by another YCoding process" : status.lid ?? "unreported"}.`,
  })
}
