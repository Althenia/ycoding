import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

if (process.env.MCP_TEST_START_MARKER) await Bun.write(process.env.MCP_TEST_START_MARKER, "started")

const server = new Server({ name: "spawn-marker", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler("tools/list", () => ({ tools: [] }))
await server.connect(new StdioServerTransport())
