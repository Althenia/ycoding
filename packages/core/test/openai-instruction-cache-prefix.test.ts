import { expect } from "bun:test"
import { LLM, LLMClient, Message, SystemPart, ToolDefinition } from "@ycoding-ai/ai"
import { OpenAIResponses, type OpenAIResponsesBody } from "@ycoding-ai/ai/protocols/openai-responses"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import PROMPT_DEFAULT from "../src/session/runner/prompt/base.txt"
import { Effect } from "effect"
import { it } from "./lib/effect"

for (const mode of ["auto", "explicit", "implicit"] as const) {
  it.effect(`${mode}: preserves a cached instruction-update prefix before changing live state`, () =>
    Effect.gen(function* () {
      const id = CatalogModel.ID.make("gpt-6.1-sol")
      const model = yield* SessionRunnerModel.fromCatalogModel(CatalogModel.Info.make({
        ...CatalogModel.Info.empty(Provider.ID.openai, id),
        modelID: id,
        package: Provider.aisdk("@ai-sdk/openai"),
        settings: { baseURL: "https://api.openai.com/v1" },
      }))
      const system = [SystemPart.make("You are a coding assistant.")]
      const tools = SessionRunnerCache.canonicalTools([ToolDefinition.make({
        name: "read",
        description: "Read a file from the workspace.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      })])
      const cache = SessionRunnerCache.providerOptions({
        projectID: "project_ycoding",
        directory: "/workspace/ycoding",
        providerID: "openai",
        modelID: id,
        apiModelID: id,
        sessionID: "ses_instruction_cache",
        policyRevision: CACHE_POLICY_REVISION,
        permissions: [],
        system,
        tools,
        routeID: model.route.id,
        endpointBaseURL: model.route.endpoint.baseURL,
        openaiMode: mode,
      })
      const history = [
        Message.user("Inspect the repository instructions before changing code."),
        Message.system(PROMPT_DEFAULT),
      ]
      const prepare = (state: string, messages = history) => LLMClient.prepare<OpenAIResponsesBody>(LLM.request({
        model,
        system,
        tools,
        messages: [...messages, Message.make({ role: "system", content: state, volatile: true })],
        providerOptions: { openai: { ...cache.providerOptions.openai, store: false, reasoningEffort: "medium" } },
        cache: cache.cache,
      }))
      const first = (yield* prepare("Pending your review: 1 item(s) in this Session family.")).body
      const second = (yield* prepare("Pending your review: 2 item(s) in this Session family.", [
        ...history,
        Message.assistant("I have read the instructions."),
      ])).body
      expect(first.prompt_cache_key).toBe(second.prompt_cache_key)
      expect(first.tools).toEqual(second.tools)
      expect(first.reasoning).toEqual(second.reasoning)
      expect(second.input.slice(0, 3)).toEqual(first.input.slice(0, 3))
      expect(second.input.at(-1)).not.toEqual(first.input.at(-1))
      expect(JSON.stringify(second.input.at(-1))).not.toContain("prompt_cache_breakpoint")
      expect(first.input[2]).toMatchObject({ role: "system", content: [{ type: "input_text", text: PROMPT_DEFAULT }] })
      if (mode === "implicit") {
        expect(JSON.stringify(first)).not.toContain("prompt_cache_breakpoint")
        return
      }
      expect(first.prompt_cache_options?.mode).toBe("explicit")
      expect(JSON.stringify(first.input[2]).includes('"prompt_cache_breakpoint":{"mode":"explicit"}')).toBe(true)
      expect(second.input[2]).toEqual(first.input[2])
    }),
  )
}

for (const route of [
  { id: "openai-responses", websocket: false, provider: "openai", baseURL: "https://api.openai.com/v1", marked: true },
  { id: "openai-responses-websocket", websocket: true, provider: "openai", baseURL: "https://api.openai.com/v1", marked: true },
  { id: "openai-codex-responses", websocket: false, provider: "openai", baseURL: "https://chatgpt.com/backend-api/codex", marked: false },
  { id: "openai-codex-websocket-responses", websocket: true, provider: "openai", baseURL: "https://chatgpt.com/backend-api/codex", marked: false },
  { id: "github-copilot-responses", websocket: false, provider: "github-copilot", baseURL: "https://api.githubcopilot.com", marked: false },
  { id: "openai-responses", websocket: false, provider: "openai", baseURL: "https://gateway.example/v1", marked: false },
]) {
  it.effect(`gates chronological system markers on ${route.id} at ${route.baseURL}`, () =>
    Effect.gen(function* () {
      const model = (route.websocket ? OpenAIResponses.webSocketRoute : OpenAIResponses.route)
        .with({ id: route.id, provider: route.provider, endpoint: { baseURL: route.baseURL } })
        .model({ id: "gpt-6.1-sol" })
      const prepared = yield* LLMClient.prepare<OpenAIResponsesBody>(LLM.request({
        model,
        messages: [Message.user("Read the instructions."), Message.system(PROMPT_DEFAULT)],
        cache: { system: true, messages: { tail: Number.MAX_SAFE_INTEGER } },
        providerOptions: { openai: { store: false, promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
      }))
      expect(prepared.body.input[1]).toMatchObject({ role: "system", content: [{ type: "input_text", text: PROMPT_DEFAULT }] })
      expect(JSON.stringify(prepared.body.input[1]).includes('"prompt_cache_breakpoint"')).toBe(route.marked)
      if (route.id.startsWith("openai-codex") || route.id === "github-copilot-responses") {
        expect(prepared.body.prompt_cache_options).toBeUndefined()
        expect(prepared.body.prompt_cache_retention).toBeUndefined()
      }
    }),
  )
}
