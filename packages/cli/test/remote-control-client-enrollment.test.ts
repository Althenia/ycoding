import { describe, expect, test } from "bun:test"
import { createHash, createPublicKey, verify } from "node:crypto"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildClientHeaders,
  buildClientWebSocketHeaders,
  buildEnrollFinishRequest,
  buildRefreshFinishRequest,
  buildStepUpAuthorizeURL,
  buildStepUpTokenRequest,
  clientEnrollFinishURL,
  clientEnrollStartURL,
  clientRefreshFinishURL,
  clientRefreshStartURL,
  clientWebSocketURL,
  createClientProofStateStore,
  createStepUpCallbackServer,
  decodeChallengeResponse,
  decodeStepUpTokenResponse,
  decodeTokenResponse,
  deviceIdentityHash,
  enrollCanonicalPayload,
  generateDeviceKey,
  generateKeyId,
  runEnrollmentProof,
  runRefreshProof,
  selectProofCredential,
  signPayload,
  type DeviceKeyRecord,
} from "../src/remote-control/client-enrollment"

const credential = { access: "synthetic-access", accountID: "acct-workspace-1" }
const now = Date.parse("2026-10-27T00:00:00Z")
const nonce = Buffer.alloc(32, 7).toString("base64url")

function challengeValue(overrides: Record<string, unknown> = {}) {
  return {
    account_user_id: "user-1",
    client_id: "client-1",
    device_key_challenge: {
      challenge_id: "chal-1",
      challenge_token: "synthetic-challenge-token",
      nonce,
      purpose: "remote_control_client_enrollment",
      audience: "remote_control_client_enrollment",
      account_user_id: "user-1",
      client_id: "client-1",
      target_origin: "https://chatgpt.com",
      target_path: "/backend-api/codex/remote/control/client/enroll/finish",
      challenge_expires_at: "2026-10-27T00:10:00Z",
      ...overrides,
    },
  }
}

