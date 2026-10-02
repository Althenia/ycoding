import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { base64UrlEncode } from "../src/auth/crypto"
import { deriveWebPushKeys } from "../src/push/crypto"
import { pushDeliveryTimeoutMs, sendPushToOwner, sendTestPush } from "../src/push/send"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createRelay } from "../src/relay/core"
import { createNoticeStore } from "../src/relay/notice-store"
import { createNoticeStorage } from "./notice-storage"

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }

async function receiverFor(endpoint: string, categories = allOn, browserSessionID = `bs_${endpoint.split("/").at(-1)}`) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(pair instanceof Object) || !("privateKey" in pair)) throw new Error("key pair unavailable")
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const subscription: PushSubscription = { endpoint, accountID: "usr_1", browserSessionID, keys: { p256dh: base64UrlEncode(raw), auth: base64UrlEncode(auth) },
    categories, createdAt: 1, failures: 0 }
  const decrypt = async (request: Request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer())
    const sender = body.slice(21, 86)
    const senderPublic = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderPublic }, pair.privateKey, 256))
    const { cek, nonce } = await deriveWebPushKeys(shared, auth, raw, sender, body.slice(0, 16))
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)))
    expect(plaintext.at(-1)).toBe(2)
    return JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1))) as unknown
  }
  return { subscription, decrypt }
}

async function vapidKeys() {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(vapid instanceof Object) || !("privateKey" in vapid)) throw new Error("key pair unavailable")
  return { publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
    privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? "", subject: "mailto:push@example.invalid", now: () => 1_700_000_000_000 }
}

function memoryStore(rows: readonly PushSubscription[], failures: [string, boolean][] = [], successes: string[] = []): PushStore {
  return { list: async () => rows, upsert: async () => true, renew: async () => "missing", remove: async () => undefined,
    claimTest: async () => ({ status: "missing" }), recordFailure: async (row, permanent) => { failures.push([row.endpoint, permanent]) },
    recordSuccess: async (row) => { successes.push(row.endpoint) } }
}

test("Web Push sends a decryptable minimal payload with VAPID and bounded headers, tracking endpoint failure", async () => {
  const receiver = await receiverFor("https://fcm.googleapis.com/fcm/send/a")
  const failures: [string, boolean][] = []
  const requests: Request[] = []
  const send = async () => sendPushToOwner({ store: memoryStore([receiver.subscription], failures), accountID: "usr_1",
    event: { category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_4" }, ...await vapidKeys(),
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: requests.length === 1 ? 201 : 410 })
    } })
  await send()
  expect(requests).toHaveLength(1)
  const request = requests[0]
  expect(request.headers.get("content-encoding")).toBe("aes128gcm")
  expect(request.headers.get("ttl")).toBe("3600")
  expect(request.headers.get("urgency")).toBe("high")
  expect(request.headers.get("topic")?.length).toBeLessThanOrEqual(32)
  expect(request.headers.get("authorization")).toMatch(/^vapid t=[A-Za-z0-9_.-]+, k=[A-Za-z0-9_-]+$/)
  expect(await receiver.decrypt(request)).toEqual({ category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_4" })
  expect(failures).toEqual([])
  await send()
  expect(failures).toEqual([["https://fcm.googleapis.com/fcm/send/a", true]])
})

