import { describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { createD1AuthStore } from "../src/auth/d1-store"
import { sha256Base64Url } from "../src/auth/crypto"
import { createAuthService } from "../src/auth/service"
import { createD1McpStore } from "../src/auth/mcp/d1-store"
import { createMemoryMcpStore } from "../src/auth/mcp/memory-store"
import { createMcpAuthService } from "../src/auth/mcp/service"
import { createMemoryAuthStore } from "./support/memory-store"
import { migratedDatabase } from "./support/d1-sqlite"

const issuer = "https://relay.example"
const redirect = "https://client.example/callback"
const clientID = "mcp_client_1"
const epochA = "epoch-aaaaaaaaaaaa"
const epochB = "epoch-bbbbbbbbbbbb"
const verifier = "v".repeat(43)
const minute = 60_000
const day = 24 * 60 * minute
const allowlist = new Set(["owner@example.com"])
const ownerIdentity = { subject: "sub-owner", email: "owner@example.com", emailVerified: true }

function atomicD1(sqlite: Database): D1Database {
  const statement = (sql: string, values: readonly (string | number | null)[]) => {
    const exec = () => ({ results: [], meta: { changes: sqlite.prepare(sql).run(...values).changes } })
    return {
      exec,
      run: async () => exec(),
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
    }
  }
  const value: unknown = {
    prepare: (sql: string) => ({ ...statement(sql, []), bind: (...values: (string | number | null)[]) => statement(sql, values) }),
    batch: async (statements: readonly { exec: () => unknown }[]) => {
      sqlite.exec("BEGIN")
      try {
        const results = statements.map((item) => item.exec())
        sqlite.exec("COMMIT")
        return results
      } catch (cause) {
        sqlite.exec("ROLLBACK")
        throw cause
      }
    },
  }
  return value as D1Database
}

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" }
}

type Kind = "memory" | "d1"

