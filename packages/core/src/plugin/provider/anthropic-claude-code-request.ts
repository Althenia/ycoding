import { AnthropicModel } from "@ycoding-ai/ai"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ClaudeCodeCredentials, ClaudeCodeRequestEvent } from "./anthropic-claude-code-account"

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>
type FetchBody = FetchInit["body"]

const defaultVersion = "2.1.220"
const systemIdentity = "You are Claude Code, Anthropic's official CLI for Claude."
const billingPrefix = "x-anthropic-billing-header"
const toolPrefix = "mcp_"
const billingSalt = "59cf53e54c78"
const claudeCodeBeta = "claude-code-20250219"
const oauthBeta = "oauth-2025-04-20"
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14"
const contextManagementBeta = "context-management-2025-06-27"
const promptCachingScopeBeta = "prompt-caching-scope-2026-01-05"
const effortBeta = "effort-2025-11-24"
const longContextBetas = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"] as const
const claudeCodeSessionID = randomUUID()

type ContentBlock = { type?: string; text?: string } & Record<string, unknown>
type ClaudeMessage = { role?: string; content?: string | ContentBlock[] }
type ClaudeBody = {
  model?: string
  system?: ContentBlock[]
  thinking?: Record<string, unknown>
  output_config?: Record<string, unknown>
  tools?: Array<{ name?: string } & Record<string, unknown>>
  messages?: ClaudeMessage[]
} & Record<string, unknown>

export function getClaudeCodeModelBetas(modelID: string, excluded = new Set<string>()) {
  const model = AnthropicModel.normalize(modelID)
  const capabilities = AnthropicModel.capabilities(modelID)
  const configured = (process.env.ANTHROPIC_BETA_FLAGS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const defaults = [
    claudeCodeBeta,
    oauthBeta,
    ...(capabilities.adaptiveThinking !== "unsupported" || capabilities.manualThinking
      ? [interleavedThinkingBeta]
      : []),
    ...(model.generation !== undefined && model.generation >= 4 ? [contextManagementBeta] : []),
    promptCachingScopeBeta,
    ...(capabilities.effort.length > 0 ? [effortBeta] : []),
  ]
  return [...new Set([...defaults, ...configured])].filter(
    (beta) => !excluded.has(beta) && beta !== "context-1m-2025-08-07",
  )
}

export function buildClaudeCodeHeaders(
  input: FetchInput,
  init: RequestInit,
  accessToken: string,
  modelID: string,
  excluded: Set<string>,
  options: {
    readonly sessionID?: string
    readonly requestID?: () => string
  } = {},
) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", [...new Set([...getClaudeCodeModelBetas(modelID, excluded), ...incoming])].join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${version()} (external, sdk-cli)`)
  headers.set("x-client-request-id", options.requestID?.() ?? randomUUID())
  headers.set("x-claude-code-session-id", options.sessionID ?? headers.get("x-session-id") ?? claudeCodeSessionID)
  const stainless = {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
  Object.entries(stainless).forEach(([key, value]) => {
    if (!headers.has(key)) headers.set(key, value)
  })
  headers.delete("x-api-key")
  return headers
}

export function transformClaudeCodeBody(
  body: FetchBody,
  options: { readonly version?: string; readonly billingSample?: string } = {},
): FetchBody {
  if (typeof body !== "string") return body
  let parsed: ClaudeBody
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!Array.isArray(parsed.system)) parsed.system = []
  parsed.system = parsed.system.filter(
    (entry) => !(entry.type === "text" && typeof entry.text === "string" && entry.text.startsWith(billingPrefix)),
  )
  parsed.system.unshift({
    type: "text",
    text: buildBillingHeader(
      parsed.messages ?? [],
      options.version ?? version(),
      process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli",
      options.billingSample,
    ),
  })
  parsed.system = parsed.system.flatMap((entry) => {
    if (
      entry.type !== "text" ||
      typeof entry.text !== "string" ||
      !entry.text.startsWith(systemIdentity) ||
      entry.text.length === systemIdentity.length
    )
      return [entry]
    const rest = entry.text.slice(systemIdentity.length).replace(/^\n+/, "")
    const { text: _text, ...properties } = entry
    const { cache_control: _cacheControl, ...identityProperties } = properties
    return [{ ...identityProperties, text: systemIdentity }, ...(rest ? [{ ...properties, text: rest }] : [])]
  })
  if (!parsed.system.some((entry) => entry.text === systemIdentity))
    parsed.system.splice(1, 0, { type: "text", text: systemIdentity })

  const kept: ContentBlock[] = []
  const moved: ContentBlock[] = []
  parsed.system.forEach((entry) => {
    const text = typeof entry.text === "string" ? entry.text : ""
    if (text.startsWith(billingPrefix) || text.startsWith(systemIdentity)) kept.push(entry)
    else if (text.length > 0) moved.push(entry)
  })
  const firstUser = parsed.messages?.find((message) => message.role === "user")
  if (firstUser && moved.length > 0) {
    parsed.system = kept
    if (typeof firstUser.content === "string") firstUser.content = [...moved, { type: "text", text: firstUser.content }]
    else firstUser.content = [...moved, ...(firstUser.content ?? [])]
  }

  if (parsed.model?.toLowerCase().includes("haiku")) {
    if (parsed.output_config) {
      delete parsed.output_config.effort
      if (Object.keys(parsed.output_config).length === 0) delete parsed.output_config
    }
    if (parsed.thinking) {
      delete parsed.thinking.effort
      if (Object.keys(parsed.thinking).length === 0) delete parsed.thinking
    }
  }

  if (Array.isArray(parsed.tools))
    parsed.tools = parsed.tools.map((tool) => ({
      ...tool,
      name: tool.name ? prefixToolName(tool.name) : tool.name,
    }))
  if (Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((message) => {
      if (!Array.isArray(message.content)) return message
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === "tool_use" && typeof block.name === "string"
            ? { ...block, name: prefixToolName(block.name) }
            : block,
        ),
      }
    })
    parsed.messages = repairClaudeCodeToolPairs(parsed.messages)
  }
  return JSON.stringify(parsed)
}

