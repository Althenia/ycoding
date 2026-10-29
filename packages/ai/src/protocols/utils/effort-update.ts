import type { LLMRequest, Message } from "../../schema"
import { AnthropicModel } from "../../anthropic-model"
import { isRecord } from "../shared"

export const ANTHROPIC_EFFORT_BETA = "mid-conversation-output-config-2026-07-01"
export type EffortProvider = "openai" | "anthropic" | "openrouter"

export const gpt6EffortModel = (id: string) =>
  /^(?:gpt-6-(?:luna|sol|astra)|gpt-6\.1-(?:sol|terra))(?:-\d{4}-\d{2}-\d{2})?$/.test(id)

export const anthropicEffortModel = (id: string) =>
  /^claude-(?:(?:fable|mythos)-5-1|opus-5(?:-5)?|(?:sonnet|haiku)-5-5)(?:[-@]\d{8})?$/.test(
    id.replaceAll(".", "-").replace(/^anthropic\//, ""),
  )

export const vertexAnthropicEndpoint = (url: string) =>
  /^https:\/\/(?:[a-z0-9-]+-aiplatform\.googleapis\.com|aiplatform\.googleapis\.com|aiplatform\.(?:eu|us)\.rep\.googleapis\.com)\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/?$/.test(
    url,
  )

export const openRouterEndpoint = (url: string) => /^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(url)

const openRouterModel = (id: string) =>
  (id.startsWith("openai/") && gpt6EffortModel(id.slice("openai/".length))) ||
  /^anthropic\/claude-(?:fable-5[.-]1|opus-5)$/.test(id)

export const mechanism = (request: LLMRequest): EffortProvider | undefined => {
  const route = request.model.route
  const endpoint = route.endpoint.baseURL ?? ""
  const openai = request.providerOptions?.openai
  const reasoning = request.http?.body?.reasoning
  const multiAgent = request.http?.body?.multi_agent
  const routerReasoning = request.providerOptions?.openrouter?.reasoning
  const standard =
    (openai?.reasoningMode === undefined || openai.reasoningMode === "standard") &&
    (!isRecord(reasoning) || reasoning.mode === undefined || reasoning.mode === "standard") &&
    (!isRecord(routerReasoning) || routerReasoning.mode === undefined || routerReasoning.mode === "standard") &&
    (!isRecord(multiAgent) || multiAgent.enabled !== true) &&
    (!Array.isArray(openai?.contextManagement) || openai.contextManagement.length === 0) &&
    (!Array.isArray(request.http?.body?.context_management) || request.http.body.context_management.length === 0) &&
    request.http?.body?.truncation !== "auto" &&
    (!isRecord(reasoning) || reasoning.effort === undefined)
  const thinking = request.providerOptions?.anthropic?.thinking
  const adaptive = !isRecord(thinking) || thinking.type === "adaptive"
  if (
    openRouterEndpoint(endpoint) &&
    openRouterModel(request.model.id) &&
    standard &&
    (!isRecord(routerReasoning) || (routerReasoning.enabled === undefined && routerReasoning.max_tokens === undefined))
  ) {
    if (route.id === "openrouter-responses") return "openrouter"
    if (["openai-compatible-responses", "openai-compatible-chat", "openai-responses", "openai-chat"].includes(route.id))
      return "openai"
    if (
      route.id === "anthropic-messages" &&
      adaptive &&
      (!isRecord(request.http?.body?.output_config) || request.http.body.output_config.effort === undefined)
    )
      return "anthropic"
  }
  if (
    ["openai-responses", "openai-responses-websocket"].includes(route.id) &&
    /^https:\/\/api\.openai\.com\/v1\/?$/.test(endpoint) &&
    gpt6EffortModel(request.model.id) &&
    standard
  )
    return "openai"
  if (
    ((route.id === "anthropic-messages" && /^https:\/\/api\.anthropic\.com\/v1\/?$/.test(endpoint)) ||
      (route.id === "google-vertex-messages" && vertexAnthropicEndpoint(endpoint))) &&
    anthropicEffortModel(request.model.id) &&
    (!isRecord(request.http?.body?.output_config) || request.http.body.output_config.effort === undefined) &&
    adaptive
  )
    return "anthropic"
  return undefined
}

export const updateEffort = (message: Message, provider: EffortProvider) => {
  const native = message.native?.[provider]
  if (!isRecord(native)) return undefined
  const effort = provider === "openai" ? native.reasoningEffort : native.effort
  return typeof effort === "string" ? effort : undefined
}

export const selectedEffort = (options: LLMRequest["providerOptions"], provider: EffortProvider) => {
  const reasoning = options?.openrouter?.reasoning
  const effort =
    provider === "openrouter"
      ? isRecord(reasoning) && typeof reasoning.effort === "string"
        ? reasoning.effort
        : options?.openai?.reasoningEffort
      : options?.[provider]?.[provider === "openai" ? "reasoningEffort" : "effort"]
  return typeof effort === "string" ? effort : undefined
}

export const defaultEffort = (modelID: string) => {
  const id = modelID.split("/").at(-1) ?? modelID
  if (/^gpt-6-astra(?:-|$)/.test(id)) return undefined
  if (gpt6EffortModel(id)) return "medium"
  const model = AnthropicModel.normalize(id.replace(/@\d{8}$/, ""))
  return model.generation === 5 && model.minor === 5 && ["opus", "haiku"].includes(model.family) ? "medium" : "high"
}
