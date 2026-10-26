import { afterEach, describe, expect, test } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createHash } from "node:crypto"
import { RemoteMCPTransport } from "../src/remote-mcp/transport"
import { inputRequired } from "@modelcontextprotocol/server"
import { Schema } from "effect"

const endpoint = "http://127.0.0.1:4096/api/mcp/devices/dev_1"
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
}
const tools = [
  {
    name: "echo",
    description: "Echo the count.",
    inputSchema: {
      type: "object" as const,
      properties: { count: { type: "integer", minimum: 0, maximum: 10 }, label: { type: "string", maxLength: 8 } },
      required: ["count"],
      additionalProperties: false,
    },
  },
  { name: "ping", description: "No input.", inputSchema: { type: "object" as const, additionalProperties: false } },
]

type Seen = { name: string; arguments: Record<string, unknown>; context: string | undefined; signal: AbortSignal }
const open: Array<{ transport: ReturnType<typeof RemoteMCPTransport.create<string>>; clients: Client[] }> = []

test("MRTR carries the per-request envelope, responses and verified opaque state through the SDK seam", async () => {
  const seen: RemoteMCPTransport.Call<string>[] = []
  const transport = RemoteMCPTransport.create<string>({
    name: "mrtr", version: "1", tools,
    requestState: { verify: (state) => { if (state !== "opaque") throw new Error("invalid state") } },
    call: async (call) => {
      seen.push(call)
      if (call.requestState === undefined) return inputRequired({ requestState: "opaque", inputRequests: { decision: inputRequired.elicit({ message: "Choose", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } }) } })
      return { content: [], structuredContent: call.inputResponses }
    },
  })
  open.push({ transport, clients: [] })
  const post = (extra: Record<string, unknown>) => transport.fetch(new Request(endpoint, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "tools/call", "mcp-name": "echo", "mcp-protocol-version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { count: 1 }, _meta: { ...meta, "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } }, ...extra } }),
  }), "synthetic")
  const decode = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }))
  const first = decode(await (await post({})).json())
  expect(first.result).toMatchObject({ resultType: "input_required", requestState: "opaque", inputRequests: { decision: { method: "elicitation/create" } } })
  const accepted = { decision: { action: "accept", content: { confirm: false } } }
  expect(decode(await (await post({ requestState: "opaque", inputResponses: accepted })).json()).result.structuredContent).toEqual(accepted)
  expect(seen[1]?.requestState).toBe("opaque")
  expect(seen[1]?.envelope).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" })
  const dropped = { method: "elicitation/create", result: accepted.decision }
  expect(decode(await (await post({ requestState: "opaque", inputResponses: { ...accepted, wrapped: dropped } })).json()).result.structuredContent).toEqual(accepted)
  expect(seen[2]).toMatchObject({ inputResponses: accepted, droppedInputResponseKeys: ["wrapped"] })
  const tampered = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.Unknown }))(await (await post({ requestState: "tampered", inputResponses: accepted })).json())
  expect(tampered.error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } })
  expect(seen).toHaveLength(3)
})

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await Promise.all(entry.clients.map((client) => client.close()))
    await entry.transport.close()
  }
})

function fixture(handler?: (seen: Seen) => Promise<RemoteMCPTransport.ToolResult>, maxRequestBodySize?: number) {
  const seen: Seen[] = []
  const transport = RemoteMCPTransport.create<string>({
    name: "ycoding-remote-test",
    version: "1.0.0",
    tools,
    ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
    call: async (input) => {
      seen.push(input)
      return (await handler?.(input)) ?? { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], structuredContent: { ok: true } }
    },
  })
  const clients: Client[] = []
  open.push({ transport, clients })
  const connect = async () => {
    const client = new Client({ name: "ycoding-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        fetch: async (url, init) => transport.fetch(new Request(url instanceof URL ? url.href : url, init), "principal-context"),
      }),
    )
    return client
  }
  const post = (message: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    transport.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "echo",
          ...headers,
        },
        body: typeof message === "string" ? message : JSON.stringify(message),
        ...(signal === undefined ? {} : { signal }),
      }),
      "principal-context",
    )
  const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: meta } })
  return { seen, transport, connect, post, call }
}

