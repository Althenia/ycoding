import { constantTimeEqual, randomToken, sha256Base64Url, sha256Hex } from "../crypto"
import { isIdentityAllowed } from "../allowlist"
import type { GoogleIdentity } from "../google"
import { cleanupLimit, expiredMetadataRetentionMs, oauthTransactionTtlMs } from "../service"
import type {
  McpAuthorizationRow,
  McpAuthorizationStage,
  McpClientRow,
  McpGrantRow,
  McpStore,
  McpTokenRow,
} from "./store"

export const mcpScope = "ycoding:remote"
export const mcpAccessTtlMs = 5 * 60 * 1000
export const mcpCodeTtlMs = 60 * 1000
export const mcpGrantTtlMs = 30 * 24 * 60 * 60 * 1000

const maxStateChars = 512
const challengePattern = /^[A-Za-z0-9_-]{43}$/
const verifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/
const epochPattern = /^[A-Za-z0-9_-]{8,128}$/
const devicePattern = /^[A-Za-z0-9_-]{1,128}$/

export type McpRejection =
  | "invalid_client"
  | "invalid_redirect_uri"
  | "unsupported_response_type"
  | "invalid_request"
  | "invalid_target"
  | "invalid_scope"
  | "invalid_grant"
  | "unknown_transaction"
  | "consumed_transaction"
  | "expired_transaction"
  | "wrong_stage"
  | "bad_csrf"
  | "state_mismatch"
  | "not_allowed"
  | "not_owner"
  | "device_unavailable"
  | "unknown_token"
  | "expired_token"
  | "revoked_token"
  | "wrong_resource"
  | "mcp_disabled"
  | "epoch_mismatch"
  | "insufficient_scope"

export type McpOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: McpRejection }

export type McpStartOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: McpRejection; readonly redirectable: boolean }

export type McpAuthorizeRequest = {
  readonly clientID: string | undefined
  readonly redirectUri: string | undefined
  readonly responseType: string | undefined
  readonly resource: string | undefined
  readonly scope: string | undefined
  readonly state: string | undefined
  readonly codeChallenge: string | undefined
  readonly codeChallengeMethod: string | undefined
}

export type McpPrincipal = {
  readonly ownerID: string
  readonly deviceID: string
  readonly clientID: string
  readonly grantID: string
  readonly epoch: string
  readonly expiresAt: number
}

export type McpTokenSet = {
  readonly accessToken: string
  readonly accessExpiresAt: number
  readonly refreshToken: string
  readonly refreshExpiresAt: number
  readonly scope: string
}

export type McpAuthorizationView = {
  readonly stage: McpAuthorizationStage
  readonly client: McpClientRow
  readonly redirectUri: string
  readonly resource: string
  readonly expiresAt: number
  readonly deviceID?: string
}

export type McpConsentResult =
  | {
      readonly kind: "allow"
      readonly redirectUri: string
      readonly code: string
      readonly state?: string
      readonly issuer: string
    }
  | {
      readonly kind: "deny"
      readonly error: "access_denied"
      readonly redirectUri: string
      readonly state?: string
      readonly issuer: string
    }

export type McpAuthService = ReturnType<typeof createMcpAuthService>

