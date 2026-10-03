import { createSession, sessionVariant, type RunSession, type SessionMessages } from "./session.shared"
import type { RunInput, RunProvider } from "./types"
import { cycleModelVariant } from "../model-preference"

export function modelInfo(providers: RunProvider[] | undefined, model: NonNullable<RunInput["model"]>) {
  const provider = providers?.find((item) => item.id === model.providerID)
  return {
    provider: provider?.name ?? model.providerID,
    model: provider?.models[model.modelID]?.name ?? model.modelID,
  }
}

export function formatModelLabel(
  model: NonNullable<RunInput["model"]>,
  variant: string | undefined,
  providers?: RunProvider[],
): string {
  const names = modelInfo(providers, model)
  const label = variant ? ` · ${variant}` : ""
  return `${names.model} · ${names.provider}${label}`
}

export function cycleVariant(current: string | undefined, variants: string[]): string | undefined {
  return cycleModelVariant(current, variants)
}

export function pickVariant(model: RunInput["model"], input: RunSession | SessionMessages): string | undefined {
  return sessionVariant(Array.isArray(input) ? createSession(input) : input, model)
}

export function resolveVariant(
  input: string | undefined,
  session: string | undefined,
  saved: string | undefined,
): string | undefined {
  return input ?? session ?? saved
}
