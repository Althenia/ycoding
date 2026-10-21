import { isPreviewOrigin, leaseTagPattern, maxPreviewLeases, maxRegistrationMs } from "../../../../packages/remote/src/index"

type DirectorySql = {
  readonly exec: (query: string, ...bindings: unknown[]) => { readonly toArray: () => unknown[] }
}

export type PreviewDirectoryStorage = {
  readonly sql: DirectorySql
  readonly transactionSync: <Value>(operation: () => Value) => Value
}

export type PreviewDevice = { readonly ownerID: string; readonly deviceID: string }
export type PreviewAllocation = { readonly state: "allocated"; readonly origin: string } | { readonly state: "exhausted" } | { readonly state: "rejected" }
export type PreviewLeaseRecord = PreviewDevice & { readonly origin: string; readonly expiresAt: number; readonly leaseTag: string }
export type PreviewLeaseInput = PreviewLeaseRecord & { readonly ticketHash: string; readonly registration: string }
export type PreviewAccess =
  | { readonly state: "valid"; readonly ticketHash: string; readonly lease: PreviewLeaseRecord }
  | { readonly state: "unbound" | "ended" | "unknown" | "expired" | "mismatch" | "gone" }

export const previewDirectoryName = "global"
export const maxLeaseLifetimeMs = 900_000
export const expiredRetentionMs = 3_600_000

type LeaseRow = {
  readonly ticket_hash: string
  readonly owner_id: string
  readonly device_id: string
  readonly origin: string
  readonly lease_tag: string
  readonly expires_at: number
  readonly redeemed: number
  readonly cookie_hash: string | null
}
type OriginRow = {
  readonly origin: string
  readonly owner_id: string
  readonly device_id: string
  readonly registration: string
  readonly expires_at: number
  readonly ended: number
}

const hashPattern = /^[a-f0-9]{64}$/
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/

