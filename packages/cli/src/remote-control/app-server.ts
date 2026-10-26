import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"
import { platformFamily } from "./types"

export type RemoteControlLocation = { readonly directory: string; readonly workspaceID?: string }
export type RemoteControlThread = {
  readonly id: string
  readonly title?: string
  readonly directory: string
  readonly updatedAt?: number
}
export type RemoteControlMessage = { readonly id: string; readonly role: string; readonly text: string }

export interface RemoteControlBackend {
  readonly resolveLocation: (directory: string) => Promise<RemoteControlLocation | undefined>
  readonly createThread: (input: { readonly location: RemoteControlLocation; readonly title?: string }) => Promise<RemoteControlThread>
  readonly getThread: (threadID: string) => Promise<RemoteControlThread | undefined>
  readonly listThreads: () => Promise<readonly RemoteControlThread[]>
  readonly readMessages: (threadID: string) => Promise<readonly RemoteControlMessage[]>
  readonly prompt: (
    threadID: string,
    input: {
      readonly text: string
      readonly delivery: "steer" | "queue"
      readonly origin: "plugin"
      readonly externalSource: { readonly kind: "remote-control" }
    },
  ) => Promise<{ readonly messageID: string }>
  readonly interrupt: (threadID: string) => Promise<void>
  readonly models: () => Promise<readonly { readonly id: string; readonly providerID?: string; readonly name?: string }[]>
  readonly skills: () => Promise<readonly { readonly id: string; readonly name?: string }[]>
  readonly account: () => Promise<{ readonly profile: string } | undefined>
  readonly pendingApprovals: (threadID: string) => Promise<readonly { readonly id: string; readonly kind: string }[]>
}

type Notify = (method: string, params: unknown) => void

const refusedPrefixes = ["command/", "process/", "fs/", "permission/", "guardrail/", "question/", "form/"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validHeaderValue(value: string) {
  return value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value)
}

function threadWire(thread: RemoteControlThread) {
  return {
    id: thread.id,
    cwd: thread.directory,
    ...(thread.title === undefined ? {} : { title: thread.title, name: thread.title }),
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
    status: { type: "idle" },
  }
}

function turnsFromMessages(messages: readonly RemoteControlMessage[]) {
  const turns: Array<{ id: string; items: Array<Record<string, unknown>>; status: string }> = []
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        id: message.id,
        status: "completed",
        items: [{ type: "userMessage", id: message.id, content: message.text }],
      })
      continue
    }
    if (message.role !== "assistant") continue
    const item = { type: "agentMessage", id: message.id, content: message.text, text: message.text }
    const current = turns[turns.length - 1]
    if (current) current.items.push(item)
    else turns.push({ id: message.id, status: "completed", items: [item] })
  }
  return turns
}

