export const providerAuthOperations = ["provider.auth.list", "provider.auth.key", "provider.auth.begin", "provider.auth.status", "provider.auth.complete", "provider.auth.cancel"] as const
export type ProviderAuthOperation = (typeof providerAuthOperations)[number]
export type ProviderAuthTarget = { readonly sessionID: string } | { readonly workspace: string }
export type ProviderAuthPrompt = { readonly type: "text"; readonly key: string; readonly message: string; readonly placeholder?: string; readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string } }
  | { readonly type: "select"; readonly key: string; readonly message: string; readonly options: readonly { readonly label: string; readonly value: string; readonly hint?: string }[]; readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string } }
export type ProviderAuthInfo = {
  readonly id: string
  readonly name: string
  readonly providers: readonly string[]
  readonly profiles: readonly { readonly name: string; readonly active: boolean }[]
  readonly methods: readonly { readonly type: "key" | "oauth" | "command"; readonly id?: string; readonly label: string; readonly available: boolean; readonly reason?: string; readonly prompts?: readonly ProviderAuthPrompt[] }[]
}
export type ProviderAuthAttempt = { readonly attemptID: string; readonly type: "oauth" | "command"; readonly time: { readonly created: number; readonly expires: number }; readonly url?: string; readonly instructions?: string; readonly mode?: "auto" | "code"; readonly manualCode?: boolean }
export type ProviderAuthStatus = { readonly status: "pending" | "complete" | "failed" | "expired"; readonly message?: string; readonly time: { readonly created: number; readonly expires: number } }
export type ProviderAuthInput = { readonly kind: "list"; readonly target: ProviderAuthTarget }
  | { readonly kind: "key"; readonly target: ProviderAuthTarget; readonly integrationID: string; readonly label: string; readonly key: string }
  | { readonly kind: "begin"; readonly target: ProviderAuthTarget; readonly integrationID: string; readonly methodID: string; readonly label: string; readonly inputs: Readonly<Record<string, string>> }
  | { readonly kind: "status" | "cancel" | "complete"; readonly target: ProviderAuthTarget; readonly integrationID: string; readonly attemptID: string; readonly code?: string }

export function parseProviderAuthInput(operation: string, input: unknown): ProviderAuthInput | undefined {
  if (!record(input) || !record(input.target) || Object.keys(input.target).length !== 1) return
  const target = typeof input.target.sessionID === "string" && /^ses_[A-Za-z0-9_-]+$/.test(input.target.sessionID) && input.target.sessionID.length <= 128
    ? { sessionID: input.target.sessionID }
    : typeof input.target.workspace === "string" && input.target.workspace.length > 0 && input.target.workspace.length <= 256
      ? { workspace: input.target.workspace } : undefined
  if (!target) return
  const only = (keys: readonly string[]) => Object.keys(input).every((key) => keys.includes(key))
  if (operation === "provider.auth.list" && only(["target"])) return { kind: "list", target }
  if (!text(input.integrationID, 128)) return
  const integrationID = input.integrationID
  if (operation === "provider.auth.key" && only(["target", "integrationID", "label", "key"]) && text(input.label, 128) && text(input.key, 8192))
    return { kind: "key", target, integrationID, label: input.label, key: input.key }
  if (operation === "provider.auth.begin" && only(["target", "integrationID", "methodID", "label", "inputs"]) && text(input.label, 128) && text(input.methodID, 128) && record(input.inputs) && Object.keys(input.inputs).length <= 32 && Object.entries(input.inputs).every(([key, value]) => text(key, 128) && typeof value === "string" && value.length <= 2048))
    return { kind: "begin", target, integrationID, methodID: input.methodID, label: input.label, inputs: input.inputs as Readonly<Record<string, string>> }
  if (!text(input.attemptID, 128) || !/^con_[A-Za-z0-9_-]+$/.test(input.attemptID)) return
  if (operation === "provider.auth.status" && only(["target", "integrationID", "attemptID"])) return { kind: "status", target, integrationID, attemptID: input.attemptID }
  if (operation === "provider.auth.cancel" && only(["target", "integrationID", "attemptID"])) return { kind: "cancel", target, integrationID, attemptID: input.attemptID }
  if (operation === "provider.auth.complete" && only(["target", "integrationID", "attemptID", "code"]) && text(input.code, 2048) && !/[\r\n\0]/.test(input.code))
    return { kind: "complete", target, integrationID, attemptID: input.attemptID, code: input.code }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\0\r\n]/.test(value) }

export function isProviderAuthorizationURL(value: string) {
  if (value.length > 8192 || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost") && !/^127\./.test(url.hostname) && url.hostname !== "[::1]" && !url.hostname.startsWith("[::ffff:7f")
}
