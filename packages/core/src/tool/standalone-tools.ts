export * as StandaloneTools from "./standalone-tools"

import { Context, Effect, Layer } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { StandaloneConfig } from "../config/standalone"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { StandaloneForm } from "../form/standalone"
import { Location } from "../location"
import { StandaloneAgent } from "../plugin/standalone-agent"
import { SessionAutonomy } from "../session/autonomy"
import { SessionStore } from "../session/store"
import { SessionTodo } from "../session/todo"
import { ToolOutputStore } from "../tool-output-store"
import { GoalTool } from "./goal"
import { QuestionTool } from "./question"
import { ToolRegistry } from "./registry"
import { StandalonePermission } from "./standalone-permission"
import { TaskCompleteTool } from "./task-complete"
import { TodoWriteTool } from "./todowrite"

export interface Materialization extends Omit<ToolRegistry.Materialization, "settle"> {
  readonly settle: (input: ToolRegistry.ExecuteInput) => Effect.Effect<ToolRegistry.Settlement, StandaloneConfig.InvalidError | ToolOutputStore.Error>
}
export class Service extends Context.Service<Service, {
  readonly materialize: (...args: Parameters<ToolRegistry.Interface["materialize"]>) => Effect.Effect<Materialization, StandaloneConfig.InvalidError>
}>()("@ycoding/StandaloneTools") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const forms = yield* StandaloneForm.Service
    const permission = yield* StandalonePermission.Service
    const todos = yield* SessionTodo.Service
    const autonomy = yield* SessionAutonomy.Service
    const database = yield* Database.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const agentState = yield* StandaloneAgent.Service
    const config = yield* StandaloneConfig.Service
    yield* registry.register({
      question: QuestionTool.makeStandalone(forms, permission, config),
      todowrite: TodoWriteTool.make(todos, permission),
      goal: GoalTool.make(autonomy, database, permission),
      task_complete: TaskCompleteTool.makeStandalone(permission),
    }, { codemode: false }).pipe(Effect.orDie)
    return Service.of({ materialize: (...args) => Effect.gen(function* () {
      const generation = yield* agentState.refresh()
      const materialized = yield* registry.materialize(...args)
      yield* config.assert(generation)
      return {
        definitions: materialized.definitions,
        settle: (input) => Effect.gen(function* () {
          yield* config.assert(generation)
          const current = yield* config.snapshot()
          const agentGeneration = yield* agentState.refresh()
          const session = yield* sessions.get(input.sessionID)
          if (!session || session.scope !== "standalone" || session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
            return { result: { type: "error" as const, value: "Session is unavailable in this scope" }, error: { type: "tool.scope_unavailable", message: "Session is unavailable in this scope" } }
          if (!materialized.definitions.some((definition) => definition.name === input.call.name))
            return yield* materialized.settle(input)
          const agent = yield* agents.get(input.agent)
          const visible = yield* registry.available(agent?.permissions ?? [], Config.capabilities(current.entries))
          yield* config.assert(generation)
          if (current.generation !== agentGeneration || !visible.has(input.call.name))
            return { result: { type: "error" as const, value: "Tool is unavailable in this scope" }, error: { type: "tool.scope_unavailable", message: "Tool is unavailable in this scope" } }
          return yield* materialized.settle(input)
        }).pipe(Effect.provideService(StandalonePermission.DispatchGeneration, generation)),
      }
    }) })
  })),
  deps: [ToolRegistry.standaloneNode, StandaloneForm.node, StandalonePermission.node, SessionTodo.node, SessionAutonomy.node, Database.node, SessionStore.node, Location.node, StandaloneAgent.node, StandaloneConfig.node],
})