export function createPreviewDirectoryStore(storage: PreviewDirectoryStorage, now: () => number = Date.now) {
  const sql = storage.sql
  sql.exec(
    "CREATE TABLE IF NOT EXISTS preview_origin (origin TEXT PRIMARY KEY, owner_id TEXT NOT NULL, device_id TEXT NOT NULL, registration TEXT NOT NULL UNIQUE, bound_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0)",
  ).toArray()
  sql.exec(
    "CREATE TABLE IF NOT EXISTS preview_lease (ticket_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, device_id TEXT NOT NULL, origin TEXT NOT NULL, lease_tag TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, redeemed INTEGER NOT NULL DEFAULT 0, cookie_hash TEXT UNIQUE)",
  ).toArray()
  sql.exec("CREATE INDEX IF NOT EXISTS preview_lease_device ON preview_lease (owner_id, device_id)").toArray()
  sql.exec("CREATE INDEX IF NOT EXISTS preview_lease_origin ON preview_lease (origin)").toArray()
  sql.exec("CREATE INDEX IF NOT EXISTS preview_origin_device ON preview_origin (owner_id, device_id)").toArray()

  const first = <Row>(query: string, ...bindings: unknown[]) => sql.exec(query, ...bindings).toArray()[0] as Row | undefined
  const binding = (origin: string): "bound" | "unbound" | "ended" => {
    const found = first<OriginRow>("SELECT * FROM preview_origin WHERE origin = ?", origin)
    if (found === undefined) return "unbound"
    return found.ended === 0 && found.expires_at > now() ? "bound" : "ended"
  }
  const lookup = (found: LeaseRow | undefined, origin: string, usable: (found: LeaseRow) => boolean): PreviewAccess => {
    const state = binding(origin)
    if (state !== "bound") return { state }
    if (found === undefined || found.origin !== origin || !usable(found)) return { state: "unknown" }
    if (found.expires_at <= now()) {
      sql.exec("DELETE FROM preview_lease WHERE ticket_hash = ?", found.ticket_hash).toArray()
      return { state: "expired" }
    }
    return { state: "valid", ticketHash: found.ticket_hash, lease: { ownerID: found.owner_id, deviceID: found.device_id, origin: found.origin, expiresAt: found.expires_at, leaseTag: found.lease_tag } }
  }

  return {
    allocate(input: PreviewDevice & { readonly registration: string; readonly expiresAt: number; readonly origins: readonly string[] }): PreviewAllocation {
      const current = now()
      if (!validDevice(input) || !hashPattern.test(input.registration) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= current || !input.origins.every(isPreviewOrigin))
        return { state: "rejected" }
      return storage.transactionSync((): PreviewAllocation => {
        const existing = first<OriginRow>("SELECT * FROM preview_origin WHERE registration = ?", input.registration)
        if (existing !== undefined)
          return existing.owner_id === input.ownerID && existing.device_id === input.deviceID && existing.ended === 0 && existing.expires_at > current && input.origins.includes(existing.origin)
            ? { state: "allocated", origin: existing.origin }
            : { state: "rejected" }
        const origin = input.origins.find((candidate) => first<OriginRow>("SELECT * FROM preview_origin WHERE origin = ?", candidate) === undefined)
        if (origin === undefined) return { state: "exhausted" }
        sql.exec("INSERT INTO preview_origin (origin, owner_id, device_id, registration, bound_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
          origin, input.ownerID, input.deviceID, input.registration, current, Math.min(input.expiresAt, current + maxRegistrationMs)).toArray()
        return { state: "allocated", origin }
      })
    },

    register(input: PreviewLeaseInput): boolean {
      const current = now()
      if (!hashPattern.test(input.ticketHash) || !hashPattern.test(input.registration) || !leaseTagPattern.test(input.leaseTag) || !validDevice(input) ||
        !isPreviewOrigin(input.origin) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= current) return false
      return storage.transactionSync(() => {
        sql.exec("DELETE FROM preview_lease WHERE expires_at <= ?", current - expiredRetentionMs).toArray()
        const bound = first<OriginRow>("SELECT * FROM preview_origin WHERE origin = ?", input.origin)
        if (bound === undefined || bound.owner_id !== input.ownerID || bound.device_id !== input.deviceID || bound.registration !== input.registration ||
          bound.ended !== 0 || bound.expires_at <= current) return false
        if (first<LeaseRow>("SELECT * FROM preview_lease WHERE ticket_hash = ? OR lease_tag = ?", input.ticketHash, input.leaseTag) !== undefined) return false
        const live = first<{ total: number }>("SELECT COUNT(*) AS total FROM preview_lease WHERE owner_id = ? AND device_id = ? AND expires_at > ?", input.ownerID, input.deviceID, current)
        if ((live?.total ?? 0) >= maxPreviewLeases) return false
        sql.exec("INSERT INTO preview_lease (ticket_hash, owner_id, device_id, origin, lease_tag, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
          input.ticketHash, input.ownerID, input.deviceID, input.origin, input.leaseTag, Math.min(input.expiresAt, current + maxLeaseLifetimeMs, bound.expires_at)).toArray()
        return true
      })
    },

    redeem(ticketHash: string, origin: string): PreviewAccess {
      return storage.transactionSync((): PreviewAccess => {
        const result = lookup(hashPattern.test(ticketHash) ? first<LeaseRow>("SELECT * FROM preview_lease WHERE ticket_hash = ?", ticketHash) : undefined, origin, (found) => found.redeemed === 0)
        if (result.state === "valid") sql.exec("UPDATE preview_lease SET redeemed = 1 WHERE ticket_hash = ?", ticketHash).toArray()
        return result
      })
    },

    bind(input: PreviewDevice & { readonly ticketHash: string; readonly cookieHash: string }): boolean {
      if (!hashPattern.test(input.ticketHash) || !hashPattern.test(input.cookieHash) || !validDevice(input)) return false
      return storage.transactionSync(() => {
        const found = first<LeaseRow>("SELECT * FROM preview_lease WHERE ticket_hash = ?", input.ticketHash)
        if (found === undefined || found.owner_id !== input.ownerID || found.device_id !== input.deviceID || found.redeemed !== 1 ||
          found.cookie_hash !== null || found.expires_at <= now() || binding(found.origin) !== "bound") return false
        if (first<LeaseRow>("SELECT * FROM preview_lease WHERE cookie_hash = ?", input.cookieHash) !== undefined) return false
        sql.exec("UPDATE preview_lease SET cookie_hash = ? WHERE ticket_hash = ?", input.cookieHash, input.ticketHash).toArray()
        return true
      })
    },

    resolve(cookieHash: string, leaseTag: string, origin: string): PreviewAccess {
      return storage.transactionSync((): PreviewAccess => {
        const result = lookup(hashPattern.test(cookieHash) ? first<LeaseRow>("SELECT * FROM preview_lease WHERE cookie_hash = ?", cookieHash) : undefined, origin, () => true)
        if (result.state !== "valid" || result.lease.leaseTag === leaseTag) return result
        const tagged = first<LeaseRow>("SELECT * FROM preview_lease WHERE lease_tag = ?", leaseTag)
        return tagged !== undefined && tagged.expires_at > now() ? { state: "mismatch" } : { state: "gone" }
      })
    },

    revoke(input: PreviewDevice & { readonly ticketHash?: string; readonly registration?: string }): void {
      if (!validDevice(input)) return
      storage.transactionSync(() => {
        if (input.ticketHash !== undefined) {
          sql.exec("DELETE FROM preview_lease WHERE owner_id = ? AND device_id = ? AND ticket_hash = ?", input.ownerID, input.deviceID, input.ticketHash).toArray()
          return
        }
        if (input.registration !== undefined) {
          const bound = first<OriginRow>("SELECT * FROM preview_origin WHERE owner_id = ? AND device_id = ? AND registration = ?", input.ownerID, input.deviceID, input.registration)
          if (bound === undefined) return
          sql.exec("UPDATE preview_origin SET ended = 1 WHERE origin = ?", bound.origin).toArray()
          sql.exec("DELETE FROM preview_lease WHERE origin = ?", bound.origin).toArray()
          return
        }
        sql.exec("UPDATE preview_origin SET ended = 1 WHERE owner_id = ? AND device_id = ?", input.ownerID, input.deviceID).toArray()
        sql.exec("DELETE FROM preview_lease WHERE owner_id = ? AND device_id = ?", input.ownerID, input.deviceID).toArray()
      })
    },
  }
}

export type PreviewDirectoryStore = ReturnType<typeof createPreviewDirectoryStore>

function validDevice(value: PreviewDevice): boolean {
  return identifierPattern.test(value.ownerID) && identifierPattern.test(value.deviceID)
}