async function harness(kind: Kind) {
  let clock = 1_700_000_000_000
  const now = () => clock
  const sqlite = kind === "d1" ? await migratedDatabase() : undefined
  const db = sqlite ? atomicD1(sqlite) : undefined
  const authStore = db ? createD1AuthStore(db) : createMemoryAuthStore()
  const auth = createAuthService(authStore, { now })
  const store = db ? createD1McpStore(db) : createMemoryMcpStore()
  const owner = await authStore.findOrCreateUser("google", "sub-owner", clock)
  const stranger = await authStore.findOrCreateUser("google", "sub-stranger", clock)
  const publicKey = await deviceKey()
  await authStore.insertDevice({ id: "dev_1", userID: owner, name: "Studio", publicKey, createdAt: clock })
  await authStore.insertDevice({ id: "dev_2", userID: stranger, name: "Other", publicKey, createdAt: clock })
  const service = createMcpAuthService({
    store,
    issuer,
    now,
    resolveClient: async (id) => {
      const client = await store.findClient(id)
      return client ? { ok: true, value: client } : { ok: false, reason: "invalid_client" }
    },
    authorizeDevice: (deviceID) => auth.authorizeAgentCommand(deviceID),
    resolveOwner: (subject) => authStore.findOrCreateUser("google", subject, clock),
  })
  await store.saveClient({ id: clientID, kind: "dcr", name: "Test Client", redirectUris: [redirect], authMethod: "none", createdAt: clock }, 100)
  const enabled = await service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: epochA })
  expect(enabled.ok).toBe(true)
  return {
    kind,
    sqlite,
    service,
    store,
    auth,
    owner,
    stranger,
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
    at: () => clock,
    resource: service.resourceFor("dev_1"),
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

function request(h: Harness, overrides: Record<string, string | undefined> = {}) {
  return {
    clientID,
    redirectUri: redirect,
    responseType: "code",
    resource: h.resource,
    scope: "ycoding:remote",
    state: "client-state",
    codeChallenge: "",
    codeChallengeMethod: "S256",
    ...overrides,
  }
}

async function authorizeRequest(h: Harness, overrides: Record<string, string | undefined> = {}) {
  return h.service.startAuthorization(request(h, { codeChallenge: await sha256Base64Url(verifier), ...overrides }))
}

function must<Value>(result: { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly reason: string }): Value {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}`)
  return result.value
}

async function reachConsent(h: Harness, overrides: Record<string, string | undefined> = {}) {
  const started = must(await authorizeRequest(h, overrides))
  const continued = must(await h.service.continueToGoogle({ cookieToken: started.cookieToken, csrfToken: started.csrfToken }))
  const taken = must(await h.service.takeGoogleCallback({ cookieToken: started.cookieToken, state: continued.state }))
  const bound = must(await h.service.bindOwner({ cookieToken: started.cookieToken, identity: ownerIdentity, allowlist }))
  return { started, continued, taken, cookieToken: started.cookieToken, consentCsrf: bound.csrfToken }
}

async function issueCode(h: Harness, overrides: Record<string, string | undefined> = {}) {
  const consent = await reachConsent(h, overrides)
  const decided = must(await h.service.decideConsent({ cookieToken: consent.cookieToken, csrfToken: consent.consentCsrf, decision: "allow" }))
  if (decided.kind !== "allow") throw new Error("expected allow")
  return { ...consent, code: decided.code, decided }
}

function exchange(h: Harness, code: string, overrides: Partial<Parameters<Harness["service"]["exchangeCode"]>[0]> = {}) {
  return h.service.exchangeCode({ code, clientID, redirectUri: redirect, codeVerifier: verifier, resource: h.resource, ...overrides })
}

async function issueTokens(h: Harness) {
  const { code } = await issueCode(h)
  return must(await exchange(h, code))
}

function refresh(h: Harness, refreshToken: string, overrides: Partial<Parameters<Harness["service"]["refresh"]>[0]> = {}) {
  return h.service.refresh({ refreshToken, clientID, resource: h.resource, ...overrides })
}

function rows(h: Harness, table: string) {
  return Number((h.sqlite?.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

for (const kind of ["memory", "d1"] as const) {
  describe(`MCP authorization (${kind} store)`, () => {
    describe("authorization request", () => {
      test("rejects unknown clients and unregistered redirects without allowing a redirect", async () => {
        const h = await harness(kind)
        const unknown = await authorizeRequest(h, { clientID: "mcp_missing" })
        expect(unknown).toEqual({ ok: false, reason: "invalid_client", redirectable: false })
        for (const redirectUri of [`${redirect}?x=1`, `${redirect}/`, "https://client.example/other", "http://client.example/callback"]) {
          expect(await authorizeRequest(h, { redirectUri })).toEqual({ ok: false, reason: "invalid_redirect_uri", redirectable: false })
        }
      })

      test("rejects request parameters that break the binding with redirectable OAuth errors", async () => {
        const h = await harness(kind)
        const cases: readonly [Record<string, string | undefined>, string][] = [
          [{ responseType: "token" }, "unsupported_response_type"],
          [{ codeChallengeMethod: "plain" }, "invalid_request"],
          [{ codeChallengeMethod: undefined }, "invalid_request"],
          [{ codeChallenge: "short" }, "invalid_request"],
          [{ codeChallenge: undefined }, "invalid_request"],
          [{ resource: `${issuer}/api/mcp/devices/dev_missing` }, "invalid_target"],
          [{ resource: `${issuer}/api/mcp/devices/dev_2` }, "invalid_target"],
          [{ resource: "https://other.example/api/mcp/devices/dev_1" }, "invalid_target"],
          [{ resource: undefined }, "invalid_target"],
          [{ scope: "ycoding:remote extra" }, "invalid_scope"],
          [{ scope: "other" }, "invalid_scope"],
          [{ state: "s".repeat(513) }, "invalid_request"],
        ]
        for (const [overrides, reason] of cases) {
          const result = await authorizeRequest(h, overrides)
          expect({ overrides, result }).toEqual({ overrides, result: { ok: false, reason, redirectable: true } })
        }
      })

      test("treats a device with MCP off as an invalid target and defaults an omitted scope", async () => {
        const h = await harness(kind)
        expect((await authorizeRequest(h, { scope: undefined })).ok).toBe(true)
        must(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: false, epoch: epochB }))
        expect(await authorizeRequest(h)).toEqual({ ok: false, reason: "invalid_target", redirectable: true })
      })
    })

    describe("consent transaction", () => {
      test("walks notice, Google, and final consent and issues a code bound to the transaction", async () => {
        const h = await harness(kind)
        const flow = await issueCode(h)
        expect(flow.started.client.name).toBe("Test Client")
        expect(flow.started.deviceID).toBe("dev_1")
        expect(flow.continued.codeChallenge).toBe(await sha256Base64Url(flow.taken.codeVerifier))
        expect(flow.taken.nonce).toBe(flow.continued.nonce)
        expect(flow.decided).toMatchObject({ kind: "allow", redirectUri: redirect, state: "client-state", issuer })
        expect(flow.code.length).toBeGreaterThanOrEqual(43)
        const view = await h.service.describeAuthorization(flow.cookieToken)
        expect(view).toEqual({ ok: false, reason: "consumed_transaction" })
      })

      test("reveals the device only after the owner is verified", async () => {
        const h = await harness(kind)
        const started = must(await authorizeRequest(h))
        const notice = must(await h.service.describeAuthorization(started.cookieToken))
        expect(notice).toMatchObject({ stage: "notice", redirectUri: redirect, resource: h.resource })
        expect("deviceID" in notice).toBe(false)
        const continued = must(await h.service.continueToGoogle({ cookieToken: started.cookieToken, csrfToken: started.csrfToken }))
        expect("deviceID" in must(await h.service.describeAuthorization(started.cookieToken))).toBe(false)
        must(await h.service.takeGoogleCallback({ cookieToken: started.cookieToken, state: continued.state }))
        expect("deviceID" in must(await h.service.describeAuthorization(started.cookieToken))).toBe(false)
        must(await h.service.bindOwner({ cookieToken: started.cookieToken, identity: ownerIdentity, allowlist }))
        expect(must(await h.service.describeAuthorization(started.cookieToken))).toMatchObject({ stage: "consent", deviceID: "dev_1" })
      })

      test("takes redirect URIs from the live client resolution, not from stored client data", async () => {
        const h = await harness(kind)
        const swapped = createMcpAuthService({
          store: h.store,
          issuer,
          now: () => h.at(),
          resolveClient: async () => ({
            ok: true,
            value: { id: clientID, kind: "cimd", name: "Moved", redirectUris: ["https://client.example/moved"], authMethod: "none", createdAt: 1 },
          }),
          authorizeDevice: (deviceID) => h.auth.authorizeAgentCommand(deviceID),
          resolveOwner: async () => h.owner,
        })
        const base = request(h, { codeChallenge: await sha256Base64Url(verifier) })
        expect(await swapped.startAuthorization(base)).toEqual({ ok: false, reason: "invalid_redirect_uri", redirectable: false })
        expect((await swapped.startAuthorization({ ...base, redirectUri: "https://client.example/moved" })).ok).toBe(true)
      })

      test("enforces stage order and CSRF values", async () => {
        const h = await harness(kind)
        const started = must(await authorizeRequest(h))
        const cookieToken = started.cookieToken
        expect(await h.service.takeGoogleCallback({ cookieToken, state: "x" })).toMatchObject({ ok: false, reason: "wrong_stage" })
        expect(await h.service.bindOwner({ cookieToken, identity: ownerIdentity, allowlist })).toMatchObject({ ok: false, reason: "wrong_stage" })
        expect(await h.service.decideConsent({ cookieToken, csrfToken: started.csrfToken, decision: "allow" })).toMatchObject({ ok: false, reason: "wrong_stage" })
        expect(await h.service.continueToGoogle({ cookieToken, csrfToken: "wrong" })).toMatchObject({ ok: false, reason: "bad_csrf" })
        const continued = must(await h.service.continueToGoogle({ cookieToken, csrfToken: started.csrfToken }))
        expect(await h.service.continueToGoogle({ cookieToken, csrfToken: started.csrfToken })).toMatchObject({ ok: false })
        must(await h.service.takeGoogleCallback({ cookieToken, state: continued.state }))
        const bound = must(await h.service.bindOwner({ cookieToken, identity: ownerIdentity, allowlist }))
        expect(await h.service.decideConsent({ cookieToken, csrfToken: started.csrfToken, decision: "allow" })).toMatchObject({ ok: false, reason: "bad_csrf" })
        expect(await h.service.decideConsent({ cookieToken, csrfToken: "wrong", decision: "allow" })).toMatchObject({ ok: false, reason: "bad_csrf" })
        expect((await h.service.decideConsent({ cookieToken, csrfToken: bound.csrfToken, decision: "allow" })).ok).toBe(true)
      })

      test("uses the Google callback once and burns the transaction on a state mismatch", async () => {
        const h = await harness(kind)
        const first = must(await authorizeRequest(h))
        const continued = must(await h.service.continueToGoogle({ cookieToken: first.cookieToken, csrfToken: first.csrfToken }))
        must(await h.service.takeGoogleCallback({ cookieToken: first.cookieToken, state: continued.state }))
        expect(await h.service.takeGoogleCallback({ cookieToken: first.cookieToken, state: continued.state })).toMatchObject({ ok: false })

        const second = must(await authorizeRequest(h))
        const secondContinued = must(await h.service.continueToGoogle({ cookieToken: second.cookieToken, csrfToken: second.csrfToken }))
        expect(await h.service.takeGoogleCallback({ cookieToken: second.cookieToken, state: "wrong" })).toMatchObject({ ok: false, reason: "state_mismatch" })
        expect(await h.service.takeGoogleCallback({ cookieToken: second.cookieToken, state: secondContinued.state })).toMatchObject({ ok: false })
      })

      test("admits only allowlisted, verified Google identities that own the device", async () => {
        const h = await harness(kind)
        const attempt = async (identity: Parameters<Harness["service"]["bindOwner"]>[0]["identity"], list: ReadonlySet<string> = allowlist) => {
          const started = must(await authorizeRequest(h))
          const continued = must(await h.service.continueToGoogle({ cookieToken: started.cookieToken, csrfToken: started.csrfToken }))
          must(await h.service.takeGoogleCallback({ cookieToken: started.cookieToken, state: continued.state }))
          return h.service.bindOwner({ cookieToken: started.cookieToken, identity, allowlist: list })
        }
        expect(await attempt({ ...ownerIdentity, email: "intruder@example.com" })).toMatchObject({ ok: false, reason: "not_allowed" })
        expect(await attempt({ ...ownerIdentity, emailVerified: false })).toMatchObject({ ok: false, reason: "not_allowed" })
        expect(await attempt(ownerIdentity, new Set())).toMatchObject({ ok: false, reason: "not_allowed" })
        expect(await attempt({ subject: "sub-stranger", email: "owner@example.com", emailVerified: true })).toMatchObject({ ok: false, reason: "not_owner" })
        expect((await attempt(ownerIdentity)).ok).toBe(true)
      })

      test("expires an unfinished transaction after ten minutes", async () => {
        const h = await harness(kind)
        const started = must(await authorizeRequest(h))
        h.advance(10 * minute + 1)
        expect(await h.service.continueToGoogle({ cookieToken: started.cookieToken, csrfToken: started.csrfToken })).toMatchObject({ ok: false, reason: "expired_transaction" })
        expect(await h.service.describeAuthorization("unknown-cookie")).toEqual({ ok: false, reason: "unknown_transaction" })
      })

      test("denies with the validated redirect, client state, and issuer and issues nothing", async () => {
        const h = await harness(kind)
        const consent = await reachConsent(h)
        const denied = must(await h.service.decideConsent({ cookieToken: consent.cookieToken, csrfToken: consent.consentCsrf, decision: "deny" }))
        expect(denied).toEqual({ kind: "deny", error: "access_denied", redirectUri: redirect, state: "client-state", issuer })
        expect(await h.service.decideConsent({ cookieToken: consent.cookieToken, csrfToken: consent.consentCsrf, decision: "allow" })).toMatchObject({ ok: false })
        if (h.sqlite) {
          expect(rows(h, "mcp_grant")).toBe(0)
          expect(rows(h, "mcp_code")).toBe(0)
        }
      })

      test("refuses a replayed Allow and creates exactly one grant under concurrent Allow", async () => {
        const h = await harness(kind)
        const consent = await reachConsent(h)
        const decide = () => h.service.decideConsent({ cookieToken: consent.cookieToken, csrfToken: consent.consentCsrf, decision: "allow" })
        const results = await Promise.all([decide(), decide()])
        expect(results.filter((result) => result.ok)).toHaveLength(1)
        expect(await decide()).toMatchObject({ ok: false })
        if (h.sqlite) {
          expect(rows(h, "mcp_grant")).toBe(1)
          expect(rows(h, "mcp_code")).toBe(1)
        }
      })

      test("refuses consent when the device epoch changed after the request started", async () => {
        const h = await harness(kind)
        const consent = await reachConsent(h)
        must(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: epochB }))
        expect(await h.service.decideConsent({ cookieToken: consent.cookieToken, csrfToken: consent.consentCsrf, decision: "allow" })).toMatchObject({ ok: false })
        if (h.sqlite) expect(rows(h, "mcp_grant")).toBe(0)
      })

      test("refuses consent when the owner no longer owns an active device", async () => {
        const h = await harness(kind)
        const consent = await reachConsent(h)
        must(await h.auth.revokeDevice({ deviceID: "dev_1", userID: h.owner }))
        expect(await h.service.decideConsent({ cookieToken: consent.cookieToken, csrfToken: consent.consentCsrf, decision: "allow" })).toMatchObject({ ok: false })
        if (h.sqlite) expect(rows(h, "mcp_grant")).toBe(0)
      })
    })

    describe("code exchange", () => {
      test("issues a five minute access token and a refresh token bounded by the thirty day grant", async () => {
        const h = await harness(kind)
        const issuedAt = h.at()
        const tokens = await issueTokens(h)
        expect(tokens.accessToken).not.toBe(tokens.refreshToken)
        expect(tokens.accessExpiresAt).toBe(issuedAt + 5 * minute)
        expect(tokens.refreshExpiresAt).toBe(issuedAt + 30 * day)
        expect(tokens.scope).toBe("ycoding:remote")
      })

      test("accepts a code once and creates one token pair under concurrent exchange", async () => {
        const h = await harness(kind)
        const { code } = await issueCode(h)
        const results = await Promise.all([exchange(h, code), exchange(h, code)])
        expect(results.filter((result) => result.ok)).toHaveLength(1)
        expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "invalid_grant" })
        expect(await exchange(h, code)).toEqual({ ok: false, reason: "invalid_grant" })
        if (h.sqlite) expect(rows(h, "mcp_token")).toBe(2)
      })

      test("rejects mismatched verifier, redirect, client, resource, and malformed values without consuming the code", async () => {
        const h = await harness(kind)
        const { code } = await issueCode(h)
        expect(await exchange(h, code, { codeVerifier: "w".repeat(43) })).toEqual({ ok: false, reason: "invalid_grant" })
        expect(await exchange(h, code, { codeVerifier: "short" })).toEqual({ ok: false, reason: "invalid_request" })
        expect(await exchange(h, code, { redirectUri: `${redirect}?x=1` })).toEqual({ ok: false, reason: "invalid_grant" })
        expect(await exchange(h, code, { clientID: "mcp_other" })).toEqual({ ok: false, reason: "invalid_grant" })
        expect(await exchange(h, code, { resource: `${issuer}/api/mcp/devices/dev_2` })).toEqual({ ok: false, reason: "invalid_target" })
        expect(await exchange(h, "unknown-code")).toEqual({ ok: false, reason: "invalid_grant" })
        expect((await exchange(h, code)).ok).toBe(true)
      })

      test("expires a code after one minute", async () => {
        const h = await harness(kind)
        const { code } = await issueCode(h)
        h.advance(minute + 1)
        expect(await exchange(h, code)).toEqual({ ok: false, reason: "invalid_grant" })
      })

      test("refuses exchange after MCP is turned off or the epoch changes", async () => {
        const h = await harness(kind)
        const { code } = await issueCode(h)
        must(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: epochB }))
        expect(await exchange(h, code)).toEqual({ ok: false, reason: "invalid_grant" })
      })
    })

    describe("access validation", () => {
      test("returns the principal for the exact resource and revalidates it without the bearer", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        const principal = must(await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource }))
        expect(principal).toMatchObject({ ownerID: h.owner, deviceID: "dev_1", clientID, epoch: epochA, expiresAt: tokens.accessExpiresAt })
        expect(principal.grantID.length).toBeGreaterThan(0)
        expect(must(await h.service.validatePrincipal(principal))).toEqual(principal)
      })

      test("rejects unknown, refresh-kind, foreign-resource, and expired bearers", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        expect(await h.service.authenticateAccess({ token: "nope", resource: h.resource })).toEqual({ ok: false, reason: "unknown_token" })
        expect(await h.service.authenticateAccess({ token: tokens.refreshToken, resource: h.resource })).toEqual({ ok: false, reason: "unknown_token" })
        expect(await h.service.authenticateAccess({ token: tokens.accessToken, resource: `${issuer}/api/mcp/devices/dev_2` })).toEqual({ ok: false, reason: "wrong_resource" })
        const principal = must(await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource }))
        h.advance(5 * minute)
        expect(await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource })).toEqual({ ok: false, reason: "expired_token" })
        expect(await h.service.validatePrincipal(principal)).toMatchObject({ ok: false })
      })

      test("rejects once MCP is off, the epoch changed, or the device was revoked", async () => {
        const off = await harness(kind)
        const offTokens = await issueTokens(off)
        const offPrincipal = must(await off.service.authenticateAccess({ token: offTokens.accessToken, resource: off.resource }))
        must(await off.service.setDeviceEnabled({ deviceID: "dev_1", enabled: false, epoch: epochB }))
        expect((await off.service.authenticateAccess({ token: offTokens.accessToken, resource: off.resource })).ok).toBe(false)
        expect((await off.service.validatePrincipal(offPrincipal)).ok).toBe(false)

        const epoch = await harness(kind)
        const epochTokens = await issueTokens(epoch)
        const epochPrincipal = must(await epoch.service.authenticateAccess({ token: epochTokens.accessToken, resource: epoch.resource }))
        must(await epoch.service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: epochB }))
        expect((await epoch.service.authenticateAccess({ token: epochTokens.accessToken, resource: epoch.resource })).ok).toBe(false)
        expect((await epoch.service.validatePrincipal(epochPrincipal)).ok).toBe(false)

        const revoked = await harness(kind)
        const revokedTokens = await issueTokens(revoked)
        const revokedPrincipal = must(await revoked.service.authenticateAccess({ token: revokedTokens.accessToken, resource: revoked.resource }))
        must(await revoked.auth.revokeDevice({ deviceID: "dev_1", userID: revoked.owner }))
        expect(await revoked.service.authenticateAccess({ token: revokedTokens.accessToken, resource: revoked.resource })).toEqual({
          ok: false,
          reason: kind === "d1" ? "unknown_token" : "device_unavailable",
        })
        expect((await revoked.service.validatePrincipal(revokedPrincipal)).ok).toBe(false)
      })

      test("keeps grants across a same-epoch reconnect and drops them on a new epoch", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        must(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: epochA }))
        expect((await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource })).ok).toBe(true)
        must(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: epochB }))
        if (h.sqlite) {
          expect(rows(h, "mcp_grant")).toBe(0)
          expect(rows(h, "mcp_token")).toBe(0)
        }
        expect((await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource })).ok).toBe(false)
        expect(await refresh(h, tokens.refreshToken)).toEqual({ ok: false, reason: "invalid_grant" })
      })

      test("rejects an invalid epoch and a device the owner cannot reach", async () => {
        const h = await harness(kind)
        expect(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: true, epoch: "bad epoch!" })).toMatchObject({ ok: false })
        expect(await h.service.setDeviceEnabled({ deviceID: "dev_missing", enabled: true, epoch: epochA })).toMatchObject({ ok: false })
        must(await h.auth.revokeDevice({ deviceID: "dev_2", userID: h.stranger }))
        expect(await h.service.setDeviceEnabled({ deviceID: "dev_2", enabled: true, epoch: epochA })).toMatchObject({ ok: false })
      })
    })

    describe("refresh", () => {
      test("rotates once, never extends the absolute lifetime, and stops at it", async () => {
        const h = await harness(kind)
        const issuedAt = h.at()
        const first = await issueTokens(h)
        h.advance(29 * day)
        const second = must(await refresh(h, first.refreshToken))
        expect(second.refreshToken).not.toBe(first.refreshToken)
        expect(second.refreshExpiresAt).toBe(issuedAt + 30 * day)
        expect(second.accessExpiresAt).toBe(h.at() + 5 * minute)
        h.advance(day - 1_000)
        const third = must(await refresh(h, second.refreshToken))
        expect(third.accessExpiresAt).toBe(issuedAt + 30 * day)
        h.advance(2_000)
        expect(await refresh(h, third.refreshToken)).toEqual({ ok: false, reason: "invalid_grant" })
        expect((await h.service.authenticateAccess({ token: third.accessToken, resource: h.resource })).ok).toBe(false)
      })

      test("revokes the whole family when a rotated refresh token is presented again", async () => {
        const h = await harness(kind)
        const first = await issueTokens(h)
        const second = must(await refresh(h, first.refreshToken))
        expect(await refresh(h, first.refreshToken)).toEqual({ ok: false, reason: "invalid_grant" })
        expect((await h.service.authenticateAccess({ token: second.accessToken, resource: h.resource })).ok).toBe(false)
        expect(await refresh(h, second.refreshToken)).toEqual({ ok: false, reason: "invalid_grant" })
      })

      test("creates exactly one replacement pair under concurrent refresh", async () => {
        const h = await harness(kind)
        const first = await issueTokens(h)
        const results = await Promise.all([refresh(h, first.refreshToken), refresh(h, first.refreshToken)])
        expect(results.filter((result) => result.ok)).toHaveLength(1)
        expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "invalid_grant" })
        if (h.sqlite) expect(rows(h, "mcp_token")).toBe(4)
      })

      test("rejects the wrong client, the wrong resource, and an access token", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        expect(await refresh(h, tokens.refreshToken, { clientID: "mcp_other" })).toEqual({ ok: false, reason: "invalid_grant" })
        expect(await refresh(h, tokens.refreshToken, { resource: `${issuer}/api/mcp/devices/dev_2` })).toEqual({ ok: false, reason: "invalid_target" })
        expect(await refresh(h, tokens.accessToken)).toEqual({ ok: false, reason: "invalid_grant" })
        expect(await refresh(h, "unknown")).toEqual({ ok: false, reason: "invalid_grant" })
        expect((await refresh(h, tokens.refreshToken)).ok).toBe(true)
      })
    })

    describe("client capacity", () => {
      const pendingClient = (id: string, at: number, name = "Pending") => ({
        id,
        kind: "cimd" as const,
        name,
        redirectUris: [redirect],
        authMethod: "none" as const,
        createdAt: at,
      })

      test("counts only never-authorized clients against the cap and refreshes existing ones at the cap", async () => {
        const h = await harness(kind)
        expect(await h.store.saveClient(pendingClient("pending_1", h.at()), 2)).toBe(true)
        expect(await h.store.countPendingClients()).toBe(2)
        expect(await h.store.saveClient(pendingClient("pending_2", h.at()), 2)).toBe(false)
        expect(await h.store.saveClient(pendingClient("pending_1", h.at(), "Renamed"), 2)).toBe(true)
        expect((await h.store.findClient("pending_1"))?.name).toBe("Renamed")
        await issueTokens(h)
        expect(await h.store.countPendingClients()).toBe(1)
        expect(await h.store.saveClient(pendingClient("pending_2", h.at()), 2)).toBe(true)
        expect(await h.store.saveClient(pendingClient("pending_3", h.at()), 2)).toBe(false)
      })

      test("admits at most the cap under concurrent inserts", async () => {
        const h = await harness(kind)
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => h.store.saveClient(pendingClient(`pending_${index}`, h.at()), 4)))
        expect(results.filter(Boolean)).toHaveLength(3)
        expect(await h.store.countPendingClients()).toBe(4)
      })

      test("stamps first authorization only when consent wins and keeps it across refreshes", async () => {
        const h = await harness(kind)
        const denied = await reachConsent(h)
        must(await h.service.decideConsent({ cookieToken: denied.cookieToken, csrfToken: denied.consentCsrf, decision: "deny" }))
        expect((await h.store.findClient(clientID))?.firstAuthorizedAt).toBeUndefined()
        const first = h.at()
        await issueCode(h)
        expect((await h.store.findClient(clientID))?.firstAuthorizedAt).toBe(first)
        h.advance(day)
        await issueCode(h)
        await h.store.saveClient({ id: clientID, kind: "dcr", name: "Renamed", redirectUris: [redirect], authMethod: "none", createdAt: h.at() }, 1)
        expect(await h.store.findClient(clientID)).toMatchObject({ name: "Renamed", firstAuthorizedAt: first })
      })

      test("sweeps never-authorized clients after the authorization lifetime and retention, and nothing else", async () => {
        const h = await harness(kind)
        const start = h.at()
        await issueTokens(h)
        await h.store.saveClient(pendingClient("pending_old", start), 10)
        await h.store.saveClient(pendingClient("pending_live", start), 10)
        h.advance(7 * day + 9 * minute)
        expect((await h.service.cleanup()).clients).toBe(0)
        h.advance(2 * minute)
        const live = await h.service.startAuthorization(request(h, { clientID: "pending_live", codeChallenge: await sha256Base64Url(verifier) }))
        expect(live.ok).toBe(true)
        const counts = await h.service.cleanup()
        expect(counts.clients).toBe(1)
        expect(await h.store.findClient("pending_old")).toBeUndefined()
        expect(await h.store.findClient("pending_live")).toBeDefined()
        expect(await h.store.findClient(clientID)).toBeDefined()
      })

      test("keeps approved clients through grant revocation, MCP off, and long-term cleanup", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        const principal = must(await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource }))
        await h.service.revokeGrant(principal.grantID)
        must(await h.service.setDeviceEnabled({ deviceID: "dev_1", enabled: false, epoch: epochB }))
        await h.service.revokeDeviceGrants("dev_1")
        h.advance(400 * day)
        await h.service.cleanup()
        await h.service.cleanup()
        expect(await h.store.findClient(clientID)).toBeDefined()
        if (h.sqlite) expect(rows(h, "mcp_client")).toBe(1)
      })
    })

    describe("revocation", () => {
      test("revokes the grant through either token and reveals nothing for unknown tokens", async () => {
        const viaRefresh = await harness(kind)
        const refreshTokens = await issueTokens(viaRefresh)
        await viaRefresh.service.revoke({ token: refreshTokens.refreshToken, clientID })
        expect((await viaRefresh.service.authenticateAccess({ token: refreshTokens.accessToken, resource: viaRefresh.resource })).ok).toBe(false)
        expect(await refresh(viaRefresh, refreshTokens.refreshToken)).toEqual({ ok: false, reason: "invalid_grant" })

        const viaAccess = await harness(kind)
        const accessTokens = await issueTokens(viaAccess)
        await viaAccess.service.revoke({ token: accessTokens.accessToken, clientID })
        expect(await refresh(viaAccess, accessTokens.refreshToken)).toEqual({ ok: false, reason: "invalid_grant" })

        await expect(viaAccess.service.revoke({ token: "unknown", clientID })).resolves.toBeUndefined()
      })

      test("ignores a revocation from a different client", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        await h.service.revoke({ token: tokens.refreshToken, clientID: "mcp_other" })
        expect((await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource })).ok).toBe(true)
      })

      test("revokes by grant ID and by device", async () => {
        const h = await harness(kind)
        const tokens = await issueTokens(h)
        const principal = must(await h.service.authenticateAccess({ token: tokens.accessToken, resource: h.resource }))
        await h.service.revokeGrant(principal.grantID)
        expect((await h.service.validatePrincipal(principal)).ok).toBe(false)

        const again = await issueTokens(h)
        await h.service.revokeDeviceGrants("dev_1")
        expect((await h.service.authenticateAccess({ token: again.accessToken, resource: h.resource })).ok).toBe(false)
        if (h.sqlite) expect(rows(h, "mcp_grant")).toBe(0)
      })
    })

    test("sweeps expired transactions, codes, tokens, and grants after the retention window", async () => {
      const h = await harness(kind)
      await issueTokens(h)
      await reachConsent(h)
      expect(await h.service.cleanup()).toEqual({ authorizations: 0, codes: 0, tokens: 0, grants: 0, clients: 0 })
      h.advance(30 * day + 7 * day + minute)
      const counts = await h.service.cleanup()
      expect(counts.authorizations).toBe(2)
      expect(counts.grants).toBe(1)
      expect(await h.store.findClient(clientID)).toBeDefined()
      if (h.sqlite) {
        for (const table of ["mcp_authorization", "mcp_grant", "mcp_code", "mcp_token"]) expect(rows(h, table)).toBe(0)
      }
    })
  })
}

describe("MCP authorization D1 migration", () => {
  test("creates the six tables and stores no secret, email, or content", async () => {
    const h = await harness("d1")
    const sqlite = h.sqlite as Database
    const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mcp_%' ORDER BY name").all()
    expect(names.map((row) => (row as { name: string }).name)).toEqual([
      "mcp_authorization",
      "mcp_client",
      "mcp_code",
      "mcp_device",
      "mcp_grant",
      "mcp_token",
    ])
    const flow = await issueCode(h)
    const tokens = must(await exchange(h, flow.code))
    const secrets = [flow.cookieToken, flow.started.csrfToken, flow.consentCsrf, flow.code, tokens.accessToken, tokens.refreshToken, flow.continued.state, "owner@example.com", "sub-owner", verifier]
    for (const table of names.map((row) => (row as { name: string }).name)) {
      const dump = JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all())
      for (const secret of secrets) expect({ table, leaked: dump.includes(secret) }).toEqual({ table, leaked: false })
    }
    expect(rows(h, "mcp_client")).toBe(1)
    const authorization = sqlite.prepare("SELECT google_nonce, google_verifier, google_state_hash FROM mcp_authorization").get() as Record<string, string | null>
    expect(authorization).toEqual({ google_nonce: null, google_verifier: null, google_state_hash: null })
  })

  test("cascades grants, codes, tokens, and device rows when the device or owner is deleted", async () => {
    const h = await harness("d1")
    const sqlite = h.sqlite as Database
    await issueTokens(h)
    sqlite.prepare("DELETE FROM device WHERE id = 'dev_1'").run()
    for (const table of ["mcp_device", "mcp_grant", "mcp_code", "mcp_token", "mcp_authorization"]) expect(rows(h, table)).toBe(0)

    const other = await harness("d1")
    const otherSqlite = other.sqlite as Database
    await issueTokens(other)
    otherSqlite.prepare('DELETE FROM "user" WHERE id = ?').run(other.owner)
    for (const table of ["mcp_grant", "mcp_code", "mcp_token", "mcp_authorization"]) expect(rows(other, table)).toBe(0)
  })
})