export function repairClaudeCodeToolPairs(messages: ClaudeMessage[]) {
  const uses = new Map<string, number>()
  const results = new Map<string, number>()
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((block) => {
      if (block.type === "tool_use" && typeof block.id === "string" && !uses.has(block.id)) uses.set(block.id, index)
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && !results.has(block.tool_use_id))
        results.set(block.tool_use_id, index)
    })
  })
  const adjacent = (id: string) => uses.has(id) && results.get(id) === (uses.get(id) ?? -2) + 1
  if ([...uses.keys(), ...results.keys()].every(adjacent)) return messages
  return messages
    .map((message, index) => {
      if (!Array.isArray(message.content)) return message
      return {
        ...message,
        content: message.content.filter((block) => {
          if (block.type === "tool_use" && typeof block.id === "string")
            return adjacent(block.id) && uses.get(block.id) === index
          if (block.type === "tool_result" && typeof block.tool_use_id === "string")
            return adjacent(block.tool_use_id) && results.get(block.tool_use_id) === index
          return true
        }),
      }
    })
    .filter((message) => !Array.isArray(message.content) || message.content.length > 0)
}

export function stripClaudeCodeToolPrefix(text: string) {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, (_match, name: string) => {
    const original = `${name.charAt(0).toLowerCase()}${name.slice(1)}`
    return `"name": "${original}"`
  })
}

export function transformClaudeCodeResponse(response: Response) {
  if (!response.body) return response
  if (!response.ok) return mapResponseBody(response, false)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const event = buffer.slice(0, boundary + 2)
          buffer = buffer.slice(boundary + 2)
          controller.enqueue(encoder.encode(stripClaudeCodeToolPrefix(event)))
          return
        }
        const part = await reader.read()
        if (part.done) {
          if (buffer) controller.enqueue(encoder.encode(stripClaudeCodeToolPrefix(buffer)))
          controller.close()
          return
        }
        buffer += decoder.decode(part.value, { stream: true })
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function createClaudeCodeFetch(input: {
  readonly fetch: typeof fetch
  readonly credentials: () => Promise<ClaudeCodeCredentials | null>
  readonly reload: () => Promise<ClaudeCodeCredentials | null>
  readonly sessionID?: string
  readonly requestID?: () => string
  readonly billingSample?: (sessionID: string) => Promise<string | undefined>
  readonly onEvent?: (event: ClaudeCodeRequestEvent) => void
  readonly onResponse?: (response: Response) => void | Promise<void>
}) {
  const run = async (
    request: FetchInput,
    init: RequestInit,
    credentials: ClaudeCodeCredentials,
    excluded: Set<string>,
    billingSample: string | undefined,
  ) => {
    const modelID = modelFromBody(init.body)
    const url = requestURL(request)
    const headers = buildClaudeCodeHeaders(request, init, credentials.accessToken, modelID, excluded, {
      sessionID: input.sessionID,
      requestID: input.requestID,
    })
    return input.fetch(url, {
      ...init,
      body: transformClaudeCodeBody(init.body, { billingSample }),
      headers,
    })
  }

  const wrapped = async (request: FetchInput, init: RequestInit = {}) => {
    const latest = await input.credentials()
    if (!latest) throw new Error("Claude Code credentials are unavailable or expired. Run `claude auth login`.")
    const excluded = new Set<string>()
    const sessionID = input.sessionID ?? requestHeader(request, init, "x-session-id")
    const billingSample =
      sessionID && input.billingSample
        ? await Promise.resolve()
            .then(() => input.billingSample!(sessionID))
            .catch(() => undefined)
        : undefined
    let response = await run(request, init, latest, excluded, billingSample)
    if (response.status === 401) {
      const rotated = await input.reload().catch(() => null)
      if (!rotated || rotated.accessToken === latest.accessToken) return response
      input.onEvent?.({
        event: "credential-rotated",
        data: { sourceReloaded: true },
      })
      response = await run(request, init, rotated, excluded, billingSample)
    }
    for (;;) {
      if (response.status !== 400 && response.status !== 429) break
      if (!isLongContextError(await response.clone().text())) break
      const active = getClaudeCodeModelBetas(modelFromBody(init.body), excluded)
      const beta = longContextBetas.find((candidate) => active.includes(candidate))
      if (!beta) break
      excluded.add(beta)
      input.onEvent?.({ event: "beta-excluded", data: { beta } })
      const current = (await input.credentials()) ?? latest
      response = await run(request, init, current, excluded, billingSample)
    }
    try {
      await input.onResponse?.(response)
    } catch {
      input.onEvent?.({ event: "response-observer-failed" })
    }
    return transformClaudeCodeResponse(response)
  }
  return Object.assign(wrapped, {
    preconnect: input.fetch.preconnect ?? fetch.preconnect,
  })
}

