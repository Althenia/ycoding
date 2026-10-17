import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { TaskMCPAuth } from "../src/task-mcp/auth"

const first = generateKeyPairSync("rsa", { modulusLength: 2048 })
const second = generateKeyPairSync("rsa", { modulusLength: 2048 })
const config = {
  issuer: "https://identity.example.com/tenant",
  jwksURL: "https://identity.example.com/tenant/keys",
  resource: "https://ycoding.example.com/mcp",
  subject: "owner-123",
}
const now = 1_800_000_000_000
const claims = {
  iss: config.issuer,
  aud: config.resource,
  sub: config.subject,
  exp: now / 1000 + 600,
  scope: "ycoding:tasks",
}
const jwk = { ...first.publicKey.export({ format: "jwk" }), kid: "first", alg: "RS256", use: "sig" }

function token(
  payload: Record<string, unknown> = claims,
  header: Record<string, unknown> = {},
  key = first.privateKey,
) {
  const input = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "first", ...header })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
  ].join(".")
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`
}

function request(value = token()) {
  return new Request("http://127.0.0.1:4096/mcp", { headers: { Authorization: `Bearer ${value}` } })
}

function fixture() {
  const state = { time: now, calls: 0, keys: [jwk], fail: false }
  const auth = TaskMCPAuth.create(config, {
    now: () => state.time,
    fetch: async (url, init) => {
      state.calls += 1
      expect(url).toBe(config.jwksURL)
      expect(init?.redirect).toBe("error")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(init?.headers).get("authorization")).toBeNull()
      if (state.fail) throw new Error("upstream secret must not escape")
      return Response.json({ keys: state.keys })
    },
  })
  return { state, auth }
}

describe("task MCP OAuth resource authentication", () => {
  test("publishes public metadata and a discoverable bearer challenge", async () => {
    const { auth, state } = fixture()
    expect(auth.metadataPath).toBe("/.well-known/oauth-protected-resource/mcp")
    expect(await auth.metadata().json()).toEqual({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: ["ycoding:tasks"],
      bearer_methods_supported: ["header"],
    })
    const response = await auth.authorize(new Request("http://127.0.0.1:4096/mcp"))
    expect(response?.status).toBe(401)
    expect(response?.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ycoding.example.com/.well-known/oauth-protected-resource/mcp", scope="ycoding:tasks"',
    )
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(state.calls).toBe(0)
  })

  test("accepts only a signed owner token for this resource and required scope", async () => {
    const { auth, state } = fixture()
    expect(await auth.authorize(request())).toBeUndefined()
    expect(
      await auth.authorize(request(token({ ...claims, aud: ["https://other.example.com", config.resource] }))),
    ).toBeUndefined()
    expect(await auth.authorize(request(token({ ...claims, scope: "profile ycoding:tasks" })))).toBeUndefined()
    expect(state.calls).toBe(1)
  })

  test("accepts the case-insensitive bearer scheme and the exact nbf boundary", async () => {
    const { auth } = fixture()
    const input = request(token({ ...claims, nbf: now / 1000 }))
    input.headers.set("authorization", `bearer ${token()}`)
    expect(await auth.authorize(input)).toBeUndefined()
    expect(await auth.authorize(request(token({ ...claims, nbf: now / 1000 })))).toBeUndefined()
  })

  test("does not accept a token from a URL, cookie, or another authorization scheme", async () => {
    const { auth, state } = fixture()
    const input = new Request(`http://127.0.0.1:4096/mcp?access_token=${token()}`, {
      headers: { cookie: `access_token=${token()}`, authorization: `Basic ${token()}` },
    })
    expect((await auth.authorize(input))?.status).toBe(401)
    expect(state.calls).toBe(0)
  })

  test.each([
    { iss: "https://other.example.com" },
    { aud: "https://other.example.com" },
    { aud: ["https://other.example.com"] },
    { sub: "another-user" },
    { exp: now / 1000 },
    { exp: undefined },
    { exp: "9999999999" },
    { nbf: now / 1000 + 1 },
    { nbf: "0" },
  ])("rejects invalid claims before fetching signing keys: %j", async (changed) => {
    const { auth, state } = fixture()
    expect((await auth.authorize(request(token({ ...claims, ...changed }))))?.status).toBe(401)
    expect(state.calls).toBe(0)
  })

  test.each([
    { alg: "none" },
    { alg: "HS256" },
    { kid: "" },
    { kid: "x".repeat(257) },
    { crit: ["unexpected"] },
    { b64: false },
  ])("rejects unsupported JWT headers: %j", async (header) => {
    const { auth, state } = fixture()
    expect((await auth.authorize(request(token(claims, header))))?.status).toBe(401)
    expect(state.calls).toBe(0)
  })

  test.each(["not-a-jwt", "a.b.c", "a.b.c.d", "x".repeat(16_385)])(
    "rejects malformed and oversized tokens",
    async (value) => {
      const { auth, state } = fixture()
      expect((await auth.authorize(request(value)))?.status).toBe(401)
      expect(state.calls).toBe(0)
    },
  )

  test("rejects invalid signatures and never fetches a token-supplied key URL", async () => {
    const { auth, state } = fixture()
    const forged = token(claims, { jku: "https://attacker.example.com/keys" }, second.privateKey)
    expect((await auth.authorize(request(forged)))?.status).toBe(401)
    expect(state.calls).toBe(1)
  })

  test("requires the exact scope after signature verification", async () => {
    const { auth } = fixture()
    for (const scope of [undefined, "", "ycoding:tasks-extra"]) {
      const response = await auth.authorize(request(token({ ...claims, scope })))
      expect(response?.status).toBe(403)
      expect(response?.headers.get("www-authenticate")).toContain('error="insufficient_scope"')
    }
    expect((await auth.authorize(request(token({ ...claims, scope: "" }, {}, second.privateKey))))?.status).toBe(401)
  })

  test("bounds unknown-key refreshes and accepts rotation after the cooldown", async () => {
    const { auth, state } = fixture()
    expect(await auth.authorize(request())).toBeUndefined()
    state.keys = [{ ...second.publicKey.export({ format: "jwk" }), kid: "second", alg: "RS256", use: "sig" }]
    const rotated = request(token(claims, { kid: "second" }, second.privateKey))
    expect((await auth.authorize(rotated))?.status).toBe(401)
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => auth.authorize(request(token(claims, { kid: `unknown-${index}` })))),
    )
    expect(state.calls).toBe(1)
    state.time += 60_000
    expect(await auth.authorize(rotated)).toBeUndefined()
    expect(state.calls).toBe(2)
  })

  test("coalesces concurrent cache misses", async () => {
    const { auth, state } = fixture()
    expect(await Promise.all(Array.from({ length: 20 }, () => auth.authorize(request())))).toEqual(
      Array(20).fill(undefined),
    )
    expect(state.calls).toBe(1)
  })

  test("fails closed when cache expires and upstream fails, without leaking errors", async () => {
    const { auth, state } = fixture()
    expect(await auth.authorize(request())).toBeUndefined()
    state.time += 300_000
    state.fail = true
    const response = await auth.authorize(request())
    expect(response?.status).toBe(401)
    expect(await response?.text()).not.toContain("secret")
    expect(state.calls).toBe(2)
    expect((await auth.authorize(request()))?.status).toBe(401)
    expect(state.calls).toBe(2)
  })

  test("rechecks expiry after key retrieval", async () => {
    const clock = { time: now }
    const auth = TaskMCPAuth.create(config, {
      now: () => clock.time,
      fetch: async () => {
        clock.time += 600_000
        return Response.json({ keys: [jwk] })
      },
    })
    expect((await auth.authorize(request()))?.status).toBe(401)
  })

  test("rejects RSA signing keys below 2048 bits", async () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 })
    const auth = TaskMCPAuth.create(config, {
      now: () => now,
      fetch: async () => Response.json({ keys: [{ ...weak.publicKey.export({ format: "jwk" }), kid: "first" }] }),
    })
    expect((await auth.authorize(request(token(claims, {}, weak.privateKey))))?.status).toBe(401)
  })

  test.each([
    { keys: [jwk, jwk] },
    { keys: Array.from({ length: 33 }, (_, index) => ({ ...jwk, kid: `key-${index}` })) },
    { keys: [{ ...jwk, alg: "RS512" }] },
    { keys: [{ ...jwk, use: "enc" }] },
    { keys: [{ ...jwk, key_ops: ["encrypt"] }] },
    { keys: [{ ...jwk, n: "malformed" }] },
  ])("rejects unusable and ambiguous JWKS", async (body) => {
    const auth = TaskMCPAuth.create(config, { now: () => now, fetch: async () => Response.json(body) })
    expect((await auth.authorize(request()))?.status).toBe(401)
  })

  test.each([
    () => new Response("not JSON"),
    () => new Response("no", { status: 503 }),
    () => new Response("{}", { headers: { "content-length": "65537" } }),
    () => new Response(" ".repeat(65_537)),
  ])("rejects failed, malformed, and oversized JWKS bodies", async (response) => {
    const auth = TaskMCPAuth.create(config, { now: () => now, fetch: async () => response() })
    expect((await auth.authorize(request()))?.status).toBe(401)
  })

  test.each([
    { issuer: "http://identity.example.com" },
    { jwksURL: "http://127.0.0.1/keys" },
    { resource: "http://localhost/mcp" },
    { issuer: "https://user:secret@identity.example.com" },
    { jwksURL: "https://identity.example.com/keys?token=secret" },
    { resource: "https://ycoding.example.com/mcp#secret" },
    { resource: "https://ycoding.example.com/mcp?" },
    { subject: "" },
    { subject: "x".repeat(257) },
  ])("fails closed on invalid configuration without exposing values: %j", (changed) => {
    expect(() => TaskMCPAuth.create({ ...config, ...changed })).toThrow("Invalid task MCP OAuth configuration")
  })

  test("snapshots configuration so later caller mutation cannot change authorization", async () => {
    const input = { ...config }
    const auth = TaskMCPAuth.create(input, { now: () => now, fetch: async () => Response.json({ keys: [jwk] }) })
    input.subject = "another-user"
    expect(await auth.authorize(request())).toBeUndefined()
    expect((await auth.authorize(request(token({ ...claims, sub: input.subject }))))?.status).toBe(401)
  })
})
