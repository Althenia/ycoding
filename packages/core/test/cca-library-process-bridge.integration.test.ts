import { afterEach, expect, test } from "bun:test"
import { createCcaLibraryProcessBridge } from "../src/cca/library-process-bridge"
import { CcaAuthorizationDeniedError } from "../src/cca/authorization"

const closes: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closes.splice(0).map((close) => close())) })
const tools = [{ name: "prepare_uploads", description: "Prepare one Library upload", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } }]
const readFile = async () => ({ canonical: "/synthetic/one.txt", bytes: new Uint8Array([1]) })

async function fixture() {
  const bridge = createCcaLibraryProcessBridge()
  closes.push(() => bridge.close())
  let current = true
  let closed = 0
  const calls: unknown[] = []
  const lease = await bridge.open({ open: async (owner) => {
    calls.push(owner)
    return {
      tools,
      check: async () => { if (!current) throw new Error("synthetic retired principal") },
      call: async (name, args) => { calls.push({ name, args }); return { uploads: [{ id: "file-synthetic", workspace_path: "/synthetic/one.txt" }] } },
      close: async () => { current = false; closed++ },
    }
  } }, { processID: "process-a", cwd: "/synthetic", readFile })
  return { bridge, lease, calls, closed: () => closed, retire: () => { current = false } }
}

function request(env: Readonly<Record<string, string>>, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(env.CODEX_APPS_MCP_URL, { method: "POST", headers: { authorization: env.CODEX_APPS_AUTHORIZATION, "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: "request-a", method, params }) })
}

test("a private process capability lists exact tools and returns plain structured results", async () => {
  const f = await fixture()
  expect(new URL(f.lease.env.CODEX_APPS_MCP_URL).hostname).toBe("127.0.0.1")
  expect(f.lease.env.CODEX_APPS_AUTHORIZATION).toMatch(/^Bearer [a-f0-9]{64}$/)
  expect(await (await request(f.lease.env, "tools/list")).json()).toMatchObject({ result: { tools } })
  expect(await (await request(f.lease.env, "tools/call", { name: "prepare_uploads", arguments: { workspace_path: "/synthetic/one.txt" } })).json()).toMatchObject({ result: { structuredContent: { uploads: [{ id: "file-synthetic" }] } } })
  expect(f.calls).toEqual([{ processID: "process-a", cwd: "/synthetic", readFile }, { name: "prepare_uploads", args: { workspace_path: "/synthetic/one.txt" } }])
})

test("foreign tokens, browser origins, hostile hosts and unsupported methods cannot dispatch", async () => {
  const f = await fixture()
  expect((await request(f.lease.env, "tools/list", {}, { authorization: "Bearer foreign" })).status).toBe(401)
  expect((await request(f.lease.env, "tools/list", {}, { origin: "https://example.com" })).status).toBe(403)
  expect((await request(f.lease.env, "tools/list", {}, { host: "example.com" })).status).toBe(403)
  expect(await (await request(f.lease.env, "session.prompt", {})).json()).toMatchObject({ error: { code: -32601 } })
  expect((await fetch(f.lease.env.CODEX_APPS_MCP_URL, { headers: { authorization: f.lease.env.CODEX_APPS_AUTHORIZATION } })).status).toBe(405)
  expect(f.calls).toHaveLength(1)
})

test("retired native pins and closed process leases revoke listing and calls", async () => {
  const f = await fixture()
  f.retire()
  const stale = await request(f.lease.env, "tools/call", { name: "prepare_uploads", arguments: {} })
  expect(stale.status).toBe(403)
  expect(f.calls).toHaveLength(1)
  await f.lease.close()
  await f.lease.close()
  expect(f.closed()).toBe(1)
  expect((await request(f.lease.env, "tools/list")).status).toBe(401)
})

test("oversized request bodies and unknown tools fail without dispatch", async () => {
  const f = await fixture()
  expect((await request(f.lease.env, "tools/call", { name: "prepare_uploads", arguments: { value: "x".repeat(300000) } })).status).toBe(413)
  expect(await (await request(f.lease.env, "tools/call", { name: "foreign_tool", arguments: {} })).json()).toMatchObject({ error: { code: -32602 } })
  expect(f.calls).toHaveLength(1)
})

test("closing a process revokes an in-flight result without retrying it", async () => {
  const bridge = createCcaLibraryProcessBridge()
  closes.push(() => bridge.close())
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let active = true
  let calls = 0
  const lease = await bridge.open({ open: async () => ({
    tools,
    check: async () => { if (!active) throw new Error("retired") },
    call: async () => { calls++; entered.resolve(); await release.promise; return { mustNotPublish: true } },
    close: async () => { active = false; release.resolve() },
  }) }, { processID: "process-pending", cwd: "/synthetic", readFile })
  const pending = request(lease.env, "tools/call", { name: "prepare_uploads", arguments: {} })
  await entered.promise
  await lease.close()
  expect(JSON.stringify(await (await pending).json())).not.toContain("mustNotPublish")
  expect(calls).toBe(1)
})

test("reused process labels receive independent backend capabilities", async () => {
  const bridge = createCcaLibraryProcessBridge()
  closes.push(() => bridge.close())
  let opened = 0
  const factory = { open: async () => {
    const instance = ++opened
    return { tools, check: async () => {}, call: async () => ({ instance }), close: async () => {} }
  } }
  const first = await bridge.open(factory, { processID: "same-peer-label", cwd: "/synthetic", readFile })
  const second = await bridge.open(factory, { processID: "same-peer-label", cwd: "/synthetic", readFile })
  expect(first.env.CODEX_APPS_AUTHORIZATION === second.env.CODEX_APPS_AUTHORIZATION).toBe(false)
  expect(await (await request(first.env, "tools/call", { name: "prepare_uploads", arguments: {} })).json()).toMatchObject({ result: { structuredContent: { instance: 1 } } })
  expect(await (await request(second.env, "tools/call", { name: "prepare_uploads", arguments: {} })).json()).toMatchObject({ result: { structuredContent: { instance: 2 } } })
  await first.close()
  expect((await request(first.env, "tools/list")).status).toBe(401)
  expect((await request(second.env, "tools/list")).status).toBe(200)
})

test("a plain authorization denial returns a valid nonempty MCP text error", async () => {
  const bridge = createCcaLibraryProcessBridge()
  closes.push(() => bridge.close())
  const lease = await bridge.open({ open: async () => ({ tools, check: async () => {},
    call: async () => { throw new CcaAuthorizationDeniedError([]) }, close: async () => {},
  }) }, { processID: "denied", cwd: "/synthetic", readFile })
  const response = await request(lease.env, "tools/call", { name: "prepare_uploads", arguments: {} })
  expect(await response.json()).toMatchObject({ result: { isError: true, content: [{ type: "text", text: "Library permission denied." }] } })
})
