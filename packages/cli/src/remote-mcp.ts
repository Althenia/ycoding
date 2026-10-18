export * as RemoteMcp from "./remote-mcp"

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { Option, Schema } from "effect"
import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import { parseChunkedValue, type McpPrincipal, type RemoteErrorCode, type RemoteResponse } from "@ycoding-ai/remote"
import type { LocalServer } from "./remote-local"
import {
  createOperationCache,
  executeRemoteDirectorySession,
  executeRemoteOperation,
  type OperationCache,
  type SessionRegistry,
  type SubscriptionRegistry,
} from "./remote-operations"
import { RemoteMcpSchemas } from "./remote-mcp-schemas"
import { RemoteMcpDemo } from "./remote-mcp-demo"

export const maxResultChars = 2 * 1024 * 1024

type TextResult = RemoteMCPTransport.ToolResult<{ readonly type: "text"; readonly text: string }>

export type Context = { readonly epoch: string; readonly principal: McpPrincipal }

export type Options = {
  readonly local: LocalServer
  readonly sessions: SessionRegistry
  readonly subscriptions: SubscriptionRegistry
  readonly cache?: OperationCache
  readonly home?: string
  readonly resource: string
  readonly allowed: (epoch: string) => boolean
  readonly maxResultChars?: number
  readonly now?: () => number
}

type Ticket = { readonly context: Context; readonly previous: Promise<void>; readonly release: () => void; readonly lane?: string; started: boolean; authorizationDenied?: true }
type Admitted = { readonly response: Response } | { readonly body: string; readonly ticket: Ticket }

const guidance: Partial<Record<RemoteErrorCode, string>> = {
  outcome_unknown: " Inspect the Session's current state before retrying; the request was not replayed.",
  unknown_operation: " Update YCoding on this machine and reconnect Remote.",
  message_too_large: " Narrow the request or page with a cursor, after, or limit.",
}

