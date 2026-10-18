export * as RemoteConnection from "./remote-connection"

import { Remote } from "@ycoding-ai/protocol/groups/remote"
import { Context } from "effect"
import type { McpEvents } from "@ycoding-ai/protocol/groups/mcp-events"

export interface EventAuthorization {
  readonly capabilities: () => Promise<boolean>
  readonly resolve: (context: McpEvents.RequestContext, signal?: AbortSignal) => Promise<{ grantID: string; expiresAt: number }>
  readonly check: (principal: McpEvents.Principal, signal?: AbortSignal) => Promise<{ expiresAt: number; signal: AbortSignal }>
}

export interface Interface {
  readonly status: () => Promise<Remote.Status>
  readonly set: (enabled: boolean) => Promise<Remote.Status>
  readonly mcpStatus: () => Promise<Remote.McpStatus>
  readonly setMcp: (enabled: boolean) => Promise<Remote.McpStatus>
  readonly shutdown: () => Promise<void>
  readonly mcpEvents?: EventAuthorization
}

export class Service extends Context.Service<Service, Interface>()("@ycoding-ai/server/RemoteConnection") {}

export const unavailable: Interface = {
  status: async () => ({ state: "off" }),
  set: async () => ({ state: "error", message: "Remote connection is unavailable in this server" }),
  mcpStatus: async () => ({ state: "off" }),
  setMcp: async () => ({ state: "error", message: "Relay MCP is unavailable in this server; run `ycoding update` and restart the service" }),
  shutdown: async () => {},
}
