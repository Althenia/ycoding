import { randomUUID } from "node:crypto"
import { WebSocket } from "ws"
import { ccaDesktopAppVersion, ccaDesktopOriginator, ccaDesktopUserAgent } from "./cca-executor-registration"

export const ccaDurableHostURL = "wss://codex-cloud-backend.chatgpt.com/"
export const ccaDurableHistoryBaseURL = "https://codex-cloud-backend.chatgpt.com"
export const ccaDurableHandshakeTimeoutMs = 15_000
export const ccaDurableRequestTimeoutMs = 30_000
export const ccaDurableAdmissionTimeoutMs = 120_000
export const ccaDurablePingMs = 10_000
export const ccaDurablePongTimeoutMs = 60_000
export const ccaDurableReconnectInitialMs = 1_000
export const ccaDurableReconnectMaxMs = 20_000
const reconnectBaseCapMs = 10_000
const maxPayload = 100 * 1024 * 1024
const watchedThreadLimit = 32
const pendingRequestLimit = 256
const threadListPageLimit = 100
const threadListMaxPages = 20

export const ccaDurableOptOutNotificationMethods = [
  "thread/project/updated", "thread/prediction/updated", "rawResponseItem/completed", "command/exec/outputDelta", "project/changed",
  "externalAgentConfig/import/progress", "thread/compacted", "windows/worldWritableWarning", "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted", "authStatusChange", "loginChatGptComplete", "codex/event/task_started", "codex/event/agent_reasoning",
  "codex/event/agent_message", "codex/event/task_complete", "codex/event/mcp_tool_call_begin", "codex/event/mcp_tool_call_end",
  "codex/event/exec_command_begin", "codex/event/exec_command_end", "codex/event/exec_command_output_delta", "codex/event/exec_approval_request",
  "codex/event/apply_patch_approval_request", "codex/event/background_event", "codex/event/turn_diff", "codex/event/get_history_entry_response",
  "codex/event/agent_reasoning_delta", "codex/event/agent_reasoning_section_break", "codex/event/agent_message_delta", "codex/event/stream_error",
  "codex/event/error", "codex/event/turn_aborted", "codex/event/plan_delta", "codex/event/plan_update", "codex/event/patch_apply_begin",
  "codex/event/patch_apply_end", "codex/event/item_started", "codex/event/item_completed", "codex/event/user_message",
  "codex/event/agent_reasoning_raw_content", "codex/event/agent_reasoning_raw_content_delta", "codex/event/web_search_begin",
  "codex/event/web_search_end", "codex/event/mcp_list_tools_response", "codex/event/list_skills_response", "codex/event/list_remote_skills_response",
  "codex/event/remote_skill_downloaded", "codex/event/list_custom_prompts_response", "codex/event/raw_response_item",
  "codex/event/agent_message_content_delta", "codex/event/reasoning_content_delta", "codex/event/reasoning_raw_content_delta",
  "codex/event/warning", "codex/event/undo_started", "codex/event/undo_completed", "codex/event/shutdown_complete",
  "codex/event/entered_review_mode", "codex/event/exited_review_mode", "codex/event/view_image_tool_call", "codex/event/mcp_startup_update",
  "codex/event/mcp_startup_complete", "codex/event/remote_task_created", "codex/event/thread_rolled_back", "codex/event/thread_name_updated",
  "codex/event/elicitation_request", "codex/event/dynamic_tool_call_request", "codex/event/request_user_input", "codex/event/terminal_interaction",
  "codex/event/token_count", "codex/event/deprecation_notice", "thread/closed", "thread/reverted", "rawResponse/completed", "warning",
  "turn/diff/updated",
] as const

export const ccaDurableCapturedRequestMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
] as const

export type CcaDurableCapturedMethod = (typeof ccaDurableCapturedRequestMethods)[number]
export type CcaDurableCredential = { readonly access: string; readonly accountID: string }
export type CcaDurableReply =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error"; readonly code?: number; readonly message: string; readonly errorCode?: string; readonly errorType?: string }
  | { readonly kind: "not-sent" }
  | { readonly kind: "unknown" }
export type CcaDurableServerRequest = {
  readonly requestID: string
  readonly rawID: string | number
  readonly method: CcaDurableCapturedMethod
  readonly threadID: string
  readonly params: Readonly<Record<string, unknown>>
}
export type CcaDurableDiagnostic = "durable-connected" | "durable-failed" | "durable-rejected"

