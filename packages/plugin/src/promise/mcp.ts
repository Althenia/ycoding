import type { MCP } from "../effect/mcp.js"

export interface MCPDomain {
  readonly servers: () => Promise<Array<MCP.ServerInfo>>
  readonly tools: () => Promise<Array<MCP.Tool>>
  readonly readResource: (input: MCP.ReadResourceInput) => Promise<MCP.ResourceContent | undefined>
  readonly callTool: (input: MCP.CallToolInput) => Promise<MCP.ToolResult>
}