export function createMcpAuthService(options: {
  readonly store: McpStore
  readonly issuer: string
  readonly resolveClient: (clientID: string) => Promise<McpOutcome<McpClientRow>>
  readonly authorizeDevice: (
    deviceID: string,
  ) => Promise<
    { readonly ok: true; readonly value: { readonly userID: string } } | { readonly ok: false; readonly reason: string }
  >
  readonly resolveOwner: (googleSubject: string) => Promise<string>
  readonly now?: () => number
}) {
  const store = options.store
  const now = options.now ?? Date.now
  const resourcePrefix = `${options.issuer}/api/mcp/devices/`
  const resourceFor = (deviceID: string) => `${resourcePrefix}${deviceID}`

  const deviceFailure = async (
    deviceID: string,
    ownerID: string | undefined,
    epoch: string,
  ): Promise<McpRejection | undefined> => {
    const device = await store.getDevice(deviceID)
    if (!device?.enabled) return "mcp_disabled"
    if (device.epoch !== epoch) return "epoch_mismatch"
    const admitted = await options.authorizeDevice(deviceID)
    if (!admitted.ok) return "device_unavailable"
    if (ownerID !== undefined && admitted.value.userID !== ownerID) return "not_owner"
    return undefined
  }

  const grantFailure = (grant: McpGrantRow): Promise<McpRejection | undefined> | McpRejection => {
    if (grant.revokedAt !== undefined) return "revoked_token"
    if (now() >= grant.expiresAt) return "expired_token"
    return deviceFailure(grant.deviceID, grant.ownerID, grant.epoch)
  }

  const liveAuthorization = async (cookieToken: string): Promise<McpOutcome<McpAuthorizationRow>> => {
    const row = await store.findAuthorization(await sha256Hex(cookieToken))
    if (!row) return { ok: false, reason: "unknown_transaction" }
    if (row.consumedAt !== undefined) return { ok: false, reason: "consumed_transaction" }
    if (now() >= row.expiresAt) return { ok: false, reason: "expired_transaction" }
    return { ok: true, value: row }
  }

  const mintTokens = async (grant: McpGrantRow) => {
    const issuedAt = now()
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    const access: McpTokenRow = {
      hash: await sha256Hex(accessToken),
      grantID: grant.id,
      kind: "access",
      createdAt: issuedAt,
      expiresAt: Math.min(issuedAt + mcpAccessTtlMs, grant.expiresAt),
    }
    const refresh: McpTokenRow = {
      hash: await sha256Hex(refreshToken),
      grantID: grant.id,
      kind: "refresh",
      createdAt: issuedAt,
      expiresAt: grant.expiresAt,
    }
    const set: McpTokenSet = {
      accessToken,
      accessExpiresAt: access.expiresAt,
      refreshToken,
      refreshExpiresAt: refresh.expiresAt,
      scope: grant.scope,
    }
    return { access, refresh, set }
  }

  return {
    resourceFor,

    async startAuthorization(input: McpAuthorizeRequest): Promise<
      McpStartOutcome<{
        readonly cookieToken: string
        readonly csrfToken: string
        readonly expiresAt: number
        readonly client: McpClientRow
        readonly deviceID: string
        readonly redirectUri: string
      }>
    > {
      const unredirectable = (reason: McpRejection) => ({ ok: false as const, reason, redirectable: false })
      const redirectable = (reason: McpRejection) => ({ ok: false as const, reason, redirectable: true })

      const resolved = input.clientID === undefined ? undefined : await options.resolveClient(input.clientID)
      if (!resolved?.ok) return unredirectable("invalid_client")
      const client = resolved.value
      if (input.redirectUri === undefined || !client.redirectUris.includes(input.redirectUri))
        return unredirectable("invalid_redirect_uri")

      if (input.responseType !== "code") return redirectable("unsupported_response_type")
      if (
        input.codeChallengeMethod !== "S256" ||
        input.codeChallenge === undefined ||
        !challengePattern.test(input.codeChallenge)
      )
        return redirectable("invalid_request")
      if (
        input.state !== undefined &&
        (input.state.length > maxStateChars || /[\u0000-\u001f\u007f]/.test(input.state))
      )
        return redirectable("invalid_request")
      if (input.scope !== undefined && input.scope !== mcpScope) return redirectable("invalid_scope")

      const deviceID = input.resource?.startsWith(resourcePrefix)
        ? input.resource.slice(resourcePrefix.length)
        : undefined
      if (deviceID === undefined || !devicePattern.test(deviceID)) return redirectable("invalid_target")
      const device = await store.getDevice(deviceID)
      if (!device?.enabled || !(await options.authorizeDevice(deviceID)).ok) return redirectable("invalid_target")

      const cookieToken = randomToken(32)
      const csrfToken = randomToken(24)
      const createdAt = now()
      await store.insertAuthorization({
        id: await sha256Hex(cookieToken),
        clientID: client.id,
        deviceID,
        resource: resourceFor(deviceID),
        scope: mcpScope,
        redirectUri: input.redirectUri,
        ...(input.state === undefined ? {} : { clientState: input.state }),
        codeChallenge: input.codeChallenge,
        stage: "notice",
        csrfHash: await sha256Hex(csrfToken),
        epoch: device.epoch,
        createdAt,
        expiresAt: createdAt + oauthTransactionTtlMs,
      })
      return {
        ok: true,
        value: {
          cookieToken,
          csrfToken,
          expiresAt: createdAt + oauthTransactionTtlMs,
          client,
          deviceID,
          redirectUri: input.redirectUri,
        },
      }
    },

    async describeAuthorization(cookieToken: string): Promise<McpOutcome<McpAuthorizationView>> {
      const row = await liveAuthorization(cookieToken)
      if (!row.ok) return row
      const client = await store.findClient(row.value.clientID)
      if (!client) return { ok: false, reason: "invalid_client" }
      return {
        ok: true,
        value: {
          stage: row.value.stage,
          client,
          redirectUri: row.value.redirectUri,
          resource: row.value.resource,
          expiresAt: row.value.expiresAt,
          ...(row.value.stage === "consent" ? { deviceID: row.value.deviceID } : {}),
        },
      }
    },

    async continueToGoogle(input: {
      readonly cookieToken: string
      readonly csrfToken: string
    }): Promise<McpOutcome<{ readonly state: string; readonly nonce: string; readonly codeChallenge: string }>> {
      const row = await liveAuthorization(input.cookieToken)
      if (!row.ok) return row
      if (row.value.stage !== "notice") return { ok: false, reason: "wrong_stage" }
      const csrfHash = await sha256Hex(input.csrfToken)
      if (!constantTimeEqual(csrfHash, row.value.csrfHash ?? "")) return { ok: false, reason: "bad_csrf" }
      const state = randomToken(24)
      const nonce = randomToken(24)
      const verifier = randomToken(32)
      const began = await store.beginGoogle({
        id: row.value.id,
        csrfHash,
        stateHash: await sha256Hex(state),
        nonce,
        verifier,
        now: now(),
      })
      if (!began) return { ok: false, reason: "consumed_transaction" }
      return { ok: true, value: { state, nonce, codeChallenge: await sha256Base64Url(verifier) } }
    },

    async takeGoogleCallback(input: {
      readonly cookieToken: string
      readonly state: string
    }): Promise<McpOutcome<{ readonly nonce: string; readonly codeVerifier: string }>> {
      const row = await liveAuthorization(input.cookieToken)
      if (!row.ok) return row
      const transaction = row.value
      if (
        transaction.stage !== "google" ||
        !transaction.googleStateHash ||
        !transaction.googleNonce ||
        !transaction.googleVerifier
      )
        return { ok: false, reason: "wrong_stage" }
      const stateHash = await sha256Hex(input.state)
      if (!constantTimeEqual(stateHash, transaction.googleStateHash)) {
        await store.burnAuthorization(transaction.id, now())
        return { ok: false, reason: "state_mismatch" }
      }
      if (!(await store.takeGoogle({ id: transaction.id, stateHash, now: now() })))
        return { ok: false, reason: "consumed_transaction" }
      return { ok: true, value: { nonce: transaction.googleNonce, codeVerifier: transaction.googleVerifier } }
    },

    async bindOwner(input: {
      readonly cookieToken: string
      readonly identity: GoogleIdentity
      readonly allowlist: ReadonlySet<string>
    }): Promise<McpOutcome<{ readonly csrfToken: string; readonly ownerID: string }>> {
      const row = await liveAuthorization(input.cookieToken)
      if (!row.ok) return row
      const transaction = row.value
      if (transaction.stage !== "exchanging") return { ok: false, reason: "wrong_stage" }
      const reject = async (reason: McpRejection) => {
        await store.burnAuthorization(transaction.id, now())
        return { ok: false as const, reason }
      }
      if (!isIdentityAllowed(input.allowlist, input.identity)) return reject("not_allowed")
      const ownerID = await options.resolveOwner(input.identity.subject)
      const failure = await deviceFailure(transaction.deviceID, ownerID, transaction.epoch)
      if (failure) return reject(failure)
      const csrfToken = randomToken(24)
      const bound = await store.bindOwner({
        id: transaction.id,
        ownerID,
        csrfHash: await sha256Hex(csrfToken),
        now: now(),
      })
      if (!bound) return { ok: false, reason: "consumed_transaction" }
      return { ok: true, value: { csrfToken, ownerID } }
    },

    async decideConsent(input: {
      readonly cookieToken: string
      readonly csrfToken: string
      readonly decision: "allow" | "deny"
    }): Promise<McpOutcome<McpConsentResult>> {
      const row = await liveAuthorization(input.cookieToken)
      if (!row.ok) return row
      const transaction = row.value
      if (transaction.stage !== "consent" || transaction.ownerID === undefined)
        return { ok: false, reason: "wrong_stage" }
      const csrfHash = await sha256Hex(input.csrfToken)
      if (!constantTimeEqual(csrfHash, transaction.csrfHash ?? "")) return { ok: false, reason: "bad_csrf" }
      const redirect = {
        redirectUri: transaction.redirectUri,
        ...(transaction.clientState === undefined ? {} : { state: transaction.clientState }),
        issuer: options.issuer,
      }

      if (input.decision === "deny") {
        if (!(await store.denyConsent({ id: transaction.id, csrfHash, now: now() })))
          return { ok: false, reason: "consumed_transaction" }
        return { ok: true, value: { kind: "deny", error: "access_denied", ...redirect } }
      }

      const failure = await deviceFailure(transaction.deviceID, transaction.ownerID, transaction.epoch)
      if (failure) return { ok: false, reason: failure }
      const consentedAt = now()
      const code = randomToken(32)
      const grant: McpGrantRow = {
        id: `grt_${randomToken(12)}`,
        clientID: transaction.clientID,
        deviceID: transaction.deviceID,
        ownerID: transaction.ownerID,
        resource: transaction.resource,
        scope: transaction.scope,
        epoch: transaction.epoch,
        consentedAt,
        expiresAt: consentedAt + mcpGrantTtlMs,
      }
      const allowed = await store.allowConsent({
        id: transaction.id,
        csrfHash,
        now: consentedAt,
        grant,
        code: {
          hash: await sha256Hex(code),
          grantID: grant.id,
          redirectUri: transaction.redirectUri,
          codeChallenge: transaction.codeChallenge,
          createdAt: consentedAt,
          expiresAt: consentedAt + mcpCodeTtlMs,
        },
      })
      if (!allowed) return { ok: false, reason: "consumed_transaction" }
      return { ok: true, value: { kind: "allow", code, ...redirect } }
    },

    async exchangeCode(input: {
      readonly code: string
      readonly clientID: string
      readonly redirectUri: string
      readonly codeVerifier: string
      readonly resource: string | undefined
    }): Promise<McpOutcome<McpTokenSet>> {
      if (!verifierPattern.test(input.codeVerifier)) return { ok: false, reason: "invalid_request" }
      const codeHash = await sha256Hex(input.code)
      const stored = await store.findCode(codeHash)
      if (!stored) return { ok: false, reason: "invalid_grant" }
      const { code, grant } = stored
      if (code.consumedAt !== undefined || now() >= code.expiresAt) return { ok: false, reason: "invalid_grant" }
      if (grant.clientID !== input.clientID || code.redirectUri !== input.redirectUri)
        return { ok: false, reason: "invalid_grant" }
      if (input.resource !== grant.resource) return { ok: false, reason: "invalid_target" }
      if (!constantTimeEqual(await sha256Base64Url(input.codeVerifier), code.codeChallenge))
        return { ok: false, reason: "invalid_grant" }
      if (await grantFailure(grant)) return { ok: false, reason: "invalid_grant" }

      const minted = await mintTokens(grant)
      const exchanged = await store.exchangeCode({
        codeHash,
        now: now(),
        access: minted.access,
        refresh: minted.refresh,
      })
      return exchanged ? { ok: true, value: minted.set } : { ok: false, reason: "invalid_grant" }
    },

    async refresh(input: {
      readonly refreshToken: string
      readonly clientID: string
      readonly resource: string | undefined
    }): Promise<McpOutcome<McpTokenSet>> {
      const tokenHash = await sha256Hex(input.refreshToken)
      const stored = await store.findToken(tokenHash)
      if (stored?.token.kind !== "refresh" || stored.grant.clientID !== input.clientID)
        return { ok: false, reason: "invalid_grant" }
      if (input.resource !== stored.grant.resource) return { ok: false, reason: "invalid_target" }
      if (stored.token.consumedAt !== undefined) {
        await store.revokeGrant(stored.grant.id, now())
        return { ok: false, reason: "invalid_grant" }
      }
      if (stored.token.revokedAt !== undefined || now() >= stored.token.expiresAt || (await grantFailure(stored.grant)))
        return { ok: false, reason: "invalid_grant" }

      const minted = await mintTokens(stored.grant)
      if (await store.rotateRefresh({ tokenHash, now: now(), access: minted.access, refresh: minted.refresh }))
        return { ok: true, value: minted.set }
      const current = await store.findToken(tokenHash)
      if (current?.token.consumedAt !== undefined) await store.revokeGrant(stored.grant.id, now())
      return { ok: false, reason: "invalid_grant" }
    },

    async revoke(input: { readonly token: string; readonly clientID: string }): Promise<void> {
      const stored = await store.findToken(await sha256Hex(input.token))
      if (stored?.grant.clientID === input.clientID) await store.revokeGrant(stored.grant.id, now())
    },

    async authenticateAccess(input: {
      readonly token: string
      readonly resource: string
    }): Promise<McpOutcome<McpPrincipal>> {
      const stored = await store.findToken(await sha256Hex(input.token))
      if (stored?.token.kind !== "access") return { ok: false, reason: "unknown_token" }
      const { token, grant } = stored
      if (input.resource !== grant.resource) return { ok: false, reason: "wrong_resource" }
      if (token.revokedAt !== undefined) return { ok: false, reason: "revoked_token" }
      if (now() >= token.expiresAt) return { ok: false, reason: "expired_token" }
      if (!grant.scope.split(" ").includes(mcpScope)) return { ok: false, reason: "insufficient_scope" }
      const failure = await grantFailure(grant)
      if (failure) return { ok: false, reason: failure }
      return {
        ok: true,
        value: {
          ownerID: grant.ownerID,
          deviceID: grant.deviceID,
          clientID: grant.clientID,
          grantID: grant.id,
          epoch: grant.epoch,
          expiresAt: token.expiresAt,
        },
      }
    },

    async validatePrincipal(principal: McpPrincipal): Promise<McpOutcome<McpPrincipal>> {
      const grant = await store.findGrant(principal.grantID)
      if (
        !grant ||
        grant.ownerID !== principal.ownerID ||
        grant.deviceID !== principal.deviceID ||
        grant.clientID !== principal.clientID ||
        grant.epoch !== principal.epoch
      )
        return { ok: false, reason: "unknown_token" }
      if (now() >= principal.expiresAt) return { ok: false, reason: "expired_token" }
      const failure = await grantFailure(grant)
      return failure ? { ok: false, reason: failure } : { ok: true, value: principal }
    },

    async setDeviceEnabled(input: {
      readonly deviceID: string
      readonly enabled: boolean
      readonly epoch: string
    }): Promise<McpOutcome<{ readonly deviceID: string; readonly enabled: boolean; readonly epoch: string }>> {
      if (!epochPattern.test(input.epoch)) return { ok: false, reason: "invalid_request" }
      if (!(await options.authorizeDevice(input.deviceID)).ok) return { ok: false, reason: "device_unavailable" }
      await store.setDevice({ deviceID: input.deviceID, enabled: input.enabled, epoch: input.epoch, now: now() })
      return { ok: true, value: { deviceID: input.deviceID, enabled: input.enabled, epoch: input.epoch } }
    },

    getDevice: (deviceID: string) => store.getDevice(deviceID),
    revokeGrant: (grantID: string) => store.revokeGrant(grantID, now()),
    revokeDeviceGrants: (deviceID: string) => store.deleteDeviceGrants(deviceID),
    cleanup: () => store.deleteExpired(now(), expiredMetadataRetentionMs, cleanupLimit),
  }
}
