import { Database } from "bun:sqlite"
import { createPreviewDirectoryStore } from "../../../infra/cloudflare/src/preview/directory-store"
import { createPreviewWorker } from "../../../infra/cloudflare/src/preview/worker"
import { PreviewRelayError, createPreviewRelay } from "../../../infra/cloudflare/src/relay/preview"
import { RemoteAgent } from "../src/remote-bridge"
import type { RemoteAppPreviewHost } from "../src/remote-app-preview"
import type { LocalServer } from "../src/remote-local"
import type { RemoteMcpHost } from "../src/remote-mcp-host"

export const previewOrigins = ["https://preview-1.example.invalid", "https://preview-2.example.invalid"]
export const sessionID = "ses_preview"
const agent = { agentID: "agent_fixture", ownerID: "owner_fixture", deviceID: "device_fixture" }
const principal = { ownerID: agent.ownerID, deviceID: agent.deviceID, clientID: "client_fixture" }
const epoch = "epoch_fixture"
const resource = `https://relay.example/api/mcp/devices/${agent.deviceID}`

export async function waitFor<Value>(check: () => Value | undefined, timeout = 2_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(5)
  }
}

export function previewHarness(options: { appPreview?: RemoteAppPreviewHost.Config; relayOrigins?: readonly string[]; database?: Database } = {}) {
  const database = options.database ?? new Database(":memory:")
  const origins = options.relayOrigins ?? previewOrigins
  const store = createPreviewDirectoryStore({
    sql: { exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...(bindings as never[])) }) },
    transactionSync: (operation) => database.transaction(operation)(),
  })
  const sent: string[] = []
  const relayed: Array<{ path: string; method: string }> = []
  let deliver: ((frame: unknown) => void) | undefined
  let granted = true
  let sequence = 0
  const relay = createPreviewRelay({
    origins,
    directory: { allocate: async (request) => store.allocate(request), register: async (lease) => store.register(lease), revoke: async (target) => store.revoke(target) },
    send: (_agentID, frame) => deliver?.(frame),
    persist: () => {},
    authorizeDevice: async () => true,
  })
  const worker = createPreviewWorker({
    origins,
    directory: {
      redeem: async (ticketHash, origin) => store.redeem(ticketHash, origin),
      bind: async (input) => store.bind(input),
      resolve: async (cookieHash, leaseTag, origin) => store.resolve(cookieHash, leaseTag, origin),
    },
    forward: (device, input, signal) => {
      relayed.push({ path: input.path, method: input.method })
      return relay.request({ ...device, input, signal }).then(
        (result) => Response.json(result),
        (error: unknown) => new Response("unavailable", { status: error instanceof PreviewRelayError ? error.status : 502 }),
      )
    },
  })
  const authority = new AbortController()
  const host: RemoteMcpHost = {
    status: () => ({ state: "on", url: resource }),
    setLaneHold: () => {},
    advertisement: () => ({ enabled: true, epoch }),
    allowed: (value) => !authority.signal.aborted && value === epoch,
    authorizationSignal: () => authority.signal,
    attach: async () => {},
    detach: () => {},
    set: async () => ({ state: "off" }),
    settled: async () => {},
  }
  const local = new Proxy({} as LocalServer, {
    get: (_target, property) => {
      if (property === "events") return async () => async () => {}
      return async () => {
        if (property === "listPage") return { data: [{ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }] }
        if (property === "getSession") return { id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }
        if (property === "outstandingSessions") return { data: [], running: [], failed: [], lost: [] }
        if (property === "completions") return { data: [] }
        if (property === "permissionRequests" || property === "formRequests" || property === "guardrailRequestList") return []
        if (property === "mcpEventsStatus") return { available: false }
        return {}
      }
    },
  })
  const bridge = new RemoteAgent({
    mcp: {
      host, resource, deviceID: agent.deviceID, home: "/home/synthetic",
      authorizationFetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { action: string }
        if (request.action === "capabilities") return Response.json({ action: request.action, supported: true })
        return Response.json(granted ? { action: request.action, authorized: true, grantID: "grant_fixture", expiresAt: Date.now() + 600_000 } : { action: request.action, authorized: false, reason: "unauthorized" })
      },
      ...(options.appPreview === undefined ? {} : { appPreview: options.appPreview }),
    },
    relayURL: "https://relay.example",
    local,
    credentials: async () => ({ accessToken: "token_fixture", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: (input) => {
      relay.setAgent(agent)
      return {
        connect: async () => input.onOpen(),
        send: async (value) => {
          sent.push(value)
          await relay.route(agent.agentID, value)
        },
        onMessage: (handler) => { deliver = handler },
        disconnect: async () => {
          const cleared = relay.clearAgent(agent.agentID)
          if (cleared !== undefined) await relay.purge(cleared)
        },
      }
    },
    refreshIntervalMs: 3_600_000,
    advertiseCoalesceMs: 0,
  })
  const frames = () => sent.map((frame) => JSON.parse(frame) as Record<string, unknown> & { type: string })
  const call = async (name: string, input?: unknown) => {
    const id = `mcp_${++sequence}`
    deliver?.({ type: "request", id, operation: "mcp.request", input: {
      epoch, principal,
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { sessionID, ...(input === undefined ? {} : { input }) }, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
      } } }),
    } })
    const response = await waitFor(() => frames().find((frame) => frame.type === "response" && frame.id === id))
    if (response.ok !== true) throw new Error(`MCP request failed: ${JSON.stringify(response.error)}`)
    return JSON.parse((response.value as { body: string }).body).result as { isError?: boolean; structuredContent: Record<string, unknown>; _meta?: { localApp?: { url: string; origin: string } } }
  }
  const connect = async () => {
    await bridge.connect()
    if (options.appPreview !== undefined) await waitFor(() => frames().some((frame) => frame.type === "preview.state") ? true : undefined)
  }
  return {
    bridge, store, relay, worker, sent, frames, relayed, call, connect,
    deny: () => { granted = false },
    database,
    leases: () => (database.query("SELECT COUNT(*) AS total FROM preview_lease").get() as { total: number }).total,
    bindings: () => database.query("SELECT origin, ended FROM preview_origin ORDER BY bound_at, origin").all() as Array<{ origin: string; ended: number }>,
  }
}