export interface CcaDurableSocket {
  readonly readyState: number
  on(event: string, listener: (...args: never[]) => void): unknown
  send(data: string, callback?: (error?: Error) => void): void
  ping(): void
  close(code?: number): void
  terminate(): void
}

export type CcaDurableConnector = (url: string, protocols: readonly string[], headers: Record<string, string>) => CcaDurableSocket

export interface CcaDurableClient {
  readonly connected: () => boolean
  readonly request: (method: string, params: unknown, timeoutMs?: number) => Promise<CcaDurableReply>
  readonly watch: (threadID: string, options?: { readonly force?: boolean }) => Promise<CcaDurableReply>
  readonly pending: (threadID: string) => readonly CcaDurableServerRequest[]
  readonly answer: (threadID: string, requestID: string, result: unknown) => Promise<"sent" | "stale" | "unknown">
  readonly close: () => Promise<void>
}

export interface CcaDurableClientDeps {
  readonly credential: (rejectedAccess?: string) => Promise<CcaDurableCredential | undefined>
  readonly connect?: CcaDurableConnector
  readonly url?: string
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly now?: () => number
  readonly onState?: (connected: boolean) => void
  readonly onDiagnostic?: (category: CcaDurableDiagnostic) => void
}

type Connection = {
  readonly socket: CcaDurableSocket
  initialized: boolean
  readonly calls: Map<string, (reply: CcaDurableReply) => void>
  readonly requests: Map<string, CcaDurableServerRequest>
  readonly subscribed: Map<string, Promise<CcaDurableReply>>
}
type DialOutcome = "dropped" | "failed" | "unauthorized" | "closed"

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const captured = new Set<string>(ccaDurableCapturedRequestMethods)
const isCapturedMethod = (method: string): method is CcaDurableCapturedMethod => captured.has(method)

export const connectCcaDurableSocket: CcaDurableConnector = (url, protocols, headers) =>
  new WebSocket(url, [...protocols], { headers, perMessageDeflate: false, handshakeTimeout: ccaDurableHandshakeTimeoutMs, maxPayload })

export function ccaDurableProtocols(access: string) {
  return ["codex-app-server", "codex-client.desktop", `openai-bearer.${access}`]
}

export function ccaDurableHeaders(credential: CcaDurableCredential): Record<string, string> {
  return {
    "X-OpenAI-Product-Sku": "codex",
    "ChatGPT-Account-Id": credential.accountID,
    originator: ccaDesktopOriginator,
    "User-Agent": ccaDesktopUserAgent(),
  }
}

export function ccaDurableInitializeParams() {
  return {
    clientInfo: { name: ccaDesktopOriginator, title: ccaDesktopOriginator, version: ccaDesktopAppVersion },
    capabilities: { experimentalApi: true, optOutNotificationMethods: [...ccaDurableOptOutNotificationMethods] },
  }
}

export type CcaDurableThreadList =
  | { readonly kind: "listed"; readonly threads: Record<string, unknown>[]; readonly pages: number }
  | {
    readonly kind: "failed"
    readonly pages: number
    readonly reply: Exclude<CcaDurableReply, { readonly kind: "result" }> | { readonly kind: "malformed" | "cursor-repeated" | "page-limit" }
  }

export async function listCcaDurableThreads(client: Pick<CcaDurableClient, "request">): Promise<CcaDurableThreadList> {
  const threads: Record<string, unknown>[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < threadListMaxPages; page++) {
    const reply = await client.request("thread/list", { cursor, limit: threadListPageLimit, archived: false, useStateDbOnly: true })
    if (reply.kind !== "result") return { kind: "failed", pages: page, reply }
    if (!isRecord(reply.result) || !Array.isArray(reply.result.data)) return { kind: "failed", pages: page, reply: { kind: "malformed" } }
    for (const item of reply.result.data) if (isRecord(item) && typeof item.id === "string" && item.id) threads.push(item)
    const next = reply.result.nextCursor
    if (next === null || next === undefined) return { kind: "listed", threads, pages: page + 1 }
    if (typeof next !== "string" || !next) return { kind: "failed", pages: page + 1, reply: { kind: "malformed" } }
    if (cursors.has(next)) return { kind: "failed", pages: page + 1, reply: { kind: "cursor-repeated" } }
    cursors.add(next)
    cursor = next
  }
  return { kind: "failed", pages: threadListMaxPages, reply: { kind: "page-limit" } }
}