describe("2026-07-28 discovery, listing and calls", () => {
  test("preserves UI metadata and transfers binary resources with request-scoped authority", async () => {
    const bytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10])
    const uri = "artifact://demo/png"
    const reads: Array<{ uri: string; context: string | undefined; signal: AbortSignal }> = []
    const transport = RemoteMCPTransport.create<string>({
      name: "artifact-test",
      version: "1",
      tools: [{ ...tools[1], _meta: { ui: { resourceUri: "ui://demo/preview.html" } } }],
      call: async () => ({
        content: [{ type: "resource_link", uri, name: "sample.png", mimeType: "image/png", size: bytes.length }],
        _meta: { delivery: "host-attachment-required" },
      }),
      resources: {
        list: async (context, signal) => {
          expect(context).toBe("owner")
          expect(signal).toBeInstanceOf(AbortSignal)
          return [{ uri, name: "sample.png", mimeType: "image/png", size: bytes.length }]
        },
        read: async (input) => {
          reads.push(input)
          if (input.context !== "owner" || input.uri !== uri) return undefined
          return { contents: [{ uri, mimeType: "image/png", blob: bytes.toString("base64") }] }
        },
      },
    })
    const client = new Client({ name: "resource-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
    open.push({ transport, clients: [client] })
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (url, init) => transport.fetch(new Request(url instanceof URL ? url.href : url, init), "owner"),
    }))
    expect(client.getServerCapabilities()?.resources).toBeDefined()
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    expect((await client.listTools()).tools[0]._meta).toEqual({ ui: { resourceUri: "ui://demo/preview.html" } })
    expect((await client.callTool({ name: "ping", arguments: {} }))._meta).toMatchObject({ delivery: "host-attachment-required" })
    expect((await client.listResources()).resources).toEqual([{ uri, name: "sample.png", mimeType: "image/png", size: bytes.length }])
    const result = await client.readResource({ uri })
    const content = result.contents[0]
    expect("blob" in content).toBe(true)
    if (!("blob" in content)) throw new Error("Expected original bytes")
    const decoded = Buffer.from(content.blob, "base64")
    expect(decoded).toEqual(bytes)
    expect(createHash("sha256").update(decoded).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(reads[0]).toMatchObject({ uri, context: "owner" })
    expect(reads[0].signal).toBeInstanceOf(AbortSignal)
    await expect(client.readResource({ uri: "artifact://foreign/png" })).rejects.toThrow("Resource unavailable")
    await expect(client.readResource({ uri: "artifact://missing/png" })).rejects.toMatchObject({ code: -32602, data: { uri: "artifact://missing/png" } })
  })

  test("lists the supplied tools deterministically and passes validated arguments with the carried context", async () => {
    const { connect, seen } = fixture()
    const client = await connect()
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo", "ping"])
    expect(listed.tools[0]?.inputSchema).toEqual(tools[0]!.inputSchema)
    const result = await client.callTool({ name: "echo", arguments: { count: 2, label: "x" } })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true })
    expect(result.content).toEqual([{ type: "text", text: '{"ok":true}' }])
    expect(seen.map((item) => [item.name, item.arguments, item.context])).toEqual([["echo", { count: 2, label: "x" }, "principal-context"]])
  })

  test("returns a tool result for the tool's own error and a null structured value unchanged", async () => {
    const { connect } = fixture(async (input) =>
      input.name === "ping"
        ? { content: [{ type: "text", text: "null" }], structuredContent: null }
        : { isError: true, content: [{ type: "text", text: "outcome_unknown: inspect first" }], structuredContent: { error: { code: "outcome_unknown" } } },
    )
    const client = await connect()
    const settled = await client.callTool({ name: "ping", arguments: {} })
    expect(settled.structuredContent).toBeNull()
    const failed = await client.callTool({ name: "echo", arguments: { count: 1 } })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toEqual({ error: { code: "outcome_unknown" } })
  })
})

describe("published schemas are enforced before the callback", () => {
  test.each([
    ["unknown property", { count: 1, extra: true }],
    ["wrong type", { count: "1" }],
    ["fractional integer", { count: 1.5 }],
    ["out of range", { count: 11 }],
    ["missing required", {}],
    ["too long string", { count: 1, label: "123456789" }],
  ])("refuses %s as a tool error", async (_label, args) => {
    const { connect, seen } = fixture()
    const client = await connect()
    const result = await client.callTool({ name: "echo", arguments: args })
    expect(result.isError).toBe(true)
    expect(seen).toHaveLength(0)
  })

  test("accepts a mathematically integral number", async () => {
    const { post, seen } = fixture()
    const response = await post(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"count":2.0},"_meta":${JSON.stringify(meta)}}}`)
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
  })
})

describe("protocol failures stay protocol errors", () => {
  test("rejects an unknown tool with invalid params", async () => {
    const { post, call, seen } = fixture()
    const response = await post(call("missing", {}), { "mcp-name": "missing" })
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
    expect(seen).toHaveLength(0)
  })

  test("rejects missing request metadata", async () => {
    const { post, seen } = fixture()
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { count: 1 } } })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32602)
    expect(seen).toHaveLength(0)
  })

  test("rejects a method header that disagrees with the body", async () => {
    const { post, call, seen } = fixture()
    const response = await post(call("echo", { count: 1 }), { "mcp-method": "tools/list" })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32020)
    expect(seen).toHaveLength(0)
  })

  test("rejects an unsupported protocol revision and the legacy handshake", async () => {
    const { post, seen } = fixture()
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } },
      { "mcp-method": "initialize", "mcp-protocol-version": "2025-06-18" },
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: number; data: { supported: string[]; requested: string } } }
    expect(body.error.code).toBe(-32022)
    expect(body.error.data).toEqual({ supported: ["2026-07-28"], requested: "2025-06-18" })
    expect(seen).toHaveLength(0)
  })

  test("serves POST only", async () => {
    const { transport } = fixture()
    const response = await transport.fetch(new Request(endpoint, { method: "GET" }))
    expect(response.status).toBe(405)
  })

  test("refuses a body above the configured bound before parsing", async () => {
    const { post, call, seen } = fixture(undefined, 256)
    const response = await post(call("echo", { count: 1, label: "x".repeat(400) }))
    expect(response.status).toBe(413)
    expect(seen).toHaveLength(0)
  })
})

describe("cancellation and shutdown", () => {
  test("aborts the callback signal when the HTTP request is aborted", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const finished = Promise.withResolvers<void>()
    const { post, call } = fixture(async (input) => {
      started.resolve(input.signal)
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      finished.resolve()
      return { content: [{ type: "text", text: "cancelled" }] }
    })
    const controller = new AbortController()
    const pending = post(call("echo", { count: 1 }), {}, controller.signal).catch(() => undefined)
    const signal = await started.promise
    expect(signal.aborted).toBe(false)
    controller.abort()
    await finished.promise
    expect(signal.aborted).toBe(true)
    await pending
  })

  test("close aborts in-flight calls", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const { post, call, transport } = fixture(async (input) => {
      started.resolve(input.signal)
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { content: [{ type: "text", text: "closed" }] }
    })
    const pending = post(call("echo", { count: 1 })).catch(() => undefined)
    const signal = await started.promise
    await transport.close()
    expect(signal.aborted).toBe(true)
    await pending
  })
})
