import { existsSync } from "fs"
import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const server = new Server({ name: "prompts", version: "1.0.0" }, { capabilities: { prompts: {}, tools: {} } })

server.setRequestHandler("tools/list", () => ({ tools: [] }))
server.setRequestHandler("prompts/list", async () => {
  const gate = process.env.MCP_PROMPTS_GATE
  if (gate) while (!existsSync(gate)) await Bun.sleep(20)
  return { prompts: [{ name: "review" }] }
})

await server.connect(new StdioServerTransport())
