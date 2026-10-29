import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type JsonWebKeyInput,
} from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { accountHash } from "./state"

export const clientAlgorithm = "ecdsa_p256_sha256"
export const clientProtectionClass = "hardware_secure_enclave"
export const enrollmentPurpose = "remote_control_client_enrollment"
export const stepUpScope = "codex.remote_control.enroll"
export const controllerWebSocketScope = "remote_control_controller_websocket"
export const stepUpClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

const clientBase = "https://chatgpt.com/backend-api/codex/remote/control/client"
const authIssuer = "https://auth.openai.com"
const enrollFinishPath = "/backend-api/codex/remote/control/client/enroll/finish"
const refreshFinishPath = "/backend-api/codex/remote/control/client/refresh/finish"
const signDomain = "codex-device-key-sign-payload/v1"
const clockSkewMs = 300_000

export const clientEnrollStartURL = () => `${clientBase}/enroll/start`
export const clientEnrollFinishURL = () => `${clientBase}/enroll/finish`
export const clientRefreshStartURL = () => `${clientBase}/refresh/start`
export const clientRefreshFinishURL = () => `${clientBase}/refresh/finish`
export const clientWebSocketURL = () => "wss://chatgpt.com/backend-api/codex/remote/control/client"

export type ClientCredential = { readonly access: string; readonly accountID: string }
export type ClientFetch = (url: string, init?: RequestInit) => Promise<Response>

export type StoredProofCredential = {
  readonly access: string
  readonly accountID: string
  readonly key: string
  readonly profile: string
  readonly credentialID: string
  readonly accountGeneration: number
}

export type ProofCredentialSource = {
  readonly dotsProfile: () => Promise<string | undefined>
  readonly resolveStored: (profile: string) => Promise<StoredProofCredential | undefined>
}

export async function selectProofCredential(source: ProofCredentialSource, requestedProfile?: string) {
  const selected = requestedProfile === undefined || requestedProfile.length === 0
    ? { profile: await source.dotsProfile(), selection: "configured" as const }
    : { profile: requestedProfile, selection: "requested" as const }
  if (selected.profile === undefined || selected.profile.length === 0)
    throw new Error("No Dots profile is configured; configure dots.enabled with a dots.profile or pass --profile")
  const resolved = await source.resolveStored(selected.profile)
  if (resolved === undefined)
    throw new Error("The stored ChatGPT credential for the selected profile is unavailable; sign in with this YCoding build first")
  if (resolved.profile !== selected.profile)
    throw new Error("The stored ChatGPT credential does not match the selected profile")
  return { resolved, selection: selected.selection }
}

export function buildClientHeaders(credential: ClientCredential) {
  return {
    authorization: `Bearer ${credential.access}`,
    "chatgpt-account-id": credential.accountID,
    originator: "Codex Desktop",
    "User-Agent": "Codex Desktop/26.1021.31345 (Mac OS; arm64)",
    "content-type": "application/json",
  }
}

