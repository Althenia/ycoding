import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createPreviewDirectoryStore, maxLeaseLifetimeMs } from "../src/preview/directory-store"

const pool = ["https://preview-1.example.invalid", "https://preview-2.example.invalid"]
const deviceA = { ownerID: "owner_a", deviceID: "device_a" }
const deviceB = { ownerID: "owner_b", deviceID: "device_b" }
const hash = (character: string) => character.repeat(64)
const tag = (character: string) => character.repeat(16)

function fixture(database = new Database(":memory:"), clock = { time: 1_000_000 }) {
  const store = createPreviewDirectoryStore({
    sql: { exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...(bindings as never[])) }) },
    transactionSync: (operation) => database.transaction(operation)(),
  }, () => clock.time)
  const allocate = (registration: string, device = deviceA, origins = pool) => store.allocate({ ...device, registration, expiresAt: clock.time + 3_600_000, origins })
  const lease = (origin: string, registration: string, ticketHash: string, leaseTag: string, device = deviceA) =>
    store.register({ ...device, origin, registration, ticketHash, leaseTag, expiresAt: clock.time + 60_000 })
  return { store, database, clock, allocate, lease, advance: (ms: number) => { clock.time += ms } }
}

test("two registrations always receive different origins and the same registration keeps its own", () => {
  const f = fixture()
  expect(f.allocate(hash("a"))).toEqual({ state: "allocated", origin: pool[0] })
  expect(f.allocate(hash("a"))).toEqual({ state: "allocated", origin: pool[0] })
  expect(f.allocate(hash("b"), deviceB)).toEqual({ state: "allocated", origin: pool[1] })
  expect(f.allocate(hash("c"))).toEqual({ state: "exhausted" })
  expect(f.allocate(hash("a"), deviceB)).toEqual({ state: "rejected" })
  expect(f.store.allocate({ ...deviceA, registration: hash("d"), expiresAt: f.clock.time, origins: pool })).toEqual({ state: "rejected" })
})

test("a bound origin is burned: expiry, revocation, purge and a recreated directory never rebind it", () => {
  const database = new Database(":memory:")
  const clock = { time: 1_000_000 }
  const first = fixture(database, clock)
  expect(first.allocate(hash("a"))).toEqual({ state: "allocated", origin: pool[0] })
  first.store.revoke({ ...deviceA, registration: hash("a") })
  expect(first.allocate(hash("a"))).toEqual({ state: "rejected" })
  first.advance(3_600_000)
  const restarted = fixture(database, clock)
  expect(restarted.allocate(hash("b"))).toEqual({ state: "allocated", origin: pool[1] })
  restarted.store.revoke(deviceA)
  restarted.advance(7_200_000)
  const again = fixture(database, clock)
  expect(again.allocate(hash("c"))).toEqual({ state: "exhausted" })
  expect(again.allocate(hash("c"), deviceB, [...pool, "https://preview-3.example.invalid"])).toEqual({ state: "allocated", origin: "https://preview-3.example.invalid" })
  expect((database.query("SELECT COUNT(*) AS total FROM preview_origin").get() as { total: number }).total).toBe(3)
})

test("a lease is accepted only on its registration's live origin binding", () => {
  const f = fixture()
  f.allocate(hash("a"))
  f.allocate(hash("b"), deviceB)
  expect(f.lease(pool[0]!, hash("a"), hash("1"), tag("1"))).toBe(true)
  expect(f.lease(pool[0]!, hash("a"), hash("1"), tag("2"))).toBe(false)
  expect(f.lease(pool[0]!, hash("a"), hash("2"), tag("1"))).toBe(false)
  expect(f.lease(pool[1]!, hash("a"), hash("3"), tag("3"))).toBe(false)
  expect(f.lease(pool[0]!, hash("b"), hash("4"), tag("4"), deviceB)).toBe(false)
  expect(f.lease("https://preview-9.example.invalid", hash("a"), hash("5"), tag("5"))).toBe(false)
  expect(f.store.register({ ...deviceA, origin: pool[0]!, registration: hash("a"), ticketHash: hash("6"), leaseTag: tag("6"), expiresAt: f.clock.time + maxLeaseLifetimeMs + 60_000 })).toBe(true)
  expect(f.store.redeem(hash("6"), pool[0]!)).toMatchObject({ state: "valid", lease: { expiresAt: f.clock.time + maxLeaseLifetimeMs } })
  f.store.revoke({ ...deviceA, registration: hash("a") })
  expect(f.lease(pool[0]!, hash("a"), hash("7"), tag("7"))).toBe(false)
})

