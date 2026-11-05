export * as StandaloneAgent from "./standalone-agent"

import { Context, Effect, Exit, Layer, Semaphore } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { StandaloneConfig } from "../config/standalone"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { makeLocationNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { Global } from "../global"
import { AgentPlugin } from "./agent"

export class Service extends Context.Service<Service, {
  readonly refresh: () => Effect.Effect<number, StandaloneConfig.InvalidError>
}>()("@ycoding/StandaloneAgent") {}

const layer = Layer.effectContext(Effect.gen(function* () {
  const agents = yield* Agent.Service
  const config = yield* StandaloneConfig.Service
  const global = yield* Global.Service
  const lock = Semaphore.makeUnsafe(1)
  let current = yield* config.snapshot()
  yield* agents.transform((draft) => AgentPlugin.apply({ update: (id, update) => draft.update(Agent.ID.make(id), update) }, "standalone"))
  yield* agents.transform((draft) => ConfigAgentPlugin.applyDocuments({
    list: draft.list,
    has: (id) => draft.get(Agent.ID.make(id)) !== undefined,
    default: (id) => draft.default(Agent.ID.make(id)),
    update: (id, update) => draft.update(Agent.ID.make(id), update),
    remove: (id) => draft.remove(Agent.ID.make(id)),
  }, current.entries, global.home, true))
  const refresh = () => lock.withPermit(Effect.gen(function* () {
    const next = yield* config.snapshot()
    if (next.generation !== current.generation) {
      const previous = current
      current = next
      yield* agents.reload().pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.sync(() => { current = previous }) : Effect.void))
    }
    const selected = Config.latest(current.entries, "default_agent")
    if (selected !== undefined) {
      const agent = yield* agents.get(Agent.ID.make(selected))
      if (!agent || !Agent.isSelectable(agent)) return yield* new StandaloneConfig.InvalidError({ reason: "invalid" })
    }
    yield* config.assert(current.generation)
    return current.generation
  }))
  yield* refresh()
  return Context.make(Agent.Service, agents).pipe(Context.add(Service, Service.of({ refresh })))
})).pipe(Layer.provide(Agent.layer))

export const node = makeLocationNode({
  service: Agent.Service,
  layer,
  deps: [EventRuntime.node, StandaloneConfig.node, Global.node],
})
