import { describe, expect, test } from "bun:test"
import { createMcpClientResolver, isLoopbackRedirect, validateRedirectUri } from "../src/auth/mcp/client"
import { createMemoryMcpStore } from "../src/auth/mcp/memory-store"

const cimdURL = "https://chatgpt.example/oauth/client.json"

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    client_id: cimdURL,
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.example/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    logo_uri: "https://chatgpt.example/logo.png",
    jwks_uri: "https://chatgpt.example/oauth/jwks.json",
    ...overrides,
  }
}

type Call = { readonly url: string; readonly init: RequestInit | undefined }

function setup(options: {
  readonly body?: () => BodyInit | null
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
  readonly maxClients?: number
  readonly fetch?: typeof fetch
} = {}) {
  let clock = 1_700_000_000_000
  const calls: Call[] = []
  const store = createMemoryMcpStore()
  const fetchImpl =
    options.fetch ??
    ((async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(options.body ? options.body() : JSON.stringify(metadata()), {
        status: options.status ?? 200,
        headers: { "content-type": "application/json", ...options.headers },
      })
    }) as typeof fetch)
  const resolver = createMcpClientResolver({
    store,
    issuer: "https://relay.example",
    fetch: fetchImpl,
    now: () => clock,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
  })
  return { resolver, store, calls, advance: (milliseconds: number) => (clock += milliseconds) }
}

describe("redirect URI validation", () => {
  test("accepts HTTPS and explicit loopback HTTP only", () => {
    for (const uri of ["https://client.example/cb", "https://client.example:8443/cb?x=1", "http://127.0.0.1:8080/cb", "http://localhost:3000/cb", "http://[::1]:9000/cb"])
      expect({ uri, ok: validateRedirectUri(uri) }).toEqual({ uri, ok: true })
    for (const uri of [
      "http://client.example/cb",
      "https://client.example/cb#frag",
      "https://user:pw@client.example/cb",
      "https://*.client.example/cb",
      "https://client.example/*",
      "/relative",
      "custom-scheme://cb",
      "javascript:alert(1)",
      "",
      `https://client.example/${"a".repeat(2100)}`,
    ])
      expect({ uri, ok: validateRedirectUri(uri) }).toEqual({ uri, ok: false })
    expect(validateRedirectUri(42)).toBe(false)
  })

  test("identifies loopback redirects for the consent warning", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:8080/cb")).toBe(true)
    expect(isLoopbackRedirect("http://localhost/cb")).toBe(true)
    expect(isLoopbackRedirect("http://[::1]:1/cb")).toBe(true)
    expect(isLoopbackRedirect("https://client.example/cb")).toBe(false)
  })
})

