import { expect, test } from "bun:test"
import { SystemPart, ToolDefinition } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"

const base = {
  projectID: "project",
  directory: "/repo",
  workspaceID: "workspace",
  providerID: "openai",
  modelID: "gpt-5.6",
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
} satisfies SessionRunnerCache.PromptCacheNamespaceInput

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
    "64ad6709b4f0b116df48ceb83fd9ab2c743042814b393270141fd4b25742cc5c",
  )
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
    "478d42a1f266f34fefe44cac04dce27a30583909d64c0f9261382fae8a40d875",
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

test("shares equivalent parent and routed-subagent request prefixes", () => {
  const parent = { ...base, agentID: "build" }
  const routedSubagent = { ...base, agentID: "reviewer" }
  expect(SessionRunnerCache.promptCacheNamespace(routedSubagent)).toBe(SessionRunnerCache.promptCacheNamespace(parent))
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
