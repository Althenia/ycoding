export * as RemoteMCPTransport from "./transport"

import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  Server,
  type CallToolResult,
  type ContentBlock,
  type JsonSchemaType,
  type MetaObject,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/server"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv"

export type { Tool }

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
}

export const defaultMaxRequestBodySize = 128 * 1024

export function create<Context>(options: {
  readonly name: string
  readonly version: string
  readonly tools: readonly Tool[]
  readonly call: (call: Call<Context>) => Promise<ToolResult>
  readonly resources?: {
    readonly list: (context: Context | undefined, signal: AbortSignal) => Promise<Resource[]>
    readonly read: (input: ResourceRead<Context>) => Promise<ReadResourceResult | undefined>
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
    (context) => {
      const carried = context.authInfo?.extra?.context as Context | undefined
      const server = new Server(
        { name: options.name, version: options.version },
        { capabilities: { tools: {}, ...(options.resources === undefined ? {} : { resources: {} }) } },
      )
      server.setRequestHandler("tools/list", async () => ({ tools: [...options.tools] }))
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
        return (await options.call({
          name: entry.tool.name,
          arguments: args,
          signal: ctx.mcpReq.signal,
          context: carried,
        })) as CallToolResult
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
