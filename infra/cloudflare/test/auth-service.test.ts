import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { base64UrlEncode, sha256Hex } from "../src/auth/crypto"
import { createAuthService } from "../src/auth/service"
import type { RemotePublicKey } from "../../../packages/remote/src/index"
import { deviceSignaturePayload, enrollmentCodePattern } from "../../../packages/remote/src/index"
import { createMemoryAuthStore } from "./support/memory-store"
import { cleanupLimit, expiredMetadataRetentionMs } from "../src/auth/service"

const minute = 60_000
const halfLife = 15 * 24 * 60 * minute

function harness() {
  let now = 1_700_000_000_000
  const store = createMemoryAuthStore()
  return {
    service: createAuthService(store, { now: () => now }),
    store,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    at: () => now,
  }
}

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const publicKey: RemotePublicKey = { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" }
  return { pair, publicKey }
}

async function sign(pair: CryptoKeyPair, challengeID: string, nonce: string) {
  const payload = deviceSignaturePayload(challengeID, nonce)
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))),
  )
}

type Harness = ReturnType<typeof harness>

async function enroll(harness: Harness, userID: string, name = "Studio Mac") {
  const created = await harness.service.createEnrollment(userID)
  const key = await deviceKey()
  const completed = await harness.service.completeEnrollment({
    enrollmentID: created.enrollmentID,
    code: created.code,
    name,
    publicKey: key.publicKey,
  })
  if (!completed.ok) throw new Error(`enrollment failed: ${completed.reason}`)
  return { key, deviceID: completed.value.deviceID }
}

describe("oauth transaction", () => {
  test("binds state, nonce, verifier, and redirect and is consumed once", async () => {
    const h = harness()
    const begun = await h.service.beginOAuth({ redirectAfter: "/remote/chat" })
    const { state, nonce, codeVerifier, cookieToken } = begun

    const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    expect(begun.codeChallenge).toBe(expectedChallenge)
    expect(begun.expiresAt).toBe(h.at() + 10 * minute)

    const consumed = await h.service.consumeOAuthTransaction(cookieToken, state)
    expect(consumed).toEqual({ ok: true, value: { nonce, codeVerifier, redirectAfter: "/remote/chat" } })
    expect(await h.service.consumeOAuthTransaction(cookieToken, state)).toEqual({
      ok: false,
      reason: "consumed_transaction",
    })
  })

  test("rejects unknown, expired, and mismatched transactions", async () => {
    const h = harness()
    const begun = await h.service.beginOAuth({ redirectAfter: "/remote/" })

    expect(await h.service.consumeOAuthTransaction("unknown-cookie", begun.state)).toEqual({
      ok: false,
      reason: "unknown_transaction",
    })
    expect(await h.service.consumeOAuthTransaction(begun.cookieToken, "wrong-state")).toEqual({
      ok: false,
      reason: "state_mismatch",
    })
    expect(await h.service.consumeOAuthTransaction(begun.cookieToken, begun.state)).toEqual({
      ok: false,
      reason: "consumed_transaction",
    })

    const later = await h.service.beginOAuth({ redirectAfter: "/remote/" })
    h.advance(11 * minute)
    expect(await h.service.consumeOAuthTransaction(later.cookieToken, later.state)).toEqual({
      ok: false,
      reason: "expired_transaction",
    })
  })
})

