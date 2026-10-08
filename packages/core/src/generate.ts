export * as Generate from "./generate"

import { LLM, LLMClient, LLMError } from "@ycoding-ai/ai"
import { Context, Effect, Layer, Schema } from "effect"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { Credential } from "./credential"
import { makeLocationNode } from "./effect/app-node"
import { llmClient } from "./effect/app-node-platform"
import { Integration } from "./integration"
import { CatalogModel } from "./model"
import { Npm } from "./npm"
import { Provider } from "./provider"
import { SessionRunnerModel } from "./session/runner/model"

export interface TextInput {
  readonly prompt: string
  readonly model?: CatalogModel.Ref
}

export class ModelSelectionError extends Schema.TaggedErrorClass<ModelSelectionError>()(
  "Generate.ModelSelectionError",
  { message: Schema.String },
) {}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("Generate.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = ModelSelectionError | UnavailableError

export interface Interface {
  readonly text: (input: TextInput) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Generate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const llm = yield* LLMClient.Service
    const npm = yield* Npm.Service
    const credentials = yield* Credential.Service

    const selectModel = Effect.fn("Generate.selectModel")(function* (requested?: CatalogModel.Ref) {
      const selected = requested
        ? yield* catalog.model.get(requested.providerID, requested.id)
        : yield* catalog.model
            .default()
            .pipe(
              Effect.flatMap((model) =>
                model && SessionRunnerModel.supported(model)
                  ? Effect.succeed(model)
                  : Effect.map(catalog.model.available(), (models) => models.find(SessionRunnerModel.supported)),
              ),
            )
      if (!selected)
        return yield* new ModelSelectionError({
          message: requested
            ? `Model unavailable: ${requested.providerID}/${requested.id}`
            : "No model specified and no supported model is available",
        })
      return selected
    })

    const runText = Effect.fn("Generate.text")(function* (input: TextInput) {
      const selection = input.model ?? (yield* catalog.model.defaultSelection())
      const selected = yield* selectModel(selection)
      const provider = yield* catalog.provider.get(selected.providerID)
      const integrationID = provider?.integrationID ?? Integration.ID.make(selected.providerID)
      const matching =
        selection?.profile === undefined
          ? []
          : (yield* credentials.list(integrationID)).filter((credential) => credential.label === selection.profile)
      if (selection?.profile !== undefined && matching.length !== 1)
        return yield* new ModelSelectionError({
          message: `Profile unavailable for ${selected.providerID}: ${selection.profile}`,
        })
      const connection =
        selection?.profile === undefined
          ? yield* integrations.connection.active(integrationID)
          : { type: "credential" as const, id: matching[0]!.id, label: matching[0]!.label, active: matching[0]!.active }
      const snapshot = connection ? yield* integrations.connection.snapshot(connection) : undefined
      if (connection?.type === "credential" && !snapshot?.credential)
        return yield* new UnavailableError({ message: "Selected generation credential is unavailable" })
      if (
        selection?.profile !== undefined &&
        (!snapshot?.credential || snapshot.credential.accountGeneration !== matching[0]?.accountGeneration)
      )
        return yield* new ModelSelectionError({
          message: `Profile unavailable for ${selected.providerID}: ${selection.profile}`,
        })
      const contextual = yield* catalog.model.forConnection(selected, snapshot)
      if (!contextual)
        return yield* new ModelSelectionError({ message: `Model unavailable: ${selected.providerID}/${selected.id}` })
      const model = yield* SessionRunnerModel.fromCatalogModel(
        yield* SessionRunnerModel.withVariant(contextual, selection?.variant).pipe(
          Effect.mapError((error) => new ModelSelectionError({ message: error.message })),
        ),
        snapshot?.value,
        {
          loadPackage: (specifier) => Provider.loadPackage(specifier, npm),
          loadAISDK: (model, snapshot) => aisdk.model(model, snapshot),
        },
        connection,
        snapshot,
      ).pipe(
        Effect.mapError((error) =>
          input.model
            ? new ModelSelectionError({ message: error.message })
            : new UnavailableError({ message: error.message, service: selected.providerID }),
        ),
      )
      const response = yield* llm.generate(LLM.request({ model, prompt: input.prompt })).pipe(
        Effect.mapError(
          (error: LLMError) =>
            new UnavailableError({
              message: error.message,
              service: selected.providerID,
            }),
        ),
      )
      return response.text
    })

    const text: Interface["text"] = (input) =>
      runText(input).pipe(
        Effect.catchTag(
          "Integration.Authorization",
          () =>
            new UnavailableError({
              message: "Generation credentials are unavailable",
            }),
        ),
      )

    return Service.of({ text })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AISDK.node, Catalog.node, Integration.node, Credential.node, Npm.node, llmClient],
})
