import {
  buildClaudeCodeHeaders,
  buildClaudeCodeKeychainUpdate,
  createClaudeCodeCredentialStore,
  createSystemClaudeCodeCredentialSource,
  createClaudeCodeFetch,
  parseClaudeCodeCredentials,
  parseClaudeCodeOAuthResponse,
  redactClaudeCodeEvent,
  repairClaudeCodeToolPairs,
  transformClaudeCodeBody,
  transformClaudeCodeResponse,
  writeClaudeCodeDebugEvent,
  type ClaudeCodeCredentials,
  type ClaudeCodeCredentialSource,
} from "@ycoding-ai/core/plugin/provider/anthropic-claude-code"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const credentials = (accessToken: string, expiresAt = 10_000) => ({
  accessToken,
  refreshToken: `refresh-${accessToken}`,
  expiresAt,
  subscriptionType: "max",
})

const requiredString = (value: unknown, label: string) => {
  if (typeof value !== "string") throw new Error(`Expected ${label} to be a string`)
  return value
}

const fetchInputURL = (input: Parameters<typeof fetch>[0]) => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

const cacheMarkers = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((total, item) => total + cacheMarkers(item), 0)
  if (typeof value !== "object" || value === null) return 0
  return Object.entries(value).reduce(
    (total, [key, item]) => total + (key === "cache_control" ? 1 : cacheMarkers(item)),
    0,
  )
}

const cacheTTLs = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(cacheTTLs)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => {
    if (key === "cache_control" && typeof item === "object" && item !== null)
      return ["ttl" in item && typeof item.ttl === "string" ? item.ttl : "5m"]
    return cacheTTLs(item)
  })
}