test("each subscription receives only the categories its device turned on as System alerts", async () => {
  const windows = await receiverFor("https://fcm.googleapis.com/fcm/send/windows", { ...allOn, "machine-offline": false })
  const iphone = await receiverFor("https://web.push.apple.com/iphone", { "agent-completed": false, "approval-requested": true, "machine-offline": true })
  const requests: Request[] = []
  const deliver = (event: Parameters<typeof sendPushToOwner>[0]["event"]) => sendPushToOwner({
    store: memoryStore([windows.subscription, iphone.subscription]), accountID: "usr_1", event, ...keys,
    fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 201 }) } })
  const keys = await vapidKeys()
  expect(await deliver({ category: "agent-completed", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" })).toEqual([
    { owner: "bs_iphone", outcome: "unsent" }, { owner: "bs_windows", outcome: "accepted" },
  ])
  expect(requests.map((request) => request.url)).toEqual(["https://fcm.googleapis.com/fcm/send/windows"])
  expect(requests[0]?.headers.get("ttl")).toBe("3600")
  await deliver({ category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_2" })
  expect(requests.slice(1).map((request) => request.url).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/windows", "https://web.push.apple.com/iphone"])
  await deliver({ category: "machine-offline", deviceID: "dev_1", offlineAt: 1_790_000_000_000 })
  const offline = requests.slice(3)
  expect(offline.map((request) => request.url)).toEqual(["https://web.push.apple.com/iphone"])
  expect(await iphone.decrypt(offline[0] as Request)).toEqual({ category: "machine-offline", deviceID: "dev_1", offlineAt: 1_790_000_000_000 })
  expect(offline[0]?.headers.get("topic")?.length).toBeGreaterThan(0)
  const info = spyOn(console, "info").mockImplementation(() => undefined)
  try {
    await sendPushToOwner({ store: memoryStore([windows.subscription]), accountID: "usr_1", event: { category: "machine-offline", deviceID: "dev_1", offlineAt: 1_790_000_000_000 }, ...keys,
      fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 201 }) } })
    expect(requests).toHaveLength(4)
    expect(info.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { component: "web-push", category: "machine-offline", host: "none", targetCount: 0, errorClass: "category_off" },
    ])
  } finally { info.mockRestore() }
})

