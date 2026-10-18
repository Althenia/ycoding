import { oauthTransactionTtlMs } from "../service"
import type {
  McpAuthorizationRow,
  McpClientRow,
  McpCodeRow,
  McpDeviceRow,
  McpGrantRow,
  McpStore,
  McpTokenRow,
} from "./store"

export function createMemoryMcpStore(): McpStore {
  const devices = new Map<string, McpDeviceRow>()
  const clients = new Map<string, McpClientRow>()
  const authorizations = new Map<string, McpAuthorizationRow>()
  const grants = new Map<string, McpGrantRow>()
  const codes = new Map<string, McpCodeRow>()
  const tokens = new Map<string, McpTokenRow>()

  const pendingCount = () => [...clients.values()].filter((client) => client.firstAuthorizedAt === undefined).length

  const deleteGrant = (id: string) => {
    grants.delete(id)
    for (const [hash, code] of codes) if (code.grantID === id) codes.delete(hash)
    for (const [hash, token] of tokens) if (token.grantID === id) tokens.delete(hash)
  }

  const grantLive = (id: string, now: number) => {
    const grant = grants.get(id)
    if (!grant || grant.revokedAt !== undefined || now >= grant.expiresAt) return false
    const device = devices.get(grant.deviceID)
    return device !== undefined && device.enabled && device.epoch === grant.epoch
  }

  const openAuthorization = (id: string, now: number) => {
    const row = authorizations.get(id)
    return row && row.consumedAt === undefined && now < row.expiresAt ? row : undefined
  }

  const update = (row: McpAuthorizationRow, changes: Partial<McpAuthorizationRow>) => {
    authorizations.set(row.id, { ...row, ...changes })
  }

  const sweep = <Key, Row>(
    rows: Map<Key, Row>,
    limit: number,
    expired: (row: Row) => boolean,
    remove: (key: Key) => void,
  ) => {
    const keys = [...rows]
      .filter(([, row]) => expired(row))
      .slice(0, limit)
      .map(([key]) => key)
    for (const key of keys) remove(key)
    return keys.length
  }

  return {
    getDevice: async (deviceID) => devices.get(deviceID),
    setDevice: async (input) => {
      const keep = (epoch: string) => input.enabled && epoch === input.epoch
      for (const [id, grant] of grants) if (grant.deviceID === input.deviceID && !keep(grant.epoch)) deleteGrant(id)
      for (const [id, row] of authorizations)
        if (row.deviceID === input.deviceID && !keep(row.epoch)) authorizations.delete(id)
      devices.set(input.deviceID, {
        deviceID: input.deviceID,
        enabled: input.enabled,
        epoch: input.epoch,
        updatedAt: input.now,
      })
    },
    saveClient: async (row, limit) => {
      const existing = clients.get(row.id)
      if (existing) {
        clients.set(row.id, { ...existing, name: row.name, redirectUris: row.redirectUris, createdAt: row.createdAt })
        return true
      }
      if (pendingCount() >= limit) return false
      clients.set(row.id, row)
      return true
    },
    findClient: async (id) => clients.get(id),
    countPendingClients: async () => pendingCount(),

    insertAuthorization: async (row) => {
      authorizations.set(row.id, row)
    },
    findAuthorization: async (id) => authorizations.get(id),
    beginGoogle: async (input) => {
      const row = openAuthorization(input.id, input.now)
      if (!row || row.stage !== "notice" || row.csrfHash !== input.csrfHash) return false
      authorizations.set(row.id, {
        ...omit(row, "csrfHash"),
        stage: "google",
        googleStateHash: input.stateHash,
        googleNonce: input.nonce,
        googleVerifier: input.verifier,
      })
      return true
    },
    takeGoogle: async (input) => {
      const row = openAuthorization(input.id, input.now)
      if (!row || row.stage !== "google" || row.googleStateHash !== input.stateHash) return false
      update(row, { stage: "exchanging" })
      return true
    },
    bindOwner: async (input) => {
      const row = openAuthorization(input.id, input.now)
      if (!row || row.stage !== "exchanging") return false
      authorizations.set(row.id, {
        ...omit(row, "googleStateHash", "googleNonce", "googleVerifier"),
        stage: "consent",
        ownerID: input.ownerID,
        csrfHash: input.csrfHash,
      })
      return true
    },
    burnAuthorization: async (id, now) => {
      const row = authorizations.get(id)
      if (row && row.consumedAt === undefined) update(row, { consumedAt: now })
    },
    denyConsent: async (input) => {
      const row = openAuthorization(input.id, input.now)
      if (!row || row.stage !== "consent" || row.csrfHash !== input.csrfHash) return false
      update(row, { consumedAt: input.now })
      return true
    },
    allowConsent: async (input) => {
      const row = openAuthorization(input.id, input.now)
      if (!row || row.stage !== "consent" || row.csrfHash !== input.csrfHash || row.ownerID !== input.grant.ownerID)
        return false
      const device = devices.get(row.deviceID)
      if (!device || !device.enabled || device.epoch !== row.epoch) return false
      update(row, { consumedAt: input.now })
      const client = clients.get(row.clientID)
      if (client && client.firstAuthorizedAt === undefined)
        clients.set(client.id, { ...client, firstAuthorizedAt: input.now })
      grants.set(input.grant.id, input.grant)
      codes.set(input.code.hash, input.code)
      return true
    },

    findGrant: async (id) => grants.get(id),
    findCode: async (hash) => {
      const code = codes.get(hash)
      const grant = code && grants.get(code.grantID)
      return code && grant ? { code, grant } : undefined
    },
    findToken: async (hash) => {
      const token = tokens.get(hash)
      const grant = token && grants.get(token.grantID)
      return token && grant ? { token, grant } : undefined
    },
    exchangeCode: async (input) => {
      const code = codes.get(input.codeHash)
      if (!code || code.consumedAt !== undefined || input.now >= code.expiresAt || !grantLive(code.grantID, input.now))
        return false
      codes.set(code.hash, { ...code, consumedAt: input.now })
      tokens.set(input.access.hash, input.access)
      tokens.set(input.refresh.hash, input.refresh)
      return true
    },
    rotateRefresh: async (input) => {
      const token = tokens.get(input.tokenHash)
      if (
        !token ||
        token.kind !== "refresh" ||
        token.consumedAt !== undefined ||
        token.revokedAt !== undefined ||
        input.now >= token.expiresAt ||
        !grantLive(token.grantID, input.now)
      )
        return false
      tokens.set(token.hash, { ...token, consumedAt: input.now, rotatedTo: input.refresh.hash })
      tokens.set(input.access.hash, input.access)
      tokens.set(input.refresh.hash, input.refresh)
      return true
    },
    revokeGrant: async (id, now) => {
      const grant = grants.get(id)
      if (grant && grant.revokedAt === undefined) grants.set(id, { ...grant, revokedAt: now })
      for (const [hash, token] of tokens)
        if (token.grantID === id && token.revokedAt === undefined) tokens.set(hash, { ...token, revokedAt: now })
    },
    deleteDeviceGrants: async (deviceID) => {
      for (const [id, grant] of grants) if (grant.deviceID === deviceID) deleteGrant(id)
    },
    deleteExpired: async (now, retentionMs, limit) => {
      const before = now - retentionMs
      const tokenCount = sweep(
        tokens,
        limit,
        (row) => row.expiresAt < before,
        (key) => tokens.delete(key),
      )
      const codeCount = sweep(
        codes,
        limit,
        (row) => row.expiresAt < before,
        (key) => codes.delete(key),
      )
      const authorizationCount = sweep(
        authorizations,
        limit,
        (row) => row.expiresAt < before || (row.consumedAt !== undefined && row.consumedAt < before),
        (key) => authorizations.delete(key),
      )
      const grantCount = sweep(
        grants,
        limit,
        (row) => row.expiresAt < before || (row.revokedAt !== undefined && row.revokedAt < before),
        deleteGrant,
      )
      const clientCount = sweep(
        clients,
        limit,
        (row) =>
          row.firstAuthorizedAt === undefined &&
          row.createdAt < before - oauthTransactionTtlMs &&
          ![...authorizations.values()].some((authorization) => authorization.clientID === row.id) &&
          ![...grants.values()].some((grant) => grant.clientID === row.id),
        (key) => clients.delete(key),
      )
      return {
        authorizations: authorizationCount,
        codes: codeCount,
        tokens: tokenCount,
        grants: grantCount,
        clients: clientCount,
      }
    },
  }
}

function omit<Row extends object, Key extends keyof Row>(row: Row, ...keys: readonly Key[]): Omit<Row, Key> {
  const dropped: readonly PropertyKey[] = keys
  return Object.fromEntries(Object.entries(row).filter(([key]) => !dropped.includes(key))) as Omit<Row, Key>
}
