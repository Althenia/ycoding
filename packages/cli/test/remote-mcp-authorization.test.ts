import { describe, expect, test } from "bun:test"
import { RemoteMcpAuthorization } from "../src/remote-mcp-authorization"

const now = 1_800_000_000_000
const principal = { ownerID: "owner", deviceID: "dev_1", clientID: "client" }
const check = { action: "check", grantID: "grt_1", principal, epoch: "e1" } as const
const grantExpiry = now + 3_600_000

type Credential = { readonly accessToken: string; readonly accessExpiresAt: number }
type Call = { readonly url: string; readonly init: RequestInit }

function harness(overrides: {
  readonly relayURL?: string
  readonly respond?: (call: Call) => Promise<Response> | Response
  readonly allowed?: (epoch?: string) => boolean
} = {}) {
  let credential: Credential | undefined = { accessToken: "device-access-token", accessExpiresAt: now + 600_000 }
  let generation = new AbortController()
  let allowed = true
  const calls: Call[] = []
  const authorization = RemoteMcpAuthorization.create({
    relayURL: overrides.relayURL ?? "https://relay.example.com",
    deviceID: "dev_1",
    credential: () => credential,
    allowed: overrides.allowed ?? (() => allowed),
    signal: () => generation.signal,
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      return overrides.respond ? overrides.respond(call) : Response.json({ action: "check", authorized: true, grantID: "grt_1", expiresAt: grantExpiry })
    }) as typeof fetch,
    now: () => now,
  })
  return {
    authorization,
    calls,
    setCredential: (value: Credential | undefined) => { credential = value },
    currentCredential: () => credential,
    replaceGeneration: () => { generation = new AbortController() },
    abortGeneration: () => generation.abort(),
    setAllowed: (value: boolean) => { allowed = value },
  }
}

async function reason(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(RemoteMcpAuthorization.Error)
  if (!(error instanceof RemoteMcpAuthorization.Error)) throw error
  expect(JSON.stringify(error)).not.toContain("device-access-token")
  expect(error.message).not.toContain("device-access-token")
  expect(error.message).not.toContain("relay.example.com")
  expect("cause" in error).toBe(false)
  return error.reason
}

function stream(chunks: readonly string[], options: { readonly blockAfter?: boolean } = {}) {
  let index = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]))
      else if (!options.blockAfter) controller.close()
    },
    cancel() { cancelled = true },
  })
  return { body, cancelled: () => cancelled }
}

