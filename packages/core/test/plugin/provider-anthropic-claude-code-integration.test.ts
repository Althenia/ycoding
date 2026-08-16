import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { CacheHint, LLM } from "@ycoding-ai/ai"
import { LLMClient } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { claudeCodeMethodID, makeAnthropicPlugin } from "@ycoding-ai/core/plugin/provider/anthropic"
import type { ClaudeCodeCredentialSource } from "@ycoding-ai/core/plugin/provider/anthropic-claude-code"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Money } from "@ycoding-ai/schema/money"
import { expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const account = (source: string, accessToken: string) => ({
  label: source === "account-a" ? "Claude Max" : "Claude Max 2",
  source,
  credentials: {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: "max",
  },
})

const source = (accounts = [account("account-a", "secret-a"), account("account-b", "secret-b")]) =>
  ({
    list: async () => accounts,
    read: async (name) => accounts.find((item) => item.source === name)?.credentials ?? null,
    write: async () => true,
    refreshWithCli: async () => undefined,
  }) satisfies ClaudeCodeCredentialSource

const addPlugin = Effect.fn(function* (plugin: ReturnType<typeof makeAnthropicPlugin>) {
  const host = yield* PluginHost.make(yield* PluginV2.Service)
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
        accountStateFile: join(tmpdir(), `ycoding-claude-account-${crypto.randomUUID()}`),
      }),
    )

    expect(yield* credentials.list(integrationID)).toEqual([])
  }),
)

it.live("registers Claude Code accounts without persisting OAuth tokens", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const plugin = makeAnthropicPlugin({
      credentialSource: source(),
      accountStateFile: join(tmpdir(), `ycoding-claude-account-${crypto.randomUUID()}`),
    })
    yield* addPlugin(plugin)

    const info = yield* integrations.get(Integration.ID.make("anthropic"))
    expect(info?.methods).toContainEqual({
      id: claudeCodeMethodID,
      type: "oauth",
      label: "Claude Code account",
      prompts: [
        {
          type: "select",
          key: "account",
          message: "Select a Claude Code account",
          options: [
            {
              label: "Claude Max",
              value: "account-a",
              hint: "account-a (active)",
            },
            { label: "Claude Max 2", value: "account-b", hint: "account-b" },
          ],
        },
      ],
    })
    expect(info?.methods).toContainEqual({
      type: "env",
      names: ["ANTHROPIC_API_KEY"],
    })
    expect(info?.methods.some((method) => method.type === "oauth" && method.id === "claude-setup-token")).toBe(false)

    const attempt = yield* integrations.oauth.connect({
      integrationID: Integration.ID.make("anthropic"),
      methodID: claudeCodeMethodID,
      inputs: { account: "account-b" },
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
        access: "account-b",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { authKind: "claude-code", source: "account-b" },
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
        draft.provider.update(ProviderV2.ID.anthropic, (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/anthropic")
          provider.integrationID = Integration.ID.make("anthropic")
        })
        draft.model.update(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-opus-5"), (model) => {
          model.enabled = true
          model.status = "active"
          model.cost = [priced]
        })
      })

      yield* addPlugin(
        makeAnthropicPlugin({
          credentialSource: source([account("account-a", "secret-a")]),
          accountStateFile: join(tmpdir(), `ycoding-claude-account-${crypto.randomUUID()}`),
        }),
      )

      expect(yield* integrations.connection.active(Integration.ID.make("anthropic"))).toEqual({
        type: "env",
        name: "ANTHROPIC_API_KEY",
      })
      const provider = yield* catalog.provider.get(ProviderV2.ID.anthropic)
      const model = yield* catalog.model.get(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-opus-5"))
      expect(provider?.settings?.apiKey).not.toBe("claude-code")
      expect(model?.cost).toEqual([priced])
    }),
  ),
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
      draft.provider.update(ProviderV2.ID.anthropic, (provider) => {
        provider.package = ProviderV2.aisdk("@ai-sdk/anthropic")
        provider.integrationID = Integration.ID.make("anthropic")
      })
      draft.model.update(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-opus-5"), (model) => {
        model.enabled = true
        model.status = "active"
        model.cost = [priced]
      })
    })

    yield* addPlugin(
      makeAnthropicPlugin({
        credentialSource: source([account("account-a", "secret-a")]),
        accountStateFile: join(tmpdir(), `ycoding-claude-account-${crypto.randomUUID()}`),
      }),
    )

    const provider = yield* catalog.provider.get(ProviderV2.ID.anthropic)
    const model = yield* catalog.model.get(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-opus-5"))
    expect(provider?.settings).toMatchObject({
      apiKey: "claude-code",
      claudeCodeSource: "account-a",
    })
    expect(model?.cost).toEqual([priced])
    expect((yield* catalog.provider.available()).map((item) => item.id)).toContain(ProviderV2.ID.anthropic)
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
      yield* addPlugin(
        makeAnthropicPlugin({
          credentialSource: source([account("account-a", "secret-a")]),
          fetch: request,
          accountStateFile: join(tmpdir(), `ycoding-claude-account-${crypto.randomUUID()}`),
        }),
      )

      const runtime = ModelV2.Info.make({
        ...ModelV2.Info.empty(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-opus-5")),
        modelID: ModelV2.ID.make("claude-opus-5"),
        package: ProviderV2.aisdk("@ai-sdk/anthropic"),
        settings: { apiKey: "claude-code", claudeCodeSource: "account-a" },
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
        "effort-2025-11-24",
      ])
      expect(sentBody).toMatchObject({
        model: "claude-opus-5",
        system: [
          {
            type: "text",
            text: expect.stringMatching(
              /^x-anthropic-billing-header: cc_version=2\.1\.220\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/,
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