export function buildClientWebSocketHeaders(input: { readonly token: string; readonly clientID: string }) {
  return {
    "x-codex-client-session-token": `Bearer ${input.token}`,
    "x-codex-client-id": input.clientID,
    "x-codex-protocol-version": "3",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function requiredString(record: Record<string, unknown>, field: string) {
  const value = record[field]
  if (typeof value !== "string" || value.length === 0) throw new Error(`Malformed client enrollment response: missing ${field}`)
  return value
}

export type DeviceKeyChallenge = {
  readonly challengeId: string
  readonly challengeToken: string
  readonly nonce: string
  readonly purpose: string
  readonly audience: string
  readonly accountUserId: string
  readonly clientId: string
  readonly targetOrigin: string
  readonly targetPath: string
  readonly challengeExpiresAt: string | number
  readonly deviceIdentityHash?: string
}

export type ChallengeResponse = {
  readonly accountUserId: string
  readonly clientId: string
  readonly challenge: DeviceKeyChallenge
}

function expiryMs(value: string | number) {
  if (typeof value === "number") return value < 1_000_000_000_000 ? value * 1_000 : value
  const numeric = Number(value)
  if (/^[0-9]+(\.[0-9]+)?$/.test(value.trim()) && Number.isFinite(numeric))
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
  return Date.parse(value)
}

export function decodeChallengeResponse(
  value: unknown,
  expected: {
    readonly purpose?: string
    readonly audience?: string
    readonly targetPath: string
    readonly accountUserId?: string
    readonly clientId?: string
    readonly deviceIdentityHash?: string
    readonly now?: number
  },
): ChallengeResponse {
  if (!isRecord(value)) throw new Error("Malformed client enrollment response")
  const accountUserId = requiredString(value, "account_user_id")
  const clientId = requiredString(value, "client_id")
  if (!isRecord(value.device_key_challenge)) throw new Error("Malformed client enrollment response: missing device_key_challenge")
  const raw = value.device_key_challenge
  const challengeExpiresAt = raw.challenge_expires_at
  if (typeof challengeExpiresAt !== "string" && typeof challengeExpiresAt !== "number")
    throw new Error("Malformed client enrollment response: missing challenge_expires_at")
  const challenge: DeviceKeyChallenge = {
    challengeId: requiredString(raw, "challenge_id"),
    challengeToken: requiredString(raw, "challenge_token"),
    nonce: requiredString(raw, "nonce"),
    purpose: requiredString(raw, "purpose"),
    audience: requiredString(raw, "audience"),
    accountUserId: requiredString(raw, "account_user_id"),
    clientId: requiredString(raw, "client_id"),
    targetOrigin: requiredString(raw, "target_origin"),
    targetPath: requiredString(raw, "target_path"),
    challengeExpiresAt,
    ...(typeof raw.device_identity_hash === "string" && raw.device_identity_hash.length > 0
      ? { deviceIdentityHash: raw.device_identity_hash }
      : {}),
  }
  if (expected.purpose !== undefined && challenge.purpose !== expected.purpose)
    throw new Error("Device key challenge purpose mismatch")
  if (expected.audience !== undefined && challenge.audience !== expected.audience)
    throw new Error("Device key challenge audience mismatch")
  if (expected.purpose === undefined && expected.audience === undefined && challenge.purpose !== challenge.audience)
    throw new Error("Device key challenge purpose and audience differ")
  if (challenge.accountUserId !== accountUserId || (expected.accountUserId !== undefined && accountUserId !== expected.accountUserId))
    throw new Error("Device key challenge account mismatch")
  if (challenge.clientId !== clientId || (expected.clientId !== undefined && clientId !== expected.clientId))
    throw new Error("Device key challenge client mismatch")
  if (challenge.targetOrigin !== "https://chatgpt.com") throw new Error("Device key challenge target_origin mismatch")
  if (challenge.targetPath !== expected.targetPath) throw new Error("Device key challenge target_path mismatch")
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(challenge.nonce) || Buffer.from(challenge.nonce, "base64url").length < 32)
    throw new Error("Device key challenge nonce must be base64url of at least 32 bytes")
  const expires = expiryMs(challenge.challengeExpiresAt)
  if (!Number.isFinite(expires) || expires <= (expected.now ?? Date.now()))
    throw new Error("Device key challenge expired")
  if (expected.deviceIdentityHash !== undefined && challenge.deviceIdentityHash !== expected.deviceIdentityHash)
    throw new Error("Device key challenge device_identity_hash mismatch or missing")
  return { accountUserId, clientId, challenge }
}

export type DeviceKeyRecord = {
  readonly keyId: string
  readonly algorithm: typeof clientAlgorithm
  readonly protectionClass: typeof clientProtectionClass
  readonly publicKeySpkiDerBase64: string
  readonly privateKeyJwk: { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string; readonly d: string }
}

export function generateKeyId() {
  return `dk_hse_${randomUUID()}`
}

export function generateDeviceKey(keyId: string): DeviceKeyRecord {
  if (typeof keyId !== "string" || keyId.trim().length === 0)
    throw new Error("A keyId is required to generate a device key")
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = pair.privateKey.export({ format: "jwk" })
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d)
    throw new Error("Failed to generate a P-256 device key")
  return {
    keyId,
    algorithm: clientAlgorithm,
    protectionClass: clientProtectionClass,
    publicKeySpkiDerBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
  }
}

