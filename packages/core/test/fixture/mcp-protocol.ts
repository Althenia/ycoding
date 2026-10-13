import { appendFileSync } from "node:fs"
import { PROTOCOL_VERSION_META_KEY, Server } from "@modelcontextprotocol/server"
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const log = (line: string) => {
  if (process.env.MCP_PROTOCOL_LOG) appendFileSync(process.env.MCP_PROTOCOL_LOG, `${line}\n`)
}

const build = (version: () => string | undefined) => {
  const server = new Server({ name: "protocol", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler("tools/list", () => ({
    tools: [{ name: "protocol", inputSchema: { type: "object" as const } }],
  }))
  server.setRequestHandler("tools/call", (_request, ctx) => {
    const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope
    const claimed = envelope?.[PROTOCOL_VERSION_META_KEY]
    return { content: [{ type: "text" as const, text: typeof claimed === "string" ? claimed : String(version()) }] }
  })
  return server
}

const era = process.env.MCP_PROTOCOL_ERA
log("spawn")

if (era === "modern") {
  serveStdio(() => build(() => undefined), { legacy: "reject" })
}
if (era !== "modern") {
  const server = build(() => server.getNegotiatedProtocolVersion())
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const receive = transport.onmessage
  const state = { initialized: false }
  transport.onmessage = (message) => {
    if ("method" in message) log(message.method)
    if ("method" in message && message.method === "initialize") state.initialized = true
    if (era === "unsupported" && "id" in message && "method" in message && message.method === "server/discover") {
      void transport.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32022,
          message: "Unsupported protocol version: 2026-07-28",
          data: { supported: ["2027-01-01"], requested: "2026-07-28" },
        },
      })
      return
    }
    if (!state.initialized && era === "exits") process.exit(0)
    if (!state.initialized && era === "silent") return
    receive?.(message)
  }
}