function inputText(params: Record<string, unknown>) {
  const input = params.input
  if (!Array.isArray(input)) return undefined
  const texts = input.flatMap((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
  )
  return texts.length > 0 ? texts.join("\n") : undefined
}

export function createRemoteControlAppServer(input: {
  readonly backend: RemoteControlBackend
  readonly codexHome: string
  readonly notify?: Notify
}) {
  const backend = input.backend
  let initialized = false
  let ready = false

  const result = (id: unknown, value: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: value })
  const failure = (id: unknown, code: number, message: string) =>
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })

  async function surfaceApprovals(threadID: string) {
    const pending = await backend.pendingApprovals(threadID)
    if (pending.length > 0)
      input.notify?.("item/approvalRequested", {
        threadId: threadID,
        items: pending.map((item) => ({ id: item.id, kind: item.kind, status: "pending" })),
      })
  }

  async function dispatch(method: string, params: Record<string, unknown>, id: unknown): Promise<string> {
    if (method === "initialize") {
      if (initialized) return failure(id, -32600, "Already initialized")
      const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : undefined
      const name = clientInfo?.name
      if (typeof name !== "string" || !validHeaderValue(name)) return failure(id, -32602, "Invalid clientInfo.name")
      initialized = true
      return result(id, {
        userAgent: OpenAICodex.userAgent(),
        codexHome: input.codexHome,
        platformFamily: platformFamily(),
        platformOs: process.platform,
        serverInfo: { name: OpenAICodex.clientInfo.name, title: OpenAICodex.clientInfo.title, version: OpenAICodex.clientInfo.version },
        capabilities: {},
      })
    }
    if (!initialized) return failure(id, -32002, "Not initialized")
    if (
      refusedPrefixes.some((prefix) => method.startsWith(prefix)) ||
      method.includes("requestApproval") ||
      method.includes("/reply") ||
      method.includes("/approve")
    )
      return failure(id, -32601, "Method not found")

    switch (method) {
      case "thread/start": {
        const cwd = typeof params.cwd === "string" ? params.cwd : undefined
        if (cwd === undefined) return failure(id, -32602, "cwd is required")
        const location = await backend.resolveLocation(cwd)
        if (location === undefined) return failure(id, -32602, "Directory is not a recorded YCoding Location")
        const thread = await backend.createThread({
          location,
          ...(typeof params.title === "string" ? { title: params.title } : {}),
        })
        return result(id, { thread: threadWire(thread) })
      }
      case "thread/resume": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        const thread = threadID === undefined ? undefined : await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        return result(id, { thread: threadWire(thread) })
      }
      case "thread/list": {
        const threads = await backend.listThreads()
        return result(id, { data: threads.map(threadWire) })
      }
      case "thread/read": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        const thread = threadID === undefined ? undefined : await backend.getThread(threadID)
        if (thread === undefined || threadID === undefined) return failure(id, -32602, "Thread is unavailable")
        const turns = params.includeTurns === false ? [] : turnsFromMessages(await backend.readMessages(threadID))
        await surfaceApprovals(threadID)
        return result(id, { thread: { ...threadWire(thread), turns } })
      }
      case "turn/start":
      case "turn/steer": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        const text = inputText(params)
        if (threadID === undefined || text === undefined) return failure(id, -32602, "threadId and text input are required")
        if ((await backend.getThread(threadID)) === undefined) return failure(id, -32602, "Thread is unavailable")
        const admitted = await backend.prompt(threadID, {
          text,
          delivery: "steer",
          origin: "plugin",
          externalSource: { kind: "remote-control" },
        })
        input.notify?.("turn/started", { threadId: threadID, turn: { id: admitted.messageID, status: "inProgress" } })
        await surfaceApprovals(threadID)
        return result(id, { turn: { id: admitted.messageID, status: "inProgress", items: [] } })
      }
      case "turn/interrupt": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        if ((await backend.getThread(threadID)) === undefined) return failure(id, -32602, "Thread is unavailable")
        await backend.interrupt(threadID)
        return result(id, {})
      }
      case "account/read": {
        const account = await backend.account()
        return result(id, {
          account: account === undefined ? null : { type: "chatgpt", profile: account.profile },
          requiresOpenaiAuth: account === undefined,
        })
      }
      case "getAuthStatus": {
        const account = await backend.account()
        return result(id, { authMethod: account === undefined ? null : "chatgpt", requiresOpenaiAuth: account === undefined })
      }
      case "config/read":
        return result(id, { config: {} })
      case "model/list": {
        const models = await backend.models()
        return result(id, {
          data: models.map((model) => ({
            id: model.id,
            model: model.id,
            displayName: model.name ?? model.id,
            ...(model.providerID === undefined ? {} : { providerId: model.providerID }),
          })),
        })
      }
      case "skills/list": {
        const skills = await backend.skills()
        return result(id, { data: skills.map((skill) => ({ id: skill.id, name: skill.name ?? skill.id })) })
      }
      default:
        return failure(id, -32601, "Method not found")
    }
  }

  return {
    handle: async (text: string): Promise<string | undefined> => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return failure(null, -32700, "Parse error")
      }
      if (!isRecord(parsed)) return failure(null, -32600, "Invalid Request")
      if (typeof parsed.method !== "string") return undefined
      const params = isRecord(parsed.params) ? parsed.params : {}
      if (parsed.method === "initialized") {
        ready = initialized
        return undefined
      }
      if (!("id" in parsed)) return undefined
      const id = parsed.id ?? null
      try {
        return await dispatch(parsed.method, params, id)
      } catch {
        return failure(id, -32603, "Remote-control request failed")
      }
    },
    ready: () => ready,
  }
}