test("an accepted push clears earlier transient failures, and an overflow summary shares one push-service topic per device and category", async () => {
  const receiver = await receiverFor("https://fcm.googleapis.com/fcm/send/flaky")
  const keys = await vapidKeys()
  const successes: string[] = []
  const requests: Request[] = []
  const deliver = (subscription: PushSubscription, event: Parameters<typeof sendPushToOwner>[0]["event"]) => sendPushToOwner({
    store: memoryStore([subscription], [], successes), accountID: "usr_1", event, ...keys,
    fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 201 }) } })
  await deliver(receiver.subscription, { category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" })
  expect(successes).toEqual([])
  await deliver({ ...receiver.subscription, failures: 3 }, { category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_2" })
  expect(successes).toEqual(["https://fcm.googleapis.com/fcm/send/flaky"])
  await deliver(receiver.subscription, { category: "approval-requested", deviceID: "dev_1", overflow: 5 })
  await deliver(receiver.subscription, { category: "approval-requested", deviceID: "dev_1", overflow: 2 })
  expect(await receiver.decrypt(requests[2] as Request)).toEqual({ category: "approval-requested", deviceID: "dev_1", overflow: 5 })
  expect(requests[2]?.headers.get("topic")).toBe(requests[3]?.headers.get("topic") ?? "")
  expect(requests[2]?.headers.get("topic")).not.toBe(requests[1]?.headers.get("topic") ?? "")
})

test("a test alert goes only to the claimed subscription and reports the push service answer, never OS display", async () => {
  const receiver = await receiverFor("https://fcm.googleapis.com/fcm/send/test")
  const failures: [string, boolean][] = []
  const requests: Request[] = []
  let answer: () => Response = () => new Response(null, { status: 201 })
  const keys = await vapidKeys()
  const test = () => sendTestPush({ store: memoryStore([], failures), subscription: receiver.subscription, ...keys,
    fetch: async (input, init) => { requests.push(new Request(input, init)); return answer() } })
  expect(await test()).toEqual({ outcome: "accepted", status: 201 })
  expect(await receiver.decrypt(requests[0] as Request)).toEqual({ category: "test" })
  expect(requests[0]?.headers.get("topic")).toBeNull()
  expect(requests[0]?.headers.get("urgency")).toBe("high")
  answer = () => new Response(null, { status: 403 })
  expect(await test()).toEqual({ outcome: "rejected", status: 403 })
  answer = () => { throw new Error("offline") }
  expect(await test()).toEqual({ outcome: "unreachable" })
  answer = () => new Response(null, { status: 410 })
  expect(await test()).toEqual({ outcome: "expired", status: 410 })
  expect(failures).toEqual([["https://fcm.googleapis.com/fcm/send/test", false], ["https://fcm.googleapis.com/fcm/send/test", false],
    ["https://fcm.googleapis.com/fcm/send/test", true]])
})

test("an explicit completion receipt drives an encrypted push naming its atomic stored notice, never an idle status", async () => {
  const receiver = await receiverFor("https://fcm.googleapis.com/fcm/send/relay", allOn, "bs_1")
  const keys = await vapidKeys()
  const requests: Request[] = []
  const frames: string[] = []
  const database = new Database(":memory:")
  const relay = createRelay({ now: () => 1_700_000_000_000, newID: () => "r1", send: (_id, frame) => frames.push(frame),
    close: () => undefined, saveSubscriptions: () => undefined, savePending: () => undefined,
    loadStatus: async () => undefined, saveStatus: async () => undefined,
    loadOfflineCheck: async () => undefined, saveOfflineCheck: async () => undefined,
    notices: createNoticeStore(createNoticeStorage(database)),
    saveNoticeSubscription: () => undefined,
    authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }), authorityTtlMs: 0,
    notifyPush: (accountID, event) => sendPushToOwner({ store: memoryStore([receiver.subscription]), accountID, event, ...keys,
      fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 201 }) } }),
  })
  await relay.attach({ connectionID: "agent", role: "agent", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "dev_1",
    credentialExpiresAt: 1_800_000_000_000, subscriptions: [], noticesSubscribed: false, pending: [] })
  await relay.attach({ connectionID: "client", role: "client", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "bs_1",
    credentialExpiresAt: 1_800_000_000_000, subscriptions: [], noticesSubscribed: true, pending: [] })
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: ["ses_1"], attention: [] }))
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: [] }))
  expect(requests).toHaveLength(0)
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "completions", data: [], more: false }))
  const completed = JSON.stringify({ type: "completions", data: [{ id: "evt_completed", sessionID: "ses_1", seq: 9, created: 1000 }], more: false })
  await relay.handleAgentMessage("agent", completed)
  await relay.handleAgentMessage("agent", completed)
  expect(frames.some((frame) => frame.includes('"type":"notice.added"'))).toBe(true)
  expect(frames.some((frame) => frame.includes('"type":"completions"'))).toBe(false)
  await relay.settleDeliveries()
  expect(requests).toHaveLength(1)
  expect(frames.some((frame) => frame.includes('"type":"notice.present"'))).toBe(false)
  expect(await receiver.decrypt(requests[0] as Request)).toEqual({ category: "agent-completed", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" })
})

test("push attempts report only category, service host, target count, and response or error class", async () => {
  const receiver = await receiverFor("https://fcm.googleapis.com/fcm/send/private-token")
  const outcomes: string[] = []
  const info = spyOn(console, "info").mockImplementation((line: string) => { outcomes.push(line) })
  let sends = 0
  try {
    const input = { store: memoryStore([{ ...receiver.subscription, accountID: "usr_private" }]), accountID: "usr_private",
      event: { category: "agent-completed" as const, sessionID: "ses_private", deviceID: "dev_private", noticeID: "ntc_77" }, ...await vapidKeys(),
      fetch: Object.assign(async () => { sends++; if (sends === 2) throw new Error("private failure detail"); return new Response(null, { status: 201 }) }, { preconnect: fetch.preconnect }),
    }
    await sendPushToOwner(input)
    await sendPushToOwner(input)
    await sendPushToOwner({ ...input, store: memoryStore([]) })
    await sendTestPush({ ...input, subscription: { ...receiver.subscription, accountID: "usr_private" } })
  } finally { info.mockRestore() }
  expect(outcomes.map((line) => JSON.parse(line))).toEqual([
    { component: "web-push", category: "agent-completed", host: "fcm.googleapis.com", targetCount: 1, status: 201 },
    { component: "web-push", category: "agent-completed", host: "fcm.googleapis.com", targetCount: 1, errorClass: "delivery_error" },
    { component: "web-push", category: "agent-completed", host: "none", targetCount: 0, errorClass: "no_subscriptions" },
    { component: "web-push", category: "test", host: "fcm.googleapis.com", targetCount: 1, status: 201 },
  ])
  expect(outcomes.join(" ")).not.toMatch(/private|ntc_|ses_|dev_|fcm\/send|mailto:|p256dh|auth|token/i)
})

