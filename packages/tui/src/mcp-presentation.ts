import type { McpServer } from "@ycoding-ai/client"

export type McpStatusName = McpServer["status"]["status"]
export type McpTone = "subdued" | "success" | "warning" | "error"

export function mcpStatusPresentation(status: McpStatusName): {
  readonly symbol: string
  readonly label: string
  readonly tone: McpTone
} {
  switch (status) {
    case "pending":
      return { symbol: "⋯", label: "Connecting", tone: "subdued" }
    case "connected":
      return { symbol: "✓", label: "Connected", tone: "success" }
    case "disabled":
      return { symbol: "○", label: "Disabled", tone: "subdued" }
    case "needs_auth":
      return { symbol: "↗", label: "Authorize", tone: "warning" }
    case "needs_client_registration":
      return { symbol: "!", label: "Needs client ID", tone: "error" }
    case "failed":
      return { symbol: "✗", label: "Failed", tone: "error" }
  }
}

export function mcpSummary(servers: ReadonlyArray<{ readonly status: { readonly status: McpStatusName } }>) {
  const configured = servers.length
  const connected = servers.filter((server) => server.status.status === "connected").length
  const pending = servers.filter((server) => server.status.status === "pending").length
  const disabled = servers.filter((server) => server.status.status === "disabled").length
  const attention = servers.filter(
    (server) =>
      server.status.status === "failed" ||
      server.status.status === "needs_auth" ||
      server.status.status === "needs_client_registration",
  ).length
  return {
    configured,
    connected,
    pending,
    attention,
    disabled,
    label: `${connected}/${configured} MCP`,
  }
}
