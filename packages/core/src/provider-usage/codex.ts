export * as CodexUsage from "./codex"

import { Credential } from "@ycoding-ai/schema/credential"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

const chatGPTMethods = new Set(["chatgpt-browser", "chatgpt-headless"])

export interface AppServerClient {
  readonly call: (method: string, params?: unknown) => Promise<unknown>
  readonly notify: (method: string, params?: unknown) => Promise<void>
  readonly close: () => Promise<void>
}

export interface AppServerCommand {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly timeoutMs?: number
  readonly cwd?: string
}

export interface LoadAppServerInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly updatedAt: number
  readonly client: AppServerClient
}

export async function loadAppServer(input: LoadAppServerInput) {
  try {
    await input.client.call("initialize", {
      clientInfo: { name: "ycoding", title: "YCoding", version: "1" },
    })
    await input.client.notify("initialized")
    const response = await input.client.call("account/rateLimits/read")
    return normalize({
      providerID: input.providerID,
      label: input.label,
      updatedAt: input.updatedAt,
      source: "local_client_rpc",
      stability: "client_contract",
      response,
    })
  } finally {
    await input.client.close()
  }
}

export function connectAppServer(input: AppServerCommand): AppServerClient {
  const timeoutMs = Math.min(Math.max(Math.trunc(input.timeoutMs ?? 5_000), 100), 30_000)
  const child = spawn(input.command, [...(input.args ?? [])], {
    cwd: input.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stderr.resume()
  return processClient(child, timeoutMs)
}

export interface NormalizeInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly updatedAt: number
  readonly source: ProviderUsage.Source
  readonly stability: ProviderUsage.Stability
  readonly response: unknown
}

export function normalize(input: NormalizeInput) {
  const root = unwrap(input.response)
  const global = object(root.rateLimits ?? root.rate_limits ?? root)
  const byID = object(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id, false) ?? {}
  const windows = [
    ...snapshotWindows(global, string(global.limitId ?? global.limit_id) ?? "codex", false),
    ...Object.entries(byID).flatMap(([id, value]) => snapshotWindows(object(value), id, true)),
    ...resetCreditWindows(root.rateLimitResetCredits ?? root.rate_limit_reset_credits),
  ]
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: input.source,
    stability: input.stability,
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows,
    ...(planMessage(global) === undefined ? {} : { message: planMessage(global) }),
  })
}

export function isChatGPTCredential(value: Credential.Value) {
  return value.type === "oauth" && chatGPTMethods.has(value.methodID)
}

export function accountHeaders(value: Credential.OAuth) {
  const accountID = typeof value.metadata?.accountID === "string" ? value.metadata.accountID : undefined
  return {
    Authorization: `Bearer ${value.access}`,
    ...(accountID ? { "ChatGPT-Account-ID": accountID } : {}),
  }
}

function snapshotWindows(value: Record<string, unknown>, limitID: string, named: boolean) {
  const label = limitLabel(limitID)
  return [
    ...rateWindow(value.primary, `${limitID}-primary`, named ? `${label} 5-hour` : "5-hour", "primary", named),
    ...rateWindow(value.secondary, `${limitID}-secondary`, named ? `${label} weekly` : "Weekly", "secondary", named),
    ...creditWindows(value.credits, `${limitID}-credits`, named ? `${label} credits` : "Credits"),
    ...individualLimitWindows(value.individualLimit ?? value.individual_limit, limitID, label, named),
  ]
}

function rateWindow(value: unknown, id: string, preferredLabel: string, kind: string, named: boolean) {
  if (value === null || value === undefined) return []
  const item = object(value)
  const used = percent(item.usedPercent ?? item.used_percent, `${id}.usedPercent`)
  if (used === undefined) return []
  const duration = nonNegative(item.windowDurationMins ?? item.window_duration_mins, `${id}.windowDurationMins`, false)
  const resetAt = reset(item.resetsAt ?? item.resets_at, `${id}.resetsAt`)
  const label = named && !knownDuration(duration, kind) ? `${limitLabel(id.replace(/-(primary|secondary)$/, ""))} ${kind}` : preferredLabel
  return [
    new ProviderUsage.Window({
      id: safeID(id),
      label,
      unit: "percent",
      used,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(duration === undefined ? {} : { periodSeconds: Math.trunc(duration * 60) }),
    }),
  ]
}

function creditWindows(value: unknown, id: string, label: string) {
  if (!record(value)) return []
  const hasCredits = boolean(value.hasCredits ?? value.has_credits)
  if (hasCredits === false) return []
  const unlimited = boolean(value.unlimited)
  const balance = money(value.balance, `${id}.balance`)
  if (!unlimited && balance === undefined) return []
  return [
    new ProviderUsage.Window({
      id: safeID(id),
      label,
      unit: "usd",
      ...(unlimited ? { unlimited: true } : {}),
      ...(balance === undefined ? {} : { remaining: balance }),
    }),
  ]
}

