import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { base64UrlEncode } from "../src/auth/crypto"
import { createD1PushStore } from "../src/push/d1-store"
import { sendPushToOwner } from "../src/push/send"
import type { PushStore, PushSubscription } from "../src/push/store"
import { applyMigration, migratedDatabase, sqliteD1 } from "./support/d1-sqlite"

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true, "quota-pace": true }

test("migration 0009 adds one nullable coordination filter column and preserves existing subscriptions unchanged", async () => {
  const db = await migratedDatabase("0008_device_alias.sql")
  try {
    db.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
    db.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run("bs_1", "usr_1", 1, 10_000)
    db.prepare("INSERT INTO push_subscription (endpoint, account_id, browser_session_id, p256dh, auth, created_at, failures, agent_completed, approval_requested, machine_offline, quota_pace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("https://fcm.googleapis.com/send/a", "usr_1", "bs_1", "public", "secret", 2, 3, 0, 1, 0, 1)
    const before = db.prepare("SELECT endpoint, account_id, browser_session_id, p256dh, auth, created_at, failures, agent_completed, approval_requested, machine_offline, quota_pace, tested_at FROM push_subscription").all()
    await applyMigration(db, "0009_push_coordination_filter.sql")
    expect(db.prepare("PRAGMA table_info('push_subscription')").all()).toContainEqual(expect.objectContaining({ name: "coordination_filter", type: "TEXT", notnull: 0, dflt_value: null }))
    expect(db.prepare("SELECT endpoint, account_id, browser_session_id, p256dh, auth, created_at, failures, agent_completed, approval_requested, machine_offline, quota_pace, tested_at FROM push_subscription").all()).toEqual(before)
    expect(db.prepare("SELECT coordination_filter FROM push_subscription").get()).toEqual({ coordination_filter: null })
  } finally { db.close() }
})

test("D1 push store round-trips the coordination filter, clears it when omitted, and keeps it across renewal", async () => {
  const sqlite = await migratedDatabase()
  try {
    sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
    sqlite.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run("bs_phone", "usr_1", 1, 10_000)
    const store = createD1PushStore(sqliteD1(sqlite))
    const endpoint = "https://web.push.apple.com/phone"
    const filter = { scope: "selected", sessionIDs: ["ses_coord"], categories: ["question", "completion"] } as const
    await store.upsert("usr_1", "bs_phone", { endpoint, keys: { p256dh: "phone", auth: "auth" }, categories: allOn, coordinationFilter: filter }, 1)
    expect((await store.list("usr_1"))[0]?.coordinationFilter).toEqual(filter)
    const claimed = await store.claimTest("usr_1", endpoint, 1_000)
    expect(claimed.status === "claimed" ? claimed.subscription.coordinationFilter : undefined).toEqual(filter)
    const renewed = "https://web.push.apple.com/phone-renewed"
    expect(await store.renew("usr_1", "bs_phone", { endpoint: renewed, keys: { p256dh: "phone-2", auth: "auth" }, replaces: endpoint }, 2)).toBe("written")
    expect((await store.list("usr_1"))[0]?.coordinationFilter).toEqual(filter)
    await store.upsert("usr_1", "bs_phone", { endpoint: renewed, keys: { p256dh: "phone-2", auth: "auth" }, categories: allOn }, 3)
    expect((await store.list("usr_1"))[0]?.coordinationFilter).toBeUndefined()
    sqlite.prepare("UPDATE push_subscription SET coordination_filter = ?").run("not-json")
    expect((await store.list("usr_1"))[0]?.coordinationFilter).toEqual({ scope: "selected", sessionIDs: [] })
  } finally { sqlite.close() }
})

async function receiver(endpoint: string, coordinationFilter?: PushSubscription["coordinationFilter"]) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(pair instanceof Object) || !("privateKey" in pair)) throw new Error("key pair unavailable")
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const subscription: PushSubscription = {
    endpoint, accountID: "usr_1", browserSessionID: `bs_${endpoint.split("/").at(-1)}`,
    keys: { p256dh: base64UrlEncode(raw), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    categories: allOn, createdAt: 1, failures: 0, ...(coordinationFilter === undefined ? {} : { coordinationFilter }),
  }
  return subscription
}

