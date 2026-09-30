import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createNoticeStore } from "../../../infra/cloudflare/src/relay/notice-store"
import { createNoticeStorage } from "../../../infra/cloudflare/test/notice-storage"
import { sendPushToOwner } from "../../../infra/cloudflare/src/push/send"
import { base64UrlEncode } from "../../../infra/cloudflare/src/auth/crypto"
import { RemoteAgent, type ConnectionInput } from "../src/remote-bridge"
import { createLocalServer, type LocalEventStream } from "../src/remote-local"

async function until(check: () => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the relay")
    await Bun.sleep(10)
  }
}

test("a fast 2355-delta provider stream preserves explicit completion push without an idle alert", async () => {
  const sessionID = "ses_burst"
  const closes: { code: number; reason: string }[] = []
  const pushes: string[] = []
  const pushRequests: Request[] = []
  const pushSends: Promise<unknown>[] = []
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? ""
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/burst-test", accountID: "usr_1", browserSessionID: "bs_0",
    keys: { p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))),
      auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true }, createdAt: 1, failures: 0 }
  const clientEvents = [0, 0, 0]
  let stream: LocalEventStream | undefined
  let running = true
  let attention = false
  let outstanding = false
  let completed = false
  let status: { type: "status"; running: string[]; attention: string[]; outstanding?: string[] } | undefined
  let input: ConnectionInput | undefined
  let connected = false
  const database = new Database(":memory:")
  const relay = createRelay({
    now: Date.now,
    newID: () => crypto.randomUUID(),
    send: (id, frame) => {
      if (id === "agent") input && JSON.parse(frame).type === "subscriptions" && handler?.(JSON.parse(frame))
      const index = Number(id.replace("client-", ""))
      const parsed = JSON.parse(frame)
      if (parsed.type === "events" && index >= 0 && index < clientEvents.length) clientEvents[index] += parsed.events.length
    },
    close: (id, code, reason) => {
      if (id !== "agent") return
      closes.push({ code, reason })
      connected = false
      input?.onClose(code, reason)
    },
    saveSubscriptions: () => {}, savePriority: () => {}, savePending: () => {},
    notices: createNoticeStore(createNoticeStorage(database)),
    saveNoticeSubscription: () => {},
    loadStatus: async () => status,
    loadOfflineCheck: async () => undefined,
    saveOfflineCheck: async () => {},
    saveStatus: async (value) => { status = { type: "status", running: [...value.running], attention: [...value.attention],
      ...(value.outstanding === undefined ? {} : { outstanding: [...value.outstanding] }) } },
    authorizeClientCommand: async () => ({ ok: true }),
    authorizeAgentCommand: async () => ({ ok: true }),
    authorityTtlMs: 60_000,
    notifyPush: (accountID, event) => {
      pushes.push(event.category)
      const sent = sendPushToOwner({
        store: { list: async () => [subscription], upsert: async () => true, renew: async () => "missing", remove: async () => {},
          claimTest: async () => ({ status: "missing" }), recordFailure: async () => {} },
        accountID, event, publicKey, privateKey, subject: "mailto:push@example.invalid", now: Date.now,
        fetch: Object.assign(async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          pushRequests.push(new Request(url, init))
          return new Response(null, { status: 201 })
        }, { preconnect: fetch.preconnect }),
      })
      pushSends.push(sent)
      return sent
    },
  })
  let handler: ((frame: unknown) => void) | undefined
  const local = Object.assign(createLocalServer({ url: "http://127.0.0.1:1" }), {
    listPage: async () => ({ data: [{ id: sessionID, title: "Burst", projectID: "prj_burst", time: { created: 1, updated: 1 }, location: { directory: "/work" } }] }),
    activeSessions: async () => running ? { [sessionID]: { type: "running" } } : {},
    outstandingSessions: async () => ({ data: outstanding || running ? [sessionID] : [], running: running ? [sessionID] : [], failed: [] }),
    completions: async () => ({ data: completed ? [{ id: "evt_burst_complete", seq: 25, created: Date.now(), sessionID, inputID: "msg_burst_input", assistantMessageID: "msg_burst_final" }] : [] }),
    permissionRequests: async () => attention ? [{ sessionID }] : [], formRequests: async () => [], guardrailRequestList: async () => [],
    events: async (value: LocalEventStream) => { stream = value; return async () => {} },
  })
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example", local,
    credentials: async () => ({ accessToken: "test", accessExpiresAt: Date.now() + 300_000 }),
    refreshIntervalMs: 3_600_000,
    createConnection: (value) => {
      input = value
      return {
        connect: async () => {
          await relay.attach({ connectionID: "agent", role: "agent", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "dev_1", credentialExpiresAt: Date.now() + 300_000, subscriptions: [], noticesSubscribed: false, pending: [] })
          connected = true
          value.onOpen()
        },
        send: async (frame) => {
          if (!connected) throw new Error("closed")
          await relay.handleAgentMessage("agent", frame)
        },
        onMessage: (value) => { handler = value },
        disconnect: async () => { connected = false; relay.detach("agent") },
      }
    },
  })
  try {
    await bridge.connect()
    await until(() => status?.running.includes(sessionID) === true && stream !== undefined)
    for (let index = 0; index < clientEvents.length; index++)
      await relay.attach({ connectionID: `client-${index}`, role: "client", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: `bs_${index}`, credentialExpiresAt: Date.now() + 300_000, subscriptions: [sessionID], noticesSubscribed: false, pending: [] })
    const deltas = 2_355
    for (let index = 0; index < deltas; index++)
      stream?.onEvent({ type: "session.text.delta", data: { sessionID, assistantMessageID: "msg_burst_final", ordinal: 0, delta: "x" } })
    await until(() => closes.length > 0 || clientEvents[0] === deltas, 90_000)
    attention = true
    stream?.onEvent({ type: "permission.v2.requested", data: { sessionID } })
    await until(() => pushes.includes("approval-requested"))
    attention = false
    stream?.onEvent({ type: "permission.v2.replied", data: { sessionID } })
    await until(() => status?.attention.length === 0)
    outstanding = true
    running = false
    stream?.onEvent({ type: "session.execution.succeeded", data: { sessionID } })
    await until(() => status?.running.length === 0 && status.outstanding?.includes(sessionID) === true)
    expect(pushes).toEqual(["approval-requested"])
    outstanding = false
    stream?.onEvent({ type: "session.shell.ended", data: { sessionID } })
    await until(() => status?.outstanding === undefined && status?.running.length === 0)
    expect(pushes).toEqual(["approval-requested"])
    completed = true
    stream?.onEvent({ type: "session.work.completed", data: { sessionID, inputID: "msg_burst_input", assistantMessageID: "msg_burst_final" } })
    await until(() => pushes.length === 2)
    expect(closes).toEqual([])
    expect(clientEvents).toEqual([deltas + 5, deltas + 5, deltas + 5])
    expect(pushes).toEqual(["approval-requested", "agent-completed"])
    await Promise.all(pushSends)
    expect(pushRequests).toHaveLength(2)
    expect(pushRequests.map((request) => request.headers.get("ttl")).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["3600", "600"])
  } finally {
    await bridge.close()
    database.close()
  }
}, 100_000)
