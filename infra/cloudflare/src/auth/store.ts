import type { RemotePublicKey } from "../../../../packages/remote/src/index"

/**
 * Storage port for durable authentication metadata. The Durable Object and HTTP
 * layer depend on this port, not on SQL, so the state transitions in
 * `auth/service.ts` are exercised against an in-memory store while the D1
 * implementation is verified against real Wrangler/D1.
 *
 * Nothing here stores transcripts, session contents, provider payloads, or
 * plaintext credentials.
 */

export type IdentityRow = {
  readonly provider: string
  readonly subject: string
  readonly userID: string
}

export type BrowserSessionRow = {
  readonly id: string
  readonly userID: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
}

export type OAuthTransactionRow = {
  readonly id: string
  readonly stateHash: string
  readonly nonce: string
  readonly codeVerifier: string
  readonly redirectAfter: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly consumedAt?: number
}

export type DeviceRow = {
  readonly id: string
  readonly userID: string
  readonly name: string
  readonly publicKey: RemotePublicKey
  readonly createdAt: number
  readonly lastSeenAt?: number
  readonly revokedAt?: number
}

export type EnrollmentRow = {
  readonly id: string
  readonly codeHash: string
  readonly userID: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly consumedAt?: number
  readonly deviceID?: string
}

export type ChallengeRow = {
  readonly id: string
  readonly deviceID: string
  readonly nonce: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly consumedAt?: number
}

export type CredentialKind = "access" | "refresh"

export type CredentialRow = {
  readonly id: string
  readonly deviceID: string
  readonly kind: CredentialKind
  readonly createdAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
}

export type AuthStore = {
  /** Read-only liveness probe for the health endpoint. */
  readonly health: () => Promise<boolean>
  /** Returns the stable user ID for a provider subject, creating it on first sight. */
  readonly findOrCreateUser: (provider: string, subject: string, now: number) => Promise<string>
  readonly insertBrowserSession: (row: Omit<BrowserSessionRow, "revokedAt">) => Promise<void>
  readonly findBrowserSession: (id: string) => Promise<BrowserSessionRow | undefined>
  readonly revokeBrowserSession: (id: string, now: number) => Promise<void>
  /**
   * Atomically revokes the current session and inserts its replacement. Returns
   * false when the current session was already revoked or expired, in which case
   * nothing is written.
   */
  readonly rotateBrowserSession: (currentID: string, next: Omit<BrowserSessionRow, "revokedAt">, now: number) => Promise<boolean>
  readonly insertOAuthTransaction: (row: Omit<OAuthTransactionRow, "consumedAt">) => Promise<void>
  readonly findOAuthTransaction: (id: string) => Promise<OAuthTransactionRow | undefined>
  /** Atomically marks the transaction consumed; false when it was already consumed or absent. */
  readonly consumeOAuthTransaction: (id: string, now: number) => Promise<boolean>
  readonly insertDevice: (row: Omit<DeviceRow, "lastSeenAt" | "revokedAt">) => Promise<void>
  readonly findDevice: (id: string) => Promise<DeviceRow | undefined>
  readonly listDevices: (userID: string) => Promise<readonly DeviceRow[]>
  readonly markDeviceSeen: (id: string, now: number) => Promise<void>
  /** Atomically revokes an owner's device and its credentials; false when not owned or already revoked. */
  readonly revokeDevice: (id: string, userID: string, now: number) => Promise<boolean>
  readonly insertEnrollment: (row: Omit<EnrollmentRow, "consumedAt" | "deviceID">) => Promise<void>
  readonly findEnrollment: (id: string) => Promise<EnrollmentRow | undefined>
  /** Atomically binds the enrollment to a device; false when already consumed. */
  readonly consumeEnrollment: (id: string, now: number, deviceID: string) => Promise<boolean>
  readonly insertChallenge: (row: Omit<ChallengeRow, "consumedAt">) => Promise<void>
  readonly findChallenge: (id: string) => Promise<ChallengeRow | undefined>
  /** Atomically marks the challenge consumed; false when it was already consumed or absent. */
  readonly consumeChallenge: (id: string, now: number) => Promise<boolean>
  readonly insertCredential: (row: Omit<CredentialRow, "revokedAt">) => Promise<void>
  readonly findCredential: (id: string) => Promise<CredentialRow | undefined>
  /**
   * Atomically revokes the presented credential and inserts its replacement.
   * Returns false when the presented credential was already revoked or expired,
   * in which case nothing is written.
   */
  readonly rotateCredential: (currentID: string, next: Omit<CredentialRow, "revokedAt">, now: number) => Promise<boolean>
  readonly revokeCredential: (id: string, now: number) => Promise<void>
  /**
   * Bounded cleanup of expired authentication metadata. Deletes at most
   * `limit` rows per table and returns how many rows were removed.
   */
  readonly deleteExpired: (now: number, retentionMs: number, limit: number) => Promise<ExpiredCounts>
}

export type ExpiredCounts = {
  readonly oauthTransactions: number
  readonly challenges: number
  readonly enrollments: number
  readonly browserSessions: number
  readonly credentials: number
}
