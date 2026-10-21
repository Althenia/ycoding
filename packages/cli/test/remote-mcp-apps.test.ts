import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { RemoteLocalApp } from "../src/remote-local-app"
import { RemoteMcpApps } from "../src/remote-mcp-apps"

const context: McpEvents.RequestContext = { requestID: "request", principal: { ownerID: "owner", deviceID: "device", clientID: "https://client.example/oauth" }, epoch: "epoch" }
const principal: McpEvents.Principal = { ...context.principal, epoch: context.epoch, grantID: "grant" }
const sessionID = "ses_fixture"
const input = { host: "127.0.0.1", port: 45678, entryPath: "/app", routes: [{ path: "/app", match: "prefix", methods: ["GET", "HEAD", "POST"] }] }
const policy = '<script id="preview-policy" type="application/json">[]</script>'
const html = `<!doctype html><h1>App preview</h1>${policy}`
const origin = "https://preview.example"

function harness(options: { preview?: boolean; issue?: RemoteMcpApps.Preview["issue"]; fetcher?: RemoteLocalApp.Fetcher; verifySession?: (id: string) => Promise<boolean>; origins?: readonly string[] } = {}) {
  let now = 10_000
  let current = principal
  let resolutions = 0
  let issues = 0
  let contacts = 0
  const previewCalls: string[] = []
  const registry = RemoteLocalApp.create({ now: () => now, verifySession: options.verifySession ?? (async () => true), authorize: async () => true, fetcher: async (url, init) => {
    contacts++
    return options.fetcher ? options.fetcher(url, init) : new Response(new Uint8Array([0, 255, 10]), { headers: { "content-type": "application/octet-stream" } })
  } })
  const apps = RemoteMcpApps.create({ registry, now: () => now, html, resolve: async () => { resolutions++; return { ...current } }, ...(options.preview ? { preview: {
    origins: () => options.origins ?? [origin],
    issue: async (request) => { issues++; return options.issue ? options.issue(request) : { url: `${origin}/_ycoding/bootstrap?ticket=private-ticket`, origin, expiresAt: now + 100 } },
    revoke: (input) => { previewCalls.push(`revoke:${input.id}:${input.generation}`) },
    clear: () => { previewCalls.push("clear") },
  } } : {}) })
  const execute = (operation: RemoteMcpApps.Operation, args: unknown = { sessionID }, ctx = context, signal = new AbortController().signal) => apps.execute(operation, args, ctx, signal)
  const register = async () => (await execute("local.app.register", { sessionID, input })).value as RemoteLocalApp.Registration
  return { registry, apps, execute, register, owner: { ...context.principal, sessionID }, scope: { ...principal, sessionID }, setNow: (value: number) => { now = value }, setPrincipal: (value: McpEvents.Principal) => { current = value }, resolutions: () => resolutions, issues: () => issues, contacts: () => contacts, previewCalls }
}

async function reason(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(RemoteMcpApps.Error)
  if (!(error instanceof RemoteMcpApps.Error)) throw error
  expect(error.message).toBe(error.reason)
  expect(JSON.stringify(error)).not.toMatch(/private-ticket|45678|upstream-secret/)
  expect("cause" in error).toBe(false)
  return error.reason
}

