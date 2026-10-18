import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { buildMcpApp, checkMcpApps, inputDigest, mcpApps } from "./build-mcp-apps"

test("all MCP apps are generated from the shared bridge and owned inputs", () => {
  expect(mcpApps.map((app) => app.id)).toEqual(["mcp-artifact-demo", "local-http-app"])
  for (const app of mcpApps) {
    expect(app.inputs.some((input) => input.endsWith(path.join("mcp-app", "bridge.js")))).toBe(true)
    expect(app.inputs.some((input) => input.endsWith("template.html"))).toBe(true)
    expect(app.inputs.some((input) => input.endsWith("client.js"))).toBe(true)
  }
})

test("canonical index.html files match a fresh generation and their input digest", async () => {
  expect(await checkMcpApps()).toEqual({ ok: true, drift: [] })
  for (const app of mcpApps) {
    const generated = await buildMcpApp(app.id)
    const onDisk = await readFile(path.join(app.directory, "index.html"), "utf8")
    expect(onDisk).toBe(generated)
    expect(onDisk).toContain(`<meta name="ycoding-mcp-app-inputs" content="sha256:${await inputDigest(app.id)}" />`)
  }
})

test("generated wrapper documents are self-contained and start no network clients", async () => {
  for (const app of mcpApps) {
    const html = await buildMcpApp(app.id)
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i)
    expect(html).not.toMatch(/\bfetch\s*\(/)
    if (app.id !== "local-http-app") expect(html).not.toContain("WebSocket")
    expect(html).not.toMatch(/\bWebSocket\s*\(/)
    expect(html).not.toContain("EventSource")
    expect(html).not.toContain("ui/message")
  }
})

test("generated documents keep their owning surfaces", async () => {
  const demo = await buildMcpApp("mcp-artifact-demo")
  expect(demo).toContain("Artifact preview feasibility fixture")
  expect(demo).toContain('id="probe-button"')
  expect(demo).toContain('id="variant-cards"')
  expect(demo).not.toContain("agent_eval_dashboard_data")
  const local = await buildMcpApp("local-http-app")
  expect(local).toContain('<script id="preview-policy" type="application/json">[]</script>')
  expect(local).toContain("App preview")
  expect(local).toContain("local_app_status")
  expect(local).not.toContain("agent_eval_dashboard_data")
})