describe("remote MCP authorization driver", () => {
  test("sends the typed control to the exact enrolled device route with the bearer only in the authorization header", async () => {
    const h = harness()
    expect(await h.authorization.authorize(check)).toEqual({ action: "check", authorized: true, grantID: "grt_1", expiresAt: grantExpiry })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe("https://relay.example.com/api/devices/dev_1/mcp/events/authorize")
    expect(h.calls[0].init.method).toBe("POST")
    expect(h.calls[0].init.redirect).toBe("error")
    expect(new Headers(h.calls[0].init.headers).get("authorization")).toBe("Bearer device-access-token")
    expect(new Headers(h.calls[0].init.headers).get("content-type")).toBe("application/json")
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual(check)
    expect(String(h.calls[0].init.body)).not.toContain("device-access-token")
    expect(h.calls[0].url).not.toContain("device-access-token")
  })

  test("accepts a literal loopback HTTP development relay and rejects unsafe configured relay URLs without fetching", async () => {
    const loopback = harness({ relayURL: "http://127.0.0.1:8787" })
    await loopback.authorization.authorize(check)
    expect(loopback.calls[0].url).toBe("http://127.0.0.1:8787/api/devices/dev_1/mcp/events/authorize")
    for (const relayURL of [
      "http://relay.example.com",
      "https://user:pass@relay.example.com",
      "https://relay.example.com/?next=https://evil.example",
      "https://relay.example.com/#fragment",
      "https://relay.example.com/base-path",
      "relay.example.com",
    ]) {
      expect(() =>
        RemoteMcpAuthorization.create({
          relayURL,
          deviceID: "dev_1",
          credential: () => undefined,
          allowed: () => true,
          signal: () => new AbortController().signal,
          fetcher: async () => { throw new Error("must not fetch") },
          now: () => now,
        }),
      ).toThrow(RemoteMcpAuthorization.Error)
    }
  })

  test("rejects invalid requests, wrong device, missing or expired credentials, and a closed gate before any fetch", async () => {
    const h = harness()
    expect(await reason(h.authorization.authorize({ ...check, extra: true } as never))).toBe("unavailable")
    expect(await reason(h.authorization.authorize({ ...check, principal: { ...principal, deviceID: "dev_2" } }))).toBe("forbidden")
    h.setCredential(undefined)
    expect(await reason(h.authorization.authorize(check))).toBe("unauthorized")
    h.setCredential({ accessToken: "device-access-token", accessExpiresAt: now })
    expect(await reason(h.authorization.authorize(check))).toBe("unauthorized")
    h.setCredential({ accessToken: "device-access-token", accessExpiresAt: now + 600_000 })
    h.setAllowed(false)
    expect(await reason(h.authorization.authorize(check))).toBe("unavailable")
    h.setAllowed(true)
    h.abortGeneration()
    expect(await reason(h.authorization.authorize(check))).toBe("unavailable")
    expect(h.calls).toHaveLength(0)
  })

  test.each([
    [404, "unsupported"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "unavailable"],
    [302, "unavailable"],
  ] as const)("maps HTTP %i to %s without following or retrying", async (status, expected) => {
    const h = harness({ respond: () => new Response(status === 302 ? null : "{}", { status, ...(status === 302 ? { headers: { location: "https://evil.example/authorize" } } : {}) }) })
    expect(await reason(h.authorization.authorize(check))).toBe(expected)
    expect(h.calls).toHaveLength(1)
  })

  test("refuses malformed, oversized, mismatched, or senseless success bodies as unavailable", async () => {
    const bodies: readonly (() => Response)[] = [
      () => new Response("not json", { headers: { "content-type": "application/json" } }),
      () => Response.json({ action: "check", authorized: true, grantID: "grt_1", expiresAt: grantExpiry, extra: true }),
      () => Response.json({ action: "resolve", authorized: true, grantID: "grt_1", expiresAt: grantExpiry }),
      () => Response.json({ action: "check", authorized: true, grantID: "grt_other", expiresAt: grantExpiry }),
      () => Response.json({ action: "check", authorized: true, grantID: "grt_1", expiresAt: now - 1 }),
      () => Response.json({ action: "check", authorized: false, reason: "revoked_grant" }),
      () => new Response(stream(["x".repeat(5000), "y".repeat(4000)]).body, { headers: { "content-type": "application/json" } }),
      () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "8193" } }),
    ]
    for (const respond of bodies) {
      const h = harness({ respond })
      expect(await reason(h.authorization.authorize(check))).toBe("unavailable")
      expect(h.calls).toHaveLength(1)
    }
  })

  test("returns a relay authorized:false verdict unchanged", async () => {
    const h = harness({ respond: () => Response.json({ action: "check", authorized: false, reason: "unauthorized" }) })
    expect(await h.authorization.authorize(check)).toEqual({ action: "check", authorized: false, reason: "unauthorized" })
  })

  test("aborts a blocked body read when the caller aborts and cancels the stream", async () => {
    const blocked = stream(['{"action":"check"'], { blockAfter: true })
    const caller = new AbortController()
    const h = harness({ respond: () => new Response(blocked.body, { headers: { "content-type": "application/json" } }) })
    const pending = h.authorization.authorize(check, caller.signal)
    for (let index = 0; index < 50 && h.calls.length === 0; index++) await Promise.resolve()
    caller.abort()
    expect(await reason(pending)).toBe("unavailable")
    expect(blocked.cancelled()).toBe(true)
  })

  test("fails closed when the credential rotates, the generation is replaced, or the gate closes during the await", async () => {
    for (const mutate of ["rotate", "replace", "close"] as const) {
      let release!: () => void
      const gate = new Promise<void>((done) => { release = done })
      const h = harness({
        respond: async () => {
          await gate
          return Response.json({ action: "check", authorized: true, grantID: "grt_1", expiresAt: grantExpiry })
        },
      })
      const pending = h.authorization.authorize(check)
      for (let index = 0; index < 50 && h.calls.length === 0; index++) await Promise.resolve()
      if (mutate === "rotate") h.setCredential({ accessToken: "rotated-token", accessExpiresAt: now + 600_000 })
      if (mutate === "replace") h.replaceGeneration()
      if (mutate === "close") h.setAllowed(false)
      release()
      expect(await reason(pending)).toBe("unavailable")
    }
  })

  test("never retries a network failure and never refreshes credentials itself", async () => {
    let fetches = 0
    const h = harness({
      respond: () => {
        fetches += 1
        throw new Error("network down")
      },
    })
    const before = h.currentCredential()
    expect(await reason(h.authorization.authorize(check))).toBe("unavailable")
    expect(fetches).toBe(1)
    expect(h.currentCredential()).toBe(before)
  })
})