describe("browser sessions", () => {
  test("signs in, resolves, rotates past half life, and revokes", async () => {
    const h = harness()
    const signedIn = await h.service.signIn({ provider: "google", subject: "subject-1" })
    expect(signedIn.sessionID).toBe(await sha256Hex(signedIn.token))
    expect(signedIn.expiresAt).toBe(h.at() + 30 * 24 * 60 * minute)

    expect(await h.service.resolveBrowserSession(signedIn.token)).toEqual({
      ok: true,
      value: { sessionID: signedIn.sessionID, userID: signedIn.userID, expiresAt: signedIn.expiresAt },
    })
    expect(await h.service.resolveBrowserSession("no-such-token")).toEqual({ ok: false, reason: "unknown_session" })

    const early = await h.service.rotateBrowserSession(signedIn.token)
    expect(early).toEqual({
      ok: true,
      value: { sessionID: signedIn.sessionID, userID: signedIn.userID, expiresAt: signedIn.expiresAt },
    })

    h.advance(halfLife + 1)
    const rotated = await h.service.rotateBrowserSession(signedIn.token)
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) throw new Error("rotation failed")
    expect(rotated.value.rotatedToken).toBeDefined()
    expect(rotated.value.rotatedToken).not.toBe(signedIn.token)
    expect(await h.service.resolveBrowserSession(signedIn.token)).toEqual({ ok: false, reason: "revoked_session" })
    expect(await h.service.resolveBrowserSession(rotated.value.rotatedToken ?? "")).toMatchObject({
      ok: true,
      value: { userID: signedIn.userID },
    })

    await h.service.signOut(rotated.value.rotatedToken ?? "")
    expect(await h.service.resolveBrowserSession(rotated.value.rotatedToken ?? "")).toEqual({
      ok: false,
      reason: "revoked_session",
    })
  })

  test("expires sessions and keeps identities stable per provider subject", async () => {
    const h = harness()
    const first = await h.service.signIn({ provider: "google", subject: "same-subject" })
    const second = await h.service.signIn({ provider: "google", subject: "same-subject" })
    const other = await h.service.signIn({ provider: "google", subject: "other-subject" })
    expect(second.userID).toBe(first.userID)
    expect(other.userID).not.toBe(first.userID)

    h.advance(31 * 24 * 60 * minute)
    expect(await h.service.resolveBrowserSession(first.token)).toEqual({ ok: false, reason: "expired_session" })
    expect(await h.service.rotateBrowserSession(first.token)).toEqual({ ok: false, reason: "expired_session" })
  })
})

describe("device enrollment", () => {
  test("mints one-use codes and binds a device public key", async () => {
    const h = harness()
    const created = await h.service.createEnrollment("usr_1")
    expect(created.code).toMatch(enrollmentCodePattern)
    expect(created.expiresAt).toBe(h.at() + 10 * minute)

    const key = await deviceKey()
    const completed = await h.service.completeEnrollment({
      enrollmentID: created.enrollmentID,
      code: created.code,
      name: "Studio Mac",
      publicKey: key.publicKey,
    })
    expect(completed.ok).toBe(true)
    if (!completed.ok) throw new Error("enrollment failed")
    expect(completed.value.userID).toBe("usr_1")
    expect(
      await h.service.completeEnrollment({
        enrollmentID: created.enrollmentID,
        code: created.code,
        name: "Second",
        publicKey: key.publicKey,
      }),
    ).toEqual({ ok: false, reason: "consumed_enrollment" })
  })

  test("rejects a wrong code without burning the enrollment, and rejects expired or unknown ones", async () => {
    const h = harness()
    const created = await h.service.createEnrollment("usr_1")
    const key = await deviceKey()
    expect(
      await h.service.completeEnrollment({
        enrollmentID: created.enrollmentID,
        code: "AAAA-AAAA-AAAA-AAAA-AAAA",
        name: "Studio Mac",
        publicKey: key.publicKey,
      }),
    ).toEqual({ ok: false, reason: "bad_enrollment_code" })
    expect(
      await h.service.completeEnrollment({
        enrollmentID: created.enrollmentID,
        code: created.code,
        name: "Studio Mac",
        publicKey: key.publicKey,
      }),
    ).toMatchObject({ ok: true })

    const expiring = await h.service.createEnrollment("usr_1")
    h.advance(11 * minute)
    expect(
      await h.service.completeEnrollment({
        enrollmentID: expiring.enrollmentID,
        code: expiring.code,
        name: "Late Mac",
        publicKey: key.publicKey,
      }),
    ).toEqual({ ok: false, reason: "expired_enrollment" })

    expect(
      await h.service.completeEnrollment({
        enrollmentID: "enr_unknown",
        code: expiring.code,
        name: "Late Mac",
        publicKey: key.publicKey,
      }),
    ).toEqual({ ok: false, reason: "unknown_enrollment" })
  })
})

