/**
 * Authentication state transitions: Google sign-in sessions, device enrollment,
 * challenge/credential issuance, rotation, revocation, and the relay's
 * per-command authorization checks.
 *
 * All durable state goes through `AuthStore`. Nothing here stores plaintext
 * credentials: cookie tokens, enrollment codes, challenges, and device tokens are
 * persisted as SHA-256 hashes.
 */

import type { DeviceTokenResponse, RemoteDeviceInfo, RemotePublicKey } from "../../../../packages/remote/src/index"
import {
  deviceSignaturePayload,
  enrollmentCodeChars,
  enrollmentCodePattern,
} from "../../../../packages/remote/src/index"
import { constantTimeEqual, randomToken, sha256Base64Url, sha256Hex, verifyP256Signature } from "./crypto"
import type { AuthStore, BrowserSessionRow, CredentialKind, CredentialRow, DeviceRow } from "./store"

export const browserSessionTtlMs = 30 * 24 * 60 * 60 * 1000
export const browserSessionRotationMs = browserSessionTtlMs / 2
export const oauthTransactionTtlMs = 10 * 60 * 1000
export const enrollmentTtlMs = 10 * 60 * 1000
export const challengeTtlMs = 2 * 60 * 1000
export const accessCredentialTtlMs = 10 * 60 * 1000
export const refreshCredentialTtlMs = 30 * 24 * 60 * 60 * 1000

/**
 * Retained after expiry so an operator can still see a recent credential or
 * session that expired or was revoked. Expired authentication metadata is
 * deleted after this window; no transcript or session content is ever stored.
 */
export const expiredMetadataRetentionMs = 7 * 24 * 60 * 60 * 1000
/** Rows removed per table per cleanup pass, keeping each pass bounded. */
export const cleanupLimit = 500

export type AuthRejection =
  | "unknown_transaction"
  | "consumed_transaction"
  | "expired_transaction"
  | "state_mismatch"
  | "unknown_session"
  | "revoked_session"
  | "expired_session"
  | "unknown_device"
  | "revoked_device"
  | "unknown_enrollment"
  | "consumed_enrollment"
  | "expired_enrollment"
  | "bad_enrollment_code"
  | "unknown_challenge"
  | "consumed_challenge"
  | "expired_challenge"
  | "challenge_mismatch"
  | "bad_signature"
  | "unknown_credential"
  | "revoked_credential"
  | "expired_credential"
  | "wrong_credential_kind"
  | "not_owner"

export type Outcome<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly reason: AuthRejection }

const enrollmentAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const remotePathPrefix = "/remote"

/** Keeps the post-login redirect on this origin under the remote app prefix. */
export function safeRedirectAfter(value: unknown): string {
  const fallback = "/remote/"
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback
  if (!value.startsWith(remotePathPrefix)) return fallback
  if (value.startsWith("//") || value.includes("\\") || value.includes("\n") || value.includes("\r")) return fallback
  return value
}

export type BrowserSession = {
  readonly sessionID: string
  readonly userID: string
  readonly expiresAt: number
}

export type AuthService = ReturnType<typeof createAuthService>

