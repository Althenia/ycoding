import type {
  AuthStore,
  ExpiredCounts,
  BrowserSessionRow,
  ChallengeRow,
  CredentialRow,
  DeviceRow,
  EnrollmentRow,
  OAuthTransactionRow,
} from "../../src/auth/store"

/**
 * In-memory `AuthStore` used by unit tests. It mirrors the atomic guarantees the
 * D1 implementation provides ("consume once", "rotate once") so state transitions
 * under test match production behaviour.
 */
export function createMemoryAuthStore(): AuthStore {
  const users = new Map<string, string>()
  const identities = new Map<string, string>()
  const sessions = new Map<string, BrowserSessionRow>()
  const transactions = new Map<string, OAuthTransactionRow>()
  const devices = new Map<string, DeviceRow>()
  const enrollments = new Map<string, EnrollmentRow>()
  const challenges = new Map<string, ChallengeRow>()
  const credentials = new Map<string, CredentialRow>()
  let userSequence = 0

  return {
    health: async () => true,
    findOrCreateUser: async (provider, subject) => {
      const key = `${provider}:${subject}`
      const existing = identities.get(key)
      if (existing !== undefined) return existing
      userSequence += 1
      const userID = `usr_${userSequence}`
      identities.set(key, userID)
      users.set(userID, provider)
      return userID
    },
    insertBrowserSession: async (row) => {
      sessions.set(row.id, row)
    },
    findBrowserSession: async (id) => sessions.get(id),
    revokeBrowserSession: async (id, now) => {
      const row = sessions.get(id)
      if (row) sessions.set(id, { ...row, revokedAt: now })
    },
    rotateBrowserSession: async (currentID, next, now) => {
      const row = sessions.get(currentID)
      if (!row || row.revokedAt !== undefined || now >= row.expiresAt) return false
      sessions.set(currentID, { ...row, revokedAt: now })
      sessions.set(next.id, next)
      return true
    },
    insertOAuthTransaction: async (row) => {
      transactions.set(row.id, row)
    },
    findOAuthTransaction: async (id) => transactions.get(id),
    consumeOAuthTransaction: async (id, now) => {
      const row = transactions.get(id)
      if (!row || row.consumedAt !== undefined || now >= row.expiresAt) return false
      transactions.set(id, { ...row, consumedAt: now })
      return true
    },
    insertDevice: async (row) => {
      devices.set(row.id, row)
    },
    findDevice: async (id) => devices.get(id),
    listDevices: async (userID) => [...devices.values()].filter((row) => row.userID === userID),
    markDeviceSeen: async (id, now) => {
      const row = devices.get(id)
      if (row) devices.set(id, { ...row, lastSeenAt: now })
    },
    revokeDevice: async (id, userID, now) => {
      const row = devices.get(id)
      if (!row || row.userID !== userID || row.revokedAt !== undefined) return false
      devices.set(id, { ...row, revokedAt: now })
      for (const [credentialID, credential] of credentials)
        if (credential.deviceID === id) credentials.set(credentialID, { ...credential, revokedAt: now })
      return true
    },
    insertEnrollment: async (row) => {
      enrollments.set(row.id, row)
    },
    findEnrollment: async (id) => enrollments.get(id),
    consumeEnrollment: async (id, now, deviceID) => {
      const row = enrollments.get(id)
      if (!row || row.consumedAt !== undefined) return false
      enrollments.set(id, { ...row, consumedAt: now, deviceID })
      return true
    },
    insertChallenge: async (row) => {
      challenges.set(row.id, row)
    },
    findChallenge: async (id) => challenges.get(id),
    consumeChallenge: async (id, now) => {
      const row = challenges.get(id)
      if (!row || row.consumedAt !== undefined || now >= row.expiresAt) return false
      challenges.set(id, { ...row, consumedAt: now })
      return true
    },
    insertCredential: async (row) => {
      credentials.set(row.id, row)
    },
    findCredential: async (id) => credentials.get(id),
    rotateCredential: async (currentID, next, now) => {
      const row = credentials.get(currentID)
      if (!row || row.revokedAt !== undefined || now >= row.expiresAt) return false
      credentials.set(currentID, { ...row, revokedAt: now })
      credentials.set(next.id, next)
      return true
    },
    revokeCredential: async (id, now) => {
      const row = credentials.get(id)
      if (row) credentials.set(id, { ...row, revokedAt: now })
    },

    deleteExpired: async (now, retentionMs, limit) => {
      const before = now - retentionMs
      const counts = { oauthTransactions: 0, challenges: 0, enrollments: 0, browserSessions: 0, credentials: 0 }
      const drop = <T extends { readonly id: string }>(
        values: Map<string, T>,
        predicate: (row: T) => boolean,
        key: keyof ExpiredCounts,
      ) => {
        for (const [id, row] of [...values]) {
          if (counts[key] >= limit) break
          if (!predicate(row)) continue
          values.delete(id)
          counts[key] += 1
        }
      }
      drop(transactions, (row) => row.expiresAt < before || (row.consumedAt !== undefined && row.consumedAt < before), "oauthTransactions")
      drop(challenges, (row) => row.expiresAt < before || (row.consumedAt !== undefined && row.consumedAt < before), "challenges")
      drop(enrollments, (row) => row.expiresAt < before || (row.consumedAt !== undefined && row.consumedAt < before), "enrollments")
      drop(sessions, (row) => row.expiresAt < before, "browserSessions")
      drop(credentials, (row) => row.expiresAt < before, "credentials")
      return counts
    },
  }
}