describe("device credentials", () => {
  test("redeems a one-use challenge into signed credentials", async () => {
    const h = harness()
    const { key, deviceID } = await enroll(h, "usr_1")

    const challenge = await h.service.createChallenge(deviceID)
    expect(challenge.ok).toBe(true)
    if (!challenge.ok) throw new Error("challenge failed")
    expect(challenge.value.expiresAt).toBe(h.at() + 2 * minute)

    const signature = await sign(key.pair, challenge.value.challengeID, challenge.value.nonce)
    const issued = await h.service.redeemChallenge({
      deviceID,
      challengeID: challenge.value.challengeID,
      signature,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) throw new Error("redeem failed")
    expect(issued.value.accessExpiresAt).toBe(h.at() + 10 * minute)
    expect(issued.value.refreshExpiresAt).toBe(h.at() + 30 * 24 * 60 * minute)
    expect(await h.service.authorizeAgentToken(issued.value.accessToken)).toEqual({
      ok: true,
      value: { deviceID, userID: "usr_1", expiresAt: issued.value.accessExpiresAt },
    })
    expect(await h.service.authorizeAgentToken(issued.value.refreshToken)).toEqual({
      ok: false,
      reason: "wrong_credential_kind",
    })

    expect(
      await h.service.redeemChallenge({ deviceID, challengeID: challenge.value.challengeID, signature }),
    ).toEqual({ ok: false, reason: "consumed_challenge" })
  })

  test("rejects bad signatures, cross-device challenges, and inconsistent devices", async () => {
    const h = harness()
    const first = await enroll(h, "usr_1", "First")
    const second = await enroll(h, "usr_1", "Second")

    const challenge = await h.service.createChallenge(first.deviceID)
    if (!challenge.ok) throw new Error("challenge failed")
    const foreign = await sign(second.key.pair, challenge.value.challengeID, challenge.value.nonce)
    expect(
      await h.service.redeemChallenge({
        deviceID: first.deviceID,
        challengeID: challenge.value.challengeID,
        signature: foreign,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" })

    const good = await sign(first.key.pair, challenge.value.challengeID, challenge.value.nonce)
    expect(
      await h.service.redeemChallenge({
        deviceID: second.deviceID,
        challengeID: challenge.value.challengeID,
        signature: good,
      }),
    ).toEqual({ ok: false, reason: "challenge_mismatch" })
    expect(
      await h.service.redeemChallenge({
        deviceID: first.deviceID,
        challengeID: challenge.value.challengeID,
        signature: good,
      }),
    ).toMatchObject({ ok: true })

    expect(await h.service.createChallenge("dev_unknown")).toEqual({ ok: false, reason: "unknown_device" })

    const expiring = await h.service.createChallenge(first.deviceID)
    if (!expiring.ok) throw new Error("challenge failed")
    h.advance(3 * minute)
    expect(
      await h.service.redeemChallenge({
        deviceID: first.deviceID,
        challengeID: expiring.value.challengeID,
        signature: await sign(first.key.pair, expiring.value.challengeID, expiring.value.nonce),
      }),
    ).toEqual({ ok: false, reason: "expired_challenge" })
    expect(await h.service.createChallenge("dev_unknown")).toEqual({ ok: false, reason: "unknown_device" })
  })

  test("expires access credentials and rotates refresh credentials once", async () => {
    const h = harness()
    const { key, deviceID } = await enroll(h, "usr_1")
    const first = await h.service.issueCredentials(deviceID)
    if (!first.ok) throw new Error("issue failed")

    h.advance(11 * minute)
    expect(await h.service.authorizeAgentToken(first.value.accessToken)).toEqual({
      ok: false,
      reason: "expired_credential",
    })

    const refreshed = await h.service.refreshCredentials({
      deviceID,
      refreshToken: first.value.refreshToken,
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) throw new Error("refresh failed")
    expect(refreshed.value.accessToken).not.toBe(first.value.accessToken)
    expect(
      await h.service.refreshCredentials({ deviceID, refreshToken: first.value.refreshToken }),
    ).toEqual({ ok: false, reason: "revoked_credential" })
    expect(await h.service.authorizeAgentToken(refreshed.value.accessToken)).toMatchObject({ ok: true })

    const challenge = await h.service.createChallenge(deviceID)
    if (!challenge.ok) throw new Error("challenge failed")
    expect(
      await h.service.redeemChallenge({
        deviceID,
        challengeID: challenge.value.challengeID,
        signature: await sign(key.pair, challenge.value.challengeID, challenge.value.nonce),
      }),
    ).toMatchObject({ ok: true })
  })

  test("refuses revoked devices on every credential and challenge path", async () => {
    const h = harness()
    const { deviceID } = await enroll(h, "usr_1")
    const issued = await h.service.issueCredentials(deviceID)
    if (!issued.ok) throw new Error("issue failed")

    expect(await h.service.revokeDevice({ deviceID, userID: "usr_1" })).toEqual({ ok: true, value: { deviceID } })
    expect(await h.service.authorizeAgentToken(issued.value.accessToken)).toEqual({
      ok: false,
      reason: "revoked_credential",
    })
    expect(await h.service.authorizeAgentCommand(deviceID)).toEqual({ ok: false, reason: "revoked_device" })
    expect(await h.service.createChallenge(deviceID)).toEqual({ ok: false, reason: "unknown_device" })
    expect(
      await h.service.refreshCredentials({ deviceID, refreshToken: issued.value.refreshToken }),
    ).toEqual({ ok: false, reason: "revoked_device" })
    expect(await h.service.revokeDevice({ deviceID, userID: "usr_1" })).toEqual({ ok: true, value: { deviceID } })
  })
})

describe("owner isolation", () => {
  test("keeps devices, sessions, and command authority inside one owner", async () => {
    const h = harness()
    const owner = await h.service.signIn({ provider: "google", subject: "owner" })
    const intruder = await h.service.signIn({ provider: "google", subject: "intruder" })
    const { deviceID } = await enroll(h, owner.userID)

    expect(await h.service.authorizeClientCommand(owner.sessionID, deviceID)).toEqual({
      ok: true,
      value: { userID: owner.userID },
    })
    expect(await h.service.authorizeClientCommand(intruder.sessionID, deviceID)).toEqual({
      ok: false,
      reason: "not_owner",
    })
    expect(await h.service.listDevices(owner.userID)).toHaveLength(1)
    expect(await h.service.listDevices(intruder.userID)).toEqual([])
    expect(await h.service.revokeDevice({ deviceID, userID: intruder.userID })).toEqual({
      ok: false,
      reason: "not_owner",
    })
    expect(await h.service.authorizeAgentCommand(deviceID)).toEqual({ ok: true, value: { userID: owner.userID } })
  })

  test("reports revoked, expired, and unknown authority precisely", async () => {
    const h = harness()
    const owner = await h.service.signIn({ provider: "google", subject: "owner" })
    const { deviceID } = await enroll(h, owner.userID)

    await h.service.signOut(owner.token)
    expect(await h.service.authorizeClientCommand(owner.sessionID, deviceID)).toEqual({
      ok: false,
      reason: "revoked_session",
    })

    const active = await h.service.signIn({ provider: "google", subject: "owner" })
    expect(await h.service.authorizeClientCommand(active.sessionID, "dev_unknown")).toEqual({
      ok: false,
      reason: "unknown_device",
    })
    h.advance(31 * 24 * 60 * minute)
    expect(await h.service.authorizeClientCommand(active.sessionID, deviceID)).toEqual({
      ok: false,
      reason: "expired_session",
    })
  })
})

describe("rotation atomicity and expiry guards", () => {
  test("rotates a browser session exactly once when two rotations race", async () => {
    const h = harness()
    const signedIn = await h.service.signIn({ provider: "google", subject: "race" })
    h.advance(halfLife + 1)

    const results = await Promise.all([
      h.service.rotateBrowserSession(signedIn.token),
      h.service.rotateBrowserSession(signedIn.token),
    ])
    const succeeded = results.filter((result) => result.ok)
    expect(succeeded).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "revoked_session" })

    const winner = succeeded[0]
    if (!winner?.ok) throw new Error("rotation failed")
    expect(winner.value.rotatedToken).toBeDefined()
    expect(await h.service.resolveBrowserSession(winner.value.rotatedToken ?? "")).toMatchObject({ ok: true })
    expect(await h.service.resolveBrowserSession(signedIn.token)).toEqual({ ok: false, reason: "revoked_session" })
  })

  test("rotates a device refresh credential exactly once when two refreshes race", async () => {
    const h = harness()
    const { deviceID } = await enroll(h, "usr_1")
    const issued = await h.service.issueCredentials(deviceID)
    if (!issued.ok) throw new Error("issue failed")

    const results = await Promise.all([
      h.service.refreshCredentials({ deviceID, refreshToken: issued.value.refreshToken }),
      h.service.refreshCredentials({ deviceID, refreshToken: issued.value.refreshToken }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const winner = results.find((result) => result.ok)
    if (!winner?.ok) throw new Error("refresh failed")
    expect(await h.service.authorizeAgentToken(winner.value.accessToken)).toMatchObject({ ok: true })
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "revoked_credential" })
  })

  test("refuses to consume an expired transaction or challenge at the store boundary", async () => {
    const h = harness()
    const store = h.store
    const service = h.service

    const begun = await service.beginOAuth({ redirectAfter: "/remote/" })
    const transactionID = await sha256Hex(begun.cookieToken)
    const { deviceID } = await enroll(h, "usr_1")
    const challenge = await service.createChallenge(deviceID)
    if (!challenge.ok) throw new Error("challenge failed")

    h.advance(11 * minute)
    expect(await store.consumeOAuthTransaction(transactionID, h.at())).toBe(false)
    h.advance(3 * minute)
    expect(await store.consumeChallenge(challenge.value.challengeID, h.at())).toBe(false)
  })
})

describe("expired metadata cleanup", () => {
  test("deletes only metadata past the retention window and keeps live records", async () => {
    const h = harness()
    const store = h.store
    const stale = await h.service.signIn({ provider: "google", subject: "stale" })
    const { deviceID } = await enroll(h, "usr_1")
    const issued = await h.service.issueCredentials(deviceID)
    if (!issued.ok) throw new Error("issue failed")
    await h.service.createEnrollment("usr_1")
    await h.service.beginOAuth({ redirectAfter: "/remote/" })

    expect(await h.service.cleanup()).toEqual({
      oauthTransactions: 0,
      challenges: 0,
      enrollments: 0,
      browserSessions: 0,
      credentials: 0,
    })

    h.advance(expiredMetadataRetentionMs + 31 * 24 * 60 * minute)
    const fresh = await h.service.signIn({ provider: "google", subject: "fresh" })
    const counts = await h.service.cleanup()
    expect(counts).toEqual({
      oauthTransactions: 1,
      challenges: 0,
      enrollments: 2,
      browserSessions: 1,
      credentials: 2,
    })
    expect(await store.findBrowserSession(stale.sessionID)).toBeUndefined()
    expect(await store.findCredential(await sha256Hex(issued.value.accessToken))).toBeUndefined()
    expect(await h.service.resolveBrowserSession(fresh.token)).toMatchObject({ ok: true })
  })

  test("bounds how many rows one cleanup pass removes per table", async () => {
    const h = harness()
    const store = h.store
    for (let index = 0; index < 3; index += 1) await h.service.signIn({ provider: "google", subject: `s${index}` })
    h.advance(expiredMetadataRetentionMs + 31 * 24 * 60 * minute)

    expect((await store.deleteExpired(h.at(), expiredMetadataRetentionMs, 2)).browserSessions).toBe(2)
    expect((await store.deleteExpired(h.at(), expiredMetadataRetentionMs, 2)).browserSessions).toBe(1)
    expect(cleanupLimit).toBeGreaterThan(0)
  })
})
