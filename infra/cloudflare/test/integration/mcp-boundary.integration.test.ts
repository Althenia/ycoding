import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"

test("local workerd refuses retired MCP ingress and internal dispatch without a D1 schema", async () => {
  const root = new URL("../../../../", import.meta.url).pathname
  const home = await mkdtemp(path.join(root, "infra/cloudflare/test/.mcp-boundary-"))
  const config = path.join(home, "wrangler.json")
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
  const port = listener.port
  listener.stop(true)
  const origin = `http://127.0.0.1:${port}`
  let child: ReturnType<typeof Bun.spawn> | undefined
  let output = Promise.resolve("")
  try {
    await writeFile(path.join(home, ".dev.vars"), "")
    await writeFile(config, JSON.stringify({
      name: "ycoding-mcp-boundary-local",
      main: path.join(root, "infra/cloudflare/test/support/mcp-boundary-worker.ts"),
      compatibility_date: "2026-09-20",
      assets: { directory: path.join(root, "apps/web/dist"), binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true },
      d1_databases: [{ binding: "DB", database_name: "boundary-local", database_id: "00000000-0000-0000-0000-000000000001" }],
      durable_objects: { bindings: [{ name: "DEVICE_RELAY", class_name: "DeviceRelay" }, { name: "PREVIEW_DIRECTORY", class_name: "PreviewDirectory" }] },
      exports: { DeviceRelay: { type: "durable-object", storage: "sqlite" }, PreviewDirectory: { type: "durable-object", storage: "sqlite" } },
    }))
    child = Bun.spawn([
      path.join(root, "node_modules/.bin/wrangler"), "dev", "--config", config, "--local",
      "--persist-to", path.join(home, "state"), "--ip", "127.0.0.1", "--port", String(port),
    ], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, CI: "true", WRANGLER_SEND_METRICS: "false" },
      stdout: "ignore", stderr: "pipe",
    })
    output = new Response(child.stderr).text()
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fetch(`${origin}/health`).then((response) => response.ok, () => false)) { ready = true; break }
      await Bun.sleep(100)
    }
    expect(ready).toBe(true)
    const paths = [
      "/api/mcp", "/api/mcp/", "/api/mcp/devices/device", "/api/mcp/device/device",
      ...["register", "authorize", "login", "google/callback", "consent", "token", "revoke"].map((name) => `/api/mcp/oauth/${name}`),
      "/.well-known", "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/api/mcp/devices/device", "/api/devices/device/mcp/events/authorize",
    ]
    for (const target of paths)
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
        const response = await fetch(`${origin}${target}`, {
          method, redirect: "manual", headers: { accept: "text/html", authorization: "Bearer synthetic-token", cookie: "yc_mcp_auth=synthetic" },
        })
        expect(response.status, `${method} ${target}`).toBe(404)
        expect(response.headers.get("content-type")).toContain("application/json")
        expect(response.headers.get("www-authenticate")).toBeNull()
        expect(response.headers.get("set-cookie")).toBeNull()
        if (method !== "HEAD") expect(await response.json()).toEqual({ error: { code: "invalid_message", message: "Not found" } })
      }
    for (const target of ["/_ycoding/mcp", "/_ycoding/mcp-events/authorize"])
      for (const trusted of ["true", "false"])
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
          const response = await fetch(`${origin}/__fixture/relay?path=${encodeURIComponent(target)}&trusted=${trusted}`, { method })
          expect(response.status, `${method} ${target}, trusted=${trusted}`).toBe(404)
        }
    const presence = await fetch(`${origin}/__fixture/relay?path=/_ycoding/presence&trusted=true`)
    expect(presence.status).toBe(200)
    expect(await presence.json()).toEqual({ online: false })
    expect((await fetch(`${origin}/api/me`)).status).toBe(401)
    expect((await fetch(`${origin}/ws/v4/agent`, { headers: { upgrade: "websocket" } })).status).toBe(401)
    expect((await fetch(`${origin}/ws/v4/client`, { headers: { upgrade: "websocket", origin } })).status).toBe(401)
    const asset = await fetch(`${origin}/remote/session/ses_fixture`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("text/html")
  } finally {
    child?.kill()
    if (child) await child.exited
    const diagnostics = await output
    await rm(home, { recursive: true, force: true })
    expect(diagnostics).not.toContain("Uncaught")
  }
}, 60_000)
