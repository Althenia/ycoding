import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { CacheHint, LLM } from "@ycoding-ai/ai"
import { LLMClient } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { claudeCodeMethodID, makeAnthropicPlugin } from "@ycoding-ai/core/plugin/provider/anthropic"
import type { ClaudeCodeCredentialSource, ClaudeCodeCredentials } from "@ycoding-ai/core/plugin/provider/anthropic-claude-code"
import { Provider } from "@ycoding-ai/core/provider"
import { Money } from "@ycoding-ai/schema/money"
import { expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const profileA = "11111111-1111-4111-8111-111111111111"
const profileB = "22222222-2222-4222-8222-222222222222"

const account = (source: string, accessToken: string) => ({
  label: source === profileA ? "Claude Max" : "Claude Max 2",
  source,
  credentials: {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: "max",
  },
})

const source = (accounts = [account(profileA, "secret-a"), account(profileB, "secret-b")]) =>
  ({
    list: async () => accounts,
    read: async (name) => accounts.find((item) => item.source === name)?.credentials ?? null,
    write: async () => true,
  }) satisfies ClaudeCodeCredentialSource

const addPlugin = Effect.fn(function* (plugin: ReturnType<typeof makeAnthropicPlugin>) {
  const host = yield* PluginHost.make(yield* PluginRegistry.Service)
  yield* plugin.effect(host)
})

function withEnv<A, E, R>(name: string, value: string | undefined, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => process.env[name]),
    () =>
      Effect.suspend(() => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
        return effect()
      }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )
}

function eventually<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  remaining = 100,
): Effect.Effect<A, E | Error, R> {
  return effect.pipe(
    Effect.flatMap((value) =>
      predicate(value)
        ? Effect.succeed(value)
        : remaining <= 0
          ? Effect.fail(new Error("condition not reached"))
          : Effect.sleep("1 millis").pipe(Effect.andThen(eventually(effect, predicate, remaining - 1))),
    ),
  )
}

const cacheMarkers = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((total, item) => total + cacheMarkers(item), 0)
  if (typeof value !== "object" || value === null) return 0
  return Object.entries(value).reduce(
    (total, [key, item]) => total + (key === "cache_control" ? 1 : cacheMarkers(item)),
    0,
  )
}

it.effect("retains named Claude profiles while requiring independent managed sign-in for shared source references", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const integrationID = Integration.ID.make("anthropic")
    const existing = yield* Effect.forEach(["Personal", "Work"], (label) => credentials.create({
      integrationID,
      label,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: claudeCodeMethodID,
        access: "account-a",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", source: "account-a" },
      }),
    }))
    yield* addPlugin(makeAnthropicPlugin({ credentialSource: source() }))
    const saved = yield* credentials.list(integrationID)
    expect(saved.map((profile) => ({ id: profile.id, label: profile.label, active: profile.active })))
      .toEqual(existing.map((profile, index) => ({ id: profile.id, label: profile.label, active: index === 1 })))
    for (const profile of saved) {
      expect(profile.value).toMatchObject({ access: "", refresh: "", expires: 0, metadata: { authKind: "claude-code", requiresLogin: true } })
      expect(profile.value.metadata).not.toHaveProperty("source")
      const connection = { type: "credential" as const, id: profile.id, label: profile.label, active: profile.active }
      const resolved = yield* integrations.connection.resolve(connection).pipe(Effect.exit)
      expect(resolved._tag).toBe("Failure")
    }
  }),
)

