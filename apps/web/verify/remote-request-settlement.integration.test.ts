import { expect, test } from "bun:test"
import { RemoteLimits, parseRelayToAgentMessage, type RemoteRequest } from "@ycoding-ai/remote"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createRemoteTransport } from "../src/remote/transport"

test("timed-out browser reads release the actual relay pending budget and never replay a mutation", async () => {
  let now = 0
  let sequence = 0
  const deliveries: Promise<void>[] = []
  const requests: RemoteRequest[] = []
  const cancelled: string[] = []
  let pending = 0
  const tasks: { at: number; callback: () => void; cancelled: boolean }[] = []
  class Socket extends EventTarget {
    readyState = 0
    send(raw: string) { deliveries.push(relay.handleClientMessage("browser", raw)) }
    close() { this.readyState = 3 }
    receive(raw: string) { this.dispatchEvent(new MessageEvent("message", { data: raw })) }
  }
  const socket = new Socket()
  const relay = createRelay({
    now: () => now, newID: () => `relay_${++sequence}`,
    send: (id, raw) => {
      if (id === "browser") { socket.receive(raw); return }
      const parsed = parseRelayToAgentMessage(raw)
      if (!parsed.ok) throw new Error(parsed.error.message)
      if (parsed.value.type === "request") requests.push(parsed.value)
      if (parsed.value.type === "cancel") cancelled.push(parsed.value.id)
    },
    close: () => { throw new Error("The connection must stay open") },
    savePending: (_id, values) => { pending = values.length },
    saveSubscriptions: () => {}, savePriority: () => {}, saveNoticeSubscription: () => {},
    loadStatus: async () => undefined, saveStatus: async () => {},
    loadOfflineCheck: async () => undefined, saveOfflineCheck: async () => {},
    authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }), authorityTtlMs: 5_000,
    notices: { append: () => ({ notices: [], total: 0 }), repeat: () => [], complete: () => ({ notices: [], total: 0 }), page: () => ({ notices: [], total: 0 }), remove: () => ({ ids: [], total: 0 }), clear: () => {}, unavailable: () => false, markUnavailable: () => {} },
  })
  const transport = createRemoteTransport({ url: "ws://127.0.0.1", createSocket: () => socket as unknown as WebSocket,
    now: () => now, pingIntervalMs: 600_000,
    schedule: (callback, ms) => { const task = { at: now + ms, callback, cancelled: false }; tasks.push(task); return () => { task.cancelled = true } },
  })
  const flush = async () => { while (deliveries.length) await Promise.all(deliveries.splice(0)) }
  const advance = () => {
    now++
    for (const task of tasks.filter((value) => !value.cancelled && value.at <= now)) { task.cancelled = true; task.callback() }
  }
  const connection = { ownerID: "usr_test", deviceID: "dev_test", browserSessionID: "browser_test", credentialExpiresAt: 600_000,
    subscriptions: [], pending: [], noticesSubscribed: false }
  await relay.attach({ ...connection, role: "agent", connectionID: "agent" })
  transport.connect()
  socket.readyState = 1
  socket.dispatchEvent(new Event("open"))
  await relay.attach({ ...connection, role: "client", connectionID: "browser" })
  try {
    for (let index = 0; index < RemoteLimits.maxPendingRequestsPerClient + 1; index++) {
      const outcome = transport.request(index === 0 ? "session.interrupt" : "session.list", { ...(index === 0 ? { sessionID: "ses_a" } : {}), timeoutMs: 1 })
      await flush()
      expect(pending).toBe(1)
      advance()
      expect(await outcome).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
      await flush()
      expect(pending).toBe(0)
    }
    expect(cancelled).toEqual(requests.map((value) => value.id))
    const fresh = transport.request("session.list")
    await flush()
    const request = requests.at(-1)!
    await relay.handleAgentMessage("agent", JSON.stringify({ type: "response", id: request.id, ok: true, value: { data: [] } }))
    expect(await fresh).toEqual({ status: "ok", value: { data: [] } })
    expect(requests.filter((value) => value.operation === "session.interrupt")).toHaveLength(1)
  } finally { transport.close(); relay.detach("browser") }
})
