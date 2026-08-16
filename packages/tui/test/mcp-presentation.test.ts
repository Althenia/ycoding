import { expect, test } from "bun:test"
import { mcpStatusPresentation, mcpSummary } from "../src/mcp-presentation"

test("presents every MCP state distinctly", () => {
  expect(mcpStatusPresentation("pending")).toEqual({ symbol: "⋯", label: "Connecting", tone: "subdued" })
  expect(mcpStatusPresentation("connected")).toEqual({ symbol: "✓", label: "Connected", tone: "success" })
  expect(mcpStatusPresentation("disabled")).toEqual({ symbol: "○", label: "Disabled", tone: "subdued" })
  expect(mcpStatusPresentation("needs_auth")).toEqual({ symbol: "↗", label: "Authorize", tone: "warning" })
  expect(mcpStatusPresentation("needs_client_registration")).toEqual({
    symbol: "!",
    label: "Needs client ID",
    tone: "error",
  })
  expect(mcpStatusPresentation("failed")).toEqual({ symbol: "✗", label: "Failed", tone: "error" })
})

test("summarizes connected and configured MCP servers", () => {
  const summary = mcpSummary([
    { status: { status: "connected" } },
    { status: { status: "pending" } },
    { status: { status: "failed" } },
    { status: { status: "disabled" } },
  ])

  expect(summary).toEqual({
    configured: 4,
    connected: 1,
    pending: 1,
    attention: 1,
    disabled: 1,
    label: "1/4 MCP",
  })
})
