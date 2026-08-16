export * as AnthropicModel from "./anthropic-model"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export interface Capabilities {
  readonly family: "opus" | "fable" | "mythos" | "sonnet" | "haiku" | "unknown"
  readonly generation?: number
  readonly minor?: number
  readonly adaptiveThinking: "optional" | "default" | "required" | "unsupported"
  readonly manualThinking: boolean
  readonly disableThinkingMaxEffort?: Effort
  readonly effort: readonly Effort[]
  readonly sampling: "default-only" | "configurable"
  readonly midConversationSystem: boolean
  readonly cacheMinimumTokens?: number
  readonly maxContextTokens?: number
  readonly maxOutputTokens?: number
}

const effort = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[]

const unknown: Capabilities = {
  family: "unknown",
  adaptiveThinking: "unsupported",
  manualThinking: false,
  effort: [],
  sampling: "configurable",
  midConversationSystem: false,
}

const normalizedID = (modelID: string) =>
  modelID
    .toLowerCase()
    .replace(/^.*anthropic--/, "")
    .replace(/^anthropic[/.]/, "")
    .replaceAll(".", "-")

export function normalize(modelID: string): Pick<Capabilities, "family" | "generation" | "minor"> {
  const match = /^claude-(opus|fable|mythos|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-|$)/.exec(normalizedID(modelID))
  if (!match) return { family: "unknown" }
  return {
    family: match[1] as Exclude<Capabilities["family"], "unknown">,
    generation: Number(match[2]),
    ...(match[3] === undefined ? {} : { minor: Number(match[3]) }),
  }
}

export function capabilities(modelID: string): Capabilities {
  const id = normalizedID(modelID)
  const parsed = normalize(id)
  if (parsed.family === "unknown") return unknown

  if (parsed.generation === 5 && parsed.family === "opus") {
    const shared = {
      ...parsed,
      adaptiveThinking: "default" as const,
      manualThinking: false,
      disableThinkingMaxEffort: "high" as const,
      effort,
      sampling: "default-only" as const,
      midConversationSystem: true,
    }
    if (id !== "claude-opus-5") return shared
    return {
      ...shared,
      cacheMinimumTokens: 512,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    }
  }

  if (parsed.generation === 5 && (parsed.family === "fable" || parsed.family === "mythos")) {
    const shared = {
      ...parsed,
      adaptiveThinking: "required" as const,
      manualThinking: false,
      effort,
      sampling: "default-only" as const,
      midConversationSystem: true,
    }
    if (id !== "claude-fable-5") return shared
    return {
      ...shared,
      cacheMinimumTokens: 512,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    }
  }

  if (parsed.generation === 5) {
    return {
      ...parsed,
      adaptiveThinking: "default",
      manualThinking: false,
      effort,
      sampling: "default-only",
      midConversationSystem: false,
    }
  }

  return {
    ...parsed,
    adaptiveThinking: "optional",
    manualThinking: true,
    effort: [],
    sampling:
      parsed.family === "opus" &&
      parsed.generation === 4 &&
      parsed.minor !== undefined &&
      parsed.minor >= 7
        ? "default-only"
        : "configurable",
    midConversationSystem: parsed.family === "opus" && parsed.generation === 4 && parsed.minor === 8,
  }
}
