import type { Interaction } from "../../../../packages/schema/src/interaction"

export type InteractionPauseReason = "foreground_required" | "file_chooser" | "dialog" | "captcha" | "sensitive" | "user_takeover"
export type InteractionStatus = typeof Interaction.Status.Encoded | {
  readonly state: "paused"
  readonly platform: InteractionPlatform
  readonly generation: string
  readonly label: string
  readonly reason: InteractionPauseReason
}
export type InteractionPlatform = typeof Interaction.Platform.Encoded
type Frame = Omit<typeof Interaction.Frame.Encoded, "base64"> & { readonly bytes: Uint8Array<ArrayBuffer> }
type Request = typeof Interaction.Request.Encoded
type ReadStatus = InteractionStatus | "unsupported" | "error"
type Source = {
  status: (signal: AbortSignal) => Promise<ReadStatus>
  preview: (generation: string, signal: AbortSignal) => Promise<unknown>
  stop: (generation: string) => Promise<unknown>
  resume?: (generation: string) => Promise<unknown>
  request?: (proposal: Request) => Promise<unknown>
}

export type InteractionView = {
  readonly status: ReadStatus | "checking"
  readonly revealed: boolean
  readonly frame?: Frame
  readonly readingFrame?: boolean
  readonly busy?: "stop" | "request" | "resume"
  readonly notice?: string
}

const idle: InteractionView = { status: "checking", revealed: false }
const frameLimit = 160 * 1024
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value)) : undefined
export const interactionGeneration = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)

const pauseReasonLabels: Record<InteractionPauseReason, string> = {
  foreground_required: "Needs window focus",
  file_chooser: "File chooser open",
  dialog: "Dialog open",
  captcha: "CAPTCHA check",
  sensitive: "Sensitive field",
  user_takeover: "Paused by you",
}
const isPauseReason = (value: unknown): value is InteractionPauseReason =>
  typeof value === "string" && Object.hasOwn(pauseReasonLabels, value)

export function readInteractionStatus(value: unknown): InteractionStatus | undefined {
  const status = record(value)
  if (status?.state === "unavailable") return { state: "unavailable" }
  if (!status || !interactionGeneration(status.generation) || (status.platform !== "chrome" && status.platform !== "macos")) return undefined
  const selection: { generation: string; platform: InteractionPlatform } = { generation: status.generation, platform: status.platform }
  if (status.state === "pending") return { state: "pending", ...selection }
  if (status.state === "active" && typeof status.label === "string" && status.label.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(status.label))
    return { state: "active", ...selection, label: status.label }
  if (status.state === "paused" && typeof status.label === "string" && status.label.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(status.label) && isPauseReason(status.reason))
    return { state: "paused", ...selection, label: status.label, reason: status.reason }
  if (status.state !== "stopped" || (status.cleanup !== "pending" && status.cleanup !== "complete" && status.cleanup !== "failed")) return undefined
  const reason = status.reason
  if (reason === "stopped" || reason === "rejected" || reason === "expired" || reason === "disconnected" || reason === "target_lost" || reason === "uncertain" || reason === "permission" || reason === "shutdown")
    return { state: "stopped", ...selection, reason, cleanup: status.cleanup }
  return undefined
}

export function interactionEventGeneration(value: unknown, sessionID: string) {
  const event = record(value)
  if (event?.type !== "session.interaction.changed") return undefined
  const data = record(event.data)
  return data?.sessionID === sessionID && interactionGeneration(data.generation) ? data.generation : undefined
}

function readyFrame(value: unknown, generation: string): Frame | undefined {
  const preview = record(value)
  if (preview?.state !== "ready" || preview.generation !== generation) return undefined
  const frame = record(preview.frame)
  if (!frame) return undefined
  const { base64, width, height, mimeType } = frame
  if ((mimeType !== "image/png" && mimeType !== "image/jpeg") || typeof base64 !== "string" || base64.length > Math.ceil(frameLimit / 3) * 4 ||
    base64.length < 8 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > 960 ||
    typeof height !== "number" || !Number.isInteger(height) || height < 1 || height > 720) return undefined
  const bytes = atob(base64)
  if (bytes.length > frameLimit) return undefined
  const read = (offset: number, count: number) => {
    let value = 0
    for (let index = offset; index < offset + count; index++) value = value * 256 + bytes.charCodeAt(index)
    return value
  }
  const decoded = (): Frame => ({ width, height, mimeType, bytes: Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)) })
  if (mimeType === "image/png") return bytes.startsWith("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR") && read(16, 4) === width && read(20, 4) === height
    ? decoded() : undefined
  if (!bytes.startsWith("\xff\xd8")) return undefined
  for (let index = 2; index + 4 < bytes.length;) {
    if (read(index++, 1) !== 0xff) return undefined
    while (read(index, 1) === 0xff) index++
    const marker = read(index++, 1)
    const size = read(index, 2)
    if (marker === 0xda || !Number.isInteger(size) || size < 2 || index + size > bytes.length) return undefined
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return size >= 8 && read(index + 3, 2) === height && read(index + 5, 2) === width ? decoded() : undefined
    index += size
  }
  return undefined
}

const active = (status: InteractionView["status"]) => typeof status !== "string" && status.state === "active" ? status : undefined
export const stoppableGeneration = (status: InteractionView["status"]) =>
  typeof status !== "string" && (status.state === "pending" || status.state === "active" || status.state === "paused") ? status.generation : undefined
export const resumableGeneration = (status: InteractionView["status"]) =>
  typeof status !== "string" && status.state === "paused" ? status.generation : undefined