async function vapidKeys() {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(vapid instanceof Object) || !("privateKey" in vapid)) throw new Error("key pair unavailable")
  return { publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
    privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d ?? "", subject: "mailto:push@example.invalid", now: () => 1_700_000_000_000 }
}

function memoryStore(rows: readonly PushSubscription[]): PushStore {
  return { list: async () => rows, upsert: async () => true, renew: async () => "missing", remove: async () => undefined,
    claimTest: async () => ({ status: "missing" }), recordFailure: async () => undefined, recordSuccess: async () => undefined }
}

test("push delivery applies the persisted coordination filter to verified coordinator attribution only", async () => {
  const selected = await receiver("https://fcm.googleapis.com/send/selected", { scope: "selected", sessionIDs: ["ses_coord"], categories: ["question", "completion"] })
  const coordinators = await receiver("https://fcm.googleapis.com/send/coordinators", { scope: "coordinators" })
  const unfiltered = await receiver("https://fcm.googleapis.com/send/all")
  const keys = await vapidKeys()
  const sent: string[] = []
  const deliver = (event: Parameters<typeof sendPushToOwner>[0]["event"]) => sendPushToOwner({
    store: memoryStore([selected, coordinators, unfiltered]), accountID: "usr_1", event, ...keys,
    fetch: async (input) => { sent.push(String(input)); return new Response(null, { status: 201 }) } })
  const outcomes = (rows: readonly { owner: string; outcome: string }[]) => Object.fromEntries(rows.map((row) => [row.owner, row.outcome]))

  expect(outcomes(await deliver({ category: "approval-requested", sessionID: "ses_worker", deviceID: "dev_1", noticeID: "ntc_1", need: "question", coordinatorSessionIDs: ["ses_coord"] })))
    .toEqual({ bs_selected: "unsent", bs_coordinators: "unsent", bs_all: "accepted" })
  expect(outcomes(await deliver({ category: "approval-requested", sessionID: "ses_observer", deviceID: "dev_1", noticeID: "ntc_2", need: "question", coordinatorSessionIDs: ["ses_coord"] })))
    .toEqual({ bs_selected: "unsent", bs_coordinators: "unsent", bs_all: "accepted" })
  expect(outcomes(await deliver({ category: "approval-requested", sessionID: "ses_coord", deviceID: "dev_1", noticeID: "ntc_3", need: "question", coordinatorSessionIDs: ["ses_coord"] })))
    .toEqual({ bs_selected: "accepted", bs_coordinators: "accepted", bs_all: "accepted" })
  expect(outcomes(await deliver({ category: "approval-requested", sessionID: "ses_coord", deviceID: "dev_1", noticeID: "ntc_4", need: "permission", coordinatorSessionIDs: ["ses_coord"] })))
    .toEqual({ bs_selected: "unsent", bs_coordinators: "accepted", bs_all: "accepted" })
  expect(outcomes(await deliver({ category: "approval-requested", sessionID: "ses_solo", deviceID: "dev_1", noticeID: "ntc_5", need: "question" })))
    .toEqual({ bs_selected: "unsent", bs_coordinators: "unsent", bs_all: "accepted" })
  expect(outcomes(await deliver({ category: "agent-completed", sessionID: "ses_coord", deviceID: "dev_1", noticeID: "ntc_6", coordinatorSessionIDs: ["ses_coord"] })))
    .toEqual({ bs_selected: "accepted", bs_coordinators: "accepted", bs_all: "accepted" })
  expect(outcomes(await deliver({ category: "machine-offline", deviceID: "dev_1", offlineAt: 10 })))
    .toEqual({ bs_selected: "accepted", bs_coordinators: "accepted", bs_all: "accepted" })
  expect(sent).toHaveLength(14)
})