describe("Claude Code credentials", () => {
  test("parses wrapped Claude Code credentials and truncates fractional expiry", () => {
    expect(
      parseClaudeCodeCredentials(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 1234.9,
            subscriptionType: "max",
          },
        }),
      ),
    ).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1234,
      subscriptionType: "max",
    })
  })

  test("rejects MCP-only, incomplete, and blank credential records", () => {
    expect(parseClaudeCodeCredentials(JSON.stringify({ mcpOAuth: { token: "mcp" } }))).toBeNull()
    expect(parseClaudeCodeCredentials(JSON.stringify({ accessToken: "access", expiresAt: 1234 }))).toBeNull()
    expect(
      parseClaudeCodeCredentials(
        JSON.stringify({
          accessToken: "   ",
          refreshToken: "refresh",
          expiresAt: 100_000,
        }),
      ),
    ).toBeNull()
    expect(parseClaudeCodeOAuthResponse(JSON.stringify({ access_token: "   " }), "refresh", 1_000)).toBeNull()
  })

  test("seeds the credential cache from account discovery", async () => {
    let reads = 0
    const discovered = credentials("discovered", 100_000)
    const source: ClaudeCodeCredentialSource = {
      list: async () => [{ label: "Claude Max", source: "keychain", credentials: discovered }],
      read: async () => {
        reads += 1
        throw new Error("Keychain temporarily unavailable")
      },
      write: async () => true,
      refreshWithCli: async () => undefined,
    }
    const store = createClaudeCodeCredentialStore({ source, now: () => 1_000 })

    expect(await store.accounts()).toEqual([{ label: "Claude Max", source: "keychain", credentials: discovered }])
    expect((await store.resolve("keychain"))?.accessToken).toBe("discovered")
    expect(reads).toBe(0)
  })

  test("keeps a still-valid discovered token when a post-TTL source read fails", async () => {
    let now = 1_000
    let fail = false
    const discovered = credentials("discovered", 100_000)
    const source: ClaudeCodeCredentialSource = {
      list: async () => [{ label: "Claude Max", source: "keychain", credentials: discovered }],
      read: async () => {
        if (fail) throw new Error("Keychain temporarily unavailable")
        return discovered
      },
      write: async () => true,
      refreshWithCli: async () => undefined,
    }
    const store = createClaudeCodeCredentialStore({ source, now: () => now })
    await store.accounts()
    now += 30_001
    fail = true

    expect((await store.resolve("keychain"))?.accessToken).toBe("discovered")
  })

  test("keeps discovered accounts when a transient reload returns no accounts", async () => {
    let empty = false
    const accounts = [
      {
        label: "Claude Max",
        source: "keychain",
        credentials: credentials("discovered", 100_000),
      },
    ]
    const source: ClaudeCodeCredentialSource = {
      list: async () => (empty ? [] : accounts),
      read: async () => null,
      write: async () => true,
      refreshWithCli: async () => undefined,
    }
    const store = createClaudeCodeCredentialStore({ source, now: () => 1_000 })

    expect(await store.accounts()).toEqual(accounts)
    empty = true
    expect(await store.accounts()).toEqual(accounts)
  })

  test("deduplicates direct OAuth refresh and writes the rotated refresh token", async () => {
    let requests = 0
    let writes = 0
    let written: ClaudeCodeCredentials | undefined
    const current = credentials("expired", 61_000)
    const source: ClaudeCodeCredentialSource = {
      list: async () => [],
      read: async () => current,
      write: async (_source, value) => {
        writes += 1
        written = value
        return true
      },
      refreshWithCli: async () => undefined,
    }
    const request = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests += 1
        expect(fetchInputURL(input)).toBe("https://claude.ai/v1/oauth/token")
        const body = init?.body
        expect(body).toBeInstanceOf(URLSearchParams)
        if (!(body instanceof URLSearchParams)) throw new Error("Expected OAuth request body")
        expect(body.get("refresh_token")).toBe("refresh-expired")
        return Response.json({
          access_token: "rotated",
          refresh_token: "rotated-refresh",
          expires_in: 36_000,
        })
      },
      { preconnect: fetch.preconnect },
    )
    const store = createClaudeCodeCredentialStore({
      source,
      fetch: request,
      now: () => 1_000,
    })

    const [left, right] = await Promise.all([store.resolve("file"), store.resolve("file")])

    expect(left).toMatchObject({
      accessToken: "rotated",
      subscriptionType: "max",
    })
    expect(right).toMatchObject({
      accessToken: "rotated",
      subscriptionType: "max",
    })
    expect(requests).toBe(1)
    expect(writes).toBe(1)
    expect(written).toMatchObject({
      accessToken: "rotated",
      refreshToken: "rotated-refresh",
      expiresAt: 36_001_000,
      subscriptionType: "max",
    })
  })

  test("forces a direct OAuth refresh even while the cached access token is still valid", async () => {
    let requests = 0
    const current = credentials("current", 100_000)
    const source: ClaudeCodeCredentialSource = {
      list: async () => [],
      read: async () => current,
      write: async () => true,
      refreshWithCli: async () => undefined,
    }
    const request = Object.assign(
      async () => {
        requests += 1
        return Response.json({ access_token: "rotated", expires_in: 36_000 })
      },
      { preconnect: fetch.preconnect },
    )
    const store = createClaudeCodeCredentialStore({ source, fetch: request, now: () => 1_000 })

    expect((await store.refresh("file"))?.accessToken).toBe("rotated")
    expect(requests).toBe(1)
  })

  test("falls back to Claude CLI refresh when direct OAuth refresh fails", async () => {
    let reads = 0
    let cliRefreshes = 0
    const source: ClaudeCodeCredentialSource = {
      list: async () => [],
      read: async () => {
        reads += 1
        return reads === 1 ? credentials("expired", 61_000) : credentials("cli-rotated", 100_000)
      },
      write: async () => true,
      refreshWithCli: async () => {
        cliRefreshes += 1
      },
    }
    const request = Object.assign(async () => new Response("rejected", { status: 400 }), {
      preconnect: fetch.preconnect,
    })
    const store = createClaudeCodeCredentialStore({
      source,
      fetch: request,
      now: () => 1_000,
    })

    expect((await store.resolve("file"))?.accessToken).toBe("cli-rotated")
    expect(cliRefreshes).toBe(1)
    expect(reads).toBe(2)
  })

  test("keeps Keychain credential material out of process arguments and plaintext stdin", () => {
    const value = JSON.stringify({
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
    })
    const update = buildClaudeCodeKeychainUpdate("Claude Code-credentials-abc", 'user"name', value)

    expect(update.command).toBe("/usr/bin/security")
    expect(update.args).toEqual(["-i"])
    expect(JSON.stringify(update.args)).not.toContain("secret-access")
    expect(update.input).not.toContain("secret-access")
    expect(update.input).not.toContain("secret-refresh")
    const encoded = /-X ([0-9a-f]+)\n$/.exec(update.input)?.[1]
    expect(encoded).toBeDefined()
    expect(Buffer.from(encoded ?? "", "hex").toString("utf8")).toBe(value)
  })

  test("reads and updates the Claude credentials file with restrictive permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "ycoding-claude-home-"))
    const directory = join(home, ".claude")
    const file = join(directory, ".credentials.json")
    await mkdir(directory, { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: 100_000,
          subscriptionType: "max",
        },
        mcpOAuth: { retained: true },
      }),
      { mode: 0o644 },
    )
    const source = createSystemClaudeCodeCredentialSource({
      home,
      platform: "linux",
    })

    try {
      expect(await source.list()).toEqual([
        {
          label: "Claude Max",
          source: "file",
          credentials: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: 100_000,
            subscriptionType: "max",
          },
        },
      ])
      expect(
        await source.write("file", {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: 200_000,
        }),
      ).toBe(true)
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        claudeAiOauth: {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: 200_000,
          subscriptionType: "max",
        },
        mcpOAuth: { retained: true },
      })
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("caches source reads for 30 seconds and bypasses the cache on reload", async () => {
    let now = 1_000
    let reads = 0
    let current = credentials("first", 100_000)
    const source: ClaudeCodeCredentialSource = {
      list: async () => [],
      read: async () => {
        reads += 1
        return current
      },
      write: async () => true,
      refreshWithCli: async () => undefined,
    }
    const store = createClaudeCodeCredentialStore({ source, now: () => now })

    expect((await store.resolve("file"))?.accessToken).toBe("first")
    expect((await store.resolve("file"))?.accessToken).toBe("first")
    expect(reads).toBe(1)

    current = credentials("rotated", 100_000)
    expect((await store.reload("file"))?.accessToken).toBe("rotated")
    expect(reads).toBe(2)

    now += 30_001
    expect((await store.resolve("file"))?.accessToken).toBe("rotated")
    expect(reads).toBe(3)
  })
})

