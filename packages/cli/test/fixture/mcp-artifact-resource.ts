import { createHash } from "node:crypto"
import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import { RemoteMcpDemo } from "../../src/remote-mcp-demo"

let now = 1000
const demo = RemoteMcpDemo.create(() => now)
const transport = RemoteMCPTransport.create({
  name: "packaged-resource-fixture",
  version: "1",
  tools: RemoteMcpDemo.tools,
  call: async (call) => {
    const operation = call.name === "artifact_demo_preview" ? "artifact.demo.preview" : "artifact.demo.export"
    return { content: demo.content(operation), structuredContent: demo.data(operation) }
  },
  resources: {
    list: async () => demo.list(),
    read: async (input) => demo.read(input.uri),
  },
})

async function request(method: string, params: Record<string, unknown>) {
  const target = typeof params.uri === "string" ? params.uri : typeof params.name === "string" ? params.name : undefined
  const response = await transport.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(target === undefined ? {} : { "mcp-name": target }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  )
  if (!response.ok) throw new Error(`MCP fixture HTTP ${response.status}`)
  return (await response.json()) as {
    result: {
      contents: { uri: string; mimeType: string; text?: string; blob?: string; _meta?: unknown }[]
      resources: { uri: string }[]
    }
    error?: { code: number }
  }
}

try {
  const html = (await request("resources/read", { uri: RemoteMcpDemo.previewURI })).result.contents[0]
  const pngURI = demo.content("artifact.demo.export")[0]
  if (pngURI.type !== "resource_link") throw new Error("Expected PNG resource link")
  const png = (await request("resources/read", { uri: pngURI.uri })).result.contents[0]
  if (typeof html.text !== "string" || typeof png.blob !== "string") throw new Error("Missing resource contents")
  const bytes = Buffer.from(png.blob, "base64")
  const unknown = await request("resources/read", { uri: "artifact://ycoding-demo/missing" })
  now = 901000
  const expired = await request("resources/read", { uri: pngURI.uri })
  const retained = await request("resources/read", { uri: RemoteMcpDemo.previewURI })
  const listed = await request("resources/list", {})
  console.log(
    JSON.stringify({
      html: {
        uri: html.uri,
        mime: html.mimeType,
        sha256: createHash("sha256").update(html.text).digest("hex"),
        startsWithDoctype: html.text.startsWith("<!doctype html>"),
        metadata: html._meta,
      },
      png: { mime: png.mimeType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      unknownCode: unknown.error?.code,
      expiredCode: expired.error?.code,
      htmlAfterExpiryUnchanged: retained.result.contents[0].text === html.text,
      listedAfterExpiry: listed.result.resources.map((resource) => resource.uri),
    }),
  )
} finally {
  await transport.close()
}