export function interactionControlVisible(view: InteractionView | undefined) {
  if (!view) return false
  if (view.busy === "request" || view.notice) return true
  if (typeof view.status === "string") return false
  return view.status.state !== "unavailable"
}

export function interactionPauseReasonLabel(reason: InteractionPauseReason) {
  return pauseReasonLabels[reason]
}

export function interactionViewLabel(status: InteractionView["status"]) {
  if (status === "checking") return "Checking interaction…"
  if (status === "unsupported") return "Interaction not supported"
  if (status === "error") return "Interaction status unavailable"
  if (status.state === "unavailable") return "Interaction unavailable"
  const platform = status.platform === "chrome" ? "Chrome" : "macOS"
  if (status.state === "pending") return status.platform === "chrome" ? "Chrome control · Awaiting local approval" : "Awaiting approval in macOS"
  if (status.state === "active") return `${platform} control active${status.label ? ` · ${status.label}` : ""}`
  if (status.state === "paused") return `${platform} control paused${status.label ? ` · ${status.label}` : ""} · ${interactionPauseReasonLabel(status.reason)}`
  const reason = {
    stopped: "", rejected: " · Approval declined", expired: " · Grant expired", disconnected: " · Platform disconnected",
    target_lost: " · Target lost", uncertain: " · Last action unconfirmed", permission: " · Permission lost", shutdown: " · Backend stopped",
  }[status.reason]
  return `${platform} control stopped · Cleanup ${status.cleanup}${reason}`
}

export function createInteractionControl(publish: (view: InteractionView | undefined) => void) {
  let owner: { readonly source: Source; readonly signal: AbortController } | undefined
  let view = idle
  let statusFlight: typeof owner
  let previewFlight: AbortController | undefined
  let statusAgain = false
  let previewAgain = false
  let mutationRevision = 0

  const update = (patch: Partial<InteractionView>) => {
    view = { ...view, ...patch }
    publish(view)
  }

  const clearPreview = () => {
    previewFlight?.abort()
    previewAgain = false
    update({ frame: undefined, readingFrame: false })
  }

  const loadPreview = async () => {
    const scope = owner
    const grant = active(view.status)
    if (!scope || !grant || !view.revealed || view.busy || statusFlight) return
    if (previewFlight) {
      previewAgain ||= previewFlight.signal.aborted
      return
    }
    const flight = new AbortController()
    previewFlight = flight
    update({ readingFrame: true })
    try {
      const value = await scope.source.preview(grant.generation, AbortSignal.any([scope.signal.signal, flight.signal])).catch(() => undefined)
      if (scope !== owner || flight.signal.aborted) return
      update({ frame: readyFrame(value, grant.generation), readingFrame: false })
    } finally {
      if (previewFlight === flight) {
        previewFlight = undefined
        const again = previewAgain
        previewAgain = false
        if (again) void loadPreview()
      }
    }
  }

  const refresh = async () => {
    const scope = owner
    if (!scope) return
    if (statusFlight) {
      statusAgain = true
      return
    }
    statusFlight = scope
    const status = await scope.source.status(scope.signal.signal).catch(() => "error" as const)
    if (statusFlight !== scope) return
    statusFlight = undefined
    if (statusAgain) {
      statusAgain = false
      void refresh()
      return
    }
    const next = active(status)
    if (!next || next.generation !== active(view.status)?.generation) clearPreview()
    update({ status, revealed: !!next && view.revealed })
    void loadPreview()
  }

  const setSource = (source?: Source) => {
    owner?.signal.abort()
    previewFlight?.abort()
    statusFlight = undefined
    previewFlight = undefined
    statusAgain = false
    previewAgain = false
    owner = source ? { source, signal: new AbortController() } : undefined
    view = idle
    publish(owner ? view : undefined)
    if (owner) void refresh()
  }

  const change = (generation: string) => {
    if (!owner) return
    clearPreview()
    const status = view.status
    if (typeof status !== "string" && "generation" in status && status.generation !== generation) update({ status: "checking" })
    void refresh()
  }

  const reveal = (revealed: boolean) => {
    if (!owner || revealed === view.revealed || (revealed && (!active(view.status) || view.busy))) return
    update({ revealed })
    if (revealed) void loadPreview()
    if (!revealed) clearPreview()
  }

  const mutate = async (kind: NonNullable<InteractionView["busy"]>, send: () => Promise<unknown>) => {
    const scope = owner
    if (!scope || view.busy === "stop" || (kind !== "stop" && view.busy)) return
    const revision = ++mutationRevision
    const current = () => owner === scope && revision === mutationRevision
    clearPreview()
    update({ busy: kind, revealed: false, notice: undefined })
    try { await send() }
    catch {
      if (current()) update({ notice: kind === "stop" ? "Stop was not confirmed. Check the reported status." : kind === "resume" ? "Resume was not confirmed. Check the reported status." : "The request was not confirmed. Check the reported status." })
    }
    if (!current()) return
    update({ busy: undefined, status: "checking" })
    void refresh()
  }

  return {
    setSource, change, reveal, refresh,
    stop: (generation: string) => {
      const scope = owner
      if (scope && stoppableGeneration(view.status) === generation) void mutate("stop", () => scope.source.stop(generation))
    },
    resume: (generation: string) => {
      const resume = owner?.source.resume
      if (resume && resumableGeneration(view.status) === generation) void mutate("resume", () => resume(generation))
    },
    request: (proposal: Request) => {
      const request = owner?.source.request
      const status = view.status
      if (request && typeof status !== "string" && (status.state === "unavailable" || status.state === "stopped"))
        void mutate("request", () => request(proposal))
    },
  }
}
