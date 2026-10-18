import { describe, expect, spyOn, test } from "bun:test"
import { ControlSchema, LedgerClass, QuotaPaceStatus, create, decodeLossless } from "../../../packages/protocol/src/v5"
import type { Frame, QuotaPace } from "../../../packages/protocol/src/v5"
import { frameReservation, quotaToWire } from "../../../packages/remote/src/index"
import type { RemoteQuota } from "../../../packages/remote/src/index"
import { base64UrlEncode } from "../src/auth/crypto"
import { deriveWebPushKeys } from "../src/push/crypto"
import { sendPush, sendPushToOwner } from "../src/push/send"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createQuotaClaims } from "../src/relay/quota-claims"
import type { QuotaClaimStorage } from "../src/relay/quota-claims"
import { harness } from "./support/relay"

const start = 1_000
const quota: RemoteQuota = { providerID: "anthropic", windowID: "five-hour", milestone: "will-run-out", resetAt: start + 1_800_000 }
const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": true }

type Receiver = { readonly subscription: PushSubscription; readonly decrypt: (request: Request) => Promise<unknown> }

async function receiver(accountID: string, browserSessionID: string, categories = allOn): Promise<Receiver> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!("privateKey" in pair)) throw new Error("key pair unavailable")
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const subscription: PushSubscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${browserSessionID}`,
    accountID,
    browserSessionID,
    keys: { p256dh: base64UrlEncode(raw), auth: base64UrlEncode(auth) },
    categories,
    createdAt: 1,
    failures: 0,
  }
  return {
    subscription,
    decrypt: async (request) => {
      const body = new Uint8Array(await request.clone().arrayBuffer())
      const sender = body.slice(21, 86)
      const senderKey = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, pair.privateKey, 256))
      const derived = await deriveWebPushKeys(shared, auth, raw, sender, body.slice(0, 16))
      const key = await crypto.subtle.importKey("raw", derived.cek, "AES-GCM", false, ["decrypt"])
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: derived.nonce }, key, body.slice(86)))
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1))) as unknown
    },
  }
}

function memoryKv(): QuotaClaimStorage {
  const values = new Map<string, string>()
  return {
    get: <Value>(key: string) => {
      const value = values.get(key)
      return value === undefined ? undefined : (JSON.parse(value) as Value)
    },
    put: (key, value) => {
      values.set(key, JSON.stringify(value))
    },
    delete: (key) => values.delete(key),
    list: <Value>(options?: { readonly prefix?: string }) =>
      Array.from(values)
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .map(([key, value]): [string, Value] => [key, JSON.parse(value) as Value]),
  }
}

const plain = (pace: QuotaPace | undefined) =>
  pace && {
    providerID: decodeLossless(pace.providerId!),
    windowID: decodeLossless(pace.windowId!),
    milestone: pace.milestone,
    resetAt: Number(pace.resetAt),
  }

async function world() {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!("privateKey" in vapid)) throw new Error("VAPID key pair unavailable")
  const keys = {
    publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
    privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? "",
    subject: "mailto:push@example.invalid",
  }
  const receivers = new Map<string, Receiver>()
  const accounts = new Map<string, string[]>()
  const claimStorage = new Map<string, QuotaClaimStorage>()
  const posts: { readonly browser: string; readonly request: Request }[] = []
  const answers = new Map<string, () => Promise<Response>>()
  const state = { coordinator: true, pushThrows: false }
  const reservations: { readonly owner: string; readonly key: string; readonly until: number }[] = []
  const machines: { readonly flush: (time: number) => Promise<void> }[] = []
  let now = start
  const store = (accountID: string): PushStore => ({
    list: async () => (accounts.get(accountID) ?? []).flatMap((id) => receivers.get(id)?.subscription ?? []),
    upsert: async () => true,
    renew: async () => "missing",
    remove: async () => undefined,
    claimTest: async () => ({ status: "missing" }),
    recordFailure: async () => undefined,
    recordSuccess: async () => undefined,
  })
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

  const machine = async (ownerID: string, deviceID: string, tabs: readonly string[] = []) => {
    const h = await harness({
      ownerID,
      deviceID,
      start: now,
      notifyPush: (accountID, event) => sendPushToOwner({ store: store(accountID), accountID, event, ...keys, now: () => now, fetch }),
      quota: {
        subscriptions: async (owner) => store(owner).list(owner),
        reserve: async (owner, key, until, members) => {
          if (!state.coordinator) throw new Error("coordinator unavailable")
          reservations.push({ owner, key, until })
          return claims(owner).reserve(key, until, members)
        },
        release: async (owner, key, members) => claims(owner).release(key, members),
        push: (owner, event, subscriptions) => {
          if (state.pushThrows) return Promise.reject(new Error("digest unavailable"))
          return sendPush({ store: store(owner), event, subscriptions, ...keys, now: () => now, fetch })
        },
      },
    })
    const agent = await h.attach("agent", "agent", { credentialExpiresAt: 1e12 })
    const peers = new Map([["agent", agent]])
    const received = (id: string) => {
      const entries = h.receive(id)
      for (const entry of entries)
        if (entry.frame?.ledger === LedgerClass.NORMAL) peers.get(id)!.consume(LedgerClass.NORMAL, entry.frame.deliveryOrdinal, h.now())
      return entries
    }
    for (const tab of tabs) {
      const client = await h.attach(`tab-${tab}`, "client", { browserSessionID: tab, credentialExpiresAt: 1e12 })
      peers.set(`tab-${tab}`, client)
      h.request(client, "notice.subscribe")
      await h.send(`tab-${tab}`)
      received(`tab-${tab}`)
      await h.send(`tab-${tab}`)
    }
    received("agent")
    await h.send("agent")
    machines.push({
      flush: async (time) => {
        for (const offset of [25, 50]) {
          const step = h.now() + offset
          h.at(step)
          for (const [id, peer] of peers) {
            received(id)
            peer.advance(step)
            await h.send(id)
          }
          h.relay.sweep()
        }
        for (const [id, peer] of peers) {
          received(id)
          peer.advance(h.now())
          await h.send(id)
        }
        h.at(time)
      },
    })
    const enqueue = (body: Frame["body"]) => agent.enqueue(body, frameReservation(body), h.now())
    const pace = (value: RemoteQuota = quota): Frame["body"] => ({
      case: "control",
      value: create(ControlSchema, { kind: { case: "quotaPace", value: quotaToWire(value) } }),
    })
    const results: QuotaPaceStatus[] = []
    const notices = new Map<string, unknown[]>()
    const presented = new Map<string, unknown[][]>()
    const collect = async () => {
      for (const entry of received("agent"))
        if (entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "quotaPaceResult")
          results.push(entry.frame.body.value.kind.value.status)
      for (const tab of tabs)
        for (const entry of received(`tab-${tab}`)) {
          if (entry.frame?.body.case !== "control" || entry.frame.body.value.kind.case !== "notice") continue
          const notice = entry.frame.body.value.kind.value.kind
          if (notice.case === "quotaPace")
            notices.set(tab, [...(notices.get(tab) ?? []), { ...plain(notice.value.quota), at: Number(notice.value.at) }])
          if (notice.case === "present" && notice.value.items.some((item) => item.kind.case === "quotaPace"))
            presented.set(tab, [
              ...(presented.get(tab) ?? []),
              notice.value.items.map((item) => (item.kind.case === "quotaPace" ? plain(item.kind.value) : item.kind.case)),
            ])
        }
      for (const id of peers.keys()) await h.send(id)
    }
    return {
      h,
      send: async (value: RemoteQuota = quota) => {
        enqueue(pace(value))
        await h.send("agent")
        await h.relay.settleDeliveries()
        await collect()
      },
      status: async (attention: readonly string[]) => {
        enqueue({ case: "control", value: create(ControlSchema, { kind: { case: "status", value: { running: [], attention: [...attention] } } }) })
        await h.send("agent")
        await h.relay.settleDeliveries()
        await collect()
      },
      burst: async (count: number) => {
        for (let index = 0; index < count; index++) enqueue(pace())
        await h.send("agent")
        await h.relay.settleDeliveries()
        await collect()
      },
      results: () => results.map((status) => (status === QuotaPaceStatus.SETTLED ? "settled" : "pending")),
      notices: (tab: string) => notices.get(tab) ?? [],
      presented: (tab: string) => presented.get(tab) ?? [],
    }
  }

  return {
    state,
    reservations,
    posts,
    answers,
    machine,
    advance: async (milliseconds: number) => {
      for (const target = now + milliseconds; now < target; ) {
        now = Math.min(target, now + 5_000)
        for (const item of machines) await item.flush(now)
      }
    },
    subscribe: async (accountID: string, browser: string, categories = allOn) => {
      receivers.set(browser, await receiver(accountID, browser, categories))
      accounts.set(accountID, [...(accounts.get(accountID) ?? []), browser])
    },
    quotaPosts: async (browser?: string) => {
      const decoded = await Promise.all(
        posts
          .filter((post) => browser === undefined || post.browser === browser)
          .map(async (post) => ({ post, payload: await receivers.get(post.browser)?.decrypt(post.request) })),
      )
      return decoded.filter(
        (entry) => typeof entry.payload === "object" && entry.payload !== null && Reflect.get(entry.payload, "category") === "quota-pace",
      )
    },
  }
}

const wire = (value: RemoteQuota = quota) => ({ ...value, milestone: quotaToWire(value).milestone })

describe("relay quota alerts", () => {
  test("two machines of one account send one encrypted push per subscribed browser carrying only quota identity, device and reset", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_1", "bs_phone")
      const first = await value.machine("usr_1", "dev_a", ["bs_viewer"])
      const second = await value.machine("usr_1", "dev_b", ["bs_other_viewer"])
      await first.send()
      await second.send({ ...quota, resetAt: quota.resetAt + 1_000 })
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
      expect(first.notices("bs_viewer")).toEqual([{ ...wire(), at: start }])
      expect(second.notices("bs_other_viewer")).toEqual([{ ...wire({ ...quota, resetAt: quota.resetAt + 1_000 }), at: start }])
      expect(first.h.notices.page().notices).toEqual([])
    } finally {
      info.mockRestore()
    }
  })

  test("a machine without notice subscribers consumes no live notice, so another machine's subscribed browser with System off still gets one", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_b", { ...allOn, "quota-pace": false })
      const first = await value.machine("usr_1", "dev_a")
      const second = await value.machine("usr_1", "dev_b", ["bs_b"])
      await first.send()
      await second.send()
      expect(second.notices("bs_b")).toHaveLength(1)
      expect(value.posts).toEqual([])
      expect(second.presented("bs_b")).toEqual([])
      expect([...first.results(), ...second.results()]).toEqual(["settled", "settled"])
    } finally {
      info.mockRestore()
    }
  })

  test("each browser gets one live notice and page alert on whichever machine reaches it first, never one per machine", async () => {
    const value = await world()
    const first = await value.machine("usr_1", "dev_a", ["bs_x", "bs_shared"])
    const second = await value.machine("usr_1", "dev_b", ["bs_y", "bs_shared"])
    await first.send()
    await second.send()
    await first.send()
    expect([first.notices("bs_x"), first.notices("bs_shared"), second.notices("bs_y"), second.notices("bs_shared")].map((items) => items.length)).toEqual([1, 1, 1, 0])
    expect([first.presented("bs_x"), first.presented("bs_shared"), second.presented("bs_y"), second.presented("bs_shared")].map((items) => items.length)).toEqual([1, 1, 1, 0])
  })

  test("many duplicate frames deliver each browser at most once and answer every frame", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_1", "bs_phone")
      const machine = await value.machine("usr_1", "dev_a", ["bs_viewer"])
      await machine.burst(50)
      expect((await value.quotaPosts()).map((entry) => entry.post.browser).sort()).toEqual(["bs_laptop", "bs_phone"])
      expect(machine.results()).toEqual(Array.from({ length: 50 }, () => "settled"))
      expect(machine.notices("bs_viewer")).toHaveLength(1)
      expect(machine.presented("bs_viewer")).toEqual([[wire()]])
    } finally {
      info.mockRestore()
    }
  })

  test("another account's identical alert is delivered to its own browsers only", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_2", "bs_stranger")
      await (await value.machine("usr_1", "dev_a")).send()
      const other = await value.machine("usr_2", "dev_z")
      await other.send()
      const posts = await value.quotaPosts()
      expect(posts.map((entry) => [entry.post.browser, Reflect.get(entry.payload as object, "deviceID")]).sort()).toEqual([
        ["bs_laptop", "dev_a"],
        ["bs_stranger", "dev_z"],
      ])
      expect(other.results()).toEqual(["settled"])
    } finally {
      info.mockRestore()
    }
  })

  test("a different reset minute or milestone is a distinct alert", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.machine("usr_1", "dev_a")
      await machine.send()
      await machine.send({ ...quota, resetAt: quota.resetAt + 60_000 })
      await machine.send({ ...quota, milestone: "almost-out" })
      await machine.send({ ...quota, milestone: "almost-out" })
      expect((await value.quotaPosts()).map((entry) => [Reflect.get(entry.payload as object, "milestone"), Reflect.get(entry.payload as object, "resetAt")])).toEqual([
        ["will-run-out", quota.resetAt],
        ["will-run-out", quota.resetAt + 60_000],
        ["almost-out", quota.resetAt],
      ])
    } finally {
      info.mockRestore()
    }
  })

  test("a browser whose quota System alert is off gets neither a push nor a page alert, and a browser without push is presented once", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop", { ...allOn, "quota-pace": false })
      await value.subscribe("usr_1", "bs_phone")
      const machine = await value.machine("usr_1", "dev_a", ["bs_laptop", "bs_tab"])
      await machine.send()
      await machine.send()
      expect(value.posts.filter((post) => post.browser === "bs_laptop")).toEqual([])
      expect((await value.quotaPosts()).map((entry) => entry.post.browser)).toEqual(["bs_phone"])
      expect(machine.presented("bs_laptop")).toEqual([])
      expect(machine.presented("bs_tab")).toEqual([[wire()]])
      expect(machine.notices("bs_laptop")).toHaveLength(1)
      expect(machine.notices("bs_tab")).toHaveLength(1)
      expect(machine.results()).toEqual(["settled", "settled"])
    } finally {
      info.mockRestore()
    }
  })

  test("a quota alert beyond the twenty-a-minute push budget stays pending and a later retry delivers it", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.machine("usr_1", "dev_a")
      await machine.status([])
      await machine.status(Array.from({ length: 20 }, (_, index) => `ses_${index}`))
      expect(value.posts).toHaveLength(20)
      await machine.send()
      expect(value.posts).toHaveLength(20)
      expect(machine.results()).toEqual(["pending"])
      await value.advance(60_000)
      await machine.send()
      expect((await value.quotaPosts()).map((entry) => entry.post.browser)).toEqual(["bs_laptop"])
      expect(machine.results()).toEqual(["pending", "settled"])
    } finally {
      info.mockRestore()
    }
  })

  test("an unavailable claim coordinator leaves the alert pending with no push, page alert or live notice", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.machine("usr_1", "dev_a", ["bs_viewer"])
      value.state.coordinator = false
      await machine.send()
      expect(value.posts).toEqual([])
      expect(machine.notices("bs_viewer")).toEqual([])
      expect(machine.presented("bs_viewer")).toEqual([])
      value.state.coordinator = true
      await machine.send()
      expect((await value.quotaPosts()).map((entry) => entry.post.browser)).toEqual(["bs_laptop"])
      expect(machine.results()).toEqual(["pending", "settled"])
    } finally {
      info.mockRestore()
    }
  })

  test("a browser's attempt is reserved before its uncertain send, so a restarted relay or another machine never repeats it", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      await value.subscribe("usr_1", "bs_phone")
      const hang = Promise.withResolvers<Response>()
      value.answers.set("bs_laptop", () => hang.promise)
      const crashed = await value.machine("usr_1", "dev_a")
      const abandoned = crashed.send()
      while (value.posts.length < 2) await Bun.sleep(1)
      const restarted = await value.machine("usr_1", "dev_a", ["bs_laptop"])
      await restarted.send()
      const other = await value.machine("usr_1", "dev_b", ["bs_laptop"])
      await other.send()
      expect(value.posts.map((post) => post.browser).sort()).toEqual(["bs_laptop", "bs_phone"])
      expect(restarted.results()).toEqual(["settled"])
      expect(other.results()).toEqual(["settled"])
      expect(restarted.presented("bs_laptop")).toEqual([])
      expect(other.presented("bs_laptop")).toEqual([])
      hang.resolve(new Response(null, { status: 201 }))
      await abandoned
    } finally {
      info.mockRestore()
    }
  })

  test("a definite push rejection is not retried, and a send that fails before any request releases its browsers", async () => {
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const value = await world()
      await value.subscribe("usr_1", "bs_laptop")
      const machine = await value.machine("usr_1", "dev_a")
      value.state.pushThrows = true
      await machine.send()
      expect(value.posts).toEqual([])
      value.state.pushThrows = false
      value.answers.set("bs_laptop", async () => new Response(null, { status: 503 }))
      await machine.send()
      await machine.send()
      expect(value.posts.map((post) => post.browser)).toEqual(["bs_laptop"])
      expect(machine.results()).toEqual(["pending", "settled", "settled"])
    } finally {
      info.mockRestore()
    }
  })

  test("an account-wide claim outlives its rounded reset by the two-minute grace", async () => {
    const value = await world()
    await (await value.machine("usr_1", "dev_a", ["bs_viewer"])).send()
    expect(value.reservations).toEqual([{ owner: "usr_1", key: JSON.stringify(["anthropic", "five-hour", "will-run-out", 30]), until: quota.resetAt + 120_000 }])
  })

  test("an alert whose reset has passed settles without delivery", async () => {
    const value = await world()
    await value.subscribe("usr_1", "bs_laptop")
    const machine = await value.machine("usr_1", "dev_a", ["bs_viewer"])
    await machine.send({ ...quota, resetAt: start })
    expect(value.posts).toEqual([])
    expect(machine.notices("bs_viewer")).toEqual([])
    expect(machine.results()).toEqual(["settled"])
  })
})
