import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const server = new Server({ name: "output-schema", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler("tools/list", ({ params }) =>
  params?.cursor === "page-2"
    ? {
        tools: [
          {
            name: "second",
            inputSchema: { type: "object" as const },
            outputSchema: {
              type: "object" as const,
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
          {
            name: "unresolved",
            inputSchema: { type: "object" as const },
            outputSchema: {
              type: "object" as const,
              properties: { value: { $ref: "#/$defs/missing" } },
            },
          },
        ],
      }
    : {
        tools: [
          {
            name: "first",
            inputSchema: { type: "object" as const },
            outputSchema: {
              type: "object" as const,
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
        nextCursor: "page-2",
      },
)
server.setRequestHandler("tools/call", ({ params }) => ({
  content: [],
  structuredContent: { value: params.name === "first" ? 42 : 1 },
}))

await server.connect(new StdioServerTransport())