function individualLimitWindows(value: unknown, limitID: string, label: string, named: boolean) {
  if (!record(value)) return []
  const limit = money(value.limit ?? value.total ?? value.monthlyLimit ?? value.monthly_limit, "individualLimit.limit")
  const used = money(value.used ?? value.spent ?? value.current, "individualLimit.used")
  if (limit === undefined && used === undefined) return []
  return [
    new ProviderUsage.Window({
      id: safeID(`${limitID}-monthly-credits`),
      label: named ? `${label} monthly credits` : "Monthly credits",
      unit: "usd",
      ...(used === undefined ? {} : { used }),
      ...(limit === undefined ? {} : { limit }),
      ...(used === undefined || limit === undefined ? {} : { remaining: round(Math.max(limit - used, 0)) }),
    }),
  ]
}

function resetCreditWindows(value: unknown) {
  if (!record(value)) return []
  const available = nonNegative(value.availableCount ?? value.available_count, "rateLimitResetCredits.availableCount", false)
  if (available === undefined) return []
  return [
    new ProviderUsage.Window({
      id: "reset-credits",
      label: "Reset credits",
      unit: "count",
      remaining: available,
    }),
  ]
}

function unwrap(value: unknown) {
  const root = object(value)
  return object(root.result, false) ?? root
}

function planMessage(value: Record<string, unknown>) {
  const plan = string(value.planType ?? value.plan_type)
  const reached = string(value.rateLimitReachedType ?? value.rate_limit_reached_type)
  const spend = boolean(value.spendControlReached ?? value.spend_control_reached)
  const items = [plan ? `Plan: ${plan}` : undefined, reached ? `Reached: ${reached}` : undefined, spend ? "Spend control reached" : undefined]
    .filter((item): item is string => item !== undefined)
  return items.length ? items.join(" · ") : undefined
}

function knownDuration(value: number | undefined, kind: string) {
  if (kind === "primary") return value === 300
  if (kind === "secondary") return value === 10080
  return false
}

function limitLabel(value: string) {
  if (/spark/i.test(value)) return "Spark"
  return value
    .replace(/^codex[-_]?/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Codex"
}

function safeID(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function percent(value: unknown, field: string) {
  return nonNegative(value, field, false, 100)
}

function money(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
    throw new Error(`Invalid Codex usage: ${field}`)
  return round(number)
}

function nonNegative(value: unknown, field: string, required: boolean, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Invalid Codex usage: ${field}`)
    return undefined
  }
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > maximum)
    throw new Error(`Invalid Codex usage: ${field}`)
  return number
}

function reset(value: unknown, field: string) {
  const number = nonNegative(value, field, false)
  return number === undefined ? undefined : Math.trunc(number < 10_000_000_000 ? number * 1_000 : number)
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function object(value: unknown): Record<string, unknown>
function object(value: unknown, required: false): Record<string, unknown> | undefined
function object(value: unknown, required = true) {
  if (record(value)) return value
  if (!required && (value === undefined || value === null)) return undefined
  throw new Error("Invalid Codex usage response")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function processClient(child: ChildProcessWithoutNullStreams, timeoutMs: number): AppServerClient {
  const pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (cause: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
  >()
  let nextID = 0
  let buffer = ""
  let closed = false
  const fail = (cause: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(cause)
    }
    pending.clear()
  }
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    if (buffer.length > 1024 * 1024) {
      fail(new Error("Codex app-server response exceeded 1 MiB"))
      child.kill()
      return
    }
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!record(message) || typeof message.id !== "number") continue
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error !== undefined) request.reject(new Error("Codex app-server RPC failed"))
      else request.resolve(message.result)
    }
  })
  child.on("error", () => fail(new Error("Codex app-server process failed")))
  child.on("exit", () => {
    if (!closed) fail(new Error("Codex app-server process exited"))
  })

  const write = (message: unknown) =>
    new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(new Error("Codex app-server write failed")) : resolve(),
      )
    })

  return {
    call: async (method, params) => {
      const id = nextID++
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Codex app-server request timed out"))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
      })
      try {
        await write({ method, id, ...(params === undefined ? {} : { params }) })
      } catch (cause) {
        const request = pending.get(id)
        if (request) clearTimeout(request.timer)
        pending.delete(id)
        throw cause
      }
      return result
    },
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    close: async () => {
      if (closed) return
      closed = true
      fail(new Error("Codex app-server client closed"))
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const timer = setTimeout(resolve, 500)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
