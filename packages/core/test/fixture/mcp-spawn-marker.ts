import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.env.MCP_TEST_START_MARKER) await Bun.write(process.env.MCP_TEST_START_MARKER, "started")

const server = new Server({ name: "spawn-marker", version: "1.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
await server.connect(new StdioServerTransport())
