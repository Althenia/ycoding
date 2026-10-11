import type { Connection } from "@ycoding-ai/schema/connection"
import type { Integration } from "@ycoding-ai/schema/integration"
import type { Mcp } from "@ycoding-ai/schema/mcp"
import type { Effect } from "effect"

export namespace MCP {
  export interface ServerInfo {
    readonly name: string
    readonly status: Mcp.Status
    readonly integrationID?: Integration.ID
    readonly connection?: Connection.Info
  }

  export interface Tool {
    readonly server: string
    readonly name: string
    readonly codemode?: boolean
    readonly description?: string
    readonly inputSchema?: unknown
    readonly outputSchema?: unknown
  }

  export type ResourceContent = Mcp.ResourceContent

  export type ToolResultContent =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "media"; readonly data: string; readonly mimeType: string }

  export interface ToolResult {
    readonly server: string
    readonly tool: string
    readonly isError: boolean
    readonly structured?: unknown
    readonly content: ReadonlyArray<ToolResultContent>
  }

  export interface CallToolInput {
    readonly server: string
    readonly name: string
    readonly args?: Record<string, unknown>
  }

  export interface ReadResourceInput {
    readonly server: string
    readonly uri: string
  }
}

export interface MCPDomain {
  readonly servers: () => Effect.Effect<Array<MCP.ServerInfo>>
  readonly tools: () => Effect.Effect<Array<MCP.Tool>>
  readonly readResource: (input: MCP.ReadResourceInput) => Effect.Effect<MCP.ResourceContent | undefined, Error>
  readonly callTool: (input: MCP.CallToolInput) => Effect.Effect<MCP.ToolResult, Error>
}