export function createRemoteMcp(options: Options) {
  const resource = new URL(options.resource)
  const home = options.home ?? homedir()
  const limit = options.maxResultChars ?? maxResultChars
  const cache = options.cache ?? createOperationCache()
  const demo = RemoteMcpDemo.create(options.now)
  const demoTools = new Map(RemoteMcpDemo.tools.map((tool) => [tool.name, tool]))
  const byName = new Map(RemoteMcpSchemas.tools.map((tool) => [tool.name, tool]))
  const lanes = new Map<string, Promise<void>>()
  const uncertain = new Set<string>()
  const inflight = new Set<AbortController>()
  let admission: Promise<unknown> = Promise.resolve()
  let closed = false

  const transport = RemoteMCPTransport.create<Ticket>({
    name: "ycoding-remote",
    version: "1.0.0",
    tools: RemoteMcpSchemas.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      ...demoTools.get(tool.name),
    })),
    call: execute,
    resources: {
      list: async () => demo.list(),
      read: async (input) => {
        input.signal.throwIfAborted()
        return demo.read(input.uri)
      },
    },
  })

  async function execute(call: RemoteMCPTransport.Call<Ticket>): Promise<RemoteMCPTransport.ToolResult> {
    const ticket = call.context
    const tool = byName.get(call.name)
    if (ticket === undefined || tool === undefined || ticket.started) return failure("internal_error", "The request has no admission")
    ticket.started = true
    try {
      if (!options.allowed(ticket.context.epoch)) {
        ticket.authorizationDenied = true
        return failure("agent_unavailable", "Relay MCP is off or its authorization changed; the request was not executed")
      }
      if (ticket.lane !== undefined && uncertain.has(ticket.lane))
        return failure("outcome_unknown", "An earlier mutation in this lane has an unknown outcome. Inspect the local Session, then disconnect and reconnect Remote before another MCP mutation. This request was not executed.")
      const frames = await dispatch(tool, call.arguments, call.signal)
      if (ticket.lane !== undefined && frames.some((frame) => !frame.ok && frame.error.code === "outcome_unknown")) uncertain.add(ticket.lane)
      const result = toolResult(frames, limit)
      if (!result.isError && (tool.operation === "artifact.demo.preview" || tool.operation === "artifact.demo.export"))
        return { content: demo.content(tool.operation), structuredContent: result.structuredContent }
      return result
    } finally {
      ticket.release()
    }
  }

  function dispatch(tool: RemoteMcpSchemas.Tool, args: Record<string, unknown>, signal: AbortSignal) {
    const operation = tool.operation
    const input = RemoteMcpSchemas.recordOf(args.input)
    const id = `mcp_${randomUUID()}`
    if (operation === "session.createInDirectory")
      return executeRemoteDirectorySession({ id, home, input: input ?? {}, signal, local: options.local, sessions: options.sessions, subscriptions: options.subscriptions })
    return executeRemoteOperation({
      request: {
        type: "request",
        id,
        operation,
        ...(typeof args.sessionID === "string" ? { sessionID: args.sessionID } : {}),
        ...(input === undefined ? {} : { input }),
      },
      signal,
      local: options.local,
      sessions: options.sessions,
      subscriptions: options.subscriptions,
      cache,
      demo,
    })
  }

  async function admit(request: Request, context: Context): Promise<Admitted> {
    const url = new URL(request.url)
    if (url.origin !== resource.origin || url.pathname !== resource.pathname || url.search) return { response: new Response(null, { status: 404 }) }
    if (request.method !== "POST") return { response: new Response(null, { status: 405, headers: { allow: "POST" } }) }
    const body = await request.text()
    if (body.length > RemoteMCPTransport.defaultMaxRequestBodySize) return { response: new Response(null, { status: 413 }) }
    const lane = laneOf(body)
    const gate = Promise.withResolvers<void>()
    const previous = lane === undefined ? Promise.resolve() : (lanes.get(lane) ?? Promise.resolve())
    if (lane !== undefined) {
      const tail = previous.then(() => gate.promise)
      lanes.set(lane, tail)
      void tail.then(() => {
        if (lanes.get(lane) === tail) lanes.delete(lane)
      })
    }
    return { body, ticket: { context, previous, release: gate.resolve, ...(lane === undefined ? {} : { lane }), started: false } }
  }

  function laneOf(body: string) {
    const message = RemoteMcpSchemas.recordOf(Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)))
    const params = RemoteMcpSchemas.recordOf(message?.params)
    const tool = message?.method === "tools/call" && typeof params?.name === "string" ? byName.get(params.name) : undefined
    return tool === undefined ? undefined : RemoteMcpSchemas.laneOf(tool, RemoteMcpSchemas.recordOf(params?.arguments) ?? {})
  }

  async function serve(request: Request, admitted: Admitted) {
    if ("response" in admitted) return admitted.response
    const ticket = admitted.ticket
    const controller = new AbortController()
    const forward = () => controller.abort()
    inflight.add(controller)
    if (request.signal.aborted) controller.abort()
    request.signal.addEventListener("abort", forward, { once: true })
    try {
      if (!controller.signal.aborted) {
        const aborted = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }))
        await Promise.race([ticket.previous, aborted])
      }
      if (controller.signal.aborted || closed || ticket.lane === undefined && !options.allowed(ticket.context.epoch)) return unavailable()
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      const response = await transport.fetch(
        new Request(request.url, { method: "POST", headers, body: admitted.body, signal: controller.signal }),
        ticket,
      )
      if (controller.signal.aborted || closed || !ticket.authorizationDenied && !options.allowed(ticket.context.epoch)) return unavailable()
      response.headers.set("cache-control", "no-store")
      return response
    } finally {
      inflight.delete(controller)
      request.signal.removeEventListener("abort", forward)
      if (!ticket.started) ticket.release()
    }
  }

  return {
    fetch(request: Request, context: Context): Promise<Response> {
      if (closed || !options.allowed(context.epoch)) return Promise.resolve(unavailable())
      const admitted = admission.then(() => admit(request, context))
      admission = admitted.catch(() => undefined)
      return admitted.then((result) => serve(request, result))
    },
    async close() {
      closed = true
      for (const controller of inflight) controller.abort()
      await transport.close()
    },
  }
}

export function toolResult(frames: readonly RemoteResponse[], limit = maxResultChars): TextResult {
  const first = frames[0]
  if (first === undefined) return failure("internal_error", "The local agent returned no response")
  if (!first.ok) return failure(first.error.code, first.error.message)
  if (first.chunk === undefined) return success(JSON.stringify(first.value ?? null), first.value ?? null, limit)
  const parts = frames.map((frame, index) =>
    frame.ok && typeof frame.value === "string" && frame.chunk?.index === index && frame.chunk.last === (index === frames.length - 1) ? frame.value : undefined,
  )
  if (!parts.every((part): part is string => part !== undefined)) return failure("internal_error", "The local agent returned an incomplete chunked response")
  const text = parts.join("")
  if (text.length > limit) return failure("message_too_large", `Result is ${text.length} characters, above the ${limit} character limit`)
  const parsed = parseChunkedValue(parts)
  return parsed.ok ? success(text, parsed.value, limit) : failure("internal_error", "The local agent returned an unreadable chunked response")
}

function success(text: string, value: unknown, limit: number): TextResult {
  if (text.length > limit) return failure("message_too_large", `Result is ${text.length} characters, above the ${limit} character limit`)
  return { content: [{ type: "text", text }], structuredContent: value }
}

function failure(code: RemoteErrorCode, message: string): TextResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}${guidance[code] ?? ""}` }],
    structuredContent: { error: { code, message } },
  }
}

function unavailable() {
  return new Response(JSON.stringify({ error: "unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
