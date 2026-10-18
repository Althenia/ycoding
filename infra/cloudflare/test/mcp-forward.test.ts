import { expect, test } from "bun:test"
import { forwardMcpRequest } from "../src/mcp-forward"

const principal = { ownerID: "owner_test", deviceID: "dev_test", clientID: "client_test", grantID: "grant_test", epoch: "epoch_test", expiresAt: 9999999999999 }
const request = () => new Request("https://relay.example.invalid/api/mcp/devices/dev_test", {
  method: "POST", headers: { authorization: "Bearer synthetic-secret", cookie: "synthetic-cookie", "x-ycoding-mcp-owner": "foreign", "mcp-method": "tools/call", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "session_list", arguments: {} } }),
})

test("MCP forwarding rebuilds trusted headers and has one fixed destination", async () => {
  let forwarded: Request | undefined
  let name: string | undefined
  const response = await forwardMcpRequest({ getByName(value) { name = value; return { fetch: async (value) => {
    forwarded = value
    return Response.json({ jsonrpc: "2.0", id: 7, result: { resultType: "complete", content: [] } })
  } } } }, principal, request())
  expect(response.status).toBe(200)
  expect(name).toBe("owner_test:dev_test")
  expect(forwarded?.url).toBe("https://relay.internal/_ycoding/mcp")
  expect(forwarded?.headers.get("authorization")).toBeNull()
  expect(forwarded?.headers.get("cookie")).toBeNull()
  expect(forwarded?.headers.get("x-ycoding-mcp-owner")).toBe("owner_test")
  expect(forwarded?.headers.get("mcp-method")).toBe("tools/call")
})

test.each(["outcome_unknown", "unknown_operation", "message_too_large"])("%s is an actionable MCP tool error without replay", async (code) => {
  let calls = 0
  const response = await forwardMcpRequest({ getByName: () => ({ fetch: async () => {
    calls++
    return Response.json({ error: { code, message: "Transport failure" } }, { status: 502 })
  } }) }, principal, request())
  const result = await response.json()
  expect(calls).toBe(1)
  expect(result.id).toBe(7)
  expect(result.result.isError).toBe(true)
  expect(result.result.content[0].text).toContain(code === "unknown_operation" ? "ycoding update" : code === "message_too_large" ? "relay frame bound" : "before retrying")
})

test("invalid UTF-8 is refused before forwarding", async () => {
  let calls = 0
  const response = await forwardMcpRequest({ getByName: () => ({ fetch: async () => { calls++; return Response.json({}) } }) }, principal,
    new Request("https://relay.example.invalid/api/mcp/devices/dev_test", { method: "POST", body: new Uint8Array([0xc3, 0x28]) }))
  expect(response.status).toBe(400)
  expect(calls).toBe(0)
})

test("an interrupted internal fetch preserves unknown outcome without leaking its cause", async () => {
  let calls = 0
  const response = await forwardMcpRequest({ getByName: () => ({ fetch: async () => {
    calls++
    throw new Error("synthetic-private-detail")
  } }) }, principal, request())
  const result = await response.json()
  expect(calls).toBe(1)
  expect(result.result.isError).toBe(true)
  expect(result.result.content[0].text).toContain("outcome is unknown")
  expect(JSON.stringify(result)).not.toContain("synthetic-private-detail")
})
