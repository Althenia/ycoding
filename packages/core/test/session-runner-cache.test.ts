import { expect, test } from "bun:test"
import { SystemPart, ToolDefinition } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { ExecuteTool } from "@ycoding-ai/core/tool/execute"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { Effect, Schema } from "effect"

const base = {
  projectID: "project",
  directory: "/repo",
  workspaceID: "workspace",
  providerID: "openai",
  modelID: "gpt-5.6",
  apiModelID: "gpt-5.6",
  variant: "default",
  policyRevision: CACHE_POLICY_REVISION,
  permissions: [{ action: "read", resource: "**", effect: "allow" }] satisfies PermissionV2.Ruleset,
  system: [SystemPart.make("System after hook")],
  tools: [
    ToolDefinition.make({
      name: "search",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }),
  ],
} satisfies SessionRunnerCache.PromptCacheNamespaceInput & Pick<SessionRunnerCache.ProviderOptionsInput, "apiModelID">

const namespaceWithSchema = (inputSchema: Readonly<Record<string, unknown>>) =>
  SessionRunnerCache.promptCacheNamespace({
    ...base,
    tools: [
      ToolDefinition.make({
        name: "search",
        description: "Search",
        inputSchema,
      }),
    ],
  })

test("pins the canonical prompt-cache namespace digest", () => {
  expect(SessionRunnerCache.promptCacheNamespace(base)).toBe(
    "b98e95251a36f743abcb0ca99c6ce8544ce431af3dfbabfb29f148fb2099a3b4",
  )
})

test("keeps ordinary keys stable while isolating compaction cache scope", () => {
  const normal = SessionRunnerCache.promptCacheNamespace(base)
  const compaction = SessionRunnerCache.promptCacheNamespace({ ...base, scope: "compaction" })

  expect(normal).toBe("b98e95251a36f743abcb0ca99c6ce8544ce431af3dfbabfb29f148fb2099a3b4")
  expect(compaction).not.toBe(normal)
})

test("canonicalizes object order and preserves JSON array positions", () => {
  const sparse = Array<string | undefined>(2)
  sparse[1] = "tail"
  expect(
    namespaceWithSchema({
      type: "object",
      properties: { b: { type: "string" }, a: { type: "null" } },
    }),
  ).toBe(
    namespaceWithSchema({
      properties: { a: { type: "null" }, b: { type: "string" } },
      type: "object",
    }),
  )
  expect(namespaceWithSchema({ values: sparse })).toBe(namespaceWithSchema({ values: [undefined, "tail"] }))
  expect(namespaceWithSchema({ values: [undefined, "tail"] })).toBe(namespaceWithSchema({ values: [null, "tail"] }))
  expect(namespaceWithSchema({ value: undefined })).toBe(namespaceWithSchema({}))
  expect(namespaceWithSchema({ value: null })).not.toBe(namespaceWithSchema({}))
})

test("uses deterministic code-point ordering for integer-like and non-BMP keys", () => {
  expect(namespaceWithSchema({ "10": "ten", "2": "two", "\u{10000}": "astral", "\u{e000}": "bmp" })).toBe(
    "4fcf6a057b689492b74545701e2b3bc96c26d060d98dc2459459ed61d2e8b6cf",
  )
})

test("rejects unsupported and cyclic schema values instead of aliasing them", () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic

  for (const value of [1n, () => undefined, Symbol("unsupported"), new Date(0), new Map(), new Set(), cyclic]) {
    expect(() => namespaceWithSchema({ value })).toThrow(TypeError)
  }
})

test("isolates every cache sharing dimension", () => {
  const baseline = SessionRunnerCache.promptCacheNamespace(base)
  for (const [key, value] of Object.entries({
    projectID: "other-project",
    directory: "/other",
    workspaceID: "other-workspace",
    providerID: "anthropic",
    modelID: "claude",
    variant: "reasoning",
    // Any value other than the live revision — the point is that a revision bump
    // rotates the namespace, so this must not be pinned to a literal that a
    // future bump could collide with.
    policyRevision: `${CACHE_POLICY_REVISION}-other`,
    permissions: [{ action: "read", resource: "**", effect: "deny" }],
    system: [SystemPart.make("Changed by hook")],
    tools: [],
  })) {
    expect(SessionRunnerCache.promptCacheNamespace({ ...base, [key]: value })).not.toBe(baseline)
  }
  expect(SessionRunnerCache.promptCacheNamespace({ ...base, workspaceID: undefined })).not.toBe(baseline)
})