it.effect("migrates linked profiles once without changing API key and unrelated OAuth credentials", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrationID = Integration.ID.make("anthropic")
    const linked = yield* credentials.create({ integrationID, label: "Claude", value: Credential.OAuth.make({
      type: "oauth", methodID: claudeCodeMethodID, access: "file", refresh: "old", expires: Number.MAX_SAFE_INTEGER,
      metadata: { authKind: "claude-code", source: "file" },
    }) })
    const api = yield* credentials.create({ integrationID, label: "API", value: Credential.Key.make({ type: "key", key: "api-test" }) })
    const other = yield* credentials.create({ integrationID, label: "Other", value: Credential.OAuth.make({
      type: "oauth", methodID: Integration.MethodID.make("other"), access: "other-token", refresh: "", expires: Number.MAX_SAFE_INTEGER,
    }) })
    const apiBefore = yield* credentials.get(api.id)
    const otherBefore = yield* credentials.get(other.id)
    const plugin = makeAnthropicPlugin({ credentialSource: source([]) })
    yield* addPlugin(plugin)
    const once = yield* credentials.get(linked.id)
    expect(once?.generation).toBe(linked.generation + 1)
    expect(once?.value).toMatchObject({ access: "", refresh: "", expires: 0, metadata: { requiresLogin: true } })
    expect(yield* credentials.get(api.id)).toEqual(apiBefore)
    expect(yield* credentials.get(other.id)).toEqual(otherBefore)
    yield* addPlugin(plugin)
    expect(yield* credentials.get(linked.id)).toEqual(once)
  }),
)

it.live("switches only between explicitly signed-in managed profiles and never borrows a discovered account", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const catalog = yield* Catalog.Service
    yield* catalog.transform((draft) => draft.provider.update(Provider.ID.anthropic, (provider) => {
      provider.package = Provider.aisdk("@ai-sdk/anthropic")
      provider.integrationID = Integration.ID.make("anthropic")
    }))
    const first = yield* credentials.create({
      integrationID: Integration.ID.make("anthropic"), label: "Personal",
      value: Credential.OAuth.make({ type: "oauth", methodID: claudeCodeMethodID, access: profileA, refresh: "", expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", managed: true, source: profileA } }),
    })
    yield* credentials.create({
      integrationID: Integration.ID.make("anthropic"), label: "Work",
      value: Credential.OAuth.make({ type: "oauth", methodID: claudeCodeMethodID, access: profileB, refresh: "", expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", managed: true, source: profileB } }),
    })
    yield* addPlugin(makeAnthropicPlugin({ credentialSource: source([account(profileA, "secret-a"), account(profileB, "secret-b")]) }))
    expect((yield* catalog.provider.get(Provider.ID.anthropic))?.settings).toMatchObject({ claudeCodeSource: profileB })
    yield* integrations.connection.activate(first.id)
    const selected = yield* eventually(catalog.provider.get(Provider.ID.anthropic), (provider) => provider?.settings?.claudeCodeSource === profileA, 1500)
    expect(selected?.settings?.claudeCodeSource).toBe(profileA)
  }),
)

it.effect("removes legacy setup-token credentials during provider initialization", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const integrationID = Integration.ID.make("anthropic")
    yield* credentials.create({
      integrationID,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("claude-setup-token"),
        access: "legacy-secret",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-oauth" },
      }),
    })

    yield* addPlugin(
      makeAnthropicPlugin({
        credentialSource: source([]),
      }),
    )

    expect(yield* credentials.list(integrationID)).toEqual([])
  }),
)

it.live("signs in to a new isolated Claude profile without persisting OAuth tokens", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const plugin = makeAnthropicPlugin({
      credentialSource: source(),
      authorize: () => Effect.succeed({ source: profileB, url: "https://claude.ai/oauth/authorize", instructions: "Complete sign-in",
        callback: Effect.succeed(account(profileB, "secret-b").credentials), submitCode: () => Effect.void }),
    })
    yield* addPlugin(plugin)

    const info = yield* integrations.get(Integration.ID.make("anthropic"))
    expect(info?.methods).toContainEqual({
      id: claudeCodeMethodID,
      type: "oauth",
      label: "Claude Code account",
      prompts: undefined,
    })
    expect(info?.methods).toContainEqual({
      type: "env",
      names: ["ANTHROPIC_API_KEY"],
    })
    expect(info?.methods.some((method) => method.type === "oauth" && method.id === "claude-setup-token")).toBe(false)

    const attempt = yield* integrations.oauth.connect({
      integrationID: Integration.ID.make("anthropic"),
      methodID: claudeCodeMethodID,
      inputs: {},
    })
    expect(attempt.mode).toBe("auto")
    yield* eventually(
      integrations.oauth.status({
        integrationID: Integration.ID.make("anthropic"),
        attemptID: attempt.attemptID,
      }),
      (status) => status.status === "complete",
    )

    const stored = yield* credentials.list(Integration.ID.make("anthropic"))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.value).toEqual(
      Credential.OAuth.make({
        type: "oauth",
        methodID: claudeCodeMethodID,
        access: profileB,
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", source: profileB, managed: true },
      }),
    )
    expect(JSON.stringify(stored)).not.toContain("secret-a")
    expect(JSON.stringify(stored)).not.toContain("secret-b")
  }),
)

