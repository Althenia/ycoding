export * as StandaloneModel from "./standalone-model"

import { InvalidRequestReason, LLMError, Model } from "@ycoding-ai/ai"
import { Context, Effect, Layer, Stream } from "effect"
import { Catalog } from "../../catalog"
import { StandaloneConfig } from "../../config/standalone"
import { Credential } from "../../credential"
import { Database } from "../../database/database"
import { makeLocationNode } from "../../effect/app-node"
import { Integration } from "../../integration"
import { CatalogContributions } from "../../plugin/catalog-contributions"
import { StandaloneCatalog } from "../../plugin/standalone-catalog"
import { Provider } from "../../provider"
import { SessionSchema } from "../schema"
import { SessionRunnerModel } from "./model"

export class Service extends Context.Service<Service, {
  readonly resolve: (
    session: SessionSchema.Info,
    options?: Parameters<SessionRunnerModel.Interface["resolve"]>[1],
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error | StandaloneConfig.InvalidError>
  readonly assert: (resolved: SessionRunnerModel.Resolved) => Effect.Effect<void, StandaloneConfig.InvalidError>
}>()("@ycoding/SessionRunnerModel.Standalone") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const integration = yield* Integration.StandaloneService
    const config = yield* StandaloneConfig.Service
    const catalog = yield* StandaloneCatalog.Service
    const base = yield* SessionRunnerModel.make(integration, { loadPackage: (specifier) => Provider.loadPackage(specifier, undefined, "standalone") }, true)
    const generations = new WeakMap<SessionRunnerModel.Resolved, number>()
    return Service.of({
      assert: (resolved) => Effect.suspend(() => {
        const generation = generations.get(resolved)
        return generation === undefined ? Effect.fail(new StandaloneConfig.InvalidError({ reason: "stale" })) : config.assert(generation)
      }),
      resolve: (session, options) => Effect.gen(function* () {
        const generation = yield* catalog.refresh()
        const resolved = yield* base.resolve(session, options)
        yield* config.assert(generation)
        const original = resolved.model.route
        const transport = original.transport
        const guard = (method: string) => config.assert(generation).pipe(Effect.mapError(() => new LLMError({
          module: "standalone.config", method,
          reason: new InvalidRequestReason({ message: "Standalone configuration is unavailable or changed" }),
        })))
        const route = original.with({ transport: {
          id: transport.id,
          prepare: (input) => guard("prepare").pipe(Effect.flatMap(() => transport.prepare(input)), Effect.tap(() => guard("prepare"))),
          frames: (prepared, request, runtime) => Stream.unwrap(guard("frames").pipe(
            Effect.map(() => transport.frames(prepared, request, { ...runtime, beforeDispatch: (runtime.beforeDispatch ?? Effect.void).pipe(Effect.andThen(guard("dispatch"))) })),
          )),
        } })
        const current = { ...resolved, model: Model.update(resolved.model, { route }) }
        generations.set(current, generation)
        return current
      }),
    })
  })),
  deps: [Catalog.node, CatalogContributions.standaloneNode, Integration.standaloneNode, Credential.node, Database.node, StandaloneConfig.node],
})
