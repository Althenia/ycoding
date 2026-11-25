import { isRetiredID } from "@ycoding-ai/schema/provider"

const builtInProviders = [
  ["openai", "OpenAI"],
  ["anthropic", "Claude"],
  ["openrouter", "OpenRouter"],
] as const

export const customEndpointChoice = { id: "custom-openai-endpoint", name: "Custom OpenAI-compatible Endpoint" } as const

export function isBuiltInProvider(id: string) {
  return builtInProviders.some(([provider]) => provider === id)
}

export function providerChoices<T extends { readonly id: string; readonly name: string }>(
  items: readonly T[],
  integrationIDs?: ReadonlySet<string>,
) {
  const offered = items.filter((item) => !isRetiredID(item.id) && (integrationIDs === undefined || integrationIDs.has(item.id)))
  return {
    builtIn: builtInProviders.flatMap(([id, name]) => {
      const item = offered.find((entry) => entry.id === id)
      return item ? [{ ...item, id, name }] : []
    }),
    custom: offered.filter((item) => !isBuiltInProvider(item.id)),
  }
}
