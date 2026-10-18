import { expect, test } from "bun:test"
import { parseClientMessage, parseRelayToClientMessage, RemoteLimits } from "../src/index"
import { parseMcpRequest, parseMcpState, parseMcpStateAck, mcpResource } from "../src/mcp"

const request = {
  type: "request", id: "mcp_test", operation: "mcp.request",
  input: {
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    principal: { ownerID: "owner_test", deviceID: "dev_test", clientID: "https://client.example.invalid/client.json" },
    epoch: "epoch_test",
  },
} as const

test("MCP forwarding accepts only its fixed target and trusted envelope", () => {
  expect(parseMcpRequest(JSON.stringify(request))).toEqual(request)
  for (const field of ["url", "path", "method", "authorization", "cookie"])
    expect(parseMcpRequest(JSON.stringify({ ...request, input: { ...request.input, [field]: "foreign" } }))).toBeUndefined()
  expect(parseMcpRequest(JSON.stringify({ ...request, input: { ...request.input, headers: { authorization: "Bearer synthetic" } } }))).toBeUndefined()
  expect(parseMcpRequest(JSON.stringify({ ...request, sessionID: "ses_foreign" }))).toBeUndefined()
  expect(parseMcpRequest(JSON.stringify({ ...request, input: { ...request.input, body: "x".repeat(RemoteLimits.maxClientMessageChars) } }))).toBeUndefined()
  expect(parseClientMessage(JSON.stringify(request)).ok).toBe(false)
})

test("MCP controls are agent-only and preserve explicit epochs", () => {
  const state = { type: "mcp.state", id: "state_test", enabled: true, epoch: "epoch_test" } as const
  const ack = { ...state, type: "mcp.state.ack" } as const
  expect(parseMcpState(JSON.stringify(state))).toEqual(state)
  expect(parseMcpStateAck(JSON.stringify(ack))).toEqual(ack)
  expect(parseMcpState(JSON.stringify({ ...state, enabled: "yes" }))).toBeUndefined()
  expect(parseMcpState(JSON.stringify({ ...state, epoch: "" }))).toBeUndefined()
  expect(parseClientMessage(JSON.stringify(state)).ok).toBe(false)
  expect(parseRelayToClientMessage(JSON.stringify(state)).ok).toBe(false)
  expect(parseRelayToClientMessage(JSON.stringify(ack)).ok).toBe(false)
})

test("device MCP resources are stable and contain no credential", () => {
  expect(mcpResource("https://relay.example.invalid", "dev_test")).toBe("https://relay.example.invalid/api/mcp/devices/dev_test")
  expect(() => mcpResource("https://relay.example.invalid", "../escape")).toThrow()
})
