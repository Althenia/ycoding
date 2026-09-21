/**
 * D1 implementation of the `AuthStore` port.
 *
 * Single-use consumption and credential rotation are expressed as conditional
 * UPDATE statements so concurrent callers race safely at the database, not in the
 * worker. Only hashed credential material is stored.
 */

import { parsePublicKey } from "../../../../packages/remote/src/index"
import { randomToken } from "./crypto"
import type {
  AuthStore,
  BrowserSessionRow,
  ChallengeRow,
  CredentialKind,
  CredentialRow,
  DeviceRow,
  EnrollmentRow,
  OAuthTransactionRow,
} from "./store"

type DeviceRecord = {
  readonly id: string
  readonly user_id: string
  readonly name: string
  readonly public_key_jwk: string
  readonly key_algorithm: string
  readonly created_at: number
  readonly last_seen_at: number | null
  readonly revoked_at: number | null
}

type CredentialRecord = {
  readonly id: string
  readonly device_id: string
  readonly kind: string
  readonly created_at: number
  readonly expires_at: number
  readonly revoked_at: number | null
}

type SessionRecord = {
  readonly id: string
  readonly user_id: string
  readonly created_at: number
  readonly expires_at: number
  readonly revoked_at: number | null
}

type TransactionRecord = {
  readonly id: string
  readonly state_hash: string
  readonly nonce: string
  readonly code_verifier: string
  readonly redirect_after: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

type EnrollmentRecord = {
  readonly id: string
  readonly code_hash: string
  readonly user_id: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
  readonly device_id: string | null
}

type ChallengeRecord = {
  readonly id: string
  readonly device_id: string
  readonly nonce: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

export function createD1AuthStore(db: D1Database): AuthStore {
  const changed = (result: D1Result) => result.meta.changes === 1

  return {
    async health() {
      try {
        const row = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>()
        return row?.ok === 1
      } catch {
        return false
      }
    },

    async findOrCreateUser(provider: string, subject: string, now: number) {
      const existing = await db
        .prepare("SELECT user_id FROM identity WHERE provider = ? AND subject = ?")
        .bind(provider, subject)
        .first<{ user_id: string }>()
      if (existing) return existing.user_id
      const userID = `usr_${randomToken(9)}`
      try {
        await db.batch([
          db.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').bind(userID, now),
          db
            .prepare("INSERT INTO identity (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)")
            .bind(provider, subject, userID, now),
        ])
        return userID
      } catch {
        const raced = await db
          .prepare("SELECT user_id FROM identity WHERE provider = ? AND subject = ?")
          .bind(provider, subject)
          .first<{ user_id: string }>()
        if (!raced) throw new Error("identity insert failed")
        return raced.user_id
      }
    },

    async insertBrowserSession(row) {
      await db
        .prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(row.id, row.userID, row.createdAt, row.expiresAt)
        .run()
    },

    async findBrowserSession(id) {
      const row = await db
        .prepare("SELECT id, user_id, created_at, expires_at, revoked_at FROM browser_session WHERE id = ?")
        .bind(id)
        .first<SessionRecord>()
      return row ? toBrowserSession(row) : undefined
    },

    async revokeBrowserSession(id, now) {
      await db.prepare("UPDATE browser_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run()
    },

    async rotateBrowserSession(currentID, next, now) {
      // One transaction: insert the replacement only while the current session is
      // still live, then revoke it. A PK/constraint failure rolls both statements
      // back, so a failed rotation can never burn the current session.
      const [inserted, revoked] = await db.batch([
        db
          .prepare(
            "INSERT INTO browser_session (id, user_id, created_at, expires_at, rotated_from) SELECT ?, user_id, ?, ?, id FROM browser_session WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
          )
          .bind(next.id, next.createdAt, next.expiresAt, currentID, now),
        db
          .prepare("UPDATE browser_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?")
          .bind(now, currentID, now),
      ])
      return inserted !== undefined && revoked !== undefined && changed(inserted) && changed(revoked)
    },

    async insertOAuthTransaction(row) {
      await db
        .prepare(
          "INSERT INTO oauth_transaction (id, state_hash, nonce, code_verifier, redirect_after, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(row.id, row.stateHash, row.nonce, row.codeVerifier, row.redirectAfter, row.createdAt, row.expiresAt)
        .run()
    },

    async findOAuthTransaction(id) {
      const row = await db
        .prepare(
          "SELECT id, state_hash, nonce, code_verifier, redirect_after, created_at, expires_at, consumed_at FROM oauth_transaction WHERE id = ?",
        )
        .bind(id)
        .first<TransactionRecord>()
      return row ? toTransaction(row) : undefined
    },

    async consumeOAuthTransaction(id, now) {
      const result = await db
        .prepare("UPDATE oauth_transaction SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?")
        .bind(now, id, now)
        .run()
      return changed(result)
    },

    async insertDevice(row) {
      await db
        .prepare(
          "INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(row.id, row.userID, row.name, JSON.stringify(row.publicKey), row.publicKey.crv, row.createdAt)
        .run()
    },

    async findDevice(id) {
      const row = await db
        .prepare(
          "SELECT id, user_id, name, public_key_jwk, key_algorithm, created_at, last_seen_at, revoked_at FROM device WHERE id = ?",
        )
        .bind(id)
        .first<DeviceRecord>()
      return row ? toDevice(row) : undefined
    },

    async listDevices(userID) {
      const result = await db
        .prepare(
          "SELECT id, user_id, name, public_key_jwk, key_algorithm, created_at, last_seen_at, revoked_at FROM device WHERE user_id = ? ORDER BY created_at DESC",
        )
        .bind(userID)
        .all<DeviceRecord>()
      return result.results.map(toDevice)
    },

    async markDeviceSeen(id, now) {
      await db.prepare("UPDATE device SET last_seen_at = ? WHERE id = ?").bind(now, id).run()
    },

    async revokeDevice(id, userID, now) {
      // One transaction: the device and its credentials are revoked together, and
      // the credential update is scoped to the owner so a caller can never revoke
      // another owner's credentials.
      const [device] = await db.batch([
        db
          .prepare("UPDATE device SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
          .bind(now, id, userID),
        db
          .prepare(
            "UPDATE device_credential SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM device WHERE id = ? AND user_id = ?)",
          )
          .bind(now, id, id, userID),
      ])
      return device !== undefined && changed(device)
    },

    async insertEnrollment(row) {
      await db
        .prepare("INSERT INTO enrollment (id, code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, row.codeHash, row.userID, row.createdAt, row.expiresAt)
        .run()
    },

    async findEnrollment(id) {
      const row = await db
        .prepare(
          "SELECT id, code_hash, user_id, created_at, expires_at, consumed_at, device_id FROM enrollment WHERE id = ?",
        )
        .bind(id)
        .first<EnrollmentRecord>()
      return row ? toEnrollment(row) : undefined
    },

    async consumeEnrollment(id, now, deviceID) {
      const result = await db
        .prepare(
          "UPDATE enrollment SET consumed_at = ?, device_id = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .bind(now, deviceID, id, now)
        .run()
      return changed(result)
    },

    async insertChallenge(row) {
      await db
        .prepare("INSERT INTO device_challenge (id, device_id, nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, row.deviceID, row.nonce, row.createdAt, row.expiresAt)
        .run()
    },

    async findChallenge(id) {
      const row = await db
        .prepare(
          "SELECT id, device_id, nonce, created_at, expires_at, consumed_at FROM device_challenge WHERE id = ?",
        )
        .bind(id)
        .first<ChallengeRecord>()
      return row ? toChallenge(row) : undefined
    },

    async consumeChallenge(id, now) {
      const result = await db
        .prepare("UPDATE device_challenge SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?")
        .bind(now, id, now)
        .run()
      return changed(result)
    },

    async insertCredential(row) {
      await db
        .prepare(
          "INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(row.id, row.deviceID, row.kind, row.createdAt, row.expiresAt)
        .run()
    },

    async findCredential(id) {
      const row = await db
        .prepare(
          "SELECT id, device_id, kind, created_at, expires_at, revoked_at FROM device_credential WHERE id = ?",
        )
        .bind(id)
        .first<CredentialRecord>()
      return row ? toCredential(row) : undefined
    },

    async rotateCredential(currentID, next, now) {
      const [inserted, revoked] = await db.batch([
        db
          .prepare(
            "INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) SELECT ?, device_id, ?, ?, ? FROM device_credential WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
          )
          .bind(next.id, next.kind, next.createdAt, next.expiresAt, currentID, now),
        db
          .prepare(
            "UPDATE device_credential SET revoked_at = ?, rotated_to = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
          )
          .bind(now, next.id, currentID, now),
      ])
      return inserted !== undefined && revoked !== undefined && changed(inserted) && changed(revoked)
    },

    async revokeCredential(id, now) {
      await db
        .prepare("UPDATE device_credential SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, id)
        .run()
    },

    async deleteExpired(now, retentionMs, limit) {
      const before = now - retentionMs
      const results = await db.batch([
        db
          .prepare(
            "DELETE FROM oauth_transaction WHERE id IN (SELECT id FROM oauth_transaction WHERE expires_at < ? OR consumed_at < ? LIMIT ?)",
          )
          .bind(before, before, limit),
        db
          .prepare(
            "DELETE FROM device_challenge WHERE id IN (SELECT id FROM device_challenge WHERE expires_at < ? OR consumed_at < ? LIMIT ?)",
          )
          .bind(before, before, limit),
        db
          .prepare(
            "DELETE FROM enrollment WHERE id IN (SELECT id FROM enrollment WHERE expires_at < ? OR consumed_at < ? LIMIT ?)",
          )
          .bind(before, before, limit),
        db
          .prepare("DELETE FROM browser_session WHERE id IN (SELECT id FROM browser_session WHERE expires_at < ? LIMIT ?)")
          .bind(before, limit),
        db
          .prepare("DELETE FROM device_credential WHERE id IN (SELECT id FROM device_credential WHERE expires_at < ? LIMIT ?)")
          .bind(before, limit),
      ])
      const removed = (index: number) => results[index]?.meta.changes ?? 0
      return {
        oauthTransactions: removed(0),
        challenges: removed(1),
        enrollments: removed(2),
        browserSessions: removed(3),
        credentials: removed(4),
      }
    },
  }
}

function toBrowserSession(row: SessionRecord): BrowserSessionRow {
  return {
    id: row.id,
    userID: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }
}

function toTransaction(row: TransactionRecord): OAuthTransactionRow {
  return {
    id: row.id,
    stateHash: row.state_hash,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    redirectAfter: row.redirect_after,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  }
}

function toDevice(row: DeviceRecord): DeviceRow {
  const publicKey = parsePublicKey(JSON.parse(row.public_key_jwk))
  if (!publicKey.ok) throw new Error("stored device public key is not a valid P-256 JWK")
  return {
    id: row.id,
    userID: row.user_id,
    name: row.name,
    publicKey: publicKey.value,
    createdAt: row.created_at,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }
}

function toEnrollment(row: EnrollmentRecord): EnrollmentRow {
  return {
    id: row.id,
    codeHash: row.code_hash,
    userID: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.device_id === null ? {} : { deviceID: row.device_id }),
  }
}

function toChallenge(row: ChallengeRecord): ChallengeRow {
  return {
    id: row.id,
    deviceID: row.device_id,
    nonce: row.nonce,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  }
}

function toCredential(row: CredentialRecord): CredentialRow {
  return {
    id: row.id,
    deviceID: row.device_id,
    kind: (row.kind === "refresh" ? "refresh" : "access") satisfies CredentialKind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }
}