export function deviceIdentityHash(input: {
  readonly algorithm: string
  readonly keyId: string
  readonly protectionClass: string
  readonly publicKeySpkiDerBase64: string
}) {
  const record = {
    algorithm: input.algorithm,
    keyId: input.keyId,
    protectionClass: input.protectionClass,
    publicKeySpkiDerBase64: input.publicKeySpkiDerBase64,
  }
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url")
}

export function canonicalSignedPayload(challenge: DeviceKeyChallenge, hash: string, type: string) {
  return JSON.stringify({
    domain: signDomain,
    payload: {
      accountUserId: challenge.accountUserId,
      audience: challenge.audience,
      challengeExpiresAt: challenge.challengeExpiresAt,
      challengeId: challenge.challengeId,
      clientId: challenge.clientId,
      deviceIdentitySha256Base64url: hash,
      nonce: challenge.nonce,
      targetOrigin: challenge.targetOrigin,
      targetPath: challenge.targetPath,
      type,
    },
  })
}

export function enrollCanonicalPayload(challenge: DeviceKeyChallenge, hash: string) {
  return canonicalSignedPayload(challenge, hash, "remoteControlClientEnrollment")
}

export function signPayload(privateKeyJwk: DeviceKeyRecord["privateKeyJwk"], payload: string) {
  const key = createPrivateKey({ key: privateKeyJwk, format: "jwk" } satisfies JsonWebKeyInput)
  return sign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" }).toString("base64")
}

export type DeviceKeyProof = {
  readonly challenge_token: string
  readonly key_id: string
  readonly signature_der_base64: string
  readonly signed_payload_base64: string
  readonly algorithm: typeof clientAlgorithm
}

export function buildDeviceKeyProof(input: {
  readonly challenge: DeviceKeyChallenge
  readonly record: DeviceKeyRecord
  readonly type: string
}): DeviceKeyProof {
  const payload = canonicalSignedPayload(input.challenge, deviceIdentityHash(input.record), input.type)
  return {
    challenge_token: input.challenge.challengeToken,
    key_id: input.record.keyId,
    signature_der_base64: signPayload(input.record.privateKeyJwk, payload),
    signed_payload_base64: Buffer.from(payload, "utf8").toString("base64"),
    algorithm: clientAlgorithm,
  }
}

export function buildEnrollFinishRequest(input: {
  readonly clientId: string
  readonly stepUpToken: string
  readonly record: DeviceKeyRecord
  readonly proof: DeviceKeyProof
}) {
  return {
    client_id: input.clientId,
    step_up_token: input.stepUpToken,
    device_identity: {
      key_id: input.record.keyId,
      public_key_spki_der_base64: input.record.publicKeySpkiDerBase64,
      algorithm: clientAlgorithm,
      protection_class: clientProtectionClass,
    },
    device_key_proof: input.proof,
  }
}

export function buildRefreshFinishRequest(input: { readonly clientId: string; readonly proof: DeviceKeyProof }) {
  return { client_id: input.clientId, device_key_proof: input.proof }
}

export type TokenResponse = {
  readonly remoteControlToken: string
  readonly scope: readonly [typeof controllerWebSocketScope]
  readonly fieldNames: readonly string[]
}

export function decodeTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) throw new Error("Malformed client token response")
  const fieldNames = Object.keys(value).sort()
  const scopes = value.scopes ?? value.scope
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== controllerWebSocketScope)
    throw new Error(`Client token response scope must be exactly ["${controllerWebSocketScope}"]; fields: ${fieldNames.join(", ")}`)
  if (typeof value.remote_control_token !== "string" || value.remote_control_token.length === 0)
    throw new Error(`Client token response is missing remote_control_token; fields: ${fieldNames.join(", ")}`)
  return { remoteControlToken: value.remote_control_token, scope: [controllerWebSocketScope], fieldNames }
}

