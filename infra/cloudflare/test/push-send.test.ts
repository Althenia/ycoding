import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { base64UrlEncode } from "../src/auth/crypto"
import { deriveWebPushKeys } from "../src/push/crypto"
import { sendPushToOwner, sendTestPush } from "../src/push/send"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createRelay } from "../src/relay/core"
import { createNoticeStore } from "../src/relay/notice-store"

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }

async function receiverFor(endpoint: string, categories = allOn) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(pair instanceof Object) || !("privateKey" in pair)) throw new Error("key pair unavailable")
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const subscription: PushSubscription = { endpoint, accountID: "usr_1", keys: { p256dh: base64UrlEncode(raw), auth: base64UrlEncode(auth) },
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

function memoryStore(rows: readonly PushSubscription[], failures: [string, boolean][] = []): PushStore {
  return { list: async () => rows, upsert: async () => undefined, renew: async () => false, remove: async () => undefined,
    claimTest: async () => ({ status: "missing" }), recordFailure: async (row, permanent) => { failures.push([row.endpoint, permanent]) } }
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
  await deliver({ category: "agent-completed", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" })
  expect(requests.map((request) => request.url)).toEqual(["https://fcm.googleapis.com/fcm/send/windows"])
  expect(requests[0]?.headers.get("ttl")).toBe("600")
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

test("relay status diff drives an encrypted push that names its stored notice without delaying frame forwarding", async () => {
  const receiver = await receiverFor("https://fcm.googleapis.com/fcm/send/relay")
  const keys = await vapidKeys()
  const requests: Request[] = []
  const pending: Promise<void>[] = []
  const frames: string[] = []
  const database = new Database(":memory:")
  const relay = createRelay({ now: () => 1_700_000_000_000, newID: () => "r1", send: (_id, frame) => frames.push(frame),
    close: () => undefined, saveSubscriptions: () => undefined, savePending: () => undefined,
    loadStatus: async () => undefined, saveStatus: async () => undefined,
    loadOfflineCheck: async () => undefined, saveOfflineCheck: async () => undefined,
    notices: createNoticeStore({ exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...(bindings as never[])) }) }),
    saveNoticeSubscription: () => undefined,
    authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }), authorityTtlMs: 0,
    notifyPush: (accountID, event) => { pending.push(sendPushToOwner({ store: memoryStore([receiver.subscription]), accountID, event, ...keys,
      fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 201 }) } })) },
  })
  await relay.attach({ connectionID: "agent", role: "agent", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "dev_1",
    credentialExpiresAt: 1_800_000_000_000, subscriptions: [], noticesSubscribed: false, pending: [] })
  await relay.attach({ connectionID: "client", role: "client", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "bs_1",
    credentialExpiresAt: 1_800_000_000_000, subscriptions: [], noticesSubscribed: false, pending: [] })
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: [] }))
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: ["ses_1"] }))
  expect(frames.some((frame) => frame.includes('"attention":["ses_1"]'))).toBe(true)
  await Promise.all(pending)
  expect(requests).toHaveLength(1)
  expect(await receiver.decrypt(requests[0] as Request)).toEqual({ category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1", noticeID: "ntc_1" })
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
