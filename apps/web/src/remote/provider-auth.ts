import { isProviderAuthorizationURL, type ProviderAuthAttempt, type ProviderAuthInfo, type ProviderAuthOperation, type ProviderAuthPrompt, type ProviderAuthStatus } from "@ycoding-ai/remote"
import type { CatalogTarget } from "./catalog"
import type { QueryScope } from "./queries"
import type { RemoteRequestOutcome } from "./transport"

export type ProviderAuthState = { readonly phase: "loading" | "ready" | "sending" | "pending" | "complete" | "failed" | "unknown" | "unsupported"; readonly integrations: readonly ProviderAuthInfo[]; readonly integrationID?: string; readonly attempt?: ProviderAuthAttempt; readonly message?: string }

export function providerAuthPrompts(prompts: readonly ProviderAuthPrompt[], values: Readonly<Record<string, string>>) {
  return prompts.filter((prompt) => !prompt.when || (prompt.when.op === "eq" ? values[prompt.when.key] === prompt.when.value : values[prompt.when.key] !== prompt.when.value))
}

export function createProviderAuth(options: {
  readonly scope: QueryScope
  readonly target: CatalogTarget
  readonly current: () => boolean
  readonly request: (operation: ProviderAuthOperation, input: Readonly<Record<string, unknown>>) => Promise<RemoteRequestOutcome>
  readonly changed: (state: ProviderAuthState) => void
}) {
  const target = "sessionID" in options.target ? { sessionID: options.target.sessionID } : { workspace: options.target.workspaceID }
  let state: ProviderAuthState = { phase: "loading", integrations: [] }
  let disposed = false
  let revision = 0
  const publish = (next: ProviderAuthState) => { if (!disposed && options.current()) { state = next; options.changed(next) } }
  const request = (operation: ProviderAuthOperation, input: Readonly<Record<string, unknown>> = {}) => options.current()
    ? options.request(operation, { target, ...input }) : Promise.resolve<RemoteRequestOutcome>({ status: "unavailable", reason: "not-connected" })
  const failed = (outcome: RemoteRequestOutcome) => {
    const unsupported = outcome.status === "failed" && outcome.error.code === "unknown_operation"
    const unknown = outcome.status === "unknown" || outcome.status === "failed" && outcome.error.code === "outcome_unknown"
    publish({ ...state, phase: state.attempt ? "unknown" : unsupported ? "unsupported" : unknown ? "unknown" : "failed", message: unsupported
      ? "Update YCoding on this machine to connect providers from the web."
      : unknown ? "The machine did not confirm the result. Check status or profiles before trying again; this action was not replayed."
        : "Provider authentication could not finish. Check the machine connection and try again." })
  }
  const cancel = async (integrationID: string, attemptID: string) => {
    revision += 1
    publish({ ...state, phase: "sending" })
    const outcome = await request("provider.auth.cancel", { integrationID, attemptID })
    if (disposed || !options.current()) return
    if (outcome.status !== "ok") { failed(outcome); return }
    publish({ phase: "ready", integrations: state.integrations })
  }
  const mutate = async (operation: "provider.auth.key" | "provider.auth.begin" | "provider.auth.complete", input: Readonly<Record<string, unknown>>) => {
    if (disposed || !options.current() || state.phase === "sending" || operation !== "provider.auth.complete" && state.attempt) return
    revision += 1
    publish({ ...state, phase: "sending", integrationID: typeof input.integrationID === "string" ? input.integrationID : state.integrationID, message: undefined })
    const outcome = await request(operation, input)
    if (outcome.status !== "ok") { failed(outcome); return }
    if (operation === "provider.auth.begin") {
      const attempt = readProviderAuthAttempt(outcome.value)
      if (!attempt) { publish({ ...state, phase: "unknown", message: "The machine returned an unreadable attempt. It may still be active; do not start another automatically." }); return }
      if (disposed) { if (typeof input.integrationID === "string") await cancel(input.integrationID, attempt.attemptID); return }
      publish({ ...state, phase: "pending", attempt })
      return
    }
    const answer = data(outcome.value)
    if (!record(answer) || answer.status !== (operation === "provider.auth.key" ? "complete" : "submitted")) {
      publish({ ...state, phase: "unknown", message: "The machine returned an unreadable answer. Check status or profiles before trying again." })
      return
    }
    publish({ ...state, phase: operation === "provider.auth.key" ? "complete" : "pending" })
  }
  return {
    state: () => state,
    load: async () => {
      if (disposed || !options.current() || state.phase === "sending") return
      if (state.attempt) return
      publish({ ...state, phase: "loading", message: undefined })
      const outcome = await request("provider.auth.list")
      if (outcome.status !== "ok") { failed(outcome); return }
      const integrations = readProviderAuthList(outcome.value)
      if (!integrations) { publish({ ...state, phase: "failed", message: "The machine returned an unreadable provider list." }); return }
      publish({ ...state, phase: "ready", integrations, message: undefined })
    },
    key: (integrationID: string, label: string, key: string) => mutate("provider.auth.key", { integrationID, label, key }),
    begin: (integrationID: string, methodID: string, label: string, inputs: Readonly<Record<string, string>>) => mutate("provider.auth.begin", { integrationID, methodID, label, inputs }),
    complete: (code: string) => state.attempt && state.integrationID
      ? mutate("provider.auth.complete", { integrationID: state.integrationID, attemptID: state.attempt.attemptID, code }) : Promise.resolve(),
    check: async () => {
      if (disposed || !options.current() || !state.attempt || !state.integrationID || state.phase === "sending") return
      const started = ++revision
      const outcome = await request("provider.auth.status", { integrationID: state.integrationID, attemptID: state.attempt.attemptID })
      if (started !== revision) return
      if (outcome.status !== "ok") { failed(outcome); return }
      const status = readProviderAuthStatus(outcome.value)
      if (!status) { publish({ ...state, phase: "unknown", message: "The machine returned an unreadable status. Check again before repeating authentication." }); return }
      publish({ ...state, attempt: status.status === "pending" ? state.attempt : undefined, phase: status.status === "complete" ? "complete" : status.status === "pending" ? "pending" : "failed", message: status.status === "failed" ? "Authentication failed. Try connecting again." : status.status === "expired" ? "Authentication expired. Connect again." : undefined })
    },
    cancel: () => state.attempt && state.integrationID ? cancel(state.integrationID, state.attempt.attemptID) : Promise.resolve(),
    dispose: () => { disposed = true; if (state.attempt && state.integrationID && state.phase !== "complete") void cancel(state.integrationID, state.attempt.attemptID) },
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function data(value: unknown) { return record(value) ? value.data : undefined }
function text(value: unknown, limit = 2048): value is string { return typeof value === "string" && value.length <= limit }
function time(value: unknown): value is { created: number; expires: number } { return record(value) && typeof value.created === "number" && Number.isFinite(value.created) && typeof value.expires === "number" && Number.isFinite(value.expires) }

export function readProviderAuthAttempt(value: unknown): ProviderAuthAttempt | undefined {
  const item = data(value)
  if (!record(item) || !text(item.attemptID, 128) || !/^con_[A-Za-z0-9_-]+$/.test(item.attemptID) || !time(item.time)) return
  const attemptTime = { created: item.time.created, expires: item.time.expires }
  if (item.type === "command") return { type: "command", attemptID: item.attemptID, time: attemptTime }
  if (item.type !== "oauth" || !text(item.url, 8192) || !URL.canParse(item.url) || !text(item.instructions) || (item.mode !== "auto" && item.mode !== "code")) return
  if (!isProviderAuthorizationURL(item.url)) return
  return { type: "oauth", attemptID: item.attemptID, time: attemptTime, url: item.url, instructions: item.instructions, mode: item.mode, ...(item.manualCode === true ? { manualCode: true } : {}) }
}

export function readProviderAuthStatus(value: unknown): ProviderAuthStatus | undefined {
  const item = data(value)
  if (!record(item) || !time(item.time) || (item.status !== "pending" && item.status !== "complete" && item.status !== "failed" && item.status !== "expired")) return
  return { status: item.status, time: { created: item.time.created, expires: item.time.expires } }
}

export function readProviderAuthList(value: unknown): readonly ProviderAuthInfo[] | undefined {
  const items = data(value)
  if (!Array.isArray(items) || items.length > 500) return
  const projected = items.map((item): ProviderAuthInfo | undefined => {
    if (!record(item) || !text(item.id, 128) || !text(item.name, 256) || !Array.isArray(item.providers) || !item.providers.every((id) => text(id, 128)) || !Array.isArray(item.profiles) || !Array.isArray(item.methods)) return
    const profiles = item.profiles.map((profile) => record(profile) && text(profile.name, 128) && typeof profile.active === "boolean" ? { name: profile.name, active: profile.active } : undefined)
    const methods = item.methods.map((method): ProviderAuthInfo["methods"][number] | undefined => {
      if (!record(method) || (method.type !== "key" && method.type !== "oauth" && method.type !== "command") || !text(method.label, 256) || typeof method.available !== "boolean" || (method.type !== "key" && !text(method.id, 128))) return
      if (method.reason !== undefined && !text(method.reason)) return
      if (method.prompts !== undefined && (!Array.isArray(method.prompts) || !method.prompts.every(validPrompt))) return
      return { type: method.type, label: method.label, available: method.available, ...(text(method.id, 128) ? { id: method.id } : {}), ...(text(method.reason) ? { reason: method.reason } : {}), ...(Array.isArray(method.prompts) ? { prompts: method.prompts } : {}) }
    })
    if (profiles.some((profile) => !profile) || methods.some((method) => !method)) return
    return { id: item.id, name: item.name, providers: item.providers, profiles: profiles.filter((profile) => profile !== undefined), methods: methods.filter((method) => method !== undefined) }
  })
  return projected.some((item) => !item) ? undefined : projected.filter((item) => item !== undefined)
}

function validPrompt(value: unknown): value is ProviderAuthPrompt {
  if (!record(value) || !text(value.key, 128) || !text(value.message) || (value.when !== undefined && (!record(value.when) || !text(value.when.key, 128) || (value.when.op !== "eq" && value.when.op !== "neq") || !text(value.when.value)))) return false
  if (value.type === "text") return value.placeholder === undefined || text(value.placeholder)
  return value.type === "select" && Array.isArray(value.options) && value.options.length <= 100 && value.options.every((option) => record(option) && text(option.label) && text(option.value) && (option.hint === undefined || text(option.hint)))
}