export function startCcaDurableClient(deps: CcaDurableClientDeps): CcaDurableClient {
  const connect = deps.connect ?? connectCcaDurableSocket
  const url = deps.url ?? ccaDurableHostURL
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now
  const controller = new AbortController()
  const signal = controller.signal
  const watched = new Map<string, true>()
  let current: Connection | undefined
  let reconnectMs = ccaDurableReconnectInitialMs

  function send(connection: Connection, method: string, params: unknown, timeoutMs: number): Promise<CcaDurableReply> {
    if (connection.socket.readyState !== 1) return Promise.resolve({ kind: "not-sent" })
    const id = `${method}:${randomUUID()}`
    return new Promise((resolve) => {
      let settled = false
      const settle = (reply: CcaDurableReply) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        connection.calls.delete(id)
        resolve(reply)
      }
      const timer = setTimeout(() => settle({ kind: "unknown" }), timeoutMs)
      timer.unref?.()
      connection.calls.set(id, settle)
      try {
        connection.socket.send(JSON.stringify({ id, method, params }), (error) => { if (error) settle({ kind: "unknown" }) })
      } catch {
        settle({ kind: "not-sent" })
      }
    })
  }

  function subscribe(connection: Connection, threadID: string) {
    const existing = connection.subscribed.get(threadID)
    if (existing) return existing
    const subscription: Promise<CcaDurableReply> = send(connection, "thread/resume", { threadId: threadID, excludeTurns: true }, ccaDurableAdmissionTimeoutMs).then((reply) => {
      if (reply.kind !== "result" && connection.subscribed.get(threadID) === subscription) connection.subscribed.delete(threadID)
      return reply
    })
    connection.subscribed.set(threadID, subscription)
    return subscription
  }

  function receive(connection: Connection, data: unknown) {
    let message: unknown
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data))
    } catch {
      return
    }
    if (!isRecord(message)) return
    const id = message.id
    if (typeof message.method !== "string") {
      if (typeof id !== "string") return
      const settle = connection.calls.get(id)
      if (!settle) return
      if ("error" in message) {
        const error = isRecord(message.error) ? message.error : {}
        const data = isRecord(error.data) ? error.data : {}
        settle({
          kind: "error",
          ...(typeof error.code === "number" ? { code: error.code } : {}),
          message: typeof error.message === "string" ? error.message.slice(0, 1000) : "",
          ...(typeof data.code === "string" ? { errorCode: data.code.slice(0, 128) } : {}),
          ...(typeof data.errorType === "string" ? { errorType: data.errorType.slice(0, 128) } : {}),
        })
        return
      }
      settle({ kind: "result", result: message.result })
      return
    }
    const params = isRecord(message.params) ? message.params : undefined
    if (id === undefined) {
      if (message.method === "thread/archived" && typeof params?.threadId === "string") {
        connection.subscribed.delete(params.threadId)
        return
      }
      if (message.method !== "serverRequest/resolved" || !params) return
      const requestID = typeof params.requestId === "string" || typeof params.requestId === "number" ? String(params.requestId) : undefined
      if (requestID !== undefined) connection.requests.delete(requestID)
      return
    }
    if (typeof id !== "string" && typeof id !== "number") return
    if (!isCapturedMethod(message.method) || !params || typeof params.threadId !== "string" || !watched.has(params.threadId)) return
    const requestID = String(id)
    if (!requestID || requestID.length > 256 || connection.requests.size >= pendingRequestLimit || connection.requests.has(requestID)) return
    connection.requests.set(requestID, { requestID, rawID: id, method: message.method, threadID: params.threadId, params })
  }

  function retire(connection: Connection) {
    if (current === connection) current = undefined
    const wasInitialized = connection.initialized
    connection.initialized = false
    connection.requests.clear()
    for (const settle of connection.calls.values()) settle({ kind: "unknown" })
    if (wasInitialized) deps.onState?.(false)
  }

  function dial(credential: CcaDurableCredential): Promise<DialOutcome> {
    return new Promise((resolve) => {
      let socket: CcaDurableSocket
      try {
        socket = connect(url, ccaDurableProtocols(credential.access), ccaDurableHeaders(credential))
      } catch {
        resolve("failed")
        return
      }
      const connection: Connection = { socket, initialized: false, calls: new Map(), requests: new Map(), subscribed: new Map() }
      let status: number | undefined
      let opened = false
      let settled = false
      let lastPong = now()
      let pinger: ReturnType<typeof setInterval> | undefined
      const finish = (outcome: DialOutcome) => {
        if (settled) return
        settled = true
        clearInterval(pinger)
        signal.removeEventListener("abort", stop)
        retire(connection)
        resolve(outcome)
      }
      const stop = () => {
        try {
          socket.terminate()
        } catch {}
        finish("closed")
      }
      signal.addEventListener("abort", stop, { once: true })
      socket.on("unexpected-response", (_request: unknown, response: { readonly statusCode?: number } | undefined) => {
        status = response?.statusCode
        try {
          socket.terminate()
        } catch {}
        finish(status === 401 ? "unauthorized" : "failed")
      })
      socket.on("error", () => {})
      socket.on("pong", () => { lastPong = now() })
      socket.on("message", (data: unknown) => receive(connection, data))
      socket.on("close", () => finish(signal.aborted ? "closed" : opened ? "dropped" : "failed"))
      socket.on("open", () => {
        opened = true
        current = connection
        lastPong = now()
        pinger = setInterval(() => {
          if (socket.readyState !== 1) return
          if (now() - lastPong > ccaDurablePongTimeoutMs) {
            try {
              socket.terminate()
            } catch {}
            finish(signal.aborted ? "closed" : "dropped")
            return
          }
          try {
            socket.ping()
          } catch {}
        }, ccaDurablePingMs)
        pinger.unref?.()
        void send(connection, "initialize", ccaDurableInitializeParams(), ccaDurableRequestTimeoutMs).then((reply) => {
          if (settled) return
          if (reply.kind !== "result") {
            try {
              socket.close()
            } catch {}
            return
          }
          try {
            socket.send(JSON.stringify({ method: "initialized", params: {} }))
          } catch {
            return
          }
          connection.initialized = true
          reconnectMs = ccaDurableReconnectInitialMs
          deps.onDiagnostic?.("durable-connected")
          for (const threadID of watched.keys()) void subscribe(connection, threadID)
          deps.onState?.(true)
        })
      })
    })
  }

  async function attempt(): Promise<"retry" | "denied" | "closed"> {
    let rejected: string | undefined
    for (let tries = 0; tries < 2; tries++) {
      const credential = await deps.credential(rejected).catch(() => undefined)
      if (signal.aborted) return "closed"
      if (!credential) return "retry"
      const outcome = await dial(credential)
      if (signal.aborted || outcome === "closed") return "closed"
      if (outcome !== "unauthorized") return "retry"
      rejected = credential.access
    }
    return "denied"
  }

  const done = (async () => {
    while (!signal.aborted) {
      const outcome = await attempt()
      if (signal.aborted || outcome === "closed") return
      if (outcome === "denied") {
        deps.onDiagnostic?.("durable-rejected")
        return
      }
      deps.onDiagnostic?.("durable-failed")
      const base = Math.min(reconnectMs, reconnectBaseCapMs)
      const pause = base + Math.floor(random() * base)
      reconnectMs = Math.min(reconnectMs * 2, ccaDurableReconnectMaxMs)
      await deps.wait(pause, signal)
    }
  })()

  return {
    connected: () => current?.initialized === true && current.socket.readyState === 1,
    request: (method, params, timeoutMs = ccaDurableRequestTimeoutMs) => {
      const connection = current
      if (!connection?.initialized) return Promise.resolve({ kind: "not-sent" })
      return send(connection, method, params, timeoutMs)
    },
    watch: (threadID, options) => {
      watched.delete(threadID)
      watched.set(threadID, true)
      if (watched.size > watchedThreadLimit) watched.delete(watched.keys().next().value!)
      const connection = current
      if (!connection?.initialized) return Promise.resolve({ kind: "not-sent" })
      if (options?.force) connection.subscribed.delete(threadID)
      return subscribe(connection, threadID)
    },
    pending: (threadID) => [...(current?.requests.values() ?? [])].filter((request) => request.threadID === threadID),
    answer: (threadID, requestID, result) => {
      const connection = current
      const entry = connection?.requests.get(requestID)
      if (!connection || !entry || entry.threadID !== threadID || connection.socket.readyState !== 1) return Promise.resolve("stale")
      connection.requests.delete(requestID)
      return new Promise((resolve) => {
        try {
          connection.socket.send(JSON.stringify({ id: entry.rawID, result }), (error) => resolve(error ? "unknown" : "sent"))
        } catch {
          resolve("unknown")
        }
      })
    },
    close: async () => {
      controller.abort()
      await done
    },
  }
}
