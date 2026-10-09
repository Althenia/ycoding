export * as DecisionCandidates from "./decision-candidates"

import { Effect } from "effect"
import { Catalog } from "./catalog"
import type { ConfigDecisions } from "./config/decisions"
import { SessionRunnerModel } from "./session/runner/model"

/**
 * Narrows configured advisory candidates to models the live catalog can actually serve, with the
 * safe metadata the decision helper may see. Shared by the task-advisory harness and the scope
 * tool, which must not import each other.
 */
export const availableModels = Effect.fn("DecisionCandidates.availableModels")(function* (
  candidates: ConfigDecisions.Advisory["candidates"],
) {
  const catalog = yield* Catalog.Service
  const available = yield* catalog.model.available()
  return yield* Effect.forEach(candidates, (candidate) =>
    Effect.gen(function* () {
      if (
        !available.some(
          (model) => model.providerID === candidate.model.providerID && model.id === candidate.model.model,
        )
      )
        return undefined
      const model = yield* catalog.model.get(candidate.model.providerID, candidate.model.model, candidate.model.profile)
      if (
        !model ||
        !model.enabled ||
        !SessionRunnerModel.supported(model) ||
        (candidate.model.profile !== undefined &&
          !model.profiles?.some((profile) => profile.name === candidate.model.profile)) ||
        (candidate.model.variant !== undefined &&
          !model.variants.some((variant) => variant.id === candidate.model.variant))
      )
        return undefined
      return {
        id: candidate.id,
        description: candidate.description.slice(0, 8192),
        model: {
          providerID: candidate.model.providerID,
          id: candidate.model.model,
          ...(candidate.model.variant === undefined ? {} : { variant: candidate.model.variant }),
          ...(candidate.model.profile === undefined ? {} : { profile: candidate.model.profile }),
        },
        capabilities: model.capabilities,
        limit: model.limit,
        variants: model.variants.map((variant) => variant.id),
      }
    }),
  ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
})