export function redactClaudeCodeEvent(event: ClaudeCodeRequestEvent) {
  const redact = (key: string, value: unknown): unknown => {
    if (/access|refresh|authorization|api[-_]?key|token|secret|credential/i.test(key)) return "<redacted>"
    if (typeof value === "string" && /^eyJ[A-Za-z0-9_-]{10,}/.test(value)) return "<redacted>"
    if (Array.isArray(value)) return value.map((item) => redact("", item))
    if (record(value))
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(name, item)]))
    return value
  }
  return {
    event: event.event,
    data: Object.fromEntries(Object.entries(event.data ?? {}).map(([key, value]) => [key, redact(key, value)])),
  }
}

export function writeClaudeCodeDebugEvent(file: string, event: ClaudeCodeRequestEvent) {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...redactClaudeCodeEvent(event) })}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  })
  if (process.platform !== "win32") chmodSync(file, 0o600)
}

function requestURL(input: FetchInput) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) url.searchParams.set("beta", "true")
  return url.toString()
}

function requestHeader(input: FetchInput, init: RequestInit, name: string) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return headers.get(name) ?? undefined
}

function modelFromBody(body: FetchBody) {
  if (typeof body !== "string") return "unknown"
  try {
    const parsed = JSON.parse(body)
    return record(parsed) && typeof parsed.model === "string" ? parsed.model : "unknown"
  } catch {
    return "unknown"
  }
}

function prefixToolName(name: string) {
  return `${toolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function buildBillingHeader(messages: ClaudeMessage[], value: string, entrypoint: string, sample?: string) {
  const sampled = sample ?? claudeCodeBillingSample(firstUserText(messages))
  const suffix = createHash("sha256").update(`${billingSalt}${sampled}${value}`).digest("hex").slice(0, 3)
  return `${billingPrefix}: cc_version=${value}.${suffix}; cc_entrypoint=${entrypoint};`
}

export const claudeCodeBillingSample = (text: string) => [4, 7, 20].map((index) => text[index] ?? "0").join("")

function firstUserText(messages: ClaudeMessage[]) {
  const content = messages.find((message) => message.role === "user")?.content
  if (typeof content === "string") return content
  return content?.find((block) => block.type === "text" && typeof block.text === "string")?.text ?? ""
}

function version() {
  return process.env.ANTHROPIC_CLI_VERSION ?? defaultVersion
}

function isLongContextError(body: string) {
  return (
    body.includes("Extra usage is required for long context requests") ||
    body.includes("long context beta is not yet available") ||
    body.includes("You're out of extra usage")
  )
}

function mapResponseBody(response: Response, bufferEvents: boolean) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = await reader.read()
      if (part.done) {
        if (buffer) controller.enqueue(encoder.encode(stripClaudeCodeToolPrefix(buffer)))
        controller.close()
        return
      }
      const text = decoder.decode(part.value, { stream: true })
      if (!bufferEvents) controller.enqueue(encoder.encode(stripClaudeCodeToolPrefix(text)))
      else buffer += text
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