describe("dynamic client registration", () => {
  test("registers a public client with no secret and stores the normalized metadata", async () => {
    const { resolver, store } = setup()
    const result = await resolver.register({
      client_name: "  My Client  ",
      redirect_uris: ["https://client.example/cb", "http://127.0.0.1:7777/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_secret: "ignored",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      client_name: "My Client",
      redirect_uris: ["https://client.example/cb", "http://127.0.0.1:7777/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    })
    expect(result.value.client_id.length).toBeGreaterThanOrEqual(16)
    expect(JSON.stringify(result.value)).not.toContain("client_secret")
    expect(await store.findClient(result.value.client_id)).toMatchObject({ kind: "dcr", name: "My Client", authMethod: "none" })
  })

  test("defaults an omitted auth method to none and rejects anything else", async () => {
    const { resolver } = setup()
    expect((await resolver.register({ client_name: "A", redirect_uris: ["https://client.example/cb"] })).ok).toBe(true)
    for (const method of ["client_secret_basic", "client_secret_post", "private_key_jwt", "", 1])
      expect(await resolver.register({ client_name: "A", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: method })).toEqual({
        ok: false,
        reason: "invalid_client_metadata",
      })
  })

  test("rejects malformed registration metadata", async () => {
    const { resolver } = setup()
    const good = { client_name: "A", redirect_uris: ["https://client.example/cb"] }
    const invalid = (reason: string) => ({ ok: false, reason })
    expect(await resolver.register(null)).toEqual(invalid("invalid_client_metadata"))
    expect(await resolver.register([])).toEqual(invalid("invalid_client_metadata"))
    expect(await resolver.register({ ...good, client_name: "" })).toEqual(invalid("invalid_client_metadata"))
    expect(await resolver.register({ ...good, client_name: "n".repeat(101) })).toEqual(invalid("invalid_client_metadata"))
    expect(await resolver.register({ ...good, client_name: undefined })).toEqual(invalid("invalid_client_metadata"))
    expect(await resolver.register({ ...good, redirect_uris: [] })).toEqual(invalid("invalid_redirect_uri"))
    expect(await resolver.register({ ...good, redirect_uris: undefined })).toEqual(invalid("invalid_redirect_uri"))
    expect(await resolver.register({ ...good, redirect_uris: Array.from({ length: 11 }, (_, index) => `https://client.example/${index}`) })).toEqual(invalid("invalid_redirect_uri"))
    expect(await resolver.register({ ...good, redirect_uris: ["http://client.example/cb"] })).toEqual(invalid("invalid_redirect_uri"))
    expect(await resolver.register({ ...good, redirect_uris: ["https://client.example/cb", 5] })).toEqual(invalid("invalid_redirect_uri"))
    expect(await resolver.register({ ...good, grant_types: ["refresh_token"] })).toEqual(invalid("invalid_client_metadata"))
    expect(await resolver.register({ ...good, response_types: ["token"] })).toEqual(invalid("invalid_client_metadata"))
  })

  test("refuses registrations past the shared pending cap and keeps established clients", async () => {
    const { resolver } = setup({ maxClients: 2 })
    const body = { client_name: "A", redirect_uris: ["https://client.example/cb"] }
    const first = await resolver.register(body)
    expect((await resolver.register(body)).ok).toBe(true)
    expect(await resolver.register(body)).toEqual({ ok: false, reason: "registration_limit" })
    if (!first.ok) throw new Error("registration failed")
    expect((await resolver.resolve(first.value.client_id)).ok).toBe(true)
  })

  test("admits at most the cap under concurrent registrations", async () => {
    const { resolver, store } = setup({ maxClients: 3 })
    const body = { client_name: "A", redirect_uris: ["https://client.example/cb"] }
    const results = await Promise.all(Array.from({ length: 8 }, () => resolver.register(body)))
    expect(results.filter((result) => result.ok)).toHaveLength(3)
    expect(await store.countPendingClients()).toBe(3)
  })

  test("shares the cap with metadata clients and fetches nothing for a new one at the cap", async () => {
    const { resolver, calls } = setup({ maxClients: 2 })
    expect((await resolver.register({ client_name: "A", redirect_uris: ["https://client.example/cb"] })).ok).toBe(true)
    expect((await resolver.resolve(cimdURL)).ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(await resolver.register({ client_name: "A", redirect_uris: ["https://client.example/cb"] })).toEqual({ ok: false, reason: "registration_limit" })
    for (let index = 0; index < 5; index += 1)
      expect(await resolver.resolve(`https://chatgpt.example/clients/${index}.json`)).toEqual({ ok: false, reason: "invalid_client" })
    expect(calls).toHaveLength(1)
    expect((await resolver.resolve(cimdURL)).ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test("a metadata client that loses the insert race at the cap is not stored", async () => {
    const echo = (async (input: string | URL | Request) =>
      new Response(JSON.stringify(metadata({ client_id: String(input) })), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const { resolver, store } = setup({ maxClients: 1, fetch: echo })
    const results = await Promise.all([
      resolver.resolve("https://chatgpt.example/clients/a.json"),
      resolver.resolve("https://chatgpt.example/clients/b.json"),
    ])
    expect(await store.countPendingClients()).toBe(1)
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })

  test("resolves a registered client by ID and rejects unknown IDs", async () => {
    const { resolver } = setup()
    const registered = await resolver.register({ client_name: "A", redirect_uris: ["https://client.example/cb"] })
    if (!registered.ok) throw new Error("registration failed")
    const found = await resolver.resolve(registered.value.client_id)
    expect(found).toMatchObject({ ok: true, value: { id: registered.value.client_id, kind: "dcr" } })
    expect(await resolver.resolve("mcp_unknown")).toEqual({ ok: false, reason: "invalid_client" })
  })
})

describe("client ID metadata documents", () => {
  test("fetches once without redirects or credentials, accepts the plural auth-method list, and stores the client", async () => {
    const { resolver, store, calls } = setup()
    const result = await resolver.resolve(cimdURL)
    expect(result).toMatchObject({
      ok: true,
      value: { id: cimdURL, kind: "cimd", name: "ChatGPT", authMethod: "none", redirectUris: ["https://chatgpt.example/connector_platform_oauth_redirect"] },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(cimdURL)
    expect(calls[0]?.init?.redirect).toBe("manual")
    expect(calls[0]?.init?.method ?? "GET").toBe("GET")
    expect(calls[0]?.init?.signal).toBeDefined()
    expect(calls[0]?.init?.credentials).not.toBe("include")
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false)
    expect(new Headers(calls[0]?.init?.headers).has("cookie")).toBe(false)
    expect(await store.findClient(cimdURL)).toMatchObject({ kind: "cimd", name: "ChatGPT" })
  })

  test("negotiates the public auth method through the plural list or the singular value", async () => {
    const cases: readonly [Record<string, unknown>, boolean][] = [
      [{}, true],
      [{ token_endpoint_auth_methods_supported: ["private_key_jwt"] }, false],
      [{ token_endpoint_auth_methods_supported: [] }, false],
      [{ token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: "none" }, true],
      [{ token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: "private_key_jwt" }, false],
      [{ token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: undefined }, false],
      [{ token_endpoint_auth_methods_supported: "none" }, false],
    ]
    for (const [overrides, accepted] of cases) {
      const { resolver } = setup({ body: () => JSON.stringify(metadata(overrides)) })
      expect({ overrides, ok: (await resolver.resolve(cimdURL)).ok }).toEqual({ overrides, ok: accepted })
    }
  })

  test("rejects client IDs that are not safe metadata URLs without fetching", async () => {
    for (const id of [
      "http://chatgpt.example/oauth/client.json",
      "https://chatgpt.example/",
      "https://chatgpt.example",
      "https://user:pw@chatgpt.example/client.json",
      "https://chatgpt.example/client.json#frag",
      "https://127.0.0.1/client.json",
      "https://10.0.0.5/client.json",
      "https://[::1]/client.json",
      "https://localhost/client.json",
      "https://app.localhost/client.json",
      "https://printer.local/client.json",
      "https://db.internal/client.json",
      "https://relay.example/oauth/client.json",
      "https://app.relay.example/oauth/client.json",
      "https://intranet/client.json",
      `https://chatgpt.example/${"a".repeat(2100)}`,
    ]) {
      const { resolver, calls } = setup()
      expect({ id, result: await resolver.resolve(id) }).toEqual({ id, result: { ok: false, reason: "invalid_client" } })
      expect(calls).toHaveLength(0)
    }
  })

  test("rejects redirects, non-200 responses, non-JSON content, and malformed JSON", async () => {
    for (const options of [
      { status: 302, headers: { location: "https://elsewhere.example/client.json" } },
      { status: 404 },
      { headers: { "content-type": "text/html" } },
      { body: () => "{not json" },
      { body: () => JSON.stringify([metadata()]) },
    ]) {
      const { resolver } = setup(options)
      expect(await resolver.resolve(cimdURL)).toEqual({ ok: false, reason: "invalid_client" })
    }
  })

  test("rejects documents whose identity or required metadata is wrong", async () => {
    const invalid: readonly Record<string, unknown>[] = [
      { client_id: "https://chatgpt.example/oauth/other.json" },
      { client_id: undefined },
      { client_name: "" },
      { client_name: "n".repeat(101) },
      { client_name: undefined },
      { redirect_uris: [] },
      { redirect_uris: undefined },
      { redirect_uris: Array.from({ length: 11 }, (_, index) => `https://chatgpt.example/${index}`) },
      { redirect_uris: ["http://chatgpt.example/cb"] },
      { response_types: ["token"] },
      { grant_types: ["client_credentials"] },
    ]
    for (const overrides of invalid) {
      const { resolver } = setup({ body: () => JSON.stringify(metadata(overrides)) })
      expect({ overrides, result: await resolver.resolve(cimdURL) }).toEqual({ overrides, result: { ok: false, reason: "invalid_client" } })
    }
  })

  test("caps the streamed body at 32 KiB and cancels the stream", async () => {
    let cancelled = false
    const chunk = new TextEncoder().encode(" ".repeat(8192))
    const { resolver } = setup({
      body: () =>
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
    })
    expect(await resolver.resolve(cimdURL)).toEqual({ ok: false, reason: "invalid_client" })
    expect(cancelled).toBe(true)
  })

  test("accepts a document just under the cap", async () => {
    const padding = "p".repeat(30 * 1024)
    const { resolver } = setup({ body: () => JSON.stringify(metadata({ padding })) })
    expect((await resolver.resolve(cimdURL)).ok).toBe(true)
  })

  test("aborts a slow metadata fetch at the deadline and reports an unavailable client", async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as typeof fetch
    const { resolver } = setup({ fetch: hanging, timeoutMs: 20 })
    expect(await resolver.resolve(cimdURL)).toEqual({ ok: false, reason: "invalid_client" })
  })

  test("reports a network failure as an invalid client", async () => {
    const failing = (async () => {
      throw new Error("network")
    }) as unknown as typeof fetch
    const { resolver } = setup({ fetch: failing })
    expect(await resolver.resolve(cimdURL)).toEqual({ ok: false, reason: "invalid_client" })
  })

  test("caches within the advertised lifetime up to five minutes and honors no-store", async () => {
    const cached = setup({ headers: { "cache-control": "max-age=3600" } })
    await cached.resolver.resolve(cimdURL)
    cached.advance(4 * 60_000)
    await cached.resolver.resolve(cimdURL)
    expect(cached.calls).toHaveLength(1)
    cached.advance(61_000)
    await cached.resolver.resolve(cimdURL)
    expect(cached.calls).toHaveLength(2)

    const short = setup({ headers: { "cache-control": "max-age=10" } })
    await short.resolver.resolve(cimdURL)
    short.advance(11_000)
    await short.resolver.resolve(cimdURL)
    expect(short.calls).toHaveLength(2)

    for (const headers of [{ "cache-control": "no-store" }, { "cache-control": "max-age=60, no-store" }, {}]) {
      const uncached = setup({ headers })
      await uncached.resolver.resolve(cimdURL)
      await uncached.resolver.resolve(cimdURL)
      expect({ headers, calls: uncached.calls.length }).toEqual({ headers, calls: 2 })
    }
  })

  test("refreshes stored redirect URIs when the document changes", async () => {
    let redirectUri = "https://chatgpt.example/old"
    const { resolver, store } = setup({ body: () => JSON.stringify(metadata({ redirect_uris: [redirectUri] })) })
    await resolver.resolve(cimdURL)
    redirectUri = "https://chatgpt.example/new"
    await resolver.resolve(cimdURL)
    expect((await store.findClient(cimdURL))?.redirectUris).toEqual(["https://chatgpt.example/new"])
  })

  test("bounds the cache at 128 documents", async () => {
    const urls = Array.from({ length: 129 }, (_, index) => `https://chatgpt.example/clients/${index}.json`)
    const { resolver, calls } = setup({
      fetch: (async (input: string | URL | Request) => {
        calls.push({ url: String(input), init: undefined })
        return new Response(JSON.stringify(metadata({ client_id: String(input) })), {
          headers: { "content-type": "application/json", "cache-control": "max-age=300" },
        })
      }) as typeof fetch,
    })
    for (const url of urls) await resolver.resolve(url)
    expect(calls).toHaveLength(129)
    await resolver.resolve(urls[128] ?? "")
    expect(calls).toHaveLength(129)
    await resolver.resolve(urls[0] ?? "")
    expect(calls).toHaveLength(130)
  })

  test("never fetches the logo, client page, or key set", async () => {
    const { resolver, calls } = setup()
    await resolver.resolve(cimdURL)
    expect(calls.map((call) => call.url)).toEqual([cimdURL])
  })
})
