export * as RemoteMCPTransport from "./transport"

import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server, type CallToolResult, type JsonSchemaType, type Tool } from "@modelcontextprotocol/server"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv"

export type { Tool }

export type ToolResult = {
  readonly content: readonly { readonly type: "text"; readonly text: string }[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
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
  readonly maxRequestBodySize?: number
}) {
  const validator = new AjvJsonSchemaValidator()
  const known = new Map(options.tools.map((tool) => [tool.name, { tool, validate: validator.getValidator(tool.inputSchema as JsonSchemaType) }]))
  const handler = createMcpHandler(
    (context) => {
      const carried = context.authInfo?.extra?.context as Context | undefined
      const server = new Server({ name: options.name, version: options.version }, { capabilities: { tools: {} } })
      server.setRequestHandler("tools/list", async () => ({ tools: [...options.tools] }))
      server.setRequestHandler("tools/call", async (request, ctx) => {
        const entry = known.get(request.params.name)
        if (entry === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
        const args = request.params.arguments ?? {}
        const checked = entry.validate(args)
        if (!checked.valid)
          return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${entry.tool.name}: ${checked.errorMessage}` }] }
        return await options.call({
          name: entry.tool.name,
          arguments: args,
          signal: ctx.mcpReq.signal,
          context: carried,
        }) as CallToolResult
      })
      return server
    },
    { legacy: "reject", responseMode: "json", maxRequestBodySize: options.maxRequestBodySize ?? defaultMaxRequestBodySize },
  )
  return {
    fetch(request: Request, context?: Context): Promise<Response> {
      return handler.fetch(request, { authInfo: { token: "relay", clientId: "relay", scopes: [], extra: { context } } })
    },
    close: () => handler.close(),
  }
}
