import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import { parseRelayToAgentMessage, parseRelayToClientMessage, type RemoteQuota } from "../../../packages/remote/src/index"
import { base64UrlEncode } from "../src/auth/crypto"
import { deriveWebPushKeys } from "../src/push/crypto"
import { sendPush, sendPushToOwner } from "../src/push/send"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createRelay, type RelayConnection } from "../src/relay/core"
import { createNoticeStore } from "../src/relay/notice-store"
import { createQuotaClaims, type QuotaClaimStorage } from "../src/relay/quota-claims"
import { createNoticeStorage } from "./notice-storage"

const start = 1_800_000_000_000
const quota: RemoteQuota = { providerID: "anthropic", windowID: "five-hour", milestone: "will-run-out", resetAt: start + 1_800_000 }
const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": true }
const frame = (value: RemoteQuota = quota) => JSON.stringify({ type: "quota", ...value })

type Receiver = { readonly subscription: PushSubscription; readonly decrypt: (request: Request) => Promise<unknown> }

async function receiver(accountID: string, browserSessionID: string, categories = allOn): Promise<Receiver> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!("privateKey" in pair)) throw new Error("key pair unavailable")
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const subscription: PushSubscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${browserSessionID}`, accountID, browserSessionID,
    keys: { p256dh: base64UrlEncode(raw), auth: base64UrlEncode(auth) }, categories, createdAt: 1, failures: 0 }
  return { subscription, decrypt: async (request) => {
    const body = new Uint8Array(await request.clone().arrayBuffer())
    const sender = body.slice(21, 86)
    const senderKey = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, pair.privateKey, 256))
    const derived = await deriveWebPushKeys(shared, auth, raw, sender, body.slice(0, 16))
    const key = await crypto.subtle.importKey("raw", derived.cek, "AES-GCM", false, ["decrypt"])
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: derived.nonce }, key, body.slice(86)))
    return JSON.parse(new TextDecoder().decode(plain.slice(0, -1))) as unknown
  } }
}

function memoryKv(): QuotaClaimStorage {
  const values = new Map<string, string>()
  return {
    get: <Value>(key: string) => { const value = values.get(key); return value === undefined ? undefined : JSON.parse(value) as Value },
    put: (key, value) => { values.set(key, JSON.stringify(value)) },
    delete: (key) => values.delete(key),
    list: <Value>(options?: { readonly prefix?: string }) => Array.from(values).filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
      .map(([key, value]): [string, Value] => [key, JSON.parse(value) as Value]),
  }
}

async function world() {
  let now = start
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!("privateKey" in vapid)) throw new Error("VAPID key pair unavailable")
  const keys = { publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
    privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? "", subject: "mailto:push@example.invalid" }
  const receivers = new Map<string, Receiver>()
  const accounts = new Map<string, string[]>()
  const claimStorage = new Map<string, QuotaClaimStorage>()
  const posts: { readonly browser: string; readonly request: Request }[] = []
  const answers = new Map<string, () => Promise<Response>>()
  const state = { coordinator: true, pushThrows: false }
  const store = (accountID: string): PushStore => ({ list: async () => (accounts.get(accountID) ?? []).flatMap((id) => receivers.get(id)?.subscription ?? []),
    upsert: async () => true, renew: async () => "missing", remove: async () => undefined, claimTest: async () => ({ status: "missing" }),
    recordFailure: async () => undefined, recordSuccess: async () => undefined })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const browser = request.url.split("/").at(-1) ?? ""
    posts.push({ browser, request })
    return answers.get(browser)?.() ?? new Response(null, { status: 201 })
  }
  const claims = (ownerID: string) => {
    const storage = claimStorage.get(ownerID) ?? memoryKv()
    claimStorage.set(ownerID, storage)
    return createQuotaClaims(storage, () => now)
  }

  const relay = async (ownerID: string, deviceID: string, tabs: readonly string[] = []) => {
    const frames: { readonly connectionID: string; readonly frame: string }[] = []
    const closed: { readonly connectionID: string; readonly code: number }[] = []
    const database = new Database(":memory:")
    const value = createRelay({ now: () => now, newID: () => crypto.randomUUID(), send: (connectionID, message) => frames.push({ connectionID, frame: message }),
      close: (connectionID, code) => closed.push({ connectionID, code }), saveSubscriptions: () => undefined, savePending: () => undefined,
      savePriority: () => undefined, loadStatus: async () => undefined, saveStatus: async () => undefined,
      loadOfflineCheck: async () => undefined, saveOfflineCheck: async () => undefined,
      notices: createNoticeStore(createNoticeStorage(database)), saveNoticeSubscription: () => undefined,
      authorizeClientCommand: async () => ({ ok: true }), authorizeAgentCommand: async () => ({ ok: true }), authorityTtlMs: 0,
      notifyPush: (accountID, event) => sendPushToOwner({ store: store(accountID), accountID, event, ...keys, now: () => now, fetch }),
      quota: {
        subscriptions: async (owner) => store(owner).list(owner),
        reserve: async (owner, key, until, members) => {
          if (!state.coordinator) throw new Error("coordinator unavailable")
          return claims(owner).reserve(key, until, members)
        },
        release: async (owner, key, members) => claims(owner).release(key, members),
        push: (owner, event, subscriptions) => {
          if (state.pushThrows) return Promise.reject(new Error("digest unavailable"))
          return sendPush({ store: store(owner), event, subscriptions, ...keys, now: () => now, fetch })
        },
      },
    })
    const connection = { ownerID, deviceID, credentialExpiresAt: start * 2, subscriptions: [], pending: [] }
    await value.attach({ ...connection, connectionID: "agent", role: "agent", browserSessionID: deviceID, noticesSubscribed: false } satisfies RelayConnection)
    for (const tab of tabs) {
      await value.attach({ ...connection, connectionID: `tab-${tab}`, role: "client", browserSessionID: tab, noticesSubscribed: false })
      await value.handleClientMessage(`tab-${tab}`, JSON.stringify({ type: "request", id: "sub", operation: "notice.subscribe" }))
    }
    frames.length = 0
    const parsed = (connectionID: string) => frames.filter((entry) => entry.connectionID === connectionID).map((entry) => JSON.parse(entry.frame) as Record<string, unknown>)
    return {
      relay: value,
      database,
      closed,
      send: async (raw: string) => { await value.handleAgentMessage("agent", raw); await value.settleDeliveries() },
      results: () => frames.filter((entry) => entry.connectionID === "agent").map((entry) => {
        const result = parseRelayToAgentMessage(entry.frame)
        if (!result.ok || result.value.type !== "quota.result") throw new Error(`unexpected agent frame ${entry.frame}`)
        return result.value.status
      }),
      quotaNotices: (tab: string) => parsed(`tab-${tab}`).filter((message) => message.type === "notice.quota"),
      presented: (tab: string) => frames.filter((entry) => entry.connectionID === `tab-${tab}` && entry.frame.includes('"notice.present"')).map((entry) => {
        const result = parseRelayToClientMessage(entry.frame)
        if (!result.ok || result.value.type !== "notice.present") throw new Error(`invalid presentation ${entry.frame}`)
        return result.value.items
      }),
    }
  }

  return {
    state,
    posts,
    answers,
    relay,
    advance: (milliseconds: number) => { now += milliseconds },
    subscribe: async (accountID: string, browser: string, categories = allOn) => {
      receivers.set(browser, await receiver(accountID, browser, categories))
      accounts.set(accountID, [...accounts.get(accountID) ?? [], browser])
    },
    quotaPosts: async (browser?: string) => {
      const decoded = await Promise.all(posts.filter((post) => browser === undefined || post.browser === browser)
        .map(async (post) => ({ post, payload: await receivers.get(post.browser)?.decrypt(post.request) })))
      return decoded.filter((entry) => typeof entry.payload === "object" && entry.payload !== null && Reflect.get(entry.payload, "category") === "quota-pace")
    },
  }
}

describe("relay quota alerts", () => {
  test("two machines of one account send one encrypted push per subscribed browser carrying only quota identity, device and reset", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_1", "bs_phone")
      const first = await value.relay("usr_1", "dev_a", ["bs_viewer"])
      const second = await value.relay("usr_1", "dev_b", ["bs_other_viewer"])
      await first.send(frame())
      await second.send(frame({ ...quota, resetAt: quota.resetAt + 1_000 }))
      const posts = await value.quotaPosts()
      expect(posts.map((entry) => entry.post.browser).sort()).toEqual(["bs_laptop", "bs_phone"])
      for (const entry of posts) {
        expect(entry.payload).toEqual({ category: "quota-pace", deviceID: "dev_a", ...quota })
        expect(entry.post.request.headers.get("urgency")).toBe("normal")
        expect(entry.post.request.headers.get("ttl")).toBe("1800")
        expect(entry.post.request.headers.get("topic")?.length).toBeLessThanOrEqual(32)
        expect(JSON.stringify(entry.payload)).not.toMatch(/usr_|bs_|credential|profile|email|title|body/)
      }
      expect(first.results()).toEqual(["settled"])
      expect(second.results()).toEqual(["settled"])
      expect(first.quotaNotices("bs_viewer")).toEqual([{ type: "notice.quota", ...quota, at: start }])
      expect(second.quotaNotices("bs_other_viewer")).toEqual([{ type: "notice.quota", ...quota, resetAt: quota.resetAt + 1_000, at: start }])
      expect(first.database.query("SELECT COUNT(*) AS count FROM notice").get()).toEqual({ count: 0 })
    } finally { info.mockRestore() }
  })

  test("a machine without notice subscribers consumes no live notice, so another machine's subscribed browser with System off still gets one", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_b", { ...allOn, "quota-pace": false })
      const first = await value.relay("usr_1", "dev_a")
      const second = await value.relay("usr_1", "dev_b", ["bs_b"])
      await first.send(frame())
      await second.send(frame())
      expect(second.quotaNotices("bs_b")).toHaveLength(1)
      expect(value.posts).toEqual([])
      expect(second.presented("bs_b")).toEqual([])
      expect([...first.results(), ...second.results()]).toEqual(["settled", "settled"])
    } finally { info.mockRestore() }
  })

  test("each browser gets one live notice and page alert on whichever machine reaches it first, never one per machine", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      const first = await value.relay("usr_1", "dev_a", ["bs_x", "bs_shared"])
      const second = await value.relay("usr_1", "dev_b", ["bs_y", "bs_shared"])
      await first.send(frame())
      await second.send(frame())
      await first.send(frame())
      expect([first.quotaNotices("bs_x"), first.quotaNotices("bs_shared"), second.quotaNotices("bs_y"), second.quotaNotices("bs_shared")]
        .map((notices) => notices.length)).toEqual([1, 1, 1, 0])
      expect([first.presented("bs_x"), first.presented("bs_shared"), second.presented("bs_y"), second.presented("bs_shared")]
        .map((items) => items.length)).toEqual([1, 1, 1, 0])
    } finally { info.mockRestore() }
  })

  test("a hundred duplicate frames deliver each browser at most once and answer every frame", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_1", "bs_phone")
      const machine = await value.relay("usr_1", "dev_a", ["bs_viewer"])
      await Promise.all(Array.from({ length: 100 }, () => machine.relay.handleAgentMessage("agent", frame())))
      await machine.relay.settleDeliveries()
      expect((await value.quotaPosts()).map((entry) => entry.post.browser).sort()).toEqual(["bs_laptop", "bs_phone"])
      expect(machine.results()).toEqual(Array.from({ length: 100 }, () => "settled"))
      expect(machine.quotaNotices("bs_viewer")).toHaveLength(1)
      expect(machine.presented("bs_viewer")).toEqual([[{ kind: "quota", ...quota }]])
    } finally { info.mockRestore() }
  })

  test("another account's identical alert is delivered to its own browsers only", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_2", "bs_stranger")
      await (await value.relay("usr_1", "dev_a")).send(frame())
      const other = await value.relay("usr_2", "dev_z")
      await other.send(frame())
      const posts = await value.quotaPosts()
      expect(posts.map((entry) => [entry.post.browser, Reflect.get(entry.payload as object, "deviceID")]).sort()).toEqual([["bs_laptop", "dev_a"], ["bs_stranger", "dev_z"]])
      expect(other.results()).toEqual(["settled"])
    } finally { info.mockRestore() }
  })

  test("a different reset minute or milestone is a distinct alert", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.relay("usr_1", "dev_a")
      await machine.send(frame())
      await machine.send(frame({ ...quota, resetAt: quota.resetAt + 60_000 }))
      await machine.send(frame({ ...quota, milestone: "almost-out" }))
      await machine.send(frame({ ...quota, milestone: "almost-out" }))
      expect((await value.quotaPosts()).map((entry) => [Reflect.get(entry.payload as object, "milestone"), Reflect.get(entry.payload as object, "resetAt")])).toEqual([
        ["will-run-out", quota.resetAt], ["will-run-out", quota.resetAt + 60_000], ["almost-out", quota.resetAt]])
    } finally { info.mockRestore() }
  })

  test("a browser whose quota System alert is off gets neither a push nor a page alert, and a browser without push is presented once", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop", { ...allOn, "quota-pace": false })
      await value.subscribe("usr_1", "bs_phone")
      const machine = await value.relay("usr_1", "dev_a", ["bs_laptop", "bs_tab"])
      await machine.send(frame())
      await machine.send(frame())
      expect(value.posts.filter((post) => post.browser === "bs_laptop")).toEqual([])
      expect((await value.quotaPosts()).map((entry) => entry.post.browser)).toEqual(["bs_phone"])
      expect(machine.presented("bs_laptop")).toEqual([])
      expect(machine.presented("bs_tab")).toEqual([[{ kind: "quota", ...quota }]])
      expect(machine.quotaNotices("bs_laptop")).toHaveLength(1)
      expect(machine.quotaNotices("bs_tab")).toHaveLength(1)
      expect(machine.results()).toEqual(["settled", "settled"])
    } finally { info.mockRestore() }
  })

  test("a quota alert beyond the twenty-a-minute push budget stays pending and a later retry delivers it", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.relay("usr_1", "dev_a")
      await machine.send(JSON.stringify({ type: "status", running: [], attention: [] }))
      await machine.send(JSON.stringify({ type: "status", running: [], attention: Array.from({ length: 20 }, (_, index) => `ses_${index}`) }))
      const before = value.posts.length
      expect(before).toBe(20)
      await machine.send(frame())
      expect(value.posts).toHaveLength(before)
      expect(machine.results()).toEqual(["pending"])
      value.advance(60_000)
      await machine.send(frame())
      expect((await value.quotaPosts()).map((entry) => entry.post.browser)).toEqual(["bs_laptop"])
      expect(machine.results()).toEqual(["pending", "settled"])
    } finally { info.mockRestore() }
  })

  test("quota frames from a browser, or carrying owner, device or account fields, are rejected without delivery", async () => {
    const value = await world()
    await value.subscribe("usr_1", "bs_laptop")
    const machine = await value.relay("usr_1", "dev_a", ["bs_viewer"])
    await machine.relay.handleClientMessage("tab-bs_viewer", frame())
    for (const forged of [{ ownerID: "usr_2" }, { deviceID: "dev_forged" }, { accountID: "acct" }])
      await machine.relay.handleAgentMessage("agent", JSON.stringify({ type: "quota", ...quota, ...forged }))
    await machine.relay.settleDeliveries()
    expect(value.posts).toEqual([])
    expect(machine.closed.map((entry) => entry.connectionID)).toEqual(["tab-bs_viewer", "agent", "agent", "agent"])
    expect(machine.results()).toEqual([])
  })

  test("an unavailable claim coordinator leaves the alert pending with no push, page alert or live notice", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.relay("usr_1", "dev_a", ["bs_viewer"])
      value.state.coordinator = false
      await machine.send(frame())
      expect(value.posts).toEqual([])
      expect(machine.quotaNotices("bs_viewer")).toEqual([])
      expect(machine.presented("bs_viewer")).toEqual([])
      value.state.coordinator = true
      await machine.send(frame())
      expect((await value.quotaPosts()).map((entry) => entry.post.browser)).toEqual(["bs_laptop"])
      expect(machine.results()).toEqual(["pending", "settled"])
    } finally { info.mockRestore() }
  })

  test("a browser's attempt is recorded before its uncertain send, so a restarted relay or another machine never repeats it", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_1", "bs_phone")
      const hang = Promise.withResolvers<Response>()
      value.answers.set("bs_laptop", () => hang.promise)
      const crashed = await value.relay("usr_1", "dev_a")
      const abandoned = crashed.relay.handleAgentMessage("agent", frame())
      while (value.posts.length < 2) await Bun.sleep(1)
      const restarted = await value.relay("usr_1", "dev_a", ["bs_laptop"])
      await restarted.send(frame())
      const other = await value.relay("usr_1", "dev_b", ["bs_laptop"])
      await other.send(frame())
      expect(value.posts.map((post) => post.browser).sort()).toEqual(["bs_laptop", "bs_phone"])
      expect(restarted.results()).toEqual(["settled"])
      expect(other.results()).toEqual(["settled"])
      expect(restarted.presented("bs_laptop")).toEqual([])
      expect(other.presented("bs_laptop")).toEqual([])
      hang.resolve(new Response(null, { status: 201 }))
      await abandoned
    } finally { info.mockRestore() }
  })

  test("a definite push rejection is not retried, and a send that fails before any request releases its browsers", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.relay("usr_1", "dev_a")
      value.state.pushThrows = true
      await machine.send(frame())
      expect(value.posts).toEqual([])
      value.state.pushThrows = false
      value.answers.set("bs_laptop", async () => new Response(null, { status: 503 }))
      await machine.send(frame())
      await machine.send(frame())
      expect(value.posts.map((post) => post.browser)).toEqual(["bs_laptop"])
      expect(machine.results()).toEqual(["pending", "settled", "settled"])
    } finally { info.mockRestore() }
  })

  test("an alert whose reset has passed settles without delivery", async () => {
    const value = await world()
    await value.subscribe("usr_1", "bs_laptop")
    const machine = await value.relay("usr_1", "dev_a", ["bs_viewer"])
    await machine.send(frame({ ...quota, resetAt: start }))
    expect(value.posts).toEqual([])
    expect(machine.quotaNotices("bs_viewer")).toEqual([])
    expect(machine.results()).toEqual(["settled"])
  })
})
