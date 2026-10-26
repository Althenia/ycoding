export * as RemoteMCPTransport from "./transport"

import {
  createMcpHandler,
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  Server,
  type ContentBlock,
  type JsonSchemaType,
  type MetaObject,
  type ReadResourceResult,
  type Resource,
  type Tool,
  type InputRequiredResult,
  type ElicitRequestFormParams,
} from "@modelcontextprotocol/server"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv"
import { Schema } from "effect"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"

export type { Tool, ElicitRequestFormParams }
export { ProtocolError, inputRequired, AjvJsonSchemaValidator }

export type ToolResult<Content extends ContentBlock = ContentBlock> = {
  readonly content: readonly Content[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
  readonly _meta?: MetaObject
}

export type ResourceRead<Context> = {
  readonly uri: string
  readonly signal: AbortSignal
  readonly context: Context | undefined
}

export type Call<Context> = {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly signal: AbortSignal
  readonly context: Context | undefined
  readonly envelope?: unknown
  readonly inputResponses?: Record<string, unknown>
  readonly requestState?: unknown
  readonly droppedInputResponseKeys?: readonly string[]
}

export type Result = ToolResult | InputRequiredResult

export type EventRequest<Params, Context> = {
  readonly params: Params
  readonly context: Context | undefined
  readonly signal: AbortSignal
}

export const defaultMaxRequestBodySize = 128 * 1024

export function create<Context>(options: {
  readonly name: string
  readonly version: string
  readonly tools: readonly Tool[]
  readonly call: (call: Call<Context>) => Promise<Result>
  readonly requestState?: { readonly verify: (state: string) => void }
  readonly resources?: {
    readonly list: (context: Context | undefined, signal: AbortSignal) => Promise<Resource[]>
    readonly read: (input: ResourceRead<Context>) => Promise<ReadResourceResult | undefined>
  }
  readonly events?: {
    readonly available: (context: Context | undefined, signal?: AbortSignal) => Promise<boolean>
    readonly list: (input: EventRequest<{ readonly cursor?: string | null }, Context>) => Promise<McpEvents.ListResult>
    readonly subscribe: (input: EventRequest<McpEvents.Subscribe, Context>) => Promise<McpEvents.Subscription>
    readonly unsubscribe: (input: EventRequest<McpEvents.Unsubscribe, Context>) => Promise<Record<string, never>>
  }
  readonly maxRequestBodySize?: number
}) {
  const validator = new AjvJsonSchemaValidator()
  const known = new Map(
    options.tools.map((tool) => [
      tool.name,
      { tool, validate: validator.getValidator(tool.inputSchema as JsonSchemaType) },
    ]),
  )
  const handler = createMcpHandler(
    async (context) => {
      const carried = context.authInfo?.extra?.context as Context | undefined
      const events = options.events !== undefined && await options.events.available(carried, context.requestInfo?.signal).catch(() => false)
        ? options.events
        : undefined
      const server = new Server(
        { name: options.name, version: options.version },
        { capabilities: { tools: {}, ...(options.resources === undefined ? {} : { resources: {} }), ...(events === undefined ? {} : { events: {} }) },
          ...(options.requestState === undefined ? {} : { requestState: { verify: (state: string) => { options.requestState?.verify(state); return state } } }) },
      )
      server.setRequestHandler("tools/list", async () => ({ tools: [...options.tools] }))
      if (events !== undefined) {
        server.setRequestHandler("events/list", {
          params: eventSchema(Schema.Struct({ cursor: Schema.optional(Schema.NullOr(Schema.String)) })),
          result: eventSchema(McpEvents.ListResult),
        }, (params, ctx) => events.list({ params, context: carried, signal: ctx.mcpReq.signal }))
        server.setRequestHandler("events/subscribe", {
          params: eventSchema(McpEvents.Subscribe),
          result: eventSchema(McpEvents.Subscription),
        }, (params, ctx) => events.subscribe({ params, context: carried, signal: ctx.mcpReq.signal }))
        server.setRequestHandler("events/unsubscribe", {
          params: eventSchema(McpEvents.Unsubscribe),
          result: eventSchema(Schema.Struct({})),
        }, (params, ctx) => events.unsubscribe({ params, context: carried, signal: ctx.mcpReq.signal }))
      }
      const resources = options.resources
      if (resources !== undefined) {
        server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }))
        server.setRequestHandler("resources/list", async (_request, ctx) => ({
          resources: await resources.list(carried, ctx.mcpReq.signal),
        }))
        server.setRequestHandler("resources/read", async (request, ctx) => {
          const result = await resources.read({ uri: request.params.uri, signal: ctx.mcpReq.signal, context: carried })
          if (result === undefined) throw new ResourceNotFoundError(request.params.uri, "Resource unavailable")
          return result
        })
      }
      server.setRequestHandler("tools/call", async (request, ctx) => {
        const entry = known.get(request.params.name)
        if (entry === undefined)
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
        const args = request.params.arguments ?? {}
        const checked = entry.validate(args)
        if (!checked.valid)
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid arguments for ${entry.tool.name}: ${checked.errorMessage}` }],
          }
        const result = await options.call({
          name: entry.tool.name,
          arguments: args,
          signal: ctx.mcpReq.signal,
          context: carried,
          envelope: ctx.mcpReq.envelope,
          inputResponses: ctx.mcpReq.inputResponses,
          requestState: ctx.mcpReq.requestState(),
          droppedInputResponseKeys: ctx.mcpReq.droppedInputResponseKeys,
        })
        return "resultType" in result ? result : { ...result, content: [...result.content] }
      })
      return server
    },
    {
      legacy: "reject",
      responseMode: "json",
      maxRequestBodySize: options.maxRequestBodySize ?? defaultMaxRequestBodySize,
    },
  )
  return {
    fetch(request: Request, context?: Context): Promise<Response> {
      return handler.fetch(request, { authInfo: { token: "relay", clientId: "relay", scopes: [], extra: { context } } })
    },
    close: () => handler.close(),
  }
}

function eventSchema<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  const standard = Schema.toStandardSchemaV1(schema, { parseOptions: { onExcessProperty: "error" } })
  return {
    "~standard": {
      ...standard["~standard"],
      validate: async (input: unknown) => {
        const result = await standard["~standard"].validate(input)
        return result.issues === undefined ? result : { issues: [{ message: "Invalid event data" }] }
      },
    },
  }
}