export function createAuthService(store: AuthStore, options: { readonly now?: () => number } = {}) {
  const now = options.now ?? Date.now

  const validateSession = (row: BrowserSessionRow | undefined): Outcome<BrowserSessionRow> => {
    if (!row) return { ok: false, reason: "unknown_session" }
    if (row.revokedAt !== undefined) return { ok: false, reason: "revoked_session" }
    if (now() >= row.expiresAt) return { ok: false, reason: "expired_session" }
    return { ok: true, value: row }
  }

  const validateCredential = async (token: string, kind: CredentialKind): Promise<Outcome<CredentialRow>> => {
    const row = await store.findCredential(await sha256Hex(token))
    if (!row) return { ok: false, reason: "unknown_credential" }
    return validateCredentialRow(row, kind)
  }

  const validateCredentialRow = (row: CredentialRow, kind: CredentialKind): Outcome<CredentialRow> => {
    if (row.revokedAt !== undefined) return { ok: false, reason: "revoked_credential" }
    if (row.kind !== kind) return { ok: false, reason: "wrong_credential_kind" }
    if (now() >= row.expiresAt) return { ok: false, reason: "expired_credential" }
    return { ok: true, value: row }
  }

  const requireActiveDevice = async (deviceID: string): Promise<Outcome<DeviceRow>> => {
    const device = await store.findDevice(deviceID)
    if (!device || device.revokedAt !== undefined) return { ok: false, reason: "unknown_device" }
    return { ok: true, value: device }
  }

  /**
   * Like `requireActiveDevice` but distinguishes a revoked device. Used where the
   * caller already proved it knows the device ID, so precision beats
   * anti-enumeration.
   */
  const requireKnownActiveDevice = async (deviceID: string): Promise<Outcome<DeviceRow>> => {
    const device = await store.findDevice(deviceID)
    if (!device) return { ok: false, reason: "unknown_device" }
    if (device.revokedAt !== undefined) return { ok: false, reason: "revoked_device" }
    return { ok: true, value: device }
  }

  const issueCredentials = async (deviceID: string): Promise<Outcome<DeviceTokenResponse>> => {
    const device = await requireActiveDevice(deviceID)
    if (!device.ok) return device
    const issuedAt = now()
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    const accessExpiresAt = issuedAt + accessCredentialTtlMs
    const refreshExpiresAt = issuedAt + refreshCredentialTtlMs
    await store.insertCredential({
      id: await sha256Hex(accessToken),
      deviceID,
      kind: "access",
      createdAt: issuedAt,
      expiresAt: accessExpiresAt,
    })
    await store.insertCredential({
      id: await sha256Hex(refreshToken),
      deviceID,
      kind: "refresh",
      createdAt: issuedAt,
      expiresAt: refreshExpiresAt,
    })
    return { ok: true, value: { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt } }
  }

  return {
    safeRedirectAfter,
    health: () => store.health(),
    cleanup: () => store.deleteExpired(now(), expiredMetadataRetentionMs, cleanupLimit),

    async beginOAuth(input: { readonly redirectAfter: unknown }) {
      const createdAt = now()
      const state = randomToken(24)
      const nonce = randomToken(24)
      const codeVerifier = randomToken(32)
      const cookieToken = randomToken(32)
      await store.insertOAuthTransaction({
        id: await sha256Hex(cookieToken),
        stateHash: await sha256Hex(state),
        nonce,
        codeVerifier,
        redirectAfter: safeRedirectAfter(input.redirectAfter),
        createdAt,
        expiresAt: createdAt + oauthTransactionTtlMs,
      })
      return {
        cookieToken,
        state,
        nonce,
        codeVerifier,
        codeChallenge: await sha256Base64Url(codeVerifier),
        redirectAfter: safeRedirectAfter(input.redirectAfter),
        expiresAt: createdAt + oauthTransactionTtlMs,
      }
    },

    async consumeOAuthTransaction(cookieToken: string, state: string) {
      const id = await sha256Hex(cookieToken)
      const row = await store.findOAuthTransaction(id)
      if (!row) return { ok: false as const, reason: "unknown_transaction" as const }
      if (row.consumedAt !== undefined) return { ok: false as const, reason: "consumed_transaction" as const }
      if (now() >= row.expiresAt) return { ok: false as const, reason: "expired_transaction" as const }
      if (!constantTimeEqual(await sha256Hex(state), row.stateHash)) {
        // Burn the transaction so a wrong state cannot be retried.
        await store.consumeOAuthTransaction(id, now())
        return { ok: false as const, reason: "state_mismatch" as const }
      }
      if (!(await store.consumeOAuthTransaction(id, now())))
        return { ok: false as const, reason: "consumed_transaction" as const }
      return { ok: true as const, value: { nonce: row.nonce, codeVerifier: row.codeVerifier, redirectAfter: row.redirectAfter } }
    },

    async signIn(input: { readonly provider: string; readonly subject: string }) {
      const userID = await store.findOrCreateUser(input.provider, input.subject, now())
      const token = randomToken(32)
      const sessionID = await sha256Hex(token)
      const createdAt = now()
      const expiresAt = createdAt + browserSessionTtlMs
      await store.insertBrowserSession({ id: sessionID, userID, createdAt, expiresAt })
      return { token, sessionID, userID, expiresAt }
    },

    async resolveBrowserSession(token: string): Promise<Outcome<BrowserSession>> {
      const row = validateSession(await store.findBrowserSession(await sha256Hex(token)))
      if (!row.ok) return row
      return { ok: true, value: { sessionID: row.value.id, userID: row.value.userID, expiresAt: row.value.expiresAt } }
    },

    async authorizeBrowserSession(sessionID: string): Promise<Outcome<BrowserSession>> {
      const row = validateSession(await store.findBrowserSession(sessionID))
      if (!row.ok) return row
      return { ok: true, value: { sessionID: row.value.id, userID: row.value.userID, expiresAt: row.value.expiresAt } }
    },

    async rotateBrowserSession(
      token: string,
    ): Promise<Outcome<BrowserSession & { readonly rotatedToken?: string; readonly rotatedExpiresAt?: number }>> {
      const found = validateSession(await store.findBrowserSession(await sha256Hex(token)))
      if (!found.ok) return found
      const row = found.value
      if (now() - row.createdAt < browserSessionRotationMs)
        return { ok: true, value: { sessionID: row.id, userID: row.userID, expiresAt: row.expiresAt } }
      const createdAt = now()
      const rotatedToken = randomToken(32)
      const rotatedExpiresAt = createdAt + browserSessionTtlMs
      const rotated = await store.rotateBrowserSession(
        row.id,
        { id: await sha256Hex(rotatedToken), userID: row.userID, createdAt, expiresAt: rotatedExpiresAt },
        createdAt,
      )
      if (!rotated) return { ok: false, reason: "revoked_session" }
      return {
        ok: true,
        value: { sessionID: row.id, userID: row.userID, expiresAt: row.expiresAt, rotatedToken, rotatedExpiresAt },
      }
    },

    async signOut(token: string) {
      await store.revokeBrowserSession(await sha256Hex(token), now())
    },

    async createEnrollment(userID: string) {
      const createdAt = now()
      const enrollmentID = `enr_${randomToken(12)}`
      const code = enrollmentCode()
      await store.insertEnrollment({
        id: enrollmentID,
        codeHash: await sha256Hex(code),
        userID,
        createdAt,
        expiresAt: createdAt + enrollmentTtlMs,
      })
      return { enrollmentID, code, expiresAt: createdAt + enrollmentTtlMs }
    },

    async completeEnrollment(input: {
      readonly enrollmentID: string
      readonly code: string
      readonly name: string
      readonly publicKey: RemotePublicKey
    }): Promise<Outcome<{ readonly deviceID: string; readonly userID: string }>> {
      const row = await store.findEnrollment(input.enrollmentID)
      if (!row) return { ok: false, reason: "unknown_enrollment" }
      if (row.consumedAt !== undefined) return { ok: false, reason: "consumed_enrollment" }
      if (now() >= row.expiresAt) return { ok: false, reason: "expired_enrollment" }
      if (!constantTimeEqual(await sha256Hex(input.code), row.codeHash))
        return { ok: false, reason: "bad_enrollment_code" }
      const deviceID = `dev_${randomToken(12)}`
      if (!(await store.consumeEnrollment(row.id, now(), deviceID)))
        return { ok: false, reason: "consumed_enrollment" }
      await store.insertDevice({
        id: deviceID,
        userID: row.userID,
        name: input.name,
        publicKey: input.publicKey,
        createdAt: now(),
      })
      return { ok: true, value: { deviceID, userID: row.userID } }
    },

    async listDevices(userID: string): Promise<readonly Omit<RemoteDeviceInfo, "online">[]> {
      const rows = await store.listDevices(userID)
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        ...(row.lastSeenAt === undefined ? {} : { lastSeenAt: row.lastSeenAt }),
        ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
        status: row.revokedAt === undefined ? ("active" as const) : ("revoked" as const),
      }))
    },

    async createChallenge(deviceID: string): Promise<Outcome<{ readonly challengeID: string; readonly nonce: string; readonly expiresAt: number }>> {
      const device = await requireActiveDevice(deviceID)
      if (!device.ok) return device
      const createdAt = now()
      const challengeID = `chl_${randomToken(12)}`
      const nonce = randomToken(24)
      await store.insertChallenge({ id: challengeID, deviceID, nonce, createdAt, expiresAt: createdAt + challengeTtlMs })
      return { ok: true, value: { challengeID, nonce, expiresAt: createdAt + challengeTtlMs } }
    },

    async redeemChallenge(input: {
      readonly deviceID: string
      readonly challengeID: string
      readonly signature: string
    }): Promise<Outcome<DeviceTokenResponse>> {
      const device = await requireKnownActiveDevice(input.deviceID)
      if (!device.ok) return device
      const challenge = await store.findChallenge(input.challengeID)
      if (!challenge) return { ok: false, reason: "unknown_challenge" }
      if (challenge.deviceID !== input.deviceID) return { ok: false, reason: "challenge_mismatch" }
      if (challenge.consumedAt !== undefined) return { ok: false, reason: "consumed_challenge" }
      if (now() >= challenge.expiresAt) return { ok: false, reason: "expired_challenge" }
      const valid = await verifyP256Signature(
        device.value.publicKey,
        deviceSignaturePayload(challenge.id, challenge.nonce),
        input.signature,
      )
      if (!valid) return { ok: false, reason: "bad_signature" }
      if (!(await store.consumeChallenge(challenge.id, now()))) return { ok: false, reason: "consumed_challenge" }
      await store.markDeviceSeen(input.deviceID, now())
      return issueCredentials(input.deviceID)
    },

    issueCredentials,

    async refreshCredentials(input: { readonly deviceID: string; readonly refreshToken: string }): Promise<Outcome<DeviceTokenResponse>> {
      const device = await requireKnownActiveDevice(input.deviceID)
      if (!device.ok) return device
      const row = await store.findCredential(await sha256Hex(input.refreshToken))
      if (!row || row.deviceID !== input.deviceID) return { ok: false, reason: "unknown_credential" }
      const validated = validateCredentialRow(row, "refresh")
      if (!validated.ok) return validated

      const issuedAt = now()
      const accessToken = randomToken(32)
      const refreshToken = randomToken(32)
      const accessExpiresAt = issuedAt + accessCredentialTtlMs
      const refreshExpiresAt = issuedAt + refreshCredentialTtlMs
      // Issue the replacement access credential before consuming the refresh
      // credential so a failed rotation never strands the device.
      await store.insertCredential({
        id: await sha256Hex(accessToken),
        deviceID: input.deviceID,
        kind: "access",
        createdAt: issuedAt,
        expiresAt: accessExpiresAt,
      })
      const rotated = await store.rotateCredential(
        row.id,
        {
          id: await sha256Hex(refreshToken),
          deviceID: input.deviceID,
          kind: "refresh",
          createdAt: issuedAt,
          expiresAt: refreshExpiresAt,
        },
        issuedAt,
      )
      if (!rotated) return { ok: false, reason: "revoked_credential" }
      return { ok: true, value: { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt } }
    },

    async revokeDevice(input: { readonly deviceID: string; readonly userID: string }): Promise<Outcome<{ readonly deviceID: string }>> {
      const device = await store.findDevice(input.deviceID)
      if (!device) return { ok: false, reason: "unknown_device" }
      if (device.userID !== input.userID) return { ok: false, reason: "not_owner" }
      await store.revokeDevice(input.deviceID, input.userID, now())
      return { ok: true, value: { deviceID: input.deviceID } }
    },

    async authorizeClientCommand(sessionID: string, deviceID: string): Promise<Outcome<{ readonly userID: string }>> {
      const session = validateSession(await store.findBrowserSession(sessionID))
      if (!session.ok) return session
      const device = await store.findDevice(deviceID)
      if (!device) return { ok: false, reason: "unknown_device" }
      if (device.revokedAt !== undefined) return { ok: false, reason: "revoked_device" }
      if (device.userID !== session.value.userID) return { ok: false, reason: "not_owner" }
      return { ok: true, value: { userID: session.value.userID } }
    },

    async authorizeAgentToken(token: string): Promise<Outcome<{ readonly deviceID: string; readonly userID: string; readonly expiresAt: number }>> {
      const credential = await validateCredential(token, "access")
      if (!credential.ok) return credential
      const device = await store.findDevice(credential.value.deviceID)
      if (!device) return { ok: false, reason: "unknown_device" }
      if (device.revokedAt !== undefined) return { ok: false, reason: "revoked_device" }
      return {
        ok: true,
        value: { deviceID: device.id, userID: device.userID, expiresAt: credential.value.expiresAt },
      }
    },

    async authorizeAgentCommand(deviceID: string): Promise<Outcome<{ readonly userID: string }>> {
      const device = await store.findDevice(deviceID)
      if (!device) return { ok: false, reason: "unknown_device" }
      if (device.revokedAt !== undefined) return { ok: false, reason: "revoked_device" }
      return { ok: true, value: { userID: device.userID } }
    },
  }
}

function enrollmentCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(enrollmentCodeChars))
  const characters = [...bytes].map((byte) => enrollmentAlphabet.charAt(byte % enrollmentAlphabet.length))
  const grouped = characters.join("").match(/.{4}/g) ?? []
  const code = grouped.join("-")
  if (!enrollmentCodePattern.test(code)) throw new Error("generated enrollment code does not match the contract")
  return code
}
