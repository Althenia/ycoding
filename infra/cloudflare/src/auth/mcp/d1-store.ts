import { randomToken } from "../crypto"
import { oauthTransactionTtlMs } from "../service"
import type {
  McpAuthorizationRow,
  McpAuthorizationStage,
  McpClientRow,
  McpGrantRow,
  McpStore,
  McpTokenRow,
} from "./store"

type ClientRecord = {
  readonly client_id: string
  readonly kind: string
  readonly name: string
  readonly redirect_uris: string
  readonly auth_method: string
  readonly created_at: number
  readonly first_authorized_at: number | null
}

type AuthorizationRecord = {
  readonly id: string
  readonly client_id: string
  readonly device_id: string
  readonly resource: string
  readonly scope: string
  readonly redirect_uri: string
  readonly client_state: string | null
  readonly code_challenge: string
  readonly stage: string
  readonly google_state_hash: string | null
  readonly google_nonce: string | null
  readonly google_verifier: string | null
  readonly csrf_hash: string | null
  readonly owner_id: string | null
  readonly enable_epoch: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

type GrantRecord = {
  readonly grant_id: string
  readonly client_id: string
  readonly device_id: string
  readonly owner_id: string
  readonly resource: string
  readonly scope: string
  readonly enable_epoch: string
  readonly consented_at: number
  readonly grant_expires_at: number
  readonly grant_revoked_at: number | null
}

type CodeRecord = GrantRecord & {
  readonly code_hash: string
  readonly redirect_uri: string
  readonly code_challenge: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

type TokenRecord = GrantRecord & {
  readonly token_hash: string
  readonly kind: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
  readonly revoked_at: number | null
  readonly rotated_to: string | null
}

type DeviceRecord = {
  readonly device_id: string
  readonly enabled: number
  readonly enable_epoch: string
  readonly updated_at: number
}

const grantColumns =
  "g.id AS grant_id, g.client_id, g.device_id, g.owner_id, g.resource, g.scope, g.enable_epoch, g.consented_at, g.expires_at AS grant_expires_at, g.revoked_at AS grant_revoked_at"

const authorizationColumns =
  "id, client_id, device_id, resource, scope, redirect_uri, client_state, code_challenge, stage, google_state_hash, google_nonce, google_verifier, csrf_hash, owner_id, enable_epoch, created_at, expires_at, consumed_at"

function grantLive(grantID: string) {
  return `EXISTS (SELECT 1 FROM mcp_grant g JOIN mcp_device d ON d.device_id = g.device_id JOIN device v ON v.id = g.device_id WHERE g.id = ${grantID} AND g.revoked_at IS NULL AND g.expires_at > ? AND d.enabled = 1 AND d.enable_epoch = g.enable_epoch AND v.user_id = g.owner_id AND v.revoked_at IS NULL)`
}

const tokenInsert =
  "INSERT INTO mcp_token (token_hash, grant_id, kind, created_at, expires_at) SELECT ?, ?, ?, ?, ? WHERE"

export function createD1McpStore(db: D1Database): McpStore {
  const changed = (result: D1Result | undefined) => result?.meta.changes === 1

  const insertTokens = (
    guard: string,
    guardValues: readonly (string | number)[],
    access: McpTokenRow,
    refresh: McpTokenRow,
  ) =>
    [access, refresh].map((token) =>
      db
        .prepare(`${tokenInsert} ${guard}`)
        .bind(token.hash, token.grantID, token.kind, token.createdAt, token.expiresAt, ...guardValues),
    )

  return {
    async getDevice(deviceID) {
      const row = await db
        .prepare("SELECT device_id, enabled, enable_epoch, updated_at FROM mcp_device WHERE device_id = ?")
        .bind(deviceID)
        .first<DeviceRecord>()
      return row
        ? { deviceID: row.device_id, enabled: row.enabled === 1, epoch: row.enable_epoch, updatedAt: row.updated_at }
        : undefined
    },

    async setDevice(input) {
      const enabled = input.enabled ? 1 : 0
      await db.batch([
        db
          .prepare("DELETE FROM mcp_grant WHERE device_id = ? AND (? = 0 OR enable_epoch <> ?)")
          .bind(input.deviceID, enabled, input.epoch),
        db
          .prepare("DELETE FROM mcp_authorization WHERE device_id = ? AND (? = 0 OR enable_epoch <> ?)")
          .bind(input.deviceID, enabled, input.epoch),
        db
          .prepare(
            "INSERT INTO mcp_device (device_id, enabled, enable_epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET enabled = excluded.enabled, enable_epoch = excluded.enable_epoch, updated_at = excluded.updated_at",
          )
          .bind(input.deviceID, enabled, input.epoch, input.now),
      ])
    },

    async saveClient(row, limit) {
      const result = await db
        .prepare(
          "INSERT INTO mcp_client (client_id, kind, name, redirect_uris, auth_method, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mcp_client WHERE client_id = ?) OR (SELECT COUNT(*) FROM mcp_client WHERE first_authorized_at IS NULL) < ? ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, created_at = excluded.created_at",
        )
        .bind(
          row.id,
          row.kind,
          row.name,
          JSON.stringify(row.redirectUris),
          row.authMethod,
          row.createdAt,
          row.id,
          limit,
        )
        .run()
      return changed(result)
    },

    async findClient(id) {
      const row = await db
        .prepare(
          "SELECT client_id, kind, name, redirect_uris, auth_method, created_at, first_authorized_at FROM mcp_client WHERE client_id = ?",
        )
        .bind(id)
        .first<ClientRecord>()
      return row ? toClient(row) : undefined
    },

    async countPendingClients() {
      const row = await db
        .prepare("SELECT COUNT(*) AS pending FROM mcp_client WHERE first_authorized_at IS NULL")
        .first<{ pending: number }>()
      return row?.pending ?? 0
    },

    async insertAuthorization(row) {
      await db
        .prepare(
          "INSERT INTO mcp_authorization (id, client_id, device_id, resource, scope, redirect_uri, client_state, code_challenge, stage, csrf_hash, enable_epoch, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          row.id,
          row.clientID,
          row.deviceID,
          row.resource,
          row.scope,
          row.redirectUri,
          row.clientState ?? null,
          row.codeChallenge,
          row.stage,
          row.csrfHash ?? null,
          row.epoch,
          row.createdAt,
          row.expiresAt,
        )
        .run()
    },

    async findAuthorization(id) {
      const row = await db
        .prepare(`SELECT ${authorizationColumns} FROM mcp_authorization WHERE id = ?`)
        .bind(id)
        .first<AuthorizationRecord>()
      return row ? toAuthorization(row) : undefined
    },

    async beginGoogle(input) {
      const result = await db
        .prepare(
          "UPDATE mcp_authorization SET stage = 'google', csrf_hash = NULL, google_state_hash = ?, google_nonce = ?, google_verifier = ? WHERE id = ? AND stage = 'notice' AND csrf_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .bind(input.stateHash, input.nonce, input.verifier, input.id, input.csrfHash, input.now)
        .run()
      return changed(result)
    },

    async takeGoogle(input) {
      const result = await db
        .prepare(
          "UPDATE mcp_authorization SET stage = 'exchanging' WHERE id = ? AND stage = 'google' AND google_state_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .bind(input.id, input.stateHash, input.now)
        .run()
      return changed(result)
    },

    async bindOwner(input) {
      const result = await db
        .prepare(
          "UPDATE mcp_authorization SET stage = 'consent', owner_id = ?, csrf_hash = ?, google_state_hash = NULL, google_nonce = NULL, google_verifier = NULL WHERE id = ? AND stage = 'exchanging' AND consumed_at IS NULL AND expires_at > ?",
        )
        .bind(input.ownerID, input.csrfHash, input.id, input.now)
        .run()
      return changed(result)
    },

    async burnAuthorization(id, now) {
      await db
        .prepare(
          "UPDATE mcp_authorization SET consumed_at = ?, google_nonce = NULL, google_verifier = NULL WHERE id = ? AND consumed_at IS NULL",
        )
        .bind(now, id)
        .run()
    },

    async denyConsent(input) {
      const result = await db
        .prepare(
          "UPDATE mcp_authorization SET consumed_at = ? WHERE id = ? AND stage = 'consent' AND csrf_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .bind(input.now, input.id, input.csrfHash, input.now)
        .run()
      return changed(result)
    },

    async allowConsent(input) {
      const nonce = randomToken(16)
      const results = await db.batch([
        db
          .prepare(
            "UPDATE mcp_authorization SET consumed_at = ?, consume_nonce = ? WHERE id = ? AND stage = 'consent' AND csrf_hash = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM mcp_device d JOIN device v ON v.id = d.device_id WHERE d.device_id = mcp_authorization.device_id AND d.enabled = 1 AND d.enable_epoch = mcp_authorization.enable_epoch AND v.user_id = mcp_authorization.owner_id AND v.revoked_at IS NULL)",
          )
          .bind(input.now, nonce, input.id, input.csrfHash, input.grant.ownerID, input.now),
        db
          .prepare(
            "INSERT INTO mcp_grant (id, client_id, device_id, owner_id, resource, scope, enable_epoch, consented_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mcp_authorization WHERE id = ? AND consume_nonce = ?)",
          )
          .bind(
            input.grant.id,
            input.grant.clientID,
            input.grant.deviceID,
            input.grant.ownerID,
            input.grant.resource,
            input.grant.scope,
            input.grant.epoch,
            input.grant.consentedAt,
            input.grant.expiresAt,
            input.id,
            nonce,
          ),
        db
          .prepare(
            "INSERT INTO mcp_code (code_hash, grant_id, redirect_uri, code_challenge, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mcp_authorization WHERE id = ? AND consume_nonce = ?)",
          )
          .bind(
            input.code.hash,
            input.code.grantID,
            input.code.redirectUri,
            input.code.codeChallenge,
            input.code.createdAt,
            input.code.expiresAt,
            input.id,
            nonce,
          ),
        db
          .prepare(
            "UPDATE mcp_client SET first_authorized_at = COALESCE(first_authorized_at, ?) WHERE client_id = ? AND EXISTS (SELECT 1 FROM mcp_authorization WHERE id = ? AND consume_nonce = ?)",
          )
          .bind(input.now, input.grant.clientID, input.id, nonce),
      ])
      return results.length === 4 && results.every(changed)
    },

    async findGrant(id) {
      const row = await db
        .prepare(`SELECT ${grantColumns} FROM mcp_grant g WHERE g.id = ?`)
        .bind(id)
        .first<GrantRecord>()
      return row ? toGrant(row) : undefined
    },

    async findCode(hash) {
      const row = await db
        .prepare(
          `SELECT c.code_hash, c.redirect_uri, c.code_challenge, c.created_at, c.expires_at, c.consumed_at, ${grantColumns} FROM mcp_code c JOIN mcp_grant g ON g.id = c.grant_id WHERE c.code_hash = ?`,
        )
        .bind(hash)
        .first<CodeRecord>()
      if (!row) return undefined
      return {
        code: {
          hash: row.code_hash,
          grantID: row.grant_id,
          redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
        },
        grant: toGrant(row),
      }
    },

    async findToken(hash) {
      const row = await db
        .prepare(
          `SELECT t.token_hash, t.kind, t.created_at, t.expires_at, t.consumed_at, t.revoked_at, t.rotated_to, ${grantColumns} FROM mcp_token t JOIN mcp_grant g ON g.id = t.grant_id WHERE t.token_hash = ?`,
        )
        .bind(hash)
        .first<TokenRecord>()
      if (!row) return undefined
      return {
        token: {
          hash: row.token_hash,
          grantID: row.grant_id,
          kind: row.kind === "refresh" ? "refresh" : "access",
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
          ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
          ...(row.rotated_to === null ? {} : { rotatedTo: row.rotated_to }),
        },
        grant: toGrant(row),
      }
    },

    async exchangeCode(input) {
      const nonce = randomToken(16)
      const results = await db.batch([
        db
          .prepare(
            `UPDATE mcp_code SET consumed_at = ?, consume_nonce = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? AND ${grantLive("mcp_code.grant_id")}`,
          )
          .bind(input.now, nonce, input.codeHash, input.now, input.now),
        ...insertTokens(
          `EXISTS (SELECT 1 FROM mcp_code WHERE code_hash = ? AND consume_nonce = ? AND ${grantLive("mcp_code.grant_id")})`,
          [input.codeHash, nonce, input.now],
          input.access,
          input.refresh,
        ),
      ])
      return results.length === 3 && results.every(changed)
    },

    async rotateRefresh(input) {
      const nonce = randomToken(16)
      const results = await db.batch([
        db
          .prepare(
            `UPDATE mcp_token SET consumed_at = ?, consume_nonce = ?, rotated_to = ? WHERE token_hash = ? AND kind = 'refresh' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND ${grantLive("mcp_token.grant_id")}`,
          )
          .bind(input.now, nonce, input.refresh.hash, input.tokenHash, input.now, input.now),
        ...insertTokens(
          `EXISTS (SELECT 1 FROM mcp_token WHERE token_hash = ? AND consume_nonce = ? AND ${grantLive("mcp_token.grant_id")})`,
          [input.tokenHash, nonce, input.now],
          input.access,
          input.refresh,
        ),
      ])
      return results.length === 3 && results.every(changed)
    },

    async revokeGrant(id, now) {
      await db.batch([
        db.prepare("UPDATE mcp_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id),
        db.prepare("UPDATE mcp_token SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, id),
      ])
    },

    async deleteDeviceGrants(deviceID) {
      await db.prepare("DELETE FROM mcp_grant WHERE device_id = ?").bind(deviceID).run()
    },

    async deleteExpired(now, retentionMs, limit) {
      const before = now - retentionMs
      const results = await db.batch([
        db
          .prepare(
            "DELETE FROM mcp_token WHERE token_hash IN (SELECT token_hash FROM mcp_token WHERE expires_at < ? LIMIT ?)",
          )
          .bind(before, limit),
        db
          .prepare(
            "DELETE FROM mcp_code WHERE code_hash IN (SELECT code_hash FROM mcp_code WHERE expires_at < ? LIMIT ?)",
          )
          .bind(before, limit),
        db
          .prepare(
            "DELETE FROM mcp_authorization WHERE id IN (SELECT id FROM mcp_authorization WHERE expires_at < ? OR consumed_at < ? LIMIT ?)",
          )
          .bind(before, before, limit),
        db
          .prepare(
            "DELETE FROM mcp_grant WHERE id IN (SELECT id FROM mcp_grant WHERE expires_at < ? OR revoked_at < ? LIMIT ?)",
          )
          .bind(before, before, limit),
        db
          .prepare(
            "DELETE FROM mcp_client WHERE client_id IN (SELECT c.client_id FROM mcp_client c WHERE c.first_authorized_at IS NULL AND c.created_at < ? AND NOT EXISTS (SELECT 1 FROM mcp_authorization a WHERE a.client_id = c.client_id) AND NOT EXISTS (SELECT 1 FROM mcp_grant g WHERE g.client_id = c.client_id) LIMIT ?)",
          )
          .bind(before - oauthTransactionTtlMs, limit),
      ])
      const removed = (index: number) => results[index]?.meta.changes ?? 0
      return {
        tokens: removed(0),
        codes: removed(1),
        authorizations: removed(2),
        grants: removed(3),
        clients: removed(4),
      }
    },
  }
}

function toClient(row: ClientRecord): McpClientRow {
  const redirectUris: unknown = JSON.parse(row.redirect_uris)
  return {
    id: row.client_id,
    kind: row.kind === "cimd" ? "cimd" : "dcr",
    name: row.name,
    redirectUris: Array.isArray(redirectUris)
      ? redirectUris.filter((value): value is string => typeof value === "string")
      : [],
    authMethod: "none",
    createdAt: row.created_at,
    ...(row.first_authorized_at === null ? {} : { firstAuthorizedAt: row.first_authorized_at }),
  }
}

function toAuthorization(row: AuthorizationRecord): McpAuthorizationRow {
  return {
    id: row.id,
    clientID: row.client_id,
    deviceID: row.device_id,
    resource: row.resource,
    scope: row.scope,
    redirectUri: row.redirect_uri,
    ...(row.client_state === null ? {} : { clientState: row.client_state }),
    codeChallenge: row.code_challenge,
    stage: stages[row.stage] ?? "notice",
    ...(row.google_state_hash === null ? {} : { googleStateHash: row.google_state_hash }),
    ...(row.google_nonce === null ? {} : { googleNonce: row.google_nonce }),
    ...(row.google_verifier === null ? {} : { googleVerifier: row.google_verifier }),
    ...(row.csrf_hash === null ? {} : { csrfHash: row.csrf_hash }),
    ...(row.owner_id === null ? {} : { ownerID: row.owner_id }),
    epoch: row.enable_epoch,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  }
}

const stages: Record<string, McpAuthorizationStage> = {
  notice: "notice",
  google: "google",
  exchanging: "exchanging",
  consent: "consent",
}

function toGrant(row: GrantRecord): McpGrantRow {
  return {
    id: row.grant_id,
    clientID: row.client_id,
    deviceID: row.device_id,
    ownerID: row.owner_id,
    resource: row.resource,
    scope: row.scope,
    epoch: row.enable_epoch,
    consentedAt: row.consented_at,
    expiresAt: row.grant_expires_at,
    ...(row.grant_revoked_at === null ? {} : { revokedAt: row.grant_revoked_at }),
  }
}