test("keeps the CodeMode execute namespace stable across dynamic catalogs", () => {
  const registered = (namespace: string, name: string, description: string) => {
    const child = Tool.make({
      description,
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.String,
      execute: ({ query }) => Effect.succeed(query),
    })
    const execute = ExecuteTool.create(new Map([[`${namespace}_${name}`, { tool: child, name, namespace }]]))
    return Tool.definition("execute", execute)
  }
  const first = registered("github", "issue", "Find a GitHub issue")
  const second = registered("slack", "channel", "Find a Slack channel")

  expect(SessionRunnerCache.promptCacheNamespace({ ...base, tools: [first] })).toBe(
    SessionRunnerCache.promptCacheNamespace({ ...base, tools: [second] }),
  )
  expect(
    SessionRunnerCache.promptCacheNamespace({
      ...base,
      tools: [{ ...first, inputSchema: { type: "object", properties: { code: { type: "number" } } } }],
    }),
  ).not.toBe(SessionRunnerCache.promptCacheNamespace({ ...base, tools: [first] }))
})

test("shares subagent prefixes only when every model-visible dimension is equal", () => {
  const parent = SessionRunnerCache.promptCacheNamespace(base)
  expect(SessionRunnerCache.promptCacheNamespace({ ...base })).toBe(parent)

  const mismatches = [
    { providerID: "other-provider" },
    { modelID: "other-model" },
    { variant: "high" },
    { projectID: "other-project" },
    { directory: "/other" },
    { workspaceID: "other-workspace" },
    { policyRevision: `${CACHE_POLICY_REVISION}-other` },
    { permissions: [{ action: "read", resource: "**", effect: "deny" }] },
    { system: [SystemPart.make("Subagent system")] },
    { tools: [] },
  ] satisfies ReadonlyArray<Partial<SessionRunnerCache.PromptCacheNamespaceInput>>

  for (const mismatch of mismatches)
    expect(SessionRunnerCache.promptCacheNamespace({ ...base, ...mismatch })).not.toBe(parent)
})

test("separates provider session namespace from the shared prefix key", () => {
  const prefixInput = {
    projectID: "project",
    providerID: "openai",
  }
  const baseSession: SessionRunnerCache.ProviderSessionNamespaceInput = {
    projectID: "project",
    sessionID: "ses_aaa",
    providerID: "openai",
  }
  const prefix = SessionRunnerCache.promptCacheNamespace(base)
  const first = SessionRunnerCache.providerSessionNamespace(baseSession)
  const second = SessionRunnerCache.providerSessionNamespace({ ...baseSession, sessionID: "ses_bbb" })

  expect(prefix).not.toBe(first)
  expect(prefix).not.toBe(second)
  expect(first).not.toBe(second)
  expect(first).toMatch(/^[0-9a-f]{64}$/)
  expect(second).toMatch(/^[0-9a-f]{64}$/)
})

test("different sessions share a prompt cache key but not an OpenRouter session identity", () => {
  const input = {
    ...base,
    sessionID: "ses_aaa",
    routeID: "ai-sdk:@openrouter/ai-sdk-provider",
  }
  const same = {
    ...base,
    sessionID: "ses_aaa",
    routeID: "ai-sdk:@openrouter/ai-sdk-provider",
  }
  const other = {
    ...base,
    sessionID: "ses_bbb",
    routeID: "ai-sdk:@openrouter/ai-sdk-provider",
  }
  const first = SessionRunnerCache.providerOptions(input)
  const second = SessionRunnerCache.providerOptions(same)
  const third = SessionRunnerCache.providerOptions(other)

  expect(first.promptCacheKey).toBe(third.promptCacheKey)
  expect(first.promptCacheKey).toMatch(/^[0-9a-f]{64}$/)
  expect(first.providerOptions.openrouter.session_id).not.toBe(third.providerOptions.openrouter.session_id)
  expect(first.providerOptions.openrouter.prompt_cache_key).toBe(third.providerOptions.openrouter.prompt_cache_key)
  expect(first.providerOptions.openrouter.session_id).toMatch(/^[0-9a-f]{64}$/)
  expect(first.providerOptions.openrouter.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/)
  expect(first.providerOptions.openai.promptCacheKey).toBe(third.providerOptions.openai.promptCacheKey)

  expect(first.providerOptions.openrouter.session_id).toBe(second.providerOptions.openrouter.session_id)
  expect(first.providerOptions.openrouter.prompt_cache_key).toBe(second.providerOptions.openrouter.prompt_cache_key)
})

