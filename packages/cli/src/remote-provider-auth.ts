import { isProviderAuthorizationURL, type ProviderAuthInfo, type ProviderAuthInput, type ProviderAuthAttempt, type ProviderAuthStatus } from "@ycoding-ai/remote"
import type { LocalLocation, LocalServer } from "./remote-local"
import { LocalFailure } from "./remote-local"

export type ProviderAuthEntry = { readonly integrationID: string; readonly target: string; readonly location: LocalLocation; readonly type: "oauth" | "command"; readonly expires: number }

export async function executeProviderAuth(input: { readonly fields: ProviderAuthInput; readonly location: LocalLocation; readonly local: LocalServer; readonly attempts: Map<string, ProviderAuthEntry>; readonly now: () => number }) {
  const fields = input.fields
  for (const [id, entry] of input.attempts) if (entry.expires <= input.now()) input.attempts.delete(id)
  if (fields.kind === "list" || fields.kind === "key" || fields.kind === "begin") {
    const providers = await input.local.providerIntegrations(input.location)
    const integrations = await input.local.integrationList(input.location)
    const offered = integrations.filter((integration) => providers.some((provider) => provider.integrationID === integration.id))
    if (fields.kind === "list") {
      const data: ProviderAuthInfo[] = offered.map((integration) => ({ id: integration.id, name: integration.name,
        providers: providers.filter((provider) => provider.integrationID === integration.id).map((provider) => provider.providerID),
        profiles: integration.connections.flatMap((connection) => connection.type === "credential" ? [{ name: connection.label, active: connection.active }] : []),
        methods: integration.methods.flatMap((method): ProviderAuthInfo["methods"] => {
          if (method.type === "env") return []
          if (method.type === "key") return [{ type: "key" as const, label: method.label ?? "API key", available: true }]
          const available = method.type === "command" || method.remote === true
          return [{ type: method.type, id: method.id, label: method.label, available,
            ...(!available ? { reason: "This sign-in requires a browser on the backend machine. Use /connect there or choose a remote-capable method." } : {}),
            ...(method.type === "oauth" && method.prompts ? { prompts: method.prompts } : {}) }]
        }),
      }))
      return { data }
    }
    const integration = offered.find((item) => item.id === fields.integrationID)
    if (!integration) throw new ProviderAuthError("Provider integration is unavailable at this Location.")
    if (fields.kind === "key") {
      if (!integration.methods.some((method) => method.type === "key")) throw new ProviderAuthError("API-key sign-in is unavailable for this integration.")
      await input.local.integrationKey(input.location, fields.integrationID, fields.key, fields.label)
      return { data: { status: "complete" } }
    }
    const method = integration.methods.find((method) => (method.type === "oauth" || method.type === "command") && method.id === fields.methodID)
    if (!method || (method.type !== "oauth" && method.type !== "command")) throw new ProviderAuthError("Authentication method is unavailable.")
    if (method.type === "oauth" && method.remote !== true) throw new ProviderAuthError("This authentication method requires sign-in on the backend machine.")
    const prompts = method.type === "oauth" ? method.prompts ?? [] : []
    if (Object.keys(fields.inputs).some((key) => !prompts.some((prompt) => prompt.key === key))) throw new ProviderAuthError("Unknown authentication input.")
    for (const prompt of prompts) {
      const visible = !prompt.when || (prompt.when.op === "eq" ? fields.inputs[prompt.when.key] === prompt.when.value : fields.inputs[prompt.when.key] !== prompt.when.value)
      if (!visible) continue
      const value = fields.inputs[prompt.key]
      if (!value?.trim() || prompt.type === "select" && !prompt.options.some((option) => option.value === value)) throw new ProviderAuthError("Complete the authentication fields before connecting.")
    }
    if (input.attempts.size >= 32) throw new ProviderAuthError("Too many pending authentication attempts. Cancel an attempt or wait for it to expire.")
    const reservation = `pending_${crypto.randomUUID()}`
    input.attempts.set(reservation, { integrationID: fields.integrationID, target: JSON.stringify(fields.target), location: input.location, type: method.type, expires: input.now() + 600000 })
    try {
      const oauth = method.type === "oauth" ? await input.local.integrationOAuthBegin(input.location, fields.integrationID, method.id, fields.inputs, fields.label) : undefined
      const command = method.type === "command" ? await input.local.integrationCommandBegin(input.location, fields.integrationID, method.id, fields.label) : undefined
      const attempt = oauth ?? command
      if (!attempt) throw new ProviderAuthError("Authentication could not begin.")
      if (oauth && (!isProviderAuthorizationURL(oauth.url) || oauth.instructions.length > 2048)) {
        await input.local.integrationOAuthCancel(input.location, fields.integrationID, oauth.attemptID)
        throw new ProviderAuthError("The provider returned an authorization link that cannot safely be opened remotely. Sign in on the machine instead.")
      }
      const time = requireAttemptTime(attempt.time)
      input.attempts.set(attempt.attemptID, { integrationID: fields.integrationID, target: JSON.stringify(fields.target), location: input.location, type: method.type, expires: time.expires })
      const data: ProviderAuthAttempt = { attemptID: attempt.attemptID, type: method.type, time,
        ...(oauth ? { url: oauth.url, instructions: oauth.instructions, mode: oauth.mode, ...(oauth.manualCode ? { manualCode: true } : {}) } : {}) }
      input.attempts.delete(reservation)
      return { data }
    } catch (cause) {
      if (!(cause instanceof LocalFailure) || cause.kind !== "transport") input.attempts.delete(reservation)
      throw cause
    }
  }
  const entry = input.attempts.get(fields.attemptID)
  if (!entry || entry.integrationID !== fields.integrationID || entry.target !== JSON.stringify(fields.target) || JSON.stringify(entry.location) !== JSON.stringify(input.location))
    throw new ProviderAuthError("Authentication attempt is unavailable at its initiating Location. Connect again if it expired.")
  if (fields.kind === "cancel") {
    if (entry.type === "oauth") await input.local.integrationOAuthCancel(input.location, fields.integrationID, fields.attemptID)
    if (entry.type === "command") await input.local.integrationCommandCancel(input.location, fields.integrationID, fields.attemptID)
    input.attempts.delete(fields.attemptID)
    return { data: { status: "cancelled" } }
  }
  if (fields.kind === "complete") {
    if (entry.type !== "oauth" || !fields.code) throw new ProviderAuthError("This attempt does not accept an authorization code.")
    await input.local.integrationOAuthComplete(input.location, fields.integrationID, fields.attemptID, fields.code)
    return { data: { status: "submitted" } }
  }
  const status = entry.type === "oauth" ? await input.local.integrationOAuthStatus(input.location, fields.integrationID, fields.attemptID)
    : await input.local.integrationCommandStatus(input.location, fields.integrationID, fields.attemptID)
  const data: ProviderAuthStatus = { status: status.status, time: requireAttemptTime(status.time),
    ...(status.status === "failed" ? { message: "Authentication failed. Try connecting again." } : {}) }
  return { data }
}

export class ProviderAuthError extends Error {}

function requireAttemptTime(value: { readonly created: number | string; readonly expires: number | string }) {
  if (typeof value.created !== "number" || !Number.isFinite(value.created) || typeof value.expires !== "number" || !Number.isFinite(value.expires)) throw new ProviderAuthError("The machine returned an unreadable authentication time.")
  return { created: value.created, expires: value.expires }
}
