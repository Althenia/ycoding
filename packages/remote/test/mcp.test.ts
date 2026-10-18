import { expect, test } from "bun:test"
import {
  PeerRole,
  create,
  decodeLossless,
  decodeStrict,
  encodeLossless,
  encodeStrict,
  mcp_request_RequestSchema,
  mcp_request_ResultSchema,
  operations,
} from "@ycoding-ai/protocol/v5"
import {
  McpLimits,
  decodeMcpResponse,
  encodeMcpRequest,
  mcpResource,
  relayDescriptors,
  remoteDescriptors,
  remotePayloadCodecs,
  type McpForward,
} from "../src/index"

const forward: McpForward = {
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  principal: { ownerID: "owner_test", deviceID: "dev_test", clientID: "https://client.example.invalid/client.json" },
  epoch: "epoch_test",
}

test("an MCP forward encodes only its fixed body, allowlisted headers, trusted principal and epoch", () => {
  const encoded = encodeMcpRequest(forward)
  if (!encoded.ok) throw new Error(encoded.error.message)
  const payload = decodeStrict(mcp_request_RequestSchema, encoded.value).payload!
  expect(decodeLossless(payload.body!)).toBe(forward.body)
  expect(payload.headers.map((header) => [header.name, decodeLossless(header.value!)])).toEqual(
    Object.entries(forward.headers),
  )
  expect([payload.principal!.ownerID, payload.principal!.deviceID, decodeLossless(payload.principal!.clientID!)]).toEqual(
    [forward.principal.ownerID, forward.principal.deviceID, forward.principal.clientID],
  )
  expect(payload.epoch).toBe(forward.epoch)
})

test("an MCP forward rejects foreign headers, malformed identity and empty or oversized bodies before dispatch", () => {
  const rejected = (input: typeof forward, code: string) => expect(encodeMcpRequest(input)).toMatchObject({ ok: false, error: { code } })
  for (const name of ["authorization", "cookie", "host", "x-ycoding-mcp-owner"])
    rejected({ ...forward, headers: { ...forward.headers, [name]: "synthetic" } }, "invalid_message")
  rejected({ ...forward, headers: { accept: "a\r\nb" } }, "invalid_message")
  rejected({ ...forward, headers: { accept: "x".repeat(McpLimits.headerChars + 1) } }, "invalid_message")
  rejected({ ...forward, epoch: "" }, "invalid_message")
  rejected({ ...forward, principal: { ...forward.principal, ownerID: "../owner" } }, "invalid_message")
  rejected({ ...forward, principal: { ...forward.principal, clientID: "client\nid" } }, "invalid_message")
  rejected({ ...forward, principal: { ...forward.principal, clientID: "c".repeat(McpLimits.clientIDChars + 1) } }, "invalid_message")
  rejected({ ...forward, body: "" }, "invalid_message")
  rejected({ ...forward, body: "x".repeat(McpLimits.bodyChars + 1) }, "message_too_large")
  expect(encodeMcpRequest({ ...forward, body: "x".repeat(McpLimits.bodyChars) }).ok).toBe(true)
})

test("an MCP forward whose encoding exceeds the inline request payload is refused rather than truncated", () => {
  const huge = {
    ...forward,
    body: "\ud800".repeat(McpLimits.bodyChars),
    headers: Object.fromEntries(
      ["content-type", "accept", "mcp-protocol-version", "mcp-method", "mcp-name"].map((name) => [name, "\ud800".repeat(McpLimits.headerChars)]),
    ),
  }
  expect(encodeMcpRequest(huge)).toMatchObject({ ok: false, error: { code: "message_too_large" } })
})

test("an MCP response decodes strictly and rejects malformed bytes", () => {
  const bytes = encodeStrict(
    mcp_request_ResultSchema,
    create(mcp_request_ResultSchema, { data: { status: 200, contentType: "application/json", body: encodeLossless("{}") } }),
  )
  expect(decodeMcpResponse(bytes)).toEqual({ status: 200, contentType: "application/json", body: "{}" })
  expect(decodeMcpResponse(bytes.slice(0, -1))).toBeUndefined()
  expect(decodeMcpResponse(new Uint8Array([0xff]))).toBeUndefined()
})

test("the raw MCP request is relay-only and absent from the browser operation table", () => {
  const mcp = operations.find((operation) => operation.diagnosticName === "mcp.request")!
  expect(mcp.roles).toEqual([PeerRole.RELAY])
  expect(relayDescriptors.map((operation) => operation.operationId)).toContain(mcp.operationId)
  expect(remoteDescriptors.map((operation) => operation.operationId)).not.toContain(mcp.operationId)
  expect(remotePayloadCodecs.has("mcp.request")).toBe(false)
})

test("device MCP resources are stable and contain no credential", () => {
  expect(mcpResource("https://relay.example.invalid", "dev_test")).toBe(
    "https://relay.example.invalid/api/mcp/devices/dev_test",
  )
  expect(() => mcpResource("https://relay.example.invalid", "../escape")).toThrow()
  expect(() => mcpResource("https://user:secret@relay.example.invalid", "dev_test")).toThrow()
  expect(() => mcpResource("http://relay.example.invalid", "dev_test")).toThrow()
})
