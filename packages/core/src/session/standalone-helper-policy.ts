export * as StandaloneHelperPolicy from "./standalone-helper-policy"

import { Context, Effect, Layer } from "effect"
import type { Agent } from "../agent"
import { StandaloneConfig } from "../config/standalone"
import { makeLocationNode } from "../effect/app-node"
import type { CatalogModel } from "../model"
import { SessionHelperPolicy } from "./helper-policy"
import { StandaloneModel } from "./runner/standalone-model"
import type { SessionRunnerModel } from "./runner/model"
import type { SessionSchema } from "./schema"

export class Service extends Context.Service<Service, {
  readonly settings: () => Effect.Effect<SessionHelperPolicy.Settings, StandaloneConfig.InvalidError>
  readonly resolveRef: (session: SessionSchema.Info, selected: CatalogModel.Ref | undefined, options?: SessionHelperPolicy.ResolveOptions) => Effect.Effect<SessionRunnerModel.Resolved | undefined, StandaloneConfig.InvalidError>
  readonly resolveModel: (session: SessionSchema.Info, role: SessionHelperPolicy.Role, agent?: Agent.Info, options?: SessionHelperPolicy.ResolveOptions) => Effect.Effect<SessionRunnerModel.Resolved | undefined, StandaloneConfig.InvalidError>
}>()("@ycoding/SessionHelperPolicy.Standalone") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const config = yield* StandaloneConfig.Service
    const models = yield* StandaloneModel.Service
    const resolveRef = (session: SessionSchema.Info, selected: CatalogModel.Ref | undefined, options?: SessionHelperPolicy.ResolveOptions) =>
      models.resolve(selected === undefined ? session : { ...session, model: selected }, options).pipe(
        Effect.catchIf((error): error is SessionRunnerModel.Error => !(error instanceof StandaloneConfig.InvalidError), () => Effect.succeed(undefined)),
      )
    return Service.of({
      settings: () => config.snapshot().pipe(Effect.map((snapshot) => SessionHelperPolicy.settings(snapshot.entries))),
      resolveRef,
      resolveModel: (session, role, agent, options) => Effect.gen(function* () {
        const snapshot = yield* config.snapshot()
        const policy = SessionHelperPolicy.settings(snapshot.entries)
        const selected = role === "compaction"
          ? SessionHelperPolicy.selectCompactionModel(policy.compactionScopes ?? {}, session, agent)
          : SessionHelperPolicy.selectHelperModel({ agentModel: agent?.model, roleModel: policy.models[role], sessionModel: session.model })
        const model = yield* resolveRef(session, selected, options)
        yield* config.assert(snapshot.generation)
        return model
      }),
    })
  })),
  deps: [StandaloneConfig.node, StandaloneModel.node],
})
