export type KeepAwakeStatus = { readonly state: "off" | "on" | "unsupported" | "error"; readonly message?: string }

export type KeepAwakeChange = {
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

export const emptyKeepAwake = (): KeepAwakeState => ({ read: "idle" })

const maxMessageLength = 200

export function readKeepAwakeStatus(payload: unknown): KeepAwakeStatus | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data: unknown = Reflect.get(payload, "data")
  if (typeof data !== "object" || data === null) return undefined
  const state = Reflect.get(data, "state")
  const message = Reflect.get(data, "message")
  if (state !== "off" && state !== "on" && state !== "unsupported" && state !== "error") return undefined
  if (message !== undefined && (typeof message !== "string" || message.length > maxMessageLength)) return undefined
  return { state, ...(message === undefined ? {} : { message }) }
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
  "Available on macOS. Prevents idle sleep only, not manual sleep or closing the lid. Turns off when YCoding on that machine stops or restarts."
const updateAdvice = "Update YCoding on this machine to keep it awake from here."

export function keepAwakeView(input: {
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
  const checked = status.state === "on"
  const base = {
    label: status.state === "error" ? ("Error" as const) : checked ? ("On" as const) : ("Off" as const),
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
  return view({
    ...base,
    detail: status.message ?? (checked ? "This machine is being kept awake." : "This machine may sleep when idle."),
  })
}
