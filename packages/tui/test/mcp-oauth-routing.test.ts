import { expect, test } from "bun:test"
import type { IntegrationInfo, IntegrationOAuthMethod, McpServer } from "@ycoding-ai/client"
import { mcpDialogAction, mcpOAuthTarget } from "../src/component/dialog-mcp"

test("maps MCP lifecycle states to the correct dialog action", () => {
  expect(mcpDialogAction("pending")).toBe("none")
  expect(mcpDialogAction("connected")).toBe("disconnect")
  expect(mcpDialogAction("needs_auth")).toBe("authorize")
  expect(mcpDialogAction("disabled")).toBe("connect")
  expect(mcpDialogAction("failed")).toBe("connect")
})

test("resolves the OAuth method registered for an MCP server", () => {
  const server = {
    name: "private-mcp",
    status: { status: "needs_auth" },
    integrationID: "mcp_private",
  } as McpServer
  const method: IntegrationOAuthMethod = { id: "oauth", type: "oauth", label: "private-mcp" }
  const integration = {
    id: "mcp_private",
    name: "private-mcp",
    methods: [method],
    connections: [],
  } as IntegrationInfo

  expect(mcpOAuthTarget(server, [integration])).toEqual({ integration, method })
  expect(mcpOAuthTarget({ ...server, integrationID: undefined }, [integration])).toBeUndefined()
  expect(mcpOAuthTarget(server, [])).toBeUndefined()
  expect(mcpOAuthTarget(server, [{ ...integration, methods: [] }])).toBeUndefined()
})