test("each push reports its outcome for the verified browser session that owns the subscription, keeps distinct notices apart at the push service, and never reports a network failure as a rejection", async () => {
  const accepted = await receiverFor("https://fcm.googleapis.com/fcm/send/accepted")
  const refused = await receiverFor("https://fcm.googleapis.com/fcm/send/refused")
  const gone = await receiverFor("https://fcm.googleapis.com/fcm/send/gone")
  const offline = await receiverFor("https://fcm.googleapis.com/fcm/send/offline")
  const keys = await vapidKeys()
  const topics: (string | null)[] = []
  const send = (event: Parameters<typeof sendPushToOwner>[0]["event"]) => sendPushToOwner({
    store: memoryStore([accepted.subscription, refused.subscription, gone.subscription, offline.subscription]), accountID: "usr_1", event, ...keys,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.url.endsWith("/offline")) throw new Error("network down")
      topics.push(request.url.endsWith("/accepted") ? request.headers.get("topic") : null)
      return new Response(null, { status: request.url.endsWith("/refused") ? 403 : request.url.endsWith("/gone") ? 410 : 201 })
    } })
  const info = spyOn(console, "info").mockImplementation(() => undefined)
  try {
    const outcomes = await send({ category: "agent-completed", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" })
    expect(Object.fromEntries(outcomes.map((entry) => [entry.owner, entry.outcome]))).toEqual({
      bs_accepted: "accepted", bs_refused: "rejected", bs_gone: "expired", bs_offline: "unreachable",
    })
    expect(JSON.stringify(outcomes)).not.toContain("fcm/send")
    await send({ category: "agent-completed", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_2" })
    await send({ category: "agent-completed", sessionID: "ses_1", deviceID: "dev_2", noticeID: "ntc_1" })
    const accepts = topics.filter((topic) => topic !== null)
    expect(accepts).toHaveLength(3)
    expect(new Set(accepts).size).toBe(3)
  } finally { info.mockRestore() }
})

test("a push to its owner fails only before any push request is sent, so a failure never hides a delivered push", async () => {
  const first = await receiverFor("https://fcm.googleapis.com/fcm/send/first")
  const second = await receiverFor("https://fcm.googleapis.com/fcm/send/second")
  const keys = await vapidKeys()
  const requests: string[] = []
  const event = { category: "agent-completed", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" } as const
  const send = (store: PushStore) => sendPushToOwner({ store, accountID: "usr_1", ...keys, event,
    fetch: async (input) => { requests.push(new Request(input).url); return new Response(null, { status: 201 }) } })
  await expect(send({ ...memoryStore([]), list: async () => { throw new Error("subscription list unavailable") } })).rejects.toThrow("subscription list unavailable")
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  const spy = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    if (new TextDecoder().decode(data instanceof ArrayBuffer ? data : data.buffer).endsWith(":agent-completed")) throw new Error("digest unavailable")
    return digest(algorithm, data)
  })
  const info = spyOn(console, "info").mockImplementation(() => undefined)
  try {
    await expect(send(memoryStore([first.subscription, second.subscription]))).rejects.toThrow("digest unavailable")
    await Bun.sleep(50)
    expect(requests).toEqual([])
  } finally {
    spy.mockRestore()
    info.mockRestore()
  }
})

test("a push service that never answers is abandoned at the delivery deadline as unreachable, once, and every open browser's page still presents the alert", async () => {
  const hung = await receiverFor("https://fcm.googleapis.com/fcm/send/hung", allOn, "bs_hung")
  const refused = await receiverFor("https://fcm.googleapis.com/fcm/send/refused", allOn, "bs_refused")
  const keys = await vapidKeys()
  const calls: string[] = []
  const aborts: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input).url
    calls.push(url)
    if (url.endsWith("/refused")) return new Response(null, { status: 403 })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborts.push(init.signal?.reason instanceof Error ? init.signal.reason.name : "unknown")
        reject(init.signal?.reason)
      })
    })
  }
  const failures: [string, boolean][] = []
  const frames: { connectionID: string; frame: string }[] = []
  const relay = createRelay({ now: () => 1_700_000_000_000, newID: () => "r1", send: (connectionID, frame) => frames.push({ connectionID, frame }),
    close: () => undefined, saveSubscriptions: () => undefined, savePending: () => undefined,
    loadStatus: async () => undefined, saveStatus: async () => undefined,
    loadOfflineCheck: async () => undefined, saveOfflineCheck: async () => undefined,
    notices: createNoticeStore(createNoticeStorage(new Database(":memory:"))), saveNoticeSubscription: () => undefined,
    authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }), authorityTtlMs: 0,
    notifyPush: (accountID, event) => sendPushToOwner({ store: memoryStore([hung.subscription, refused.subscription], failures), accountID, event, ...keys, fetch }),
  })
  const connection = { ownerID: "usr_1", deviceID: "dev_1", credentialExpiresAt: 1_800_000_000_000, subscriptions: [], noticesSubscribed: true, pending: [] }
  await relay.attach({ ...connection, connectionID: "agent", role: "agent", browserSessionID: "dev_1", noticesSubscribed: false })
  for (const browser of ["hung", "refused", "none"]) await relay.attach({ ...connection, connectionID: `tab-${browser}`, role: "client", browserSessionID: `bs_${browser}` })
  const info = spyOn(console, "info").mockImplementation(() => undefined)
  try {
    await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: [] }))
    const started = performance.now()
    await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: ["ses_a"] }))
    const [admin] = await Promise.all([sendTestPush({ store: memoryStore([], failures), subscription: hung.subscription, ...keys, fetch }), relay.settleDeliveries()])
    const elapsed = performance.now() - started
    expect(pushDeliveryTimeoutMs).toBe(10_000)
    expect(elapsed).toBeGreaterThanOrEqual(pushDeliveryTimeoutMs - 50)
    expect(elapsed).toBeLessThan(pushDeliveryTimeoutMs + 3_000)
    expect(admin).toEqual({ outcome: "unreachable" })
    expect(aborts).toEqual(["TimeoutError", "TimeoutError"])
    expect(calls.sort()).toEqual(["https://fcm.googleapis.com/fcm/send/hung", "https://fcm.googleapis.com/fcm/send/hung", "https://fcm.googleapis.com/fcm/send/refused"])
    const presented = (connectionID: string) => frames.filter((entry) => entry.connectionID === connectionID && entry.frame.includes('"type":"notice.present"')).length
    expect([presented("tab-hung"), presented("tab-refused"), presented("tab-none")]).toEqual([1, 1, 1])
    expect(failures.filter(([endpoint]) => endpoint.endsWith("/hung"))).toEqual([["https://fcm.googleapis.com/fcm/send/hung", false], ["https://fcm.googleapis.com/fcm/send/hung", false]])
  } finally { info.mockRestore() }
}, 20_000)
