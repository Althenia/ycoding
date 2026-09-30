import { createD1AuthStore } from "../../src/auth/d1-store"
import { base64UrlEncode } from "../../src/auth/crypto"
import { createAuthService } from "../../src/auth/service"
import { deriveWebPushKeys } from "../../src/push/crypto"
import { createD1PushStore } from "../../src/push/d1-store"
import { sendPushToOwner, type PushEvent } from "../../src/push/send"
import { createRouter } from "../../src/router"
import { migratedDatabase, sqliteD1 } from "./d1-sqlite"
import { testEndpoints } from "./google"

const origin = "https://relay.test"

export type PushService = (endpoint: string, payload: () => Promise<unknown>) => Promise<number>

export async function createPushServer(pushService: PushService) {
  const sqlite = await migratedDatabase()
  const db = sqliteD1(sqlite)
  const service = createAuthService(createD1AuthStore(db))
  const store = createD1PushStore(db)
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!("privateKey" in vapid)) throw new Error("VAPID key pair unavailable")
  const keys = { publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
    privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? "", subject: "mailto:push@example.invalid" }
  const receivers = new Map<string, (body: Uint8Array) => Promise<unknown>>()
  const send = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = new Uint8Array(await request.arrayBuffer())
    const decrypt = receivers.get(request.url)
    const status = await pushService(request.url, async () => decrypt === undefined ? undefined : decrypt(body))
    if (status === 0) throw new Error("Synthetic push service is unreachable")
    return new Response(null, { status })
  }, { preconnect: globalThis.fetch.preconnect })
  const router = createRouter({ service, relay: { getByName: () => ({ fetch: async () => new Response() }) }, endpoints: testEndpoints(),
    allowedEmails: new Set(), fetch: send, push: { store, ...keys } })
  const account = await service.signIn({ provider: "google", subject: "push-server-owner" })
  return {
    accountID: account.userID,
    signIn: () => service.signIn({ provider: "google", subject: "push-server-owner" }),
    receiver: async (endpoint: string) => {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
      if (!("privateKey" in pair)) throw new Error("ECDH key pair unavailable")
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
      const auth = crypto.getRandomValues(new Uint8Array(16))
      receivers.set(endpoint, async (body) => {
        const sender = body.slice(21, 86)
        const senderKey = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
        const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, pair.privateKey, 256))
        const derived = await deriveWebPushKeys(shared, auth, raw, sender, body.slice(0, 16))
        const key = await crypto.subtle.importKey("raw", derived.cek, "AES-GCM", false, ["decrypt"])
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: derived.nonce }, key, body.slice(86)))
        return JSON.parse(new TextDecoder().decode(plain.slice(0, -1))) as unknown
      })
      return { endpoint, p256dh: raw, auth }
    },
    route: (token: string, path: string, init: { readonly method: string; readonly body?: string }) =>
      router(new Request(`${origin}${path}`, { method: init.method, body: init.body,
        headers: { cookie: `yc_session=${token}`, origin, "content-type": "application/json" } })),
    notify: (accountID: string, event: PushEvent) => sendPushToOwner({ store, accountID, event, ...keys, now: Date.now, fetch: send }),
    owners: async () => (await store.list(account.userID)).map((row) => [row.endpoint, row.browserSessionID]),
    close: () => sqlite.close(),
  }
}