describe("generic local app MCP facade", () => {
  test("declares only the six closed operations, explicit annotations and the open UI resource", () => {
    expect(RemoteMcpApps.tools.map((tool) => tool.operation)).toEqual(["local.app.register", "local.app.list", "local.app.revoke", "local.app.open", "local.app.status", "local.app.http"])
    expect(RemoteMcpApps.tools.map((tool) => tool.name)).toEqual(["local_app_register", "local_app_list", "local_app_revoke", "local_app_open", "local_app_status", "local_app_http"])
    for (const tool of RemoteMcpApps.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.annotations).toEqual({ readOnlyHint: ["local.app.list", "local.app.status"].includes(tool.operation), destructiveHint: ["local.app.revoke", "local.app.http"].includes(tool.operation), idempotentHint: ["local.app.list", "local.app.status", "local.app.revoke"].includes(tool.operation), openWorldHint: false })
      expect(tool._meta).toEqual(tool.operation === "local.app.open" ? { ui: { resourceUri: RemoteMcpApps.previewURI } } : undefined)
    }
  })

  test("registers and lists safe metadata; absent preview never issues, publishes, or contacts upstream", async () => {
    const h = harness()
    try {
      const app = await h.register()
      expect(app.generation).toMatch(/^generation_[a-f0-9]{32}$/)
      expect(JSON.stringify(app)).not.toMatch(/45678|127\.0\.0\.1/)
      expect((await h.execute("local.app.list")).value).toEqual([app])
      for (const operation of ["local.app.open", "local.app.status"] as const) {
        const result = await h.execute(operation, { sessionID, input: { id: app.id, ...(operation.endsWith("open") ? { generation: app.generation } : {}) } })
        expect(result).toEqual({ value: { kind: "local-http-app", version: 1, appID: app.id, sessionID, expiresAt: new Date(app.expiresAt).toISOString(), status: "unavailable", reason: "preview_unconfigured" } })
      }
      await expect(h.registry.dispatch({ id: app.id, generation: app.generation, scope: h.scope, method: "GET", path: "/app", headers: {} })).rejects.toMatchObject({ category: "forbidden" })
      expect(h.issues()).toBe(0)
      expect(h.contacts()).toBe(0)
      expect(h.resolutions()).toBeGreaterThanOrEqual(4)
    } finally { h.registry.close() }
  })

  test("open carries bootstrap only in private metadata; status never renews the lease", async () => {
    const h = harness({ preview: true })
    try {
      const app = await h.register()
      const result = await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })
      expect(result).toEqual({ value: { kind: "local-http-app", version: 1, appID: app.id, sessionID, expiresAt: new Date(10_100).toISOString(), status: "ready" }, metadata: { localApp: { url: `${origin}/_ycoding/bootstrap?ticket=private-ticket`, origin } } })
      expect(JSON.stringify(result.value)).not.toMatch(/private-ticket|preview\.example|output_url|image/)
      expect(await h.execute("local.app.status", { sessionID, input: { id: app.id } })).toEqual({ value: result.value })
      expect(h.issues()).toBe(1)
      expect(h.contacts()).toBe(0)
      h.setNow(10_100)
      expect((await h.execute("local.app.status", { sessionID, input: { id: app.id } })).value).toMatchObject({ status: "expired", reason: "expired" })
      expect(h.issues()).toBe(1)
    } finally { h.registry.close() }
  })

  test("unknown, expired and revoked states remain honest without reviving registrations", async () => {
    const h = harness({ preview: true })
    try {
      const unknown = `app_${"0".repeat(32)}`
      expect((await h.execute("local.app.status", { sessionID, input: { id: unknown } })).value).toMatchObject({ appID: unknown, expiresAt: null, status: "unavailable", reason: "not_registered" })
      const app = await h.register()
      expect((await h.execute("local.app.revoke", { sessionID, input: { id: app.id } })).value).toMatchObject({ status: "revoked", reason: "revoked", expiresAt: new Date(app.expiresAt).toISOString() })
      expect((await h.execute("local.app.status", { sessionID, input: { id: app.id } })).value).toMatchObject({ status: "revoked" })
      expect((await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })).value).toMatchObject({ status: "revoked" })
      const expiring = await h.register()
      h.setNow(expiring.expiresAt)
      expect((await h.execute("local.app.status", { sessionID, input: { id: expiring.id } })).value).toMatchObject({ status: "expired", reason: "expired" })
      expect(h.registry.list({ ownerID: "owner", deviceID: "device", sessionID })).toEqual([])
      expect(h.issues()).toBe(0)
    } finally { h.registry.close() }
  })

  test("rejects cross-principal and grant changes before issuer or local HTTP contact", async () => {
    const h = harness({ preview: true })
    try {
      const app = await h.register()
      await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })
      for (const field of ["ownerID", "deviceID", "clientID", "epoch", "grantID"] as const) {
        const other = { ...principal, [field]: "other" }
        h.setPrincipal(other)
        const ctx = { ...context, principal: { ownerID: other.ownerID, deviceID: other.deviceID, clientID: other.clientID }, epoch: other.epoch }
        expect((await h.execute("local.app.list", { sessionID }, ctx)).value).toEqual([])
        expect((await h.execute("local.app.status", { sessionID, input: { id: app.id } }, ctx)).value).toMatchObject({ status: "unavailable", reason: "access_unavailable", expiresAt: null })
        expect(await reason(h.execute("local.app.http", { sessionID, input: { id: app.id, generation: app.generation, method: "GET", path: "/app" } }, ctx))).toBe("access_unavailable")
        expect(await reason(h.execute("local.app.revoke", { sessionID, input: { id: app.id } }, ctx))).toBe("access_unavailable")
      }
      h.setPrincipal(principal)
      expect((await h.execute("local.app.status", { sessionID: "ses_other", input: { id: app.id } })).value).toMatchObject({ status: "unavailable" })
      expect(h.issues()).toBe(1)
      expect(h.contacts()).toBe(0)
    } finally { h.registry.close() }
  })

  test("rechecks fresh scope and registry after issuer awaits, before publication", async () => {
    let mutate: () => void = () => {}
    const h = harness({ preview: true, issue: async () => { mutate(); return { url: `${origin}/_ycoding/bootstrap?ticket=private-ticket`, origin, expiresAt: 10_100 } } })
    try {
      const app = await h.register()
      mutate = () => h.setPrincipal({ ...principal, grantID: "other" })
      expect(await reason(h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } }))).toBe("access_unavailable")
      h.setPrincipal(principal)
      await expect(h.registry.dispatch({ id: app.id, generation: app.generation, scope: h.scope, method: "GET", path: "/app", headers: {} })).rejects.toMatchObject({ category: "forbidden" })
      mutate = () => h.registry.revoke({ id: app.id, owner: { ownerID: "owner", deviceID: "device", sessionID } })
      expect((await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })).value).toMatchObject({ status: "revoked" })
      expect(h.contacts()).toBe(0)
    } finally { h.registry.close() }
  })

  test.each([
    `${origin}/not-bootstrap?ticket=x`, `${origin}/x/../_ycoding/bootstrap?ticket=x`,
    `${origin}/_ycoding/bootstrap?ticket=`, `${origin}/_ycoding/bootstrap?ticket=x&ticket=y`,
    `${origin}/_ycoding/bootstrap?ticket=x&other=y`, `${origin}/_ycoding/bootstrap?ticket=x#fragment`,
    `${origin}/_ycoding/bootstrap?ticket=x#`, `${origin}/_ycoding/bootstrap?ticket=x\ny`,
    `${origin}/_ycoding/bootstrap?ticket=${"x".repeat(513)}`, "https://untrusted.example/_ycoding/bootstrap?ticket=x",
    "http://preview.example/_ycoding/bootstrap?ticket=x", "https://secret@preview.example/_ycoding/bootstrap?ticket=x",
  ])("rejects an invalid bootstrap capability without publishing: %s", async (url) => {
    const h = harness({ preview: true, issue: async () => ({ url, origin, expiresAt: 10_100 }) })
    try {
      const app = await h.register()
      expect(await reason(h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } }))).toBe("access_unavailable")
      await expect(h.registry.dispatch({ id: app.id, generation: app.generation, scope: h.scope, method: "GET", path: "/app", headers: {} })).rejects.toMatchObject({ category: "forbidden" })
      expect(h.contacts()).toBe(0)
    } finally { h.registry.close() }
  })

  test.each([9_999, 10_000, 910_001, NaN, 10_000.5])("rejects issuer expiry %s", async (expiresAt) => {
    const h = harness({ preview: true, issue: async () => ({ url: `${origin}/_ycoding/bootstrap?ticket=x`, origin, expiresAt }) })
    try { const app = await h.register(); expect(await reason(h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } }))).toBe("access_unavailable") }
    finally { h.registry.close() }
  })

  test("validates all outer and nested keys and wire limits before resolution or local work", async () => {
    const h = harness()
    try {
      const cases: [RemoteMcpApps.Operation, unknown][] = [
        ["local.app.list", { sessionID, input: {} }], ["local.app.list", { sessionID, ownerID: "other" }],
        ["local.app.register", { sessionID, input: { ...input, sessionID: "ses_other" } }],
        ["local.app.register", { sessionID, input: { ...input, routes: [{ ...input.routes[0], extra: true }] } }],
        ["local.app.register", { sessionID, input: { ...input, host: "localhost" } }],
        ["local.app.register", { sessionID, input: { ...input, port: 65536 } }],
        ["local.app.open", { sessionID, input: { id: "app_bad", generation: "generation_bad" } }],
        ["local.app.http", { sessionID, input: { id: `app_${"a".repeat(32)}`, generation: `generation_${"b".repeat(32)}`, method: "CONNECT", path: "/" } }],
      ]
      for (const [operation, args] of cases) expect(await reason(h.execute(operation, args))).toBe("invalid_params")
      const app = await h.register()
      const before = h.resolutions()
      for (const fields of [{ url: "https://evil.example" }, { path: "https://evil.example" }, { body: "!!!" }, { body: "Zh==" }, { body: Buffer.alloc(65_537).toString("base64") }, { headers: { A: "a".repeat(8193) } }, { headers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-${index}`, "x"])) }, { headers: { Authorization: "x".repeat(128 * 1024) } }]) {
        expect(await reason(h.execute("local.app.http", { sessionID, input: { id: app.id, generation: app.generation, method: "POST", path: "/app", ...fields } }))).toBe("invalid_params")
      }
      expect(h.resolutions()).toBe(before)
      expect(h.contacts()).toBe(0)
    } finally { h.registry.close() }
  })

  test("HTTP explicitly binds one grant and preserves binary bytes, statuses and headers", async () => {
    const bytes = new Uint8Array([0, 255, 1, 137, 10])
    const sent: RequestInit[] = []
    let status = 206
    const h = harness({ fetcher: async (_url, init) => { sent.push(init ?? {}); return new Response([204, 304].includes(status) ? null : bytes, { status, headers: { "content-type": "image/png", "content-range": "bytes 0-4/5", "content-security-policy": "default-src 'none'", "set-cookie": "secret=x" } }) } })
    try {
      const app = await h.register()
      for (const value of [206, 404, 422, 204, 304]) {
        status = value
        const result = await h.execute("local.app.http", { sessionID, input: { id: app.id, generation: app.generation, method: "POST", path: "/app", headers: { "content-type": "application/octet-stream", Cookie: "secret=x" }, body: Buffer.from(bytes).toString("base64") } })
        expect(result.metadata).toBeUndefined()
        const output = result.value as { status: number; headers: Record<string, string>; body: string }
        expect(output.status).toBe(status)
        expect(output.headers["content-type"]).toBe("image/png")
        expect(output.headers["content-security-policy"]).toBe("default-src 'none'")
        expect(output.headers["set-cookie"]).toBeUndefined()
        expect(Buffer.from(output.body, "base64")).toEqual(Buffer.from([204, 304].includes(status) ? [] : bytes))
        if (![204, 304].includes(status)) expect(createHash("sha256").update(Buffer.from(output.body, "base64")).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"))
      }
      expect(sent.every((request) => new Headers(request.headers).get("cookie") === null)).toBe(true)
      expect(sent[0].body).toEqual(bytes)
      expect(h.issues()).toBe(0)
    } finally { h.registry.close() }
  })

  test("caps binary MCP output without truncation and accepts exact request/response boundaries", async () => {
    let size = 1_048_576
    const h = harness({ fetcher: async () => new Response(new Uint8Array(size)) })
    try {
      const app = await h.register()
      const args = { sessionID, input: { id: app.id, generation: app.generation, method: "POST", path: "/app", body: Buffer.alloc(65_536).toString("base64") } }
      const output = (await h.execute("local.app.http", args)).value as { body: string }
      expect(Buffer.from(output.body, "base64").length).toBe(size)
      size++
      expect(await reason(h.execute("local.app.http", args))).toBe("too_large")
    } finally { h.registry.close() }
  })

  test("resources use exact trusted frame origins, escape policy JSON and never include capabilities", async () => {
    for (const origins of [[origin], ["http://127.0.0.1:8080", "http://[::1]:9090"]]) {
      const h = harness({ preview: true, origins })
      try {
        expect(h.apps.list()).toEqual([{ uri: RemoteMcpApps.previewURI, name: "Local HTTP app", mimeType: "text/html;profile=mcp-app" }])
        const read = h.apps.read(RemoteMcpApps.previewURI)
        expect(read?.contents[0].text).toBe(html.replace(policy, `<script id="preview-policy" type="application/json">${JSON.stringify(origins)}</script>`))
        expect(read?.contents[0]._meta.ui.csp).toEqual({ frameDomains: origins, connectDomains: [], resourceDomains: [] })
        expect(JSON.stringify(read)).not.toContain("private-ticket")
        expect(h.apps.read("ui://unrecognized")).toBeUndefined()
      } finally { h.registry.close() }
    }
    const empty = harness()
    expect(empty.apps.read(RemoteMcpApps.previewURI)?.contents[0].text).toBe(html)
    empty.registry.close()
    for (const origins of [["http://localhost:8080"], ["http://external.example"], ["https://*.example"], ["https://preview.example/path"], ["https://preview.example/#fragment"], ["https://secret@preview.example"], ["https://preview.example</script>"]]) {
      const h = harness({ preview: true, origins })
      expect(() => h.apps.read(RemoteMcpApps.previewURI)).toThrow(RemoteMcpApps.Error)
      h.registry.close()
    }
  })

  test("bounds lease tombstones and does not revive apps after registry clear", async () => {
    const h = harness({ preview: true })
    try {
      let first: RemoteLocalApp.Registration | undefined
      for (let index = 0; index < 65; index++) {
        const app = await h.register()
        first ??= app
        await h.execute("local.app.revoke", { sessionID, input: { id: app.id } })
      }
      expect((await h.execute("local.app.status", { sessionID, input: { id: first!.id } })).value).toMatchObject({ status: "unavailable", reason: "not_registered", expiresAt: null })
      const app = await h.register()
      await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })
      h.registry.clear()
      expect((await h.execute("local.app.status", { sessionID, input: { id: app.id } })).value).toMatchObject({ status: "revoked" })
      expect((await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })).value).toMatchObject({ status: "revoked" })
      expect(h.issues()).toBe(1)
      expect((await h.register()).id).not.toBe(app.id)
    } finally { h.registry.close() }
  })

  test("cancellation and resolver failures never expose caller or upstream details", async () => {
    const registry = RemoteLocalApp.create({ verifySession: async () => true, authorize: async () => true })
    const apps = RemoteMcpApps.create({ registry, html, resolve: async () => { throw new Error("upstream-secret") } })
    expect(await reason(apps.execute("local.app.list", { sessionID }, context, new AbortController().signal))).toBe("access_unavailable")
    const signal = AbortSignal.abort()
    expect(await reason(apps.execute("local.app.list", { sessionID }, context, signal))).toBe("access_unavailable")
    registry.close()
  })

  test("facade clear revokes prior leases and admits only explicit new registrations; close is terminal", async () => {
    const h = harness({ preview: true })
    const app = await h.register()
    await h.execute("local.app.open", { sessionID, input: { id: app.id, generation: app.generation } })
    const revoked = await h.register()
    await h.execute("local.app.revoke", { sessionID, input: { id: revoked.id } })
    expect(h.previewCalls).toEqual([`revoke:${revoked.id}:${revoked.generation}`])
    h.apps.clear()
    expect(h.previewCalls.at(-1)).toBe("clear")
    expect((await h.execute("local.app.status", { sessionID, input: { id: app.id } })).value).toMatchObject({ status: "revoked" })
    expect(await reason(h.execute("local.app.http", { sessionID, input: { id: app.id, generation: app.generation, method: "GET", path: "/app" } }))).toBe("revoked")
    expect((await h.register()).id).not.toBe(app.id)
    h.apps.close()
    expect(await reason(h.register())).toBe("access_unavailable")
    expect(h.registry.list({ ownerID: "owner", deviceID: "device", sessionID })).toEqual([])
  })
})
