import { expect, spyOn, test } from "bun:test"
import { base64UrlEncode } from "../src/auth/crypto"
import { deriveWebPushKeys } from "../src/push/crypto"
import { sendPushToOwner } from "../src/push/send"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createRelay } from "../src/relay/core"

test("Web Push sends a decryptable minimal payload with VAPID and bounded headers, tracking endpoint failure", async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(receiver instanceof Object) || !("privateKey" in receiver) || !(vapid instanceof Object) || !("privateKey" in vapid)) throw new Error("key pair unavailable")
  const receiverRaw = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))
  const subscription: PushSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/a", accountID: "usr_1",
    keys: { p256dh: base64UrlEncode(receiverRaw), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    createdAt: 1, failures: 0 }
  const failures: boolean[] = []
  const store: PushStore = { list: async () => [subscription], upsert: async () => undefined,
    remove: async () => undefined, recordFailure: async (_row, permanent) => { failures.push(permanent) } }
  const requests: Request[] = []
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? ""
  const send = () => sendPushToOwner({ store, accountID: "usr_1", event: { category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1" },
    publicKey, privateKey, subject: "mailto:push@example.invalid", now: () => 1_700_000_000_000,
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
  const body = new Uint8Array(await request.arrayBuffer())
  const salt = body.slice(0, 16)
  const sender = body.slice(21, 86)
  const senderPublic = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderPublic }, receiver.privateKey, 256))
  const auth = Uint8Array.from(atob(subscription.keys.auth.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0))
  const { cek, nonce } = await deriveWebPushKeys(shared, auth, receiverRaw, sender, salt)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)))
  expect(plaintext.at(-1)).toBe(2)
  expect(JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1)))).toEqual({ category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1" })
  expect(failures).toEqual([])
  await send()
  expect(failures).toEqual([true])
})

test("relay status diff drives an encrypted push without delaying frame forwarding", async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(receiver instanceof Object) || !("privateKey" in receiver) || !(vapid instanceof Object) || !("privateKey" in vapid)) throw new Error("key pair unavailable")
  const receiverRaw = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))
  const subscription: PushSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/relay", accountID: "usr_1",
    keys: { p256dh: base64UrlEncode(receiverRaw), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) }, createdAt: 1, failures: 0 }
  const store: PushStore = { list: async () => [subscription], upsert: async () => undefined,
    remove: async () => undefined, recordFailure: async () => undefined }
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? ""
  const requests: Request[] = []
  const pending: Promise<void>[] = []
  const frames: string[] = []
  const relay = createRelay({ now: () => 1_700_000_000_000, newID: () => "r1", send: (_id, frame) => frames.push(frame),
    close: () => undefined, saveSubscriptions: () => undefined, savePending: () => undefined,
    loadStatus: async () => undefined, saveStatus: async () => undefined,
    authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }), authorityTtlMs: 0,
    notifyPush: (accountID, event) => { pending.push(sendPushToOwner({ store, accountID, event,
      publicKey, privateKey, subject: "mailto:push@example.invalid", now: () => 1_700_000_000_000,
      fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response(null, { status: 201 }) } })) },
  })
  await relay.attach({ connectionID: "agent", role: "agent", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "dev_1",
    credentialExpiresAt: 1_800_000_000_000, subscriptions: [], pending: [] })
  await relay.attach({ connectionID: "client", role: "client", ownerID: "usr_1", deviceID: "dev_1", browserSessionID: "bs_1",
    credentialExpiresAt: 1_800_000_000_000, subscriptions: [], pending: [] })
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: [] }))
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "status", running: [], attention: ["ses_1"] }))
  expect(frames.some((frame) => frame.includes('"attention":["ses_1"]'))).toBe(true)
  await Promise.all(pending)
  expect(requests).toHaveLength(1)
  const body = new Uint8Array(await requests[0].arrayBuffer())
  const sender = body.slice(21, 86)
  const publicSender = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicSender }, receiver.privateKey, 256))
  const auth = Uint8Array.from(atob(subscription.keys.auth.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0))
  const { cek, nonce } = await deriveWebPushKeys(shared, auth, receiverRaw, sender, body.slice(0, 16))
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)))
  expect(JSON.parse(new TextDecoder().decode(clear.slice(0, -1)))).toEqual({ category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1" })
})

test("push attempts report only category, service host, target count, and response or error class", async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const endpoint = "https://fcm.googleapis.com/fcm/send/private-token"
  const subscription: PushSubscription = { endpoint, accountID: "usr_private", keys: {
    p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  }, createdAt: 1, failures: 0 }
  const outcomes: string[] = []
  const info = spyOn(console, "info").mockImplementation((line: string) => { outcomes.push(line) })
  let sends = 0
  try {
    const input = { store: { list: async () => [subscription], upsert: async () => {}, remove: async () => {}, recordFailure: async () => {} },
      accountID: subscription.accountID, event: { category: "agent-completed" as const, sessionID: "ses_private", deviceID: "dev_private" },
      publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
      privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? "", subject: "mailto:push@example.invalid", now: Date.now,
      fetch: Object.assign(async () => { sends++; if (sends === 2) throw new Error("private failure detail"); return new Response(null, { status: 201 }) }, { preconnect: fetch.preconnect }),
    }
    await sendPushToOwner(input)
    await sendPushToOwner(input)
    await sendPushToOwner({ ...input, store: { ...input.store, list: async () => [] } })
  } finally { info.mockRestore() }
  expect(outcomes.map((line) => JSON.parse(line))).toEqual([
    { component: "web-push", category: "agent-completed", host: "fcm.googleapis.com", targetCount: 1, status: 201 },
    { component: "web-push", category: "agent-completed", host: "fcm.googleapis.com", targetCount: 1, errorClass: "delivery_error" },
    { component: "web-push", category: "agent-completed", host: "none", targetCount: 0, errorClass: "no_subscriptions" },
  ])
  expect(outcomes.join(" ")).not.toMatch(/private|fcm\/send|mailto:|p256dh|auth|token/i)
})
