import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createQuotaClaims, parseQuotaClaimRequest, parseQuotaReservation, quotaClaimLimits, type QuotaClaimStorage } from "../src/relay/quota-claims"

function sqliteKv(database: Database): QuotaClaimStorage {
  database.exec("CREATE TABLE IF NOT EXISTS fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  return {
    get: <Value>(key: string) => {
      const row = database.query("SELECT value FROM fixture_kv WHERE key = ?").get(key) as { value: string } | null
      return row === null ? undefined : JSON.parse(row.value) as Value
    },
    put: (key, value) => { database.query("INSERT OR REPLACE INTO fixture_kv VALUES (?, ?)").run(key, JSON.stringify(value)) },
    delete: (key) => database.query("DELETE FROM fixture_kv WHERE key = ?").run(key).changes > 0,
    list: <Value>(options?: { readonly prefix?: string }) => (database.query("SELECT key, value FROM fixture_kv ORDER BY key").all() as { key: string; value: string }[])
      .filter((row) => options?.prefix === undefined || row.key.startsWith(options.prefix))
      .map((row): [string, Value] => [row.key, JSON.parse(row.value) as Value]),
  }
}

const key = (index: number) => JSON.stringify(["anthropic", "five-hour", "will-run-out", 30_000 + index])

describe("owner quota claims", () => {
  test("each member of a key is granted once, across a reload of the same storage", () => {
    const database = new Database(":memory:")
    let now = 1_000
    const claims = createQuotaClaims(sqliteKv(database), () => now)
    expect(claims.reserve(key(1), 100_000, ["notice", "browser:laptop", "browser:phone"])).toEqual({ status: "reserved", granted: ["notice", "browser:laptop", "browser:phone"] })
    expect(claims.reserve(key(1), 100_000, ["notice", "browser:laptop"])).toEqual({ status: "reserved", granted: [] })
    const reloaded = createQuotaClaims(sqliteKv(database), () => now)
    expect(reloaded.reserve(key(1), 100_000, ["notice", "browser:phone", "browser:tablet"])).toEqual({ status: "reserved", granted: ["browser:tablet"] })
    expect(reloaded.reserve(key(2), 100_000, ["notice", "browser:laptop"])).toEqual({ status: "reserved", granted: ["notice", "browser:laptop"] })
    now = 100_000
    expect(reloaded.reserve(key(1), 200_000, ["notice"])).toEqual({ status: "reserved", granted: ["notice"] })
  })

  test("a released member can be granted again while the others stay claimed", () => {
    const claims = createQuotaClaims(sqliteKv(new Database(":memory:")), () => 1_000)
    claims.reserve(key(1), 100_000, ["browser:laptop", "browser:phone"])
    claims.release(key(1), ["browser:phone"])
    expect(claims.reserve(key(1), 100_000, ["browser:laptop", "browser:phone"])).toEqual({ status: "reserved", granted: ["browser:phone"] })
  })

  test("a full owner refuses new keys without evicting any unexpired claim, and admits them once claims expire", () => {
    const database = new Database(":memory:")
    let now = 1_000
    const claims = createQuotaClaims(sqliteKv(database), () => now)
    for (let index = 0; index < quotaClaimLimits.keys; index++)
      expect(claims.reserve(key(index), index === 0 ? 50_000 : 500_000, ["browser:laptop"]).status).toBe("reserved")
    expect(claims.reserve(key(9_999), 500_000, ["browser:laptop"])).toEqual({ status: "full" })
    expect(claims.reserve(key(1), 500_000, ["browser:phone"])).toEqual({ status: "reserved", granted: ["browser:phone"] })
    for (let index = 0; index < quotaClaimLimits.keys; index++)
      expect(claims.reserve(key(index), index === 0 ? 50_000 : 500_000, ["browser:laptop"])).toEqual({ status: "reserved", granted: [] })
    expect((database.query("SELECT COUNT(*) AS count FROM fixture_kv").get() as { count: number }).count).toBe(quotaClaimLimits.keys)
    now = 50_000
    expect(claims.reserve(key(9_999), 500_000, ["browser:laptop"])).toEqual({ status: "reserved", granted: ["browser:laptop"] })
    expect(claims.reserve(key(10_000), 500_000, ["browser:laptop"])).toEqual({ status: "full" })
  })

  test("members beyond the per-key bound are refused instead of replacing earlier claims", () => {
    const claims = createQuotaClaims(sqliteKv(new Database(":memory:")), () => 1_000)
    const members = Array.from({ length: quotaClaimLimits.members + 6 }, (_, index) => `browser:b${index}`)
    const first = claims.reserve(key(1), 100_000, members)
    expect(first.status === "reserved" ? first.granted : []).toEqual(members.slice(0, quotaClaimLimits.members))
    expect(claims.reserve(key(1), 100_000, members)).toEqual({ status: "reserved", granted: [] })
    claims.release(key(1), ["browser:b0"])
    expect(claims.reserve(key(1), 100_000, members)).toEqual({ status: "reserved", granted: ["browser:b0"] })
  })

  test("claim requests and reservations are parsed strictly", () => {
    expect(parseQuotaClaimRequest({ op: "reserve", key: key(1), until: 5, members: ["notice"] })).toEqual({ op: "reserve", key: key(1), until: 5, members: ["notice"] })
    expect(parseQuotaClaimRequest({ op: "release", key: key(1), members: ["browser:a"] })).toEqual({ op: "release", key: key(1), members: ["browser:a"] })
    for (const invalid of [undefined, {}, { op: "reserve", key: key(1), members: [] }, { op: "reserve", key: "", until: 5, members: [] },
      { op: "reserve", key: key(1), until: 1.5, members: [] }, { op: "reserve", key: key(1), until: 5, members: [1] },
      { op: "reserve", key: key(1), until: 5, members: Array.from({ length: quotaClaimLimits.members + 1 }, (_, index) => `m${index}`) },
      { op: "release", key: key(1), members: [], extra: true }, { op: "drop", key: key(1), members: [] }])
      expect(parseQuotaClaimRequest(invalid)).toBeUndefined()
    expect(parseQuotaReservation({ status: "full" })).toEqual({ status: "full" })
    expect(parseQuotaReservation({ status: "reserved", granted: ["notice"] })).toEqual({ status: "reserved", granted: ["notice"] })
    expect(parseQuotaReservation({ status: "reserved" })).toBeUndefined()
  })
})