async function postJSON(fetchFn: ClientFetch, url: string, credential: ClientCredential, body: unknown, operation: string) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: buildClientHeaders(credential),
    redirect: "error",
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Client ${operation} request failed with status ${response.status}`)
  return response.json() as Promise<unknown>
}

export type ClientProofState = {
  readonly version: 1
  readonly clientId: string
  readonly accountUserId: string
  readonly accountHash: string
  readonly keyId: string
  readonly algorithm: typeof clientAlgorithm
  readonly protectionClass: typeof clientProtectionClass
  readonly publicKeySpkiDerBase64: string
  readonly privateKeyJwk: DeviceKeyRecord["privateKeyJwk"]
  readonly deviceIdentitySha256Base64url: string
  readonly updatedAt: number
}

function recordFromState(state: ClientProofState): DeviceKeyRecord {
  return {
    keyId: state.keyId,
    algorithm: state.algorithm,
    protectionClass: state.protectionClass,
    publicKeySpkiDerBase64: state.publicKeySpkiDerBase64,
    privateKeyJwk: state.privateKeyJwk,
  }
}

export async function runEnrollmentProof(input: {
  readonly fetchFn?: ClientFetch
  readonly credential: ClientCredential
  readonly keyId?: string
  readonly stepUpToken: (context: { readonly accountUserId: string; readonly clientId: string }) => Promise<string>
  readonly now?: () => number
}) {
  const fetchFn = input.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const now = input.now ?? Date.now
  const record = generateDeviceKey(input.keyId ?? generateKeyId())
  const started = decodeChallengeResponse(
    await postJSON(fetchFn, clientEnrollStartURL(), input.credential, {}, "enroll/start"),
    { purpose: enrollmentPurpose, audience: enrollmentPurpose, targetPath: enrollFinishPath, now: now() },
  )
  const proof = buildDeviceKeyProof({ challenge: started.challenge, record, type: "remoteControlClientEnrollment" })
  const stepUpToken = await input.stepUpToken({ accountUserId: started.accountUserId, clientId: started.clientId })
  if (typeof stepUpToken !== "string" || stepUpToken.length === 0) throw new Error("Step-up authorization returned no token")
  const tokens = decodeTokenResponse(
    await postJSON(
      fetchFn,
      clientEnrollFinishURL(),
      input.credential,
      buildEnrollFinishRequest({ clientId: started.clientId, stepUpToken, record, proof }),
      "enroll/finish",
    ),
  )
  const state: ClientProofState = {
    version: 1,
    clientId: started.clientId,
    accountUserId: started.accountUserId,
    accountHash: accountHash(input.credential.accountID),
    keyId: record.keyId,
    algorithm: record.algorithm,
    protectionClass: record.protectionClass,
    publicKeySpkiDerBase64: record.publicKeySpkiDerBase64,
    privateKeyJwk: record.privateKeyJwk,
    deviceIdentitySha256Base64url: deviceIdentityHash(record),
    updatedAt: now(),
  }
  return { state, remoteControlToken: tokens.remoteControlToken, scope: tokens.scope, fieldNames: tokens.fieldNames }
}

export async function runRefreshProof(input: {
  readonly fetchFn?: ClientFetch
  readonly credential: ClientCredential
  readonly state: ClientProofState
  readonly refreshPayloadType: string
  readonly refreshPurpose?: string
  readonly now?: () => number
}) {
  if (typeof input.refreshPayloadType !== "string" || input.refreshPayloadType.trim().length === 0)
    throw new Error("A refresh payload type supplied outside this proof is required; the current typed contract does not define it")
  const fetchFn = input.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const now = input.now ?? Date.now
  const record = recordFromState(input.state)
  const computed = deviceIdentityHash(record)
  if (computed !== input.state.deviceIdentitySha256Base64url)
    throw new Error("Stored device_identity_hash does not match the stored device key")
  if (accountHash(input.credential.accountID) !== input.state.accountHash)
    throw new Error("Stored client proof account does not match the supplied account")
  const started = decodeChallengeResponse(
    await postJSON(fetchFn, clientRefreshStartURL(), input.credential, { client_id: input.state.clientId }, "refresh/start"),
    {
      ...(input.refreshPurpose === undefined ? {} : { purpose: input.refreshPurpose, audience: input.refreshPurpose }),
      targetPath: refreshFinishPath,
      accountUserId: input.state.accountUserId,
      clientId: input.state.clientId,
      deviceIdentityHash: computed,
      now: now(),
    },
  )
  const proof = buildDeviceKeyProof({ challenge: started.challenge, record, type: input.refreshPayloadType })
  const tokens = decodeTokenResponse(
    await postJSON(
      fetchFn,
      clientRefreshFinishURL(),
      input.credential,
      buildRefreshFinishRequest({ clientId: started.clientId, proof }),
      "refresh/finish",
    ),
  )
  return {
    remoteControlToken: tokens.remoteControlToken,
    scope: tokens.scope,
    fieldNames: tokens.fieldNames,
    challengePurpose: started.challenge.purpose,
    challengeAudience: started.challenge.audience,
  }
}

export function buildStepUpAuthorizeURL(input: {
  readonly accountID: string
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
}) {
  return `${authIssuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: stepUpClientID,
    scope: stepUpScope,
    code_challenge_method: "S256",
    reauth: "remote_control",
    max_age: "0",
    codex_cli_simplified_flow: "true",
    originator: "Codex Desktop",
    allowed_workspace_id: input.accountID,
    current_workspace_id: input.accountID,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
  })}`
}

export function buildStepUpTokenRequest(input: {
  readonly code: string
  readonly redirectUri: string
  readonly verifier: string
}) {
  return {
    url: `${authIssuer}/oauth/token`,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: stepUpClientID,
      code_verifier: input.verifier,
    }).toString(),
  }
}

export function generateStepUpMaterial() {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  }
}

function decodeClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1]
  if (!part) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function claimCandidates(claims: Record<string, unknown>) {
  const nested = claims["https://api.openai.com/auth"]
  const values: unknown[] = [claims.sub, claims.account_user_id, claims.user_id, claims.chatgpt_account_id]
  if (isRecord(nested)) values.push(nested.chatgpt_account_id, nested.user_id)
  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
}

export function decodeStepUpTokenResponse(
  value: unknown,
  input: {
    readonly field: "access_token" | "id_token"
    readonly accountUserId: string
    readonly accountID: string
    readonly flowStartedAt: number
    readonly now?: number
  },
) {
  if (!isRecord(value)) throw new Error("Malformed step-up token response")
  const fieldNames = Object.keys(value).sort()
  const stepUpToken = value[input.field]
  if (typeof stepUpToken !== "string" || stepUpToken.length === 0)
    throw new Error(`Step-up token response is missing ${input.field}; fields: ${fieldNames.join(", ")}`)
  let scopeVerified = false
  if (typeof value.scope === "string") {
    const scopes = value.scope.split(" ").filter((item) => item.length > 0)
    if (scopes.length !== 1 || scopes[0] !== stepUpScope)
      throw new Error(`Step-up token response scope must be exactly "${stepUpScope}"`)
    scopeVerified = true
  } else if (Array.isArray(value.scope)) {
    if (value.scope.length !== 1 || value.scope[0] !== stepUpScope)
      throw new Error(`Step-up token response scope must be exactly "${stepUpScope}"`)
    scopeVerified = true
  } else if (value.scope !== undefined) {
    throw new Error("Step-up token response scope has an unknown shape")
  }
  const claimsToken = typeof value.id_token === "string" ? value.id_token : stepUpToken
  const claims = decodeClaims(claimsToken)
  if (!claims) throw new Error(`Step-up token account cannot be verified: no decodable claims; fields: ${fieldNames.join(", ")}`)
  const claimNames = Object.keys(claims).sort()
  const candidates = claimCandidates(claims)
  if (!candidates.some((candidate) => candidate === input.accountUserId || candidate === input.accountID))
    throw new Error(`Step-up token account does not match the enrollment account; claims: ${claimNames.join(", ")}`)
  const now = input.now ?? Date.now()
  if (typeof claims.exp === "number" && claims.exp * 1_000 <= now) throw new Error("Step-up token expired")
  let authTimeMs: number | undefined
  if (typeof claims.auth_time === "number") {
    authTimeMs = claims.auth_time * 1_000
    if (authTimeMs < input.flowStartedAt - clockSkewMs)
      throw new Error("Step-up token is not fresh for this enrollment flow")
  }
  return { stepUpToken, claimNames, scopeVerified, ...(authTimeMs === undefined ? {} : { authTimeMs }) }
}

export async function createStepUpCallbackServer(input: {
  readonly state: string
  readonly ports?: readonly number[]
  readonly timeoutMs?: number
}) {
  let resolveCode: (code: string) => void = () => undefined
  let rejectCode: (error: Error) => void = () => undefined
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  code.catch(() => undefined)
  let settled = false
  const succeed = (value: string) => {
    if (!settled) {
      settled = true
      resolveCode(value)
    }
  }
  const fail = (error: Error) => {
    if (!settled) {
      settled = true
      rejectCode(error)
    }
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404).end("Not found")
      return
    }
    const error = url.searchParams.get("error")
    if (error) {
      fail(new Error(`Step-up authorization failed: ${error}`))
      response.writeHead(400, { "Content-Type": "text/html" }).end("Authorization failed. Return to the terminal.")
      return
    }
    const value = url.searchParams.get("code")
    if (!value || url.searchParams.get("state") !== input.state) {
      fail(new Error(value ? "Invalid OAuth state in step-up callback" : "Missing authorization code in step-up callback"))
      response.writeHead(400, { "Content-Type": "text/html" }).end("Authorization failed. Return to the terminal.")
      return
    }
    succeed(value)
    response.writeHead(200, { "Content-Type": "text/html" }).end("Authorization complete. Return to the terminal.")
  })
  const ports = input.ports ?? [1455, 1457]
  let lastError: unknown
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once("error", onError)
        server.listen(port, "localhost", () => {
          server.off("error", onError)
          resolve()
        })
      })
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE")) throw error
    }
  }
  if (lastError !== undefined) throw lastError instanceof Error ? lastError : new Error("Step-up callback ports are in use")
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("Step-up callback server did not bind")
  const timeout = setTimeout(() => fail(new Error("Step-up authorization timed out")), input.timeoutMs ?? 300_000)
  timeout.unref()
  return {
    redirectUri: `http://localhost:${address.port}/auth/callback`,
    waitForCode: () => code,
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timeout)
        server.close(() => resolve())
      }),
  }
}