describe("Claude Code request translation", () => {
  test("builds Claude Code headers with only model-required and explicit betas", () => {
    const headers = buildClaudeCodeHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "x-api-key": "must-be-removed",
          "anthropic-beta": "custom-feature,oauth-2025-04-20",
        },
      },
      "access-token",
      "claude-opus-5",
      new Set(),
      { sessionID: "session-fixed", requestID: () => "request-fixed" },
    )

    expect(headers.get("authorization")).toBe("Bearer access-token")
    expect(headers.has("x-api-key")).toBe(false)
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("x-claude-code-session-id")).toBe("session-fixed")
    expect(headers.get("x-client-request-id")).toBe("request-fixed")
    const betas = headers
      .get("anthropic-beta")
      ?.split(",")
      .map((value) => value.trim())
    expect(betas).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "effort-2025-11-24",
      "custom-feature",
    ])
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.220 (external, sdk-cli)")
  })

  test("uses Claude Code 2.1.220 in the default billing signature", () => {
    const transformed = JSON.parse(
      requiredString(
        transformClaudeCodeBody(
          JSON.stringify({
            model: "claude-opus-5",
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          }),
        ),
        "transformed Claude request body",
      ),
    )

    expect(transformed.system[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.220\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/,
    )
    expect(transformed.system[0].text).not.toContain("cch=")
  })

  test("adds explicit beta overrides without replacing required model betas", () => {
    const previous = process.env.ANTHROPIC_BETA_FLAGS
    process.env.ANTHROPIC_BETA_FLAGS = "custom-one, oauth-2025-04-20, custom-two"
    try {
      const betas = buildClaudeCodeHeaders(
        "https://api.anthropic.com/v1/messages",
        {},
        "access-token",
        "claude-haiku-4-5-20251001",
        new Set(),
      )
        .get("anthropic-beta")
        ?.split(",")

      expect(betas).toEqual([
        "claude-code-20250219",
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "custom-one",
        "custom-two",
      ])
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BETA_FLAGS
      else process.env.ANTHROPIC_BETA_FLAGS = previous
    }
  })

  test("preserves existing cache breakpoints while translating OAuth body and tools", () => {
    const body = {
      model: "claude-opus-5",
      system: [
        {
          type: "text",
          text: "stable YCoding system",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      tools: [
        {
          name: "lookup",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "latest prompt",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    }

    const transformed = JSON.parse(
      requiredString(
        transformClaudeCodeBody(JSON.stringify(body), { version: "2.1.217" }),
        "transformed Claude request body",
      ),
    )

    expect(cacheMarkers(transformed)).toBe(cacheMarkers(body))
    expect(cacheMarkers(transformed)).toBeLessThanOrEqual(4)
    expect(transformed.system[0].text).toStartWith("x-anthropic-billing-header")
    expect(transformed.system[0]).not.toHaveProperty("cache_control")
    expect(transformed.system[1]).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    })
    expect(transformed.tools[0]).toMatchObject({
      name: "mcp_Lookup",
      cache_control: { type: "ephemeral", ttl: "5m" },
    })
    expect(transformed.messages[0].content[0]).toEqual({
      type: "text",
      text: "stable YCoding system",
      cache_control: { type: "ephemeral", ttl: "5m" },
    })
    expect(transformed.messages[0].content[1]).toEqual({
      type: "text",
      text: "latest prompt",
      cache_control: { type: "ephemeral", ttl: "5m" },
    })
  })

  test("reports final response headers without changing the response", async () => {
    const utilization: Array<string | null> = []
    const fetcher = createClaudeCodeFetch({
      fetch: Object.assign(
        async () =>
          Response.json(
            { type: "message", content: [{ type: "text", text: "ok" }] },
            { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.42" } },
          ),
        { preconnect: fetch.preconnect },
      ),
      credentials: async () => credentials("paid", Date.now() + 3_600_000),
      reload: async () => null,
      onResponse: (response) => {
        utilization.push(response.headers.get("anthropic-ratelimit-unified-5h-utilization"))
      },
    })

    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }] }),
    })

    expect(utilization).toEqual(["0.42"])
    expect(await response.json()).toEqual({ type: "message", content: [{ type: "text", text: "ok" }] })
  })

  test("does not upgrade cache TTL from subscription metadata", async () => {
    let sent: unknown
    const fetcher = createClaudeCodeFetch({
      fetch: Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          sent = JSON.parse(requiredString(init?.body, "Claude request body"))
          return Response.json({ type: "message", content: [] })
        },
        { preconnect: fetch.preconnect },
      ),
      credentials: async () => credentials("paid", Date.now() + 3_600_000),
      reload: async () => null,
    })
    const body = {
      model: "claude-opus-5",
      system: [
        {
          type: "text",
          text: "stable system",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      tools: [
        {
          name: "lookup",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "latest prompt",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    }

    await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify(body),
    })

    expect(cacheMarkers(sent)).toBe(cacheMarkers(body))
    expect(cacheTTLs(sent)).toEqual(["5m", "5m", "5m"])
  })

  test("preserves an explicitly requested one-hour cache marker", async () => {
    let sent: unknown
    const fetcher = createClaudeCodeFetch({
      fetch: Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          sent = JSON.parse(requiredString(init?.body, "Claude request body"))
          return Response.json({ type: "message", content: [] })
        },
        { preconnect: fetch.preconnect },
      ),
      credentials: async () => credentials("paid", Date.now() + 3_600_000),
      reload: async () => null,
    })

    await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5",
        system: [
          {
            type: "text",
            text: "stable system",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [{ role: "user", content: "latest prompt" }],
      }),
    })

    expect(cacheTTLs(sent)).toEqual(["1h"])
  })

  test("preserves a cached system block when the first user message is a string", () => {
    const body = {
      model: "claude-opus-5",
      system: [
        {
          type: "text",
          text: "stable system",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [{ role: "user", content: "latest prompt" }],
    }

    const transformed = JSON.parse(
      requiredString(transformClaudeCodeBody(JSON.stringify(body)), "transformed Claude request body"),
    )

    expect(cacheMarkers(transformed)).toBe(cacheMarkers(body))
    expect(transformed.messages[0].content).toEqual([
      {
        type: "text",
        text: "stable system",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
      { type: "text", text: "latest prompt" },
    ])
  })

  test("splits a concatenated Claude identity without copying its cache marker", () => {
    const body = {
      model: "claude-opus-5",
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.\n\nstable system",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "latest prompt" }] }],
    }

    const transformed = JSON.parse(
      requiredString(transformClaudeCodeBody(JSON.stringify(body)), "transformed Claude request body"),
    )

    expect(cacheMarkers(transformed)).toBe(cacheMarkers(body))
    expect(transformed.system).toEqual([
      {
        type: "text",
        text: expect.stringContaining("x-anthropic-billing-header"),
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
    expect(transformed.messages[0].content[0]).toEqual({
      type: "text",
      text: "stable system",
      cache_control: { type: "ephemeral", ttl: "5m" },
    })
  })

  test("repairs only immediately adjacent tool-use and tool-result pairs", () => {
    expect(
      repairClaudeCodeToolPairs([
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool_a", name: "search" },
            { type: "tool_use", id: "tool_b", name: "read" },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_a", content: "a" }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_b", content: "b" }],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_a", name: "search" }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_a", content: "a" }],
      },
    ])

    expect(
      repairClaudeCodeToolPairs([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_reversed",
              content: "early",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "tool_use", id: "tool_reversed", name: "search" },
          ],
        },
      ]),
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "answer" }] }])
  })

  test("strips translated tool names from streamed responses", async () => {
    const response = transformClaudeCodeResponse(
      new Response(
        [
          'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Lookup"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    )

    expect(await response.text()).toContain('"name": "lookup"')
  })

  test("observes the final raw response without changing its status, headers, or body", async () => {
    const observed: Array<{ status: number; utilization: string | null; body: string }> = []
    const fetcher = createClaudeCodeFetch({
      fetch: Object.assign(
        async () =>
          new Response('{"type":"message","content":[]}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "anthropic-ratelimit-unified-5h-utilization": "0.42",
            },
          }),
        { preconnect: fetch.preconnect },
      ),
      credentials: async () => credentials("token", Date.now() + 60_000),
      reload: async () => null,
      onResponse: async (response) => {
        const copy = response.clone()
        observed.push({
          status: copy.status,
          utilization: copy.headers.get("anthropic-ratelimit-unified-5h-utilization"),
          body: await copy.text(),
        })
      },
    })

    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    })

    expect(observed).toHaveLength(1)
    expect(observed[0]).toEqual({
      status: 200,
      utilization: "0.42",
      body: '{"type":"message","content":[]}',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"type":"message","content":[]}')
  })

  test("redacts nested credentials and token-shaped values from diagnostics", () => {
    expect(
      redactClaudeCodeEvent({
        event: "request",
        data: {
          accessToken: "secret-access",
          payload: {
            authorization: "Bearer secret",
            note: "eyJabcdefghijklmnop.payload.signature",
            status: 401,
          },
        },
      }),
    ).toEqual({
      event: "request",
      data: {
        accessToken: "<redacted>",
        payload: {
          authorization: "<redacted>",
          note: "<redacted>",
          status: 401,
        },
      },
    })
  })

  test("redacts debug logs and tightens permissions on an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-claude-debug-"))
    const file = join(directory, "claude-auth.log")
    await writeFile(file, "", { mode: 0o644 })

    try {
      writeClaudeCodeDebugEvent(file, {
        event: "request",
        data: {
          accessToken: "secret-access",
          nested: { authorization: "Bearer secret" },
          status: 401,
        },
      })
      const text = await readFile(file, "utf8")
      expect(text).not.toContain("secret-access")
      expect(text).not.toContain("Bearer secret")
      expect(text).toContain("<redacted>")
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("removes the failing long-context beta in one retry without changing cache markers", async () => {
    const attempts: Array<{ betas: string[]; cacheMarkers: number }> = []
    const fetcher = createClaudeCodeFetch({
      fetch: Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          const body = JSON.parse(requiredString(init?.body, "Claude request body"))
          const betas = (headers.get("anthropic-beta") ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
          attempts.push({ betas, cacheMarkers: cacheMarkers(body) })
          if (betas.includes("interleaved-thinking-2025-05-14")) {
            return Response.json(
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: "You're out of extra usage",
                },
              },
              { status: 429 },
            )
          }
          return Response.json({ type: "message", content: [] }, { status: 200 })
        },
        { preconnect: fetch.preconnect },
      ),
      credentials: async () => credentials("first", Date.now() + 60_000),
      reload: async () => null,
    })
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5",
        system: [
          {
            type: "text",
            text: "stable system",
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: "latest prompt" }] }],
      }),
    })

    expect(response.status).toBe(200)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.betas).toContain("interleaved-thinking-2025-05-14")
    expect(attempts[1]?.betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(attempts.map((attempt) => attempt.cacheMarkers)).toEqual([1, 1])
  })

  test("preserves the original 401 when the source token is unchanged or reload fails", async () => {
    for (const reload of [
      async () => credentials("first", Date.now() + 60_000),
      async () => {
        throw new Error("source unavailable")
      },
    ]) {
      let attempts = 0
      const fetcher = createClaudeCodeFetch({
        fetch: Object.assign(
          async () => {
            attempts += 1
            return new Response('{"name":"mcp_Unchanged"}', {
              status: 401,
              statusText: "Unauthorized",
              headers: { "x-request-id": "request-401" },
            })
          },
          { preconnect: fetch.preconnect },
        ),
        credentials: async () => credentials("first", Date.now() + 60_000),
        reload,
      })

      const response = await fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
      })

      expect(attempts).toBe(1)
      expect(response.status).toBe(401)
      expect(response.statusText).toBe("Unauthorized")
      expect(response.headers.get("x-request-id")).toBe("request-401")
      expect(await response.text()).toBe('{"name":"mcp_Unchanged"}')
    }
  })

  test("reloads rotated credentials once after 401 without changing cache inputs", async () => {
    const attempts: Array<{
      authorization: string | null
      url: string
      betas: string | null
      cacheTTLs: string[]
    }> = []
    let current = credentials("first", Date.now() + 60_000)
    const fetcher = createClaudeCodeFetch({
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(fetchInputURL(input), init)
          attempts.push({
            authorization: request.headers.get("authorization"),
            url: request.url,
            betas: request.headers.get("anthropic-beta"),
            cacheTTLs: cacheTTLs(JSON.parse(await request.text())),
          })
          if (attempts.length === 1)
            return Response.json(
              {
                type: "error",
                error: { type: "authentication_error", message: "expired" },
              },
              { status: 401 },
            )
          return Response.json(
            {
              type: "error",
              error: { type: "rate_limit_error", message: "limited" },
            },
            { status: 429 },
          )
        },
        { preconnect: fetch.preconnect },
      ),
      credentials: async () => current,
      reload: async () => {
        current = credentials("rotated", Date.now() + 60_000)
        return current
      },
      sessionID: "session-fixed",
      requestID: () => "request-fixed",
    })

    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(429)
    expect(attempts.map((attempt) => attempt.authorization)).toEqual(["Bearer first", "Bearer rotated"])
    expect(attempts.map((attempt) => attempt.url)).toEqual([
      "https://api.anthropic.com/v1/messages?beta=true",
      "https://api.anthropic.com/v1/messages?beta=true",
    ])
    expect(attempts[1]?.betas).toBe(attempts[0]?.betas)
    expect(attempts.map((attempt) => attempt.cacheTTLs)).toEqual([["5m"], ["5m"]])
  })
})