it.effect("prefers an Anthropic API key connection over discovered Claude Code accounts", () =>
  withEnv("ANTHROPIC_API_KEY", "api-key", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const priced = {
        input: Money.USDPerMillionTokens.make(5),
        output: Money.USDPerMillionTokens.make(25),
        cache: {
          read: Money.USDPerMillionTokens.make(0.5),
          write: Money.USDPerMillionTokens.make(6.25),
        },
      }
      yield* catalog.transform((draft) => {
        draft.provider.update(Provider.ID.anthropic, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/anthropic")
          provider.integrationID = Integration.ID.make("anthropic")
        })
        draft.model.update(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5"), (model) => {
          model.enabled = true
          model.status = "active"
          model.cost = [priced]
        })
      })

      yield* addPlugin(
        makeAnthropicPlugin({
          credentialSource: source([account(profileA, "secret-a")]),
        }),
      )

      expect(yield* integrations.connection.active(Integration.ID.make("anthropic"))).toEqual({
        type: "env",
        name: "ANTHROPIC_API_KEY",
      })
      const provider = yield* catalog.provider.get(Provider.ID.anthropic)
      const model = yield* catalog.model.get(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5"))
      expect(provider?.settings?.apiKey).not.toBe("claude-code")
      expect(model?.cost).toEqual([priced])
    }),
  ),
)

it.effect("does not auto-select a managed account merely because it exists on disk", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    yield* catalog.transform((draft) => draft.provider.update(Provider.ID.anthropic, (provider) => {
      provider.package = Provider.aisdk("@ai-sdk/anthropic")
      provider.integrationID = Integration.ID.make("anthropic")
    }))
    yield* addPlugin(makeAnthropicPlugin({ credentialSource: source([account(profileA, "secret-a")]) }))
    expect((yield* catalog.provider.get(Provider.ID.anthropic))?.settings?.apiKey).not.toBe("claude-code")
    expect((yield* catalog.provider.get(Provider.ID.anthropic))?.settings?.claudeCodeSource).toBeUndefined()
  }),
)

it.effect("makes Anthropic available from Claude Code while preserving catalog price estimates", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const priced = {
      input: Money.USDPerMillionTokens.make(5),
      output: Money.USDPerMillionTokens.make(25),
      cache: {
        read: Money.USDPerMillionTokens.make(0.5),
        write: Money.USDPerMillionTokens.make(6.25),
      },
    }
    yield* catalog.transform((draft) => {
      draft.provider.update(Provider.ID.anthropic, (provider) => {
        provider.package = Provider.aisdk("@ai-sdk/anthropic")
        provider.integrationID = Integration.ID.make("anthropic")
      })
      draft.model.update(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5"), (model) => {
        model.enabled = true
        model.status = "active"
        model.cost = [priced]
      })
    })

    const credentials = yield* Credential.Service
    yield* credentials.create({ integrationID: Integration.ID.make("anthropic"), value: Credential.OAuth.make({
      type: "oauth", methodID: claudeCodeMethodID, access: profileA, refresh: "", expires: Number.MAX_SAFE_INTEGER,
      metadata: { authKind: "claude-code", source: profileA, managed: true },
    }) })
    yield* addPlugin(
      makeAnthropicPlugin({
        credentialSource: source([account(profileA, "secret-a")]),
      }),
    )

    const provider = yield* catalog.provider.get(Provider.ID.anthropic)
    const model = yield* catalog.model.get(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5"))
    expect(provider?.settings).toMatchObject({
      apiKey: "claude-code",
      claudeCodeSource: profileA,
    })
    expect(model?.cost).toEqual([priced])
    expect((yield* catalog.provider.available()).map((item) => item.id)).toContain(Provider.ID.anthropic)
  }),
)

