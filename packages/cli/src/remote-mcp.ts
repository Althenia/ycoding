export * as RemoteMcp from "./remote-mcp"

import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { Option, Result, Schema } from "effect"
import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import { localAppOperations, parseChunkedValue, type McpPrincipal, type RemoteErrorCode, type RemoteRequest, type RemoteResponse } from "@ycoding-ai/remote"
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
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsReport } from "@ycoding-ai/schema/dots-report"
import { RemoteMcpApps } from "./remote-mcp-apps"

export const maxResultChars = 2 * 1024 * 1024

type TextResult = RemoteMCPTransport.ToolResult<{ readonly type: "text"; readonly text: string }>

export type Context = { readonly requestID: string; readonly epoch: string; readonly principal: McpPrincipal }

export type Options = {
  readonly apps?: ReturnType<typeof RemoteMcpApps.create>
  readonly local: LocalServer
  readonly sessions: SessionRegistry
  readonly subscriptions: SubscriptionRegistry
  readonly cache?: OperationCache
  readonly home?: string
  readonly resource: string
  readonly allowed: (epoch: string) => boolean
  readonly maxResultChars?: number
  readonly now?: () => number
  readonly onLaneHold?: (held: boolean) => void
}

type Ticket = { readonly context: Context; readonly previous: Promise<void>; readonly release: () => void; readonly lane?: string; started: boolean; authorizationDenied?: true }
type Admitted = { readonly response: Response } | { readonly body: string; readonly ticket: Ticket }
type Hold =
  | { readonly kind: "model"; readonly sessionID: string; readonly model: Readonly<Record<string, unknown>> }
  | { readonly kind: "prompt"; readonly messageID: string }
  | { readonly kind: "exchange"; readonly sessionID: string; readonly exchangeID: string; readonly fingerprint: string }
  | { readonly kind: "unknown" }

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
  const presentationTools = new Map(RemoteMcpDemo.tools.map((tool) => [tool.name, tool]))
  const appPresentation = RemoteMcpApps.tools.find((tool) => tool.operation === "local.app.open")
  const byName = new Map(RemoteMcpSchemas.tools.map((tool) => [tool.name, tool]))
  const lanes = new Map<string, Promise<void>>()
  const holds = new Map<string, Hold>()
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
      ...presentationTools.get(tool.name),
      ...(tool.name === appPresentation?.name ? { _meta: appPresentation._meta } : {}),
    })),
    call: execute,
    events: {
      available: async (ticket, signal) => ticket !== undefined && options.allowed(ticket.context.epoch) && (await options.local.mcpEventsStatus(signal)).available,
      list: (input) => eventsCall(input.context, () => options.local.mcpEventsList(input.params.cursor == null ? {} : { cursor: input.params.cursor }, input.signal)),
      subscribe: (input) => eventsCall(input.context, (context) => options.local.mcpEventsSubscribe({ context, subscription: input.params }, input.signal)),
      unsubscribe: (input) => eventsCall(input.context, (context) => options.local.mcpEventsUnsubscribe({ context, subscription: input.params }, input.signal)),
    },
    resources: {
      list: async () => [...demo.list(), ...(options.apps?.list() ?? [])],
      read: async (input) => {
        input.signal.throwIfAborted()
        return options.apps?.read(input.uri) ?? demo.read(input.uri)
      },
    },
  })

  async function eventsCall<A>(ticket: Ticket | undefined, run: (context: Context) => Promise<A>): Promise<A> {
    if (ticket === undefined || ticket.started || !options.allowed(ticket.context.epoch))
      throw new RemoteMCPTransport.ProtocolError(-32001, "MCP event authorization is unavailable")
    ticket.started = true
    try {
      const result = await run(ticket.context)
      if (!options.allowed(ticket.context.epoch)) throw new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" })
      return result
    } catch (error) {
      const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(McpEvents.Failure)(error))
      const code = parsed?.category === "callback_endpoint" ? -32015 : parsed?.category === "invalid_params" ? -32602 : parsed?.category === "unauthorized" ? -32001 : -32603
      throw new RemoteMCPTransport.ProtocolError(code, "MCP event request failed", { reason: parsed?.reason ?? "service_unavailable" })
    } finally {
      ticket.release()
    }
  }

  async function execute(call: RemoteMCPTransport.Call<Ticket>): Promise<RemoteMCPTransport.ToolResult> {
    const ticket = call.context
    const tool = byName.get(call.name)
    if (ticket === undefined || tool === undefined || ticket.started) return failure("internal_error", "The request has no admission")
    ticket.started = true
    const denied = () => {
      if (options.allowed(ticket.context.epoch)) return undefined
      ticket.authorizationDenied = true
      return failure("agent_unavailable", "Relay MCP is off or its authorization changed; the request was not executed")
    }
    try {
      const refused = denied()
      if (refused !== undefined) return refused
      const lane = ticket.lane
      const held = lane === undefined ? undefined : holds.get(lane)
      if (lane !== undefined && held !== undefined) {
        const settled = await reconcile(lane, held, tool, call.arguments, call.signal, ticket.context)
        if (settled !== undefined) return settled
      }
      const baseline = tool.operation === "session.switchModel" && typeof call.arguments.sessionID === "string"
        ? await selectedModel(call.arguments.sessionID, call.signal, ticket.context)
        : undefined
      if (baseline?.failure !== undefined) return baseline.failure
      const revoked = denied()
      if (revoked !== undefined) return revoked
      const frames = await dispatch(tool, call.arguments, call.signal, ticket.context)
      const rawResult = toolResult(frames, limit)
      const result = tool.operation === "session.dots.exchange.read" ? reportResult(rawResult, limit) : rawResult
      if (tool.operation === "session.dots.exchange.read" && !result.isError) {
        const sessionID = call.arguments.sessionID
        const exchangeID = RemoteMcpSchemas.recordOf(call.arguments.input)?.exchangeID
        const held = typeof sessionID === "string" ? holds.get(`session:${sessionID}`) : undefined
        if (held?.kind === "exchange" && held.exchangeID === exchangeID) release(`session:${held.sessionID}`)
      }
      if (lane !== undefined && frames.some((frame) => !frame.ok && frame.error.code === "outcome_unknown")) hold(lane, holdOf(tool, call.arguments, baseline?.model))
      else if (lane !== undefined && held?.kind === "prompt" && frames[0]?.ok === true) release(lane)
      if (!result.isError && (localAppOperations as readonly string[]).includes(tool.operation)) {
        const app = RemoteMcpSchemas.recordOf(result.structuredContent)
        if (app === undefined || !("value" in app)) return failure("internal_error", "Registered app returned no result")
        const metadata = RemoteMcpSchemas.recordOf(app.metadata)
        return {
          content: [{ type: "text", text: JSON.stringify(app.value) }],
          structuredContent: app.value,
          ...(metadata === undefined ? {} : { _meta: metadata }),
        }
      }
      if (!result.isError && (tool.operation === "artifact.demo.preview" || tool.operation === "artifact.demo.export"))
        return { content: demo.content(tool.operation), structuredContent: result.structuredContent }
      return result
    } finally {
      ticket.release()
    }
  }

  async function reconcile(lane: string, held: Hold, tool: RemoteMcpSchemas.Tool, args: Record<string, unknown>, signal: AbortSignal, context: Context) {
    if (held.kind === "exchange") {
      const input = RemoteMcpSchemas.recordOf(args.input)
      if (tool.operation !== "session.dots.exchange.create" || input === undefined || held.fingerprint !== exchangeFingerprint(input))
        return failure("outcome_unknown", "An exchange admission is unconfirmed. Read that exchange before issuing another mutation; no work was replayed.")
      const result = reportResult(toolResult(await operate({ type: "request", id: `mcp_${randomUUID()}`, operation: "session.dots.exchange.read", sessionID: held.sessionID, input: { exchangeID: held.exchangeID } }, signal, context), limit), limit)
      if (result.isError) return failure("outcome_unknown", "The exchange admission could not be reconciled. This lane remains read-only; no work was replayed.")
      release(lane)
      return result
    }
    if (held.kind === "prompt")
      return tool.operation === "session.prompt" && RemoteMcpSchemas.recordOf(args.input)?.id === held.messageID
        ? undefined
        : failure("outcome_unknown", `An earlier session_prompt in this Session has an unknown outcome. Retry session_prompt with input.id ${held.messageID}; the local server admits each prompt ID once. This request was not executed.`)
    if (held.kind === "unknown")
      return failure("outcome_unknown", "An earlier mutation in this lane has an unknown outcome. This lane remains read-only for this connector instance. Inspect the local Session before further changes. This request was not executed.")
    const selected = await selectedModel(held.sessionID, signal, context)
    if (!("model" in selected) || !sameModel(selected.model, held.model))
      return failure("outcome_unknown", "An earlier session_switch_model in this Session has an unknown outcome, and its selected model could not be confirmed. Inspect the Session with session_get; the hold ends when a fresh read confirms that model. This request was not executed.")
    release(lane)
    if (tool.operation === "session.switchModel" && sameModel(RemoteMcpSchemas.recordOf(RemoteMcpSchemas.recordOf(args.input)?.model), held.model))
      return success(JSON.stringify(null), null, limit)
    return undefined
  }

  async function selectedModel(sessionID: string, signal: AbortSignal, context: Context) {
    options.sessions.invalidate(sessionID)
    const result = toolResult(await operate({ type: "request", id: `mcp_${randomUUID()}`, operation: "session.get", sessionID }, signal, context), limit)
    if (result.isError) return { failure: result }
    return { model: RemoteMcpSchemas.recordOf(RemoteMcpSchemas.recordOf(RemoteMcpSchemas.recordOf(result.structuredContent)?.data)?.model) }
  }

  function hold(lane: string, value: Hold) {
    if (closed) return
    const idle = holds.size === 0
    holds.set(lane, value)
    if (idle) options.onLaneHold?.(true)
  }

  function release(lane: string) {
    if (holds.delete(lane) && holds.size === 0) options.onLaneHold?.(false)
  }

  function dispatch(tool: RemoteMcpSchemas.Tool, args: Record<string, unknown>, signal: AbortSignal, context: Context) {
    const operation = tool.operation
    const input = RemoteMcpSchemas.recordOf(args.input)
    const id = `mcp_${randomUUID()}`
    if (operation === "session.createInDirectory")
      return executeRemoteDirectorySession({ id, home, input: input ?? {}, signal, local: options.local, sessions: options.sessions, subscriptions: options.subscriptions })
    return operate({
      type: "request",
      id,
      operation,
      ...(typeof args.sessionID === "string" ? { sessionID: args.sessionID } : {}),
      ...(input === undefined ? {} : { input }),
    }, signal, context)
  }

  function operate(request: RemoteRequest, signal: AbortSignal, context: Context) {
    return executeRemoteOperation({
      request,
      signal,
      local: options.local,
      sessions: options.sessions,
      subscriptions: options.subscriptions,
      cache,
      demo,
      apps: options.apps,
      appContext: context,
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
    clearApps() { options.apps?.clear() },
    async close() {
      closed = true
      if (holds.size > 0) {
        holds.clear()
        options.onLaneHold?.(false)
      }
      options.apps?.close()
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

function reportResult(result: TextResult, limit: number): TextResult {
  if (result.isError) return result
  const data = RemoteMcpSchemas.recordOf(result.structuredContent)?.data
  const exchange = Schema.decodeUnknownOption(Dots.Exchange)(data, { onExcessProperty: "error" })
  if (Option.isNone(exchange)) return failure("internal_error", "The Dots exchange response is invalid")
  const reports = [...exchange.value.progress, ...(exchange.value.result ? [exchange.value.result] : [])]
  if (reports.length === 0) return result
  const rendered = Result.try(() => reports.map((report) => ({ type: "text" as const, text: DotsReport.render(report.envelope, report.text) })))
  if (Result.isFailure(rendered)) return failure("internal_error", "The Dots report representation is invalid")
  const content = rendered.success
  if (content.reduce((length, item) => length + item.text.length, 0) > limit) return failure("message_too_large", "The Dots reports exceed the response bound")
  return { ...result, content }
}

function holdOf(tool: RemoteMcpSchemas.Tool, args: Record<string, unknown>, baseline: Readonly<Record<string, unknown>> | undefined): Hold {
  const input = RemoteMcpSchemas.recordOf(args.input)
  if (tool.operation === "session.dots.exchange.create" && typeof args.sessionID === "string" && typeof input?.exchangeID === "string")
    return { kind: "exchange", sessionID: args.sessionID, exchangeID: input.exchangeID, fingerprint: exchangeFingerprint(input) }
  if (tool.operation === "session.prompt" && typeof input?.id === "string") return { kind: "prompt", messageID: input.id }
  const model = RemoteMcpSchemas.recordOf(input?.model)
  if (tool.operation !== "session.switchModel" || typeof args.sessionID !== "string" || model === undefined) return { kind: "unknown" }
  if (model.profile !== undefined && (baseline === undefined || sameModel(baseline, model))) return { kind: "unknown" }
  return { kind: "model", sessionID: args.sessionID, model }
}

function exchangeFingerprint(input: Record<string, unknown>) {
  const attachment = RemoteMcpSchemas.recordOf(input.expectedAttachment)
  const ordinary = [input.exchangeID, attachment?.profile, attachment?.dotID, attachment?.threadID, attachment?.generation, input.targetSessionID, input.channel, input.delivery, input.text]
  if (input.delegation === undefined) return JSON.stringify(ordinary)
  const delegation = RemoteMcpSchemas.recordOf(input.delegation)
  const instruction = RemoteMcpSchemas.recordOf(input.instruction)
  const preferences = RemoteMcpSchemas.recordOf(instruction?.preferences)
  return JSON.stringify([...ordinary, delegation?.id, delegation?.revision, input.taskInputID, instruction?.operation, preferences?.format, preferences?.detail])
}

function sameModel(current: Readonly<Record<string, unknown>> | undefined, target: Readonly<Record<string, unknown>> | undefined) {
  return current !== undefined && target !== undefined && current.providerID === target.providerID && current.id === target.id &&
    current.variant === target.variant && current.profile === target.profile
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
