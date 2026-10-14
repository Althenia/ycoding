import { expect, test } from "bun:test"
import { WebLimits, type RelayRequestView } from "../src/remote/wire-views"
import { createAgentPeer, binaryFrame, startAgent } from "../test/core-peer"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createRemoteTransport } from "../src/remote/transport"

test("timed-out browser reads release the actual relay pending budget and never replay a mutation", async () => {
  let now = 0
  let sequence = 0
  const deliveries: Promise<void>[] = []
  const requests: RelayRequestView[] = []
  const cancelled: string[] = []
  const closes: { readonly code: number; readonly reason: string }[] = []
  const tasks: { at: number; callback: () => void; cancelled: boolean }[] = []
  class Socket extends EventTarget {
    readyState = 0
    send(raw: Uint8Array) {
      deliveries.push(relay.handleClientMessage("browser", raw.slice().buffer))
    }
    close() {
      this.readyState = 3
    }
    receive(raw: Uint8Array) {
      this.dispatchEvent(new MessageEvent("message", { data: raw.slice().buffer }))
    }
  }
  const socket = new Socket()
  const agent = createAgentPeer(
    () => now,
    (request) => requests.push(request),
  )
  const relay = createRelay({
    now: () => now,
    monotonic: () => now,
    newID: () => `relay_${++sequence}`,
    send: (id, raw) => {
      if (id === "browser") {
        socket.receive(raw)
        return
      }
      const frame = binaryFrame(raw)
      if (
        frame.body.case === "control" &&
        frame.body.value.kind.case === "cancel" &&
        frame.body.value.kind.value.target.case === "requestId"
      )
        cancelled.push(frame.body.value.kind.value.target.value)
      agent.receive(raw.slice().buffer)
    },
    close: (_id, code, reason) => {
      closes.push({ code, reason })
    },
    loadOfflineCheck: async () => undefined,
    saveOfflineCheck: async () => {},
    authorizeClientCommand: async () => ({ ok: true, ownerID: "usr_test" }),
    authorizeAgentCommand: async () => ({ ok: true, ownerID: "usr_test" }),
    notices: {
      append: () => ({ notices: [], total: 0 }),
      repeat: () => [],
      complete: () => ({ notices: [], total: 0 }),
      page: () => ({ notices: [], total: 0 }),
      remove: () => ({ ids: [], total: 0 }),
      clear: () => {},
      unavailable: () => false,
      markUnavailable: () => {},
    },
  })
  const transport = createRemoteTransport({
    url: "ws://127.0.0.1",
    createSocket: () => socket as unknown as WebSocket,
    now: () => now,
    pingIntervalMs: 600_000,
    schedule: (callback, ms) => {
      const task = { at: now + ms, callback, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
  })
  const flush = async () => {
    while (deliveries.length) await Promise.all(deliveries.splice(0))
  }
  const advance = () => {
    now++
    for (const task of tasks.filter((value) => !value.cancelled && value.at <= now)) {
      task.cancelled = true
      task.callback()
    }
  }
  const connection = {
    ownerID: "usr_test",
    deviceID: "dev_test",
    browserSessionID: "browser_test",
    credentialExpiresAt: 600_000,
    subscriptions: [],
    pending: [],
    noticesSubscribed: false,
  }
  await relay.attach({ ...connection, role: "agent", connectionID: "agent" })
  agent.message = (raw) => {
    deliveries.push(relay.handleAgentMessage("agent", raw))
  }
  startAgent(agent)
  await flush()
  await relay.attach({ ...connection, role: "client", connectionID: "browser" })
  transport.connect()
  socket.readyState = 1
  socket.dispatchEvent(new Event("open"))
  await flush()
  try {
    for (let index = 0; index < WebLimits.maxPendingRequestsPerClient + 1; index++) {
      const outcome = transport.request(index === 0 ? "session.interrupt" : "session.list", {
        ...(index === 0 ? { sessionID: "ses_a" } : {}),
        timeoutMs: 1,
      })
      await flush()
      expect(requests).toHaveLength(index + 1)
      advance()
      expect(await outcome).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
      await flush()
      expect(cancelled).toHaveLength(index + 1)
    }
    expect(cancelled).toEqual(requests.map((value) => value.id))
    const fresh = transport.request("session.list")
    await flush()
    agent.result(agent.dispatches.at(-1)!, { data: { data: [], cursor: {} } })
    await flush()
    expect(await fresh).toEqual({ status: "ok", value: { data: { data: [], cursor: {} } } })
    expect(requests.filter((value) => value.operation === "session.interrupt")).toHaveLength(1)
    expect(closes).toEqual([])
  } finally {
    transport.close()
    relay.detach("browser")
  }
})