test("tickets redeem once, only on their bound origin", () => {
  const f = fixture()
  f.allocate(hash("a"))
  f.lease(pool[0]!, hash("a"), hash("1"), tag("1"))
  expect(f.store.redeem(hash("1"), pool[1]!)).toEqual({ state: "unbound" })
  expect(f.store.redeem(hash("1"), pool[0]!)).toEqual({ state: "valid", ticketHash: hash("1"), lease: { ...deviceA, origin: pool[0], expiresAt: f.clock.time + 60_000, leaseTag: tag("1") } })
  expect(f.store.redeem(hash("1"), pool[0]!)).toEqual({ state: "unknown" })
  expect(f.store.redeem("not-a-digest", pool[0]!)).toEqual({ state: "unknown" })
  f.lease(pool[0]!, hash("a"), hash("2"), tag("2"))
  f.advance(60_000)
  expect(f.store.redeem(hash("2"), pool[0]!)).toEqual({ state: "expired" })
  expect(f.store.redeem(hash("2"), pool[0]!)).toEqual({ state: "unknown" })
})

test("a cookie binds once and resolves only with its own lease tag on its own bound origin", () => {
  const f = fixture()
  f.allocate(hash("a"))
  f.allocate(hash("b"), deviceB)
  f.lease(pool[0]!, hash("a"), hash("1"), tag("1"))
  f.lease(pool[1]!, hash("b"), hash("2"), tag("2"), deviceB)
  const cookie = { ...deviceA, ticketHash: hash("1"), cookieHash: hash("c") }
  expect(f.store.bind(cookie)).toBe(false)
  f.store.redeem(hash("1"), pool[0]!)
  expect(f.store.bind({ ...cookie, ...deviceB })).toBe(false)
  expect(f.store.bind(cookie)).toBe(true)
  expect(f.store.bind({ ...cookie, cookieHash: hash("d") })).toBe(false)
  f.store.redeem(hash("2"), pool[1]!)
  expect(f.store.bind({ ...deviceB, ticketHash: hash("2"), cookieHash: hash("c") })).toBe(false)
  expect(f.store.resolve(hash("c"), tag("1"), pool[0]!)).toMatchObject({ state: "valid", lease: { ...deviceA, leaseTag: tag("1") } })
  expect(f.store.resolve(hash("c"), tag("1"), pool[1]!)).toEqual({ state: "unknown" })
  expect(f.store.resolve(hash("c"), tag("1"), "https://preview-9.example.invalid")).toEqual({ state: "unbound" })
  expect(f.store.resolve(hash("c"), tag("9"), pool[0]!)).toEqual({ state: "gone" })
  f.lease(pool[0]!, hash("a"), hash("3"), tag("3"))
  expect(f.store.resolve(hash("c"), tag("3"), pool[0]!)).toEqual({ state: "mismatch" })
  expect(f.store.resolve(hash("e"), tag("1"), pool[0]!)).toEqual({ state: "unknown" })
  f.store.revoke({ ...deviceA, ticketHash: hash("1") })
  expect(f.store.resolve(hash("c"), tag("1"), pool[0]!)).toEqual({ state: "unknown" })
  f.store.revoke({ ...deviceA, registration: hash("a") })
  expect(f.store.resolve(hash("c"), tag("3"), pool[0]!)).toEqual({ state: "ended" })
})

test("revocation is scoped to the owning device", () => {
  const f = fixture()
  f.allocate(hash("a"))
  f.allocate(hash("b"), deviceB)
  f.lease(pool[0]!, hash("a"), hash("1"), tag("1"))
  f.lease(pool[1]!, hash("b"), hash("2"), tag("2"), deviceB)
  f.store.revoke({ ...deviceB, registration: hash("a") })
  f.store.revoke({ ...deviceB, ticketHash: hash("1") })
  expect(f.store.redeem(hash("1"), pool[0]!).state).toBe("valid")
  f.store.revoke(deviceA)
  expect(f.store.redeem(hash("2"), pool[1]!).state).toBe("valid")
  expect(f.lease(pool[0]!, hash("a"), hash("3"), tag("3"))).toBe(false)
})

test("each device holds at most 64 live leases", () => {
  const f = fixture()
  f.allocate(hash("a"))
  for (let index = 0; index < 64; index++) expect(f.lease(pool[0]!, hash("a"), index.toString(16).padStart(64, "0"), index.toString(16).padStart(16, "0"))).toBe(true)
  expect(f.lease(pool[0]!, hash("a"), hash("f"), tag("f"))).toBe(false)
})