test("selects hybrid auto or explicit OpenAI caching only for supported direct GPT-5.6 routes", () => {
  const automatic = SessionRunnerCache.providerOptions({
    ...base,
    sessionID: "ses_openai_auto",
    routeID: "openai-responses",
    openaiMode: "auto",
  })
  expect(automatic.providerOptions.openai).toEqual({
    promptCacheKey: automatic.promptCacheKey,
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
  })
  expect(automatic.cache).toEqual({ tools: false, system: true, messages: { tail: Number.MAX_SAFE_INTEGER } })

  const aliased = SessionRunnerCache.providerOptions({
    ...base,
    modelID: "catalog-alias",
    apiModelID: "gpt-5.6",
    sessionID: "ses_openai_alias",
    routeID: "openai-responses",
    openaiMode: "auto",
  })
  expect(aliased.providerOptions.openai).toEqual({
    promptCacheKey: aliased.promptCacheKey,
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
  })
  expect(aliased.promptCacheKey).toBe(SessionRunnerCache.promptCacheNamespace({ ...base, modelID: "catalog-alias" }))
  expect(aliased.cache).toEqual({ tools: false, system: true, messages: { tail: Number.MAX_SAFE_INTEGER } })

  const directRoute = SessionRunnerCache.providerOptions({
    ...base,
    providerID: "catalog-alias",
    sessionID: "ses_openai_route_identity",
    routeID: "openai-chat",
    openaiMode: "auto",
  })
  expect(directRoute.providerOptions.openai).toEqual({
    promptCacheKey: directRoute.promptCacheKey,
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
  })
  expect(directRoute.cache).toEqual({ tools: false, system: true, messages: { tail: Number.MAX_SAFE_INTEGER } })

  const webSocket = SessionRunnerCache.providerOptions({
    ...base,
    sessionID: "ses_openai_websocket",
    routeID: "openai-responses-websocket",
    openaiMode: "explicit",
  })
  expect(webSocket.providerOptions.openai).toEqual({
    promptCacheKey: webSocket.promptCacheKey,
    promptCacheOptions: { mode: "explicit", ttl: "30m" },
  })
  expect(webSocket.cache).toEqual({ tools: false, system: true, messages: { tail: Number.MAX_SAFE_INTEGER } })

  const explicit = SessionRunnerCache.providerOptions({
    ...base,
    sessionID: "ses_openai_explicit",
    routeID: "openai-responses",
    openaiMode: "explicit",
  })
  expect(explicit.providerOptions.openai).toEqual({
    promptCacheKey: explicit.promptCacheKey,
    promptCacheOptions: { mode: "explicit", ttl: "30m" },
  })
  expect(explicit.cache).toEqual({ tools: false, system: true, messages: { tail: Number.MAX_SAFE_INTEGER } })

  const legacy = SessionRunnerCache.providerOptions({
    ...base,
    modelID: "gpt-5.5",
    apiModelID: "gpt-5.5",
    sessionID: "ses_openai_legacy",
    routeID: "openai-responses",
    openaiMode: "auto",
    openaiExtendedRetention: true,
  })
  expect(legacy.providerOptions.openai).toEqual({
    promptCacheKey: legacy.promptCacheKey,
    promptCacheRetention: "24h",
  })
  expect(legacy.cache).toBeUndefined()

  const unsupportedLegacy = SessionRunnerCache.providerOptions({
    ...base,
    modelID: "gpt-4o-mini",
    apiModelID: "gpt-4o-mini",
    sessionID: "ses_openai_unsupported_legacy",
    routeID: "openai-responses",
    openaiMode: "explicit",
    openaiExtendedRetention: true,
  })
  expect(unsupportedLegacy.providerOptions.openai).toEqual({
    promptCacheKey: unsupportedLegacy.promptCacheKey,
  })
  expect(unsupportedLegacy.cache).toBeUndefined()

  const compatible = SessionRunnerCache.providerOptions({
    ...base,
    sessionID: "ses_openai_compatible",
    routeID: "openai-compatible-responses",
    openaiMode: "explicit",
    openaiExtendedRetention: true,
  })
  expect(compatible.providerOptions.openai).toEqual({ promptCacheKey: compatible.promptCacheKey })
  expect(compatible.cache).toBeUndefined()

  const codexBackend = SessionRunnerCache.providerOptions({
    ...base,
    sessionID: "ses_openai_codex",
    routeID: "openai-codex-responses",
    openaiMode: "auto",
  })
  expect(codexBackend.providerOptions.openai).toEqual({ promptCacheKey: codexBackend.promptCacheKey })
  expect(codexBackend.cache).toBeUndefined()

  const implicit = SessionRunnerCache.providerOptions({
    ...base,
    sessionID: "ses_openai_implicit",
    routeID: "openai-chat",
    openaiMode: "implicit",
  })
  expect(implicit.providerOptions.openai).toEqual({ promptCacheKey: implicit.promptCacheKey })
  expect(implicit.cache).toBeUndefined()
})

test("maps selected Anthropic TTL into a concrete cache policy", () => {
  const result = SessionRunnerCache.providerOptions({
    ...base,
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    apiModelID: "claude-sonnet-4-5",
    sessionID: "ses_anthropic_ttl",
    routeID: "anthropic-messages",
    anthropicTtlSeconds: 300,
  })
  expect(result.cache).toEqual({ tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 300 })
})

test("native openrouter route uses camelCase fields", () => {
  const input = {
    ...base,
    sessionID: "ses_camel",
    routeID: "openrouter",
  }
  const result = SessionRunnerCache.providerOptions(input)
  expect(result.providerOptions.openrouter.sessionID).toMatch(/^[0-9a-f]{64}$/)
  expect(result.providerOptions.openrouter.promptCacheKey).toMatch(/^[0-9a-f]{64}$/)
  expect(result.providerOptions.openrouter).not.toHaveProperty("session_id")
  expect(result.providerOptions.openrouter).not.toHaveProperty("prompt_cache_key")
})