function decodeProofState(value: unknown): ClientProofState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const jwk = value.privateKeyJwk
  if (
    typeof value.clientId !== "string" ||
    typeof value.accountUserId !== "string" ||
    typeof value.accountHash !== "string" ||
    typeof value.keyId !== "string" ||
    value.algorithm !== clientAlgorithm ||
    value.protectionClass !== clientProtectionClass ||
    typeof value.publicKeySpkiDerBase64 !== "string" ||
    !isRecord(jwk) ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    typeof jwk.d !== "string" ||
    typeof value.deviceIdentitySha256Base64url !== "string" ||
    typeof value.updatedAt !== "number"
  )
    return undefined
  const state: ClientProofState = {
    version: 1,
    clientId: value.clientId,
    accountUserId: value.accountUserId,
    accountHash: value.accountHash,
    keyId: value.keyId,
    algorithm: clientAlgorithm,
    protectionClass: clientProtectionClass,
    publicKeySpkiDerBase64: value.publicKeySpkiDerBase64,
    privateKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    deviceIdentitySha256Base64url: value.deviceIdentitySha256Base64url,
    updatedAt: value.updatedAt,
  }
  return deviceIdentityHash(state) === state.deviceIdentitySha256Base64url ? state : undefined
}

export function createClientProofStateStore(file: string) {
  async function existingIsSymlink() {
    try {
      return (await lstat(file)).isSymbolicLink()
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
      throw error
    }
  }
  return {
    load: async (): Promise<ClientProofState | undefined> => {
      if (await existingIsSymlink()) throw new Error(`Refusing to use ${file} because it is a symbolic link`)
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
        const state = decodeProofState(parsed)
        if (!state) throw new Error(`Malformed client proof state at ${file}; remove it and enroll again`)
        return state
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
        throw error
      }
    },
    save: async (state: ClientProofState) => {
      if (await existingIsSymlink()) throw new Error(`Refusing to use ${file} because it is a symbolic link`)
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

export type ClientProofStateStore = ReturnType<typeof createClientProofStateStore>
