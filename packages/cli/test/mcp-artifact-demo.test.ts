import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import { createArtifactDemo, demoPNG } from "../script/mcp-artifact-demo"

const origin = "http://127.0.0.1:4098"
const resource = "https://demo.example.com/mcp"
const open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const entry of open.splice(0).reverse()) await entry.close()
})

async function fixture(resourceURL = resource) {
  const state = { authorized: true, now: 1000 }
  const demo = await createArtifactDemo({
    resource: resourceURL,
    localOrigin: origin,
    now: () => state.now,
    auth: {
      authorize: async () => (state.authorized ? undefined : new Response(null, { status: 401 })),
      metadata: () => Response.json({ resource: resourceURL }),
    },
  })
  open.push(demo)
  const request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    const target =
      typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : undefined
    const response = await demo.fetch(
      new Request(`${origin}${new URL(resourceURL).pathname}`, {
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
    const body = await response.text()
    if (!response.ok) throw new Error(body || `HTTP ${response.status}`)
    const message = JSON.parse(body) as { result: T; error?: { message: string } }
    if (message.error) throw new Error(message.error.message)
    return message.result
  }
  const client = {
    listTools: () => request<{ tools: RemoteMCPTransport.Tool[] }>("tools/list"),
    listResources: () => request<{ resources: { uri: string; mimeType?: string }[] }>("resources/list"),
    callTool: (params: { name: string; arguments: Record<string, unknown> }) =>
      request<RemoteMCPTransport.ToolResult>("tools/call", params),
    readResource: (params: { uri: string }) =>
      request<{
        contents: Array<{ uri: string; mimeType?: string; _meta?: unknown } & ({ text: string } | { blob: string })>
      }>("resources/read", params),
  }
  return { demo, client, state }
}

test("serves the advertised OAuth metadata path for a root resource", async () => {
  const { demo } = await fixture("https://demo.example.com/")
  expect((await demo.fetch(new Request(`${origin}/.well-known/oauth-protected-resource`))).status).toBe(200)
})

test("discovers a portable UI resource independently of original PNG export", async () => {
  const { client } = await fixture()
  const tools = (await client.listTools()).tools
  expect(tools.map((tool) => tool.name)).toEqual(["artifact_demo_preview", "artifact_demo_export"])
  expect(tools[0]._meta).toEqual({ ui: { resourceUri: "ui://ycoding/artifact-demo/v1.html" } })
  expect(tools[1]._meta).toBeUndefined()
  expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true)
  const result = await client.callTool({ name: "artifact_demo_preview", arguments: {} })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({ variants: ["list", "cards"], hostVerification: "required" })
  const html = (await client.readResource({ uri: "ui://ycoding/artifact-demo/v1.html" })).contents[0]
  expect(html.mimeType).toBe("text/html;profile=mcp-app")
  expect(html._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } })
  expect("text" in html && html.text).toContain("ui/initialize")
})

test("delivers original PNG bytes and hash through a resource link, never text or image-inspection content", async () => {
  const { client } = await fixture()
  const result = await client.callTool({ name: "artifact_demo_export", arguments: {} })
  expect(result.content).toHaveLength(1)
  const link = result.content?.[0]
  if (link?.type !== "resource_link") throw new Error("Expected an attachment resource link")
  expect(link).toMatchObject({ name: "ycoding-demo.png", mimeType: "image/png", size: demoPNG.length })
  const metadata = result.structuredContent
  expect(metadata).toMatchObject({
    filename: "ycoding-demo.png",
    mime: "image/png",
    size: demoPNG.length,
    sha256: createHash("sha256").update(demoPNG).digest("hex"),
    expiresAt: 901000,
  })
  const file = (await client.readResource({ uri: link.uri })).contents[0]
  if (!("blob" in file)) throw new Error("Expected original byte transfer")
  const bytes = Buffer.from(file.blob, "base64")
  expect(bytes).toEqual(demoPNG)
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(demoPNG).digest("hex"))
  expect(JSON.stringify(result)).not.toContain(demoPNG.toString("base64"))
  expect(metadata).toMatchObject({ delivery: "host-native-attachment-required" })
  expect((await client.readResource({ uri: link.uri })).contents).toEqual([file])
})

test("checks authorization on every resource request and rejects unknown or expired resources", async () => {
  const { client, state } = await fixture()
  await expect(client.readResource({ uri: "file:///etc/passwd" })).rejects.toThrow()
  const listed = await client.listResources()
  const png = listed.resources.find((item) => item.mimeType === "image/png")
  if (!png) throw new Error("Missing demo PNG")
  state.authorized = false
  await expect(client.readResource({ uri: png.uri })).rejects.toThrow()
  state.authorized = true
  state.now = 901000
  await expect(client.readResource({ uri: png.uri })).rejects.toThrow("Resource unavailable")
  expect((await client.callTool({ name: "artifact_demo_export", arguments: {} })).isError).toBe(true)
})

test("keeps demo ingress private to its configured resource and rejects path-selecting arguments", async () => {
  const { client, demo } = await fixture()
  expect((await client.callTool({ name: "artifact_demo_export", arguments: { path: "../../secret" } })).isError).toBe(
    true,
  )
  for (const url of [`${origin}/mcp?token=x`, `${origin}/api/session`, "http://foreign.example/mcp"])
    expect((await demo.fetch(new Request(url))).status).toBe(url.includes("foreign") ? 403 : 404)
  expect(
    (await demo.fetch(new Request(`${origin}/mcp`, { headers: { origin: "https://foreign.example" } }))).status,
  ).toBe(403)
})