function fakeJWT(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(claims)}.synthetic`
}

describe("remote-control client enrollment proof", () => {
  test("builds exact client headers and endpoint URLs", () => {
    expect(buildClientHeaders(credential)).toEqual({
      authorization: "Bearer synthetic-access",
      "chatgpt-account-id": "acct-workspace-1",
      originator: "Codex Desktop",
      "User-Agent": "Codex Desktop/26.1021.31345 (Mac OS; arm64)",
      "content-type": "application/json",
    })
    expect(clientEnrollStartURL()).toBe("https://chatgpt.com/backend-api/codex/remote/control/client/enroll/start")
    expect(clientEnrollFinishURL()).toBe("https://chatgpt.com/backend-api/codex/remote/control/client/enroll/finish")
    expect(clientRefreshStartURL()).toBe("https://chatgpt.com/backend-api/codex/remote/control/client/refresh/start")
    expect(clientRefreshFinishURL()).toBe("https://chatgpt.com/backend-api/codex/remote/control/client/refresh/finish")
    expect(clientWebSocketURL()).toBe("wss://chatgpt.com/backend-api/codex/remote/control/client")
    expect(buildClientWebSocketHeaders({ token: "synthetic-token", clientID: "client-1" })).toEqual({
      "x-codex-client-session-token": "Bearer synthetic-token",
      "x-codex-client-id": "client-1",
      "x-codex-protocol-version": "3",
    })
  })

  test("accepts a synthetic enrollment challenge that matches every pinned field", () => {
    const decoded = decodeChallengeResponse(challengeValue(), {
      purpose: "remote_control_client_enrollment",
      audience: "remote_control_client_enrollment",
      targetPath: "/backend-api/codex/remote/control/client/enroll/finish",
      now,
    })
    expect(decoded.accountUserId).toBe("user-1")
    expect(decoded.clientId).toBe("client-1")
    expect(decoded.challenge.challengeId).toBe("chal-1")
    expect(decoded.challenge.deviceIdentityHash).toBeUndefined()
  })

  test("rejects challenges with wrong purpose, short nonce, expiry, account, or target", () => {
    const expected = {
      purpose: "remote_control_client_enrollment",
      audience: "remote_control_client_enrollment",
      targetPath: "/backend-api/codex/remote/control/client/enroll/finish",
      now,
    }
    const run = (overrides: Record<string, unknown>) => () => decodeChallengeResponse(challengeValue(overrides), expected)
    expect(run({ purpose: "other" })).toThrow(/purpose/)
    expect(run({ audience: "other" })).toThrow(/audience/)
    expect(run({ nonce: Buffer.alloc(31).toString("base64url") })).toThrow(/nonce/)
    expect(run({ nonce: "not+base64url" })).toThrow(/nonce/)
    expect(run({ challenge_expires_at: "2026-10-26T23:59:59Z" })).toThrow(/expired/)
    expect(run({ account_user_id: "user-2" })).toThrow(/account/)
    expect(run({ client_id: "client-2" })).toThrow(/client/)
    expect(run({ target_origin: "https://example.com" })).toThrow(/target_origin/)
    expect(run({ target_path: "/elsewhere" })).toThrow(/target_path/)
  })

  test("generates default device key IDs in the dk_hse_ shape", () => {
    expect(generateKeyId()).toMatch(/^dk_hse_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(generateKeyId()).not.toBe(generateKeyId())
  })

  test("selects the configured Dots profile by default and a requested profile on override", async () => {
    const resolved = (profile: string) => ({
      access: "synthetic-access", accountID: "synthetic-account", key: "synthetic-key",
      profile, credentialID: "synthetic-credential", accountGeneration: 3,
    })
    const source = {
      dotsProfile: async () => "synthetic-configured",
      resolveStored: async (profile: string) => resolved(profile),
    }
    await expect(selectProofCredential(source)).resolves.toMatchObject({ selection: "configured", resolved: { profile: "synthetic-configured", accountGeneration: 3 } })
    await expect(selectProofCredential(source, "synthetic-requested")).resolves.toMatchObject({ selection: "requested", resolved: { profile: "synthetic-requested" } })
  })

  test("fails closed without exposing profile, account, or token values", async () => {
    const missing = { dotsProfile: async () => undefined, resolveStored: async () => undefined }
    await expect(selectProofCredential(missing)).rejects.toThrow(/Dots profile/)
    const unavailable = {
      dotsProfile: async () => "synthetic-secret-profile",
      resolveStored: async () => undefined,
    }
    const failure = await selectProofCredential(unavailable).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/unavailable/)
    expect((failure as Error).message).not.toContain("synthetic-secret-profile")
    const mismatched = {
      dotsProfile: async () => "synthetic-configured",
      resolveStored: async () => ({
        access: "synthetic-secret-token", accountID: "synthetic-secret-account", key: "k",
        profile: "synthetic-other", credentialID: "c", accountGeneration: 0,
      }),
    }
    const mismatchFailure = await selectProofCredential(mismatched).catch((error: unknown) => error)
    expect((mismatchFailure as Error).message).toMatch(/does not match/)
    expect((mismatchFailure as Error).message).not.toContain("synthetic-secret-token")
    expect((mismatchFailure as Error).message).not.toContain("synthetic-secret-account")
    expect((mismatchFailure as Error).message).not.toContain("synthetic-other")
  })

  test("enrollment proof defaults to a generated dk_hse_ key ID when none is supplied", async () => {
    const result = await runEnrollmentProof({
      credential,
      stepUpToken: async () => "synthetic-step-up",
      now: () => now,
      fetchFn: async (url: string) => url.endsWith("/enroll/start")
        ? Response.json(challengeValue())
        : Response.json({ remote_control_token: "synthetic-remote-token", scope: ["remote_control_controller_websocket"] }),
    })
    expect(result.state.keyId).toMatch(/^dk_hse_/)
  })

  test("refuses to generate a device key without an externally allocated keyId", () => {
    expect(() => generateDeviceKey("")).toThrow(/keyId/)
    expect(() => generateDeviceKey("  ")).toThrow(/keyId/)
  })

  test("generates a P-256 key whose SPKI verifies DER signatures over the canonical payload", () => {
    const record = generateDeviceKey("synthetic-key-1")
    expect(record.algorithm).toBe("ecdsa_p256_sha256")
    expect(record.protectionClass).toBe("hardware_secure_enclave")
    const spki = Buffer.from(record.publicKeySpkiDerBase64, "base64")
    expect(Buffer.from(spki.toString("base64"), "base64").equals(spki)).toBe(true)
    const decoded = decodeChallengeResponse(challengeValue(), {
      purpose: "remote_control_client_enrollment",
      audience: "remote_control_client_enrollment",
      targetPath: "/backend-api/codex/remote/control/client/enroll/finish",
      now,
    })
    const payload = enrollCanonicalPayload(decoded.challenge, deviceIdentityHash(record))
    const signature = Buffer.from(signPayload(record.privateKeyJwk, payload), "base64")
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" })
    expect(verify("sha256", Buffer.from(payload), { key: publicKey, dsaEncoding: "der" }, signature)).toBe(true)
    expect(verify("sha256", Buffer.from(payload + "x"), { key: publicKey, dsaEncoding: "der" }, signature)).toBe(false)
  })

  test("computes the device identity hash over the exact ordered JSON record", () => {
    const record: Pick<DeviceKeyRecord, "algorithm" | "keyId" | "protectionClass" | "publicKeySpkiDerBase64"> = {
      algorithm: "ecdsa_p256_sha256",
      keyId: "synthetic-key-1",
      protectionClass: "hardware_secure_enclave",
      publicKeySpkiDerBase64: "c3ludGhldGljLXNwa2k=",
    }
    const expected = createHash("sha256")
      .update('{"algorithm":"ecdsa_p256_sha256","keyId":"synthetic-key-1","protectionClass":"hardware_secure_enclave","publicKeySpkiDerBase64":"c3ludGhldGljLXNwa2k="}')
      .digest("base64url")
    expect(deviceIdentityHash(record)).toBe(expected)
  })

  test("builds the canonical enrollment signed payload with exact field order and casing", () => {
    const decoded = decodeChallengeResponse(challengeValue(), {
      purpose: "remote_control_client_enrollment",
      audience: "remote_control_client_enrollment",
      targetPath: "/backend-api/codex/remote/control/client/enroll/finish",
      now,
    })
    expect(enrollCanonicalPayload(decoded.challenge, "synthetic-hash")).toBe(
      `{"domain":"codex-device-key-sign-payload/v1","payload":{"accountUserId":"user-1","audience":"remote_control_client_enrollment","challengeExpiresAt":"2026-10-27T00:10:00Z","challengeId":"chal-1","clientId":"client-1","deviceIdentitySha256Base64url":"synthetic-hash","nonce":"${nonce}","targetOrigin":"https://chatgpt.com","targetPath":"/backend-api/codex/remote/control/client/enroll/finish","type":"remoteControlClientEnrollment"}}`,
    )
  })

  test("builds enroll-finish and refresh-finish bodies in the established wire shape", () => {
    const record = generateDeviceKey("synthetic-key-1")
    const proof = {
      challenge_token: "synthetic-challenge-token",
      key_id: record.keyId,
      signature_der_base64: "synthetic-sig",
      signed_payload_base64: "synthetic-payload",
      algorithm: "ecdsa_p256_sha256" as const,
    }
    const finish = buildEnrollFinishRequest({ clientId: "client-1", stepUpToken: "synthetic-step-up", record, proof })
    expect(Object.keys(finish)).toEqual(["client_id", "step_up_token", "device_identity", "device_key_proof"])
    expect(finish).toEqual({
      client_id: "client-1",
      step_up_token: "synthetic-step-up",
      device_identity: {
        key_id: "synthetic-key-1",
        public_key_spki_der_base64: record.publicKeySpkiDerBase64,
        algorithm: "ecdsa_p256_sha256",
        protection_class: "hardware_secure_enclave",
      },
      device_key_proof: proof,
    })
    expect(buildRefreshFinishRequest({ clientId: "client-1", proof })).toEqual({ client_id: "client-1", device_key_proof: proof })
  })

  test("requires the token response scope to be exactly the controller websocket scope", () => {
    expect(decodeTokenResponse({ remote_control_token: "synthetic-token", scope: ["remote_control_controller_websocket"] }))
      .toMatchObject({ remoteControlToken: "synthetic-token", scope: ["remote_control_controller_websocket"] })
    expect(decodeTokenResponse({ remote_control_token: "synthetic-token", scopes: ["remote_control_controller_websocket"] }))
      .toMatchObject({ remoteControlToken: "synthetic-token", scope: ["remote_control_controller_websocket"] })
    expect(() => decodeTokenResponse({ remote_control_token: "t", scope: [] })).toThrow(/scope/)
    expect(() => decodeTokenResponse({ remote_control_token: "t", scope: ["remote_control_controller_websocket", "extra"] })).toThrow(/scope/)
    expect(() => decodeTokenResponse({ remote_control_token: "t" })).toThrow(/scope/)
    expect(() => decodeTokenResponse({ scope: ["remote_control_controller_websocket"] })).toThrow(/remote_control_token/)
  })

  test("runs the full enrollment proof against a synthetic fetch and persists only key material at 0600", async () => {
    const requests: Array<{ url: string; body: unknown; headers: unknown }> = []
    const fetchFn = async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers })
      if (url.endsWith("/enroll/start")) return Response.json(challengeValue())
      if (url.endsWith("/enroll/finish"))
        return Response.json({ remote_control_token: "synthetic-remote-token", scope: ["remote_control_controller_websocket"] })
      return new Response("not found", { status: 404 })
    }
    const result = await runEnrollmentProof({
      fetchFn,
      credential,
      keyId: "synthetic-key-1",
      stepUpToken: async () => "synthetic-step-up",
      now: () => now,
    })
    expect(result.remoteControlToken).toBe("synthetic-remote-token")
    expect(result.state.clientId).toBe("client-1")
    expect(result.state.deviceIdentitySha256Base64url).toBe(deviceIdentityHash(result.state))
    expect(requests.map((item) => item.url)).toEqual([clientEnrollStartURL(), clientEnrollFinishURL()])
    expect(requests[0]?.body).toEqual({})
    const finish = requests[1]?.body as { device_key_proof: { signed_payload_base64: string; signature_der_base64: string } }
    const signedPayload = Buffer.from(finish.device_key_proof.signed_payload_base64, "base64").toString("utf8")
    expect(signedPayload).toContain('"type":"remoteControlClientEnrollment"')
    const publicKey = createPublicKey({ key: Buffer.from(result.state.publicKeySpkiDerBase64, "base64"), format: "der", type: "spki" })
    expect(verify("sha256", Buffer.from(signedPayload), { key: publicKey, dsaEncoding: "der" }, Buffer.from(finish.device_key_proof.signature_der_base64, "base64"))).toBe(true)

    const dir = await mkdtemp(path.join(tmpdir(), "ycoding-client-proof-"))
    const file = path.join(dir, "state.json")
    const store = createClientProofStateStore(file)
    await store.save(result.state)
    const text = await readFile(file, "utf8")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(text).not.toContain("synthetic-access")
    expect(text).not.toContain("synthetic-step-up")
    expect(text).not.toContain("synthetic-remote-token")
    expect(text).not.toContain("synthetic-challenge-token")
    expect(await store.load()).toEqual(result.state)
  })

  test("refresh requires the server identity hash to equal the computed hash", async () => {
    const record = generateDeviceKey("synthetic-key-1")
    const state = {
      version: 1 as const,
      clientId: "client-1",
      accountUserId: "user-1",
      accountHash: createHash("sha256").update(credential.accountID).digest("hex"),
      keyId: record.keyId,
      algorithm: record.algorithm,
      protectionClass: record.protectionClass,
      publicKeySpkiDerBase64: record.publicKeySpkiDerBase64,
      privateKeyJwk: record.privateKeyJwk,
      deviceIdentitySha256Base64url: deviceIdentityHash(record),
      updatedAt: now,
    }
    const refreshChallenge = (hash: string | undefined) => ({
      account_user_id: "user-1",
      client_id: "client-1",
      device_key_challenge: {
        challenge_id: "chal-2",
        challenge_token: "synthetic-refresh-token",
        nonce,
        purpose: "synthetic-refresh-purpose",
        audience: "synthetic-refresh-purpose",
        account_user_id: "user-1",
        client_id: "client-1",
        target_origin: "https://chatgpt.com",
        target_path: "/backend-api/codex/remote/control/client/refresh/finish",
        challenge_expires_at: "2026-10-27T00:10:00Z",
        ...(hash === undefined ? {} : { device_identity_hash: hash }),
      },
    })
    const runWith = (hash: string | undefined) =>
      runRefreshProof({
        credential,
        state,
        refreshPayloadType: "syntheticRefreshType",
        now: () => now,
        fetchFn: async (url: string) => {
          if (url.endsWith("/refresh/start")) return Response.json(refreshChallenge(hash))
          return Response.json({ remote_control_token: "synthetic-refreshed", scope: ["remote_control_controller_websocket"] })
        },
      })
    await expect(runWith(undefined)).rejects.toThrow(/device_identity_hash/)
    await expect(runWith("wrong-hash")).rejects.toThrow(/device_identity_hash/)
    await expect(runWith(state.deviceIdentitySha256Base64url)).resolves.toMatchObject({ remoteControlToken: "synthetic-refreshed" })
    await expect(runRefreshProof({ credential, state, refreshPayloadType: "", now: () => now, fetchFn: async () => Response.json(refreshChallenge(state.deviceIdentitySha256Base64url)) }))
      .rejects.toThrow(/refresh payload type/)
  })

  test("builds the step-up authorize URL and token exchange from the established Codex OAuth shape", () => {
    const url = new URL(buildStepUpAuthorizeURL({
      accountID: "acct-workspace-1",
      redirectUri: "http://localhost:1455/auth/callback",
      state: "synthetic-state",
      codeChallenge: "synthetic-challenge",
    }))
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      scope: "codex.remote_control.enroll",
      code_challenge_method: "S256",
      reauth: "remote_control",
      max_age: "0",
      codex_cli_simplified_flow: "true",
      originator: "Codex Desktop",
      allowed_workspace_id: "acct-workspace-1",
      current_workspace_id: "acct-workspace-1",
      redirect_uri: "http://localhost:1455/auth/callback",
      state: "synthetic-state",
      code_challenge: "synthetic-challenge",
    })
    const exchange = buildStepUpTokenRequest({ code: "synthetic-code", redirectUri: "http://localhost:1455/auth/callback", verifier: "synthetic-verifier" })
    expect(exchange.url).toBe("https://auth.openai.com/oauth/token")
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({
      grant_type: "authorization_code",
      code: "synthetic-code",
      redirect_uri: "http://localhost:1455/auth/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "synthetic-verifier",
    })
  })

  test("validates step-up account, scope, and freshness only from safely typed claims", () => {
    const fresh = fakeJWT({ sub: "user-1", auth_time: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600 })
    const decoded = decodeStepUpTokenResponse(
      { access_token: "synthetic-step-up", id_token: fresh, scope: "codex.remote_control.enroll" },
      { field: "access_token", accountUserId: "user-1", accountID: "acct-workspace-1", flowStartedAt: now, now },
    )
    expect(decoded.stepUpToken).toBe("synthetic-step-up")
    expect(decoded.authTimeMs).toBe(now)
    const run = (value: unknown) => () =>
      decodeStepUpTokenResponse(value, { field: "access_token", accountUserId: "user-1", accountID: "acct-workspace-1", flowStartedAt: now, now })
    expect(run({ access_token: "t", id_token: fresh, scope: "openid" })).toThrow(/scope/)
    expect(run({ access_token: "t", id_token: fakeJWT({ sub: "user-2" }) })).toThrow(/account/)
    expect(run({ access_token: "t", id_token: fakeJWT({ sub: "user-1", auth_time: Math.floor(now / 1000) - 7200 }) })).toThrow(/fresh/)
    expect(run({ id_token: fresh })).toThrow(/access_token/)
  })

  test("loopback callback resolves only the matching state and falls back to the next port", async () => {
    const blocker = createServer((_, response) => response.end("occupied"))
    await new Promise<void>((resolve) => blocker.listen(0, "::1", resolve))
    const occupied = (blocker.address() as { port: number }).port
    const blockerV4 = createServer((_, response) => response.end("occupied"))
    await new Promise<void>((resolve) => blockerV4.listen(occupied, "127.0.0.1", resolve))
    const callback = await createStepUpCallbackServer({ state: "synthetic-state", ports: [occupied, 0] })
    try {
      expect(callback.redirectUri).not.toContain(`:${occupied}/`)
      const waiting = callback.waitForCode()
      const wrong = await fetch(`${callback.redirectUri}?code=synthetic-code&state=wrong`)
      expect(wrong.status).toBe(400)
      await expect(waiting).rejects.toThrow(/state/)
    } finally {
      await callback.close()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
      await new Promise<void>((resolve) => blockerV4.close(() => resolve()))
    }
    const second = await createStepUpCallbackServer({ state: "synthetic-state", ports: [0] })
    try {
      const waiting = second.waitForCode()
      const ok = await fetch(`${second.redirectUri}?code=synthetic-code&state=synthetic-state`)
      expect(ok.status).toBe(200)
      await expect(waiting).resolves.toBe("synthetic-code")
    } finally {
      await second.close()
    }
  })
})