it.effect("sends each selected managed source's bearer token and fails an unavailable source before HTTP", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const credentials = yield* Credential.Service
    const sent: string[] = []
    const request = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const web = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      sent.push(web.headers.get("authorization") ?? "")
      return Response.json({ id: "msg_profile", type: "message", role: "assistant", model: "claude-opus-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } })
    }, { preconnect: fetch.preconnect })
    const available = source([account(profileA, "secret-a"), account(profileB, "secret-b")])
    yield* credentials.create({ integrationID: Integration.ID.make("anthropic"), label: "Personal",
      value: Credential.OAuth.make({ type: "oauth", methodID: claudeCodeMethodID, access: profileA, refresh: "", expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", managed: true, source: profileA } }) })
    yield* credentials.create({ integrationID: Integration.ID.make("anthropic"), label: "Work",
      value: Credential.OAuth.make({ type: "oauth", methodID: claudeCodeMethodID, access: profileB, refresh: "", expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", managed: true, source: profileB } }) })
    yield* addPlugin(makeAnthropicPlugin({ credentialSource: available, fetch: request }))
    const run = (sourceID: string) => Effect.gen(function* () {
      const runtime = CatalogModel.Info.make({
        ...CatalogModel.Info.empty(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5")),
        package: Provider.aisdk("@ai-sdk/anthropic"),
        settings: { apiKey: "claude-code", claudeCodeSource: sourceID },
      })
      const model = yield* aisdk.model(runtime)
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(LLM.request({ model, prompt: "hello" }))
      const language = yield* aisdk.language(runtime)
      return yield* Effect.tryPromise(() => language.doGenerate(prepared.body))
    })
    yield* run(profileA)
    yield* run(profileB)
    expect(sent).toEqual(["Bearer secret-a", "Bearer secret-b"])
    const missing = "33333333-3333-4333-8333-333333333333"
    const result = yield* run(missing).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(sent).toHaveLength(2)
  }),
)

it.effect("refreshes a 401 only in the selected managed profile", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const seen: string[] = []
    const stored = new Map<string, ClaudeCodeCredentials>([[profileA, account(profileA, "stale-a").credentials], [profileB, account(profileB, "secret-b").credentials]])
    const selected: ClaudeCodeCredentialSource = {
      list: async () => Array.from(stored, ([sourceID, credentials]) => ({ source: sourceID, label: "Claude", credentials })),
      read: async (sourceID) => stored.get(sourceID) ?? null,
      write: async (sourceID, credentials) => { stored.set(sourceID, credentials); return true },
    }
    const request = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const web = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (web.url === "https://claude.ai/v1/oauth/token") {
        expect(await web.text()).toContain("refresh-stale-a")
        return Response.json({ access_token: "fresh-a", refresh_token: "fresh-refresh-a", expires_in: 36_000 })
      }
      const bearer = web.headers.get("authorization") ?? ""
      seen.push(bearer)
      if (bearer === "Bearer stale-a") return Response.json({ error: { type: "authentication_error", message: "expired" } }, { status: 401 })
      return Response.json({ id: "msg_rotated", type: "message", role: "assistant", model: "claude-opus-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } })
    }, { preconnect: fetch.preconnect })
    yield* addPlugin(makeAnthropicPlugin({ credentialSource: selected, fetch: request }))
    const run = (sourceID: string) => Effect.gen(function* () {
      const runtime = CatalogModel.Info.make({ ...CatalogModel.Info.empty(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5")),
        package: Provider.aisdk("@ai-sdk/anthropic"), settings: { apiKey: "claude-code", claudeCodeSource: sourceID } })
      const model = yield* aisdk.model(runtime)
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(LLM.request({ model, prompt: "hello" }))
      const language = yield* aisdk.language(runtime)
      return yield* Effect.tryPromise(() => language.doGenerate(prepared.body))
    })
    yield* run(profileA)
    yield* run(profileB)
    expect(seen).toEqual(["Bearer stale-a", "Bearer fresh-a", "Bearer secret-b"])
    expect(stored.get(profileA)?.accessToken).toBe("fresh-a")
    expect(stored.get(profileB)?.accessToken).toBe("secret-b")
  }),
)

it.effect(
  "sends the final AI SDK request through the integrated Claude Code interceptor without changing cache count",
  () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      let sentHeaders: Headers | undefined
      let sentBody: unknown
      const request = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const web = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
          sentHeaders = web.headers
          sentBody = JSON.parse(await web.text())
          return Response.json({
            id: "msg_claude_code",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "tool_use", id: "tool_1", name: "mcp_Lookup", input: {} }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_creation_input_tokens: 4,
              cache_read_input_tokens: 0,
            },
          })
        },
        { preconnect: fetch.preconnect },
      )
      const credentials = yield* Credential.Service
      yield* credentials.create({ integrationID: Integration.ID.make("anthropic"), value: Credential.OAuth.make({
        type: "oauth", methodID: claudeCodeMethodID, access: profileA, refresh: "", expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", source: profileA, managed: true },
      }) })
      yield* addPlugin(
        makeAnthropicPlugin({
          credentialSource: source([account(profileA, "secret-a")]),
          fetch: request,
        }),
      )

      const runtime = CatalogModel.Info.make({
        ...CatalogModel.Info.empty(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-5")),
        modelID: CatalogModel.ID.make("claude-opus-5"),
        package: Provider.aisdk("@ai-sdk/anthropic"),
        settings: { apiKey: "claude-code", claudeCodeSource: profileA },
        limit: { context: 1_000_000, output: 128_000 },
      })
      const model = yield* aisdk.model(runtime)
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({
          model,
          system: [
            {
              type: "text",
              text: "stable system",
              cache: new CacheHint({ type: "ephemeral" }),
            },
          ],
          prompt: "use lookup",
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: {} },
              cache: new CacheHint({ type: "ephemeral" }),
            },
          ],
        }),
      )
      const result = yield* Effect.tryPromise(() => aisdk.language(runtime).pipe(Effect.runPromise)).pipe(
        Effect.flatMap((language) => Effect.tryPromise(() => language.doGenerate(prepared.body))),
      )

      expect(sentHeaders?.get("authorization")).toBe("Bearer secret-a")
      expect(sentHeaders?.has("x-api-key")).toBe(false)
      expect(sentHeaders?.get("anthropic-beta")?.split(",")).toEqual([
        "claude-code-20250219",
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "advisor-tool-2026-03-01",
        "thinking-token-count-2026-05-13",
        "extended-cache-ttl-2025-04-11",
        "effort-2025-11-24",
      ])
      expect(sentBody).toMatchObject({
        model: "claude-opus-5",
        system: [
          {
            type: "text",
            text: expect.stringMatching(
              /^x-anthropic-billing-header: cc_version=2\.1\.289\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/,
            ),
          },
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
        ],
        tools: [
          {
            name: "mcp_Lookup",
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "stable system",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
              {
                type: "text",
                text: "use lookup",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
            ],
          },
        ],
      })
      expect(cacheMarkers(sentBody)).toBe(3)
      expect(cacheMarkers(sentBody)).toBeLessThanOrEqual(4)
      expect(result.usage.inputTokens).toEqual({
        total: 14,
        noCache: 10,
        cacheRead: 0,
        cacheWrite: 4,
      })
      expect(result.usage.outputTokens.total).toBe(2)
      expect(JSON.stringify(result)).toContain("lookup")
      expect(JSON.stringify(result)).not.toContain("mcp_Lookup")
    }),
)
