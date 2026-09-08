/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { railWidth } from "../../src/routes/session/rail"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_transcript_chat"
const directory = "/tmp/ycoding/session-transcript-chat"
const location = { directory, project: { id: "proj_transcript_chat", directory } }
const session = {
  id: sessionID,
  title: "Transcript chat",
  projectID: "proj_transcript_chat",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 9 },
}
const providerPayload = '{"error":{"message":"invalid x-api-key","request_id":"req_provider_123"}}'
const providerMessage = "Provider overloaded; retry in 30 seconds."
const retryMessage = "Rate limit reached; the provider will accept another request shortly."
const messages = [
  {
    id: "msg_assistant_chat",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [
      { type: "text", text: "I inspected the typed transcript data." },
      {
        type: "tool",
        id: "call_project_search",
        name: "project_search",
        state: {
          status: "completed",
          input: { query: "cache telemetry", apiKey: "test-secret-key" },
          content: [{ type: "text", text: "Found matching call sites." }],
          result: { count: 17 },
          structured: { matches: 17 },
        },
        time: { created: 2, ran: 3, completed: 4 },
      },
      {
        type: "tool",
        id: "call_http_request",
        name: "http_request",
        state: {
          status: "error",
          input: {
            url: "https://example.test/resource",
            request_id: "req_tool_123",
            headers: { authorization: "Bearer test-secret-token" },
          },
          content: [{ type: "text", text: providerPayload }],
          result: { status: 401, reason: "invalid x-api-key", credential: "test-secret-credential" },
          structured: { retryable: false, request_id: "req_tool_123" },
          error: { type: "ProviderError", message: providerPayload },
        },
        time: { created: 4, ran: 5, completed: 6 },
      },
      {
        type: "tool",
        id: "call_subagent",
        name: "subagent",
        state: {
          status: "completed",
          input: { agent: "review", description: "Audit cache accounting" },
          content: [{ type: "text", text: "Audit completed." }],
          result: { status: "completed" },
          structured: { sessionID: "ses_review_child", status: "completed" },
        },
        time: { created: 5, ran: 6, completed: 7 },
      },
      {
        type: "tool",
        id: "call_shell",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "bun test transcript" },
          content: [{ type: "text", text: "4 pass · 0 fail" }],
          result: { exitCode: 0 },
          structured: {},
        },
        time: { created: 6, ran: 7, completed: 8 },
      },
    ],
    finish: "stop",
    time: { created: 2, completed: 8 },
  },
  {
    id: "msg_provider_error",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [],
    finish: "error",
    error: { type: "ProviderError", message: providerPayload },
    time: { created: 8, completed: 9 },
  },
  {
    id: "msg_provider_error_safe",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [],
    finish: "error",
    error: { type: "provider.transport", message: providerMessage },
    retry: { attempt: 2, at: 11, error: { type: "provider.rate_limit", message: retryMessage } },
    time: { created: 9, completed: 10 },
  },
] satisfies SessionMessageInfo[]

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/subagent`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/skill",
      "/api/reference",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({
      data: {
        rootSessionID: sessionID,
        profile: "standard",
        customRules: 0,
        approvals: 0,
        blocked: 0,
        counters: [],
        invalidFiles: [],
      },
    })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, mechanism: "unreported", readReported: false, writeReported: false },
        requests: {
          logical: 0,
          physical: 0,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({
      data: {
        logical: 0,
        physical: 0,
        helpers: 0,
        continued: 0,
        fallback: 0,
        cost: 0,
        tokens: session.tokens,
      },
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: "claude-opus-5",
          modelID: "claude-opus-5",
          providerID: "anthropic",
          name: "Claude Opus 5",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  return undefined
}

test("renders typed transcript chat rows at the design gutter with safe expandable tool details", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route,
    settle: "I inspected the typed transcript data.",
  })

  try {
    const collapsed = screen.lines()
    const railStart = DESIGN_VIEWPORT.width - railWidth(DESIGN_VIEWPORT.width)
    const rowOf = (lines: string[], text: string) => lines.findIndex((line) => line.includes(text) && line.indexOf(text) < railStart)
    const assistantRow = rowOf(collapsed, "YCODING")
    const textRow = rowOf(collapsed, "I inspected the typed transcript data.")
    const ordinaryRow = rowOf(collapsed, "project_search")
    const errorRow = rowOf(collapsed, "http_request")
    const shellRow = rowOf(collapsed, "bun test transcript")

    expect(collapsed[assistantRow]?.indexOf("YCODING")).toBe(3)
    expect(collapsed[textRow]?.indexOf("I inspected the typed transcript data.")).toBe(3)
    expect(collapsed[ordinaryRow]?.indexOf("ok")).toBe(3)
    expect(collapsed[errorRow]?.indexOf("!!")).toBe(3)
    expect(collapsed[shellRow]?.indexOf("ok")).toBe(3)
    expect(collapsed.some((line) => line.includes("subagent review") && line.indexOf("subagent review") < railStart)).toBe(false)
    expect(collapsed.join("\n")).not.toContain("Request")
    expect(collapsed.join("\n")).not.toContain("Response")
    expectSafe(collapsed.join("\n"))
    expect(collapsed.join("\n")).toContain(providerMessage)
    expect(collapsed.join("\n")).toContain(`Retry attempt 2 scheduled: ${retryMessage}`)
    expect(collapsed.join("\n")).toContain("Sensitive response detail omitted.")
    expect(collapsed.join("\n")).not.toContain("Provider request failed.")
    expect(collapsed.join("\n")).not.toContain("scheduled after a provider request failed")

    const providerIdentityRow = collapsed.findLastIndex(
      (line) => line.includes("Build") && line.indexOf("Build") < railStart,
    )
    const providerFailureRow = collapsed.findLastIndex(
      (line) => line.includes(providerMessage) && line.indexOf(providerMessage) < railStart,
    )
    const providerMetadataRow = collapsed.findLastIndex(
      (line) => line.includes("Claude Opus 5") && line.indexOf("Claude Opus 5") < railStart,
    )
    expect(providerIdentityRow).toBeLessThan(providerFailureRow)
    expect(providerFailureRow).toBeLessThan(providerMetadataRow)
    expect(screen.colorOf(providerMessage)).not.toEqual(screen.colorOf("Claude Opus 5"))
    expect(collapsed[providerIdentityRow]?.slice(0, railStart)).not.toContain("│")
    expect(collapsed[providerFailureRow]?.slice(0, railStart)).not.toContain("│")
    expect(collapsed[providerMetadataRow]?.slice(0, railStart)).not.toContain("│")

    await screen.mouse.click(4, ordinaryRow)
    await waitFor(screen.frame, "Request")
    const ordinaryExpanded = screen.frame()
    expect(ordinaryExpanded).toContain("Request")
    expect(ordinaryExpanded).toContain("query: cache telemetry")
    expect(ordinaryExpanded).toContain("Response")
    expect(ordinaryExpanded).toContain("matches: 17")
    expect(ordinaryExpanded).toContain("count: 17")
    expect(ordinaryExpanded).toContain("[sensitive field]: [redacted]")
    expectSafe(ordinaryExpanded)

    const expandedOrdinaryRow = screen.lines().findIndex((line) => line.includes("project_search"))
    // A repeated click on the same cell selects a word instead of toggling the tool row.
    await screen.mouse.click(8, expandedOrdinaryRow)
    await waitForMissing(screen.frame, "query: cache telemetry")
    const collapsedErrorRow = screen.lines().findIndex((line) => line.includes("http_request"))
    await screen.mouse.click(4, collapsedErrorRow)
    await waitFor(screen.frame, "url: https://example.test/resource")
    const errorExpanded = screen.frame()
    expect(errorExpanded).toContain("url: https://example.test/resource")
    expect(errorExpanded).toContain("status: 401")
    expect(errorExpanded).toContain("Sensitive response detail omitted.")
    expectSafe(errorExpanded)
  } finally {
    await screen.dispose()
  }
}, 60_000)

function expectSafe(frame: string) {
  expect(frame).not.toContain("request_id")
  expect(frame).not.toContain("req_provider_123")
  expect(frame).not.toContain("req_tool_123")
  expect(frame).not.toContain("invalid x-api-key")
  expect(frame).not.toContain(providerPayload)
  expect(frame).not.toContain("test-secret")
  expect(frame).not.toContain("Bearer")
}

async function waitFor(frame: () => string, text: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`screen did not settle on ${text}`)
}

async function waitForMissing(frame: () => string, text: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`screen did not remove ${text}`)
}
