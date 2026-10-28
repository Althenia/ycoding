import { Agent } from "@ycoding-ai/core/agent"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Api } from "../api"
import { response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers.handle("agent.list", () =>
    Effect.gen(function* () {
      return yield* response(PluginSupervisor.Service.use((plugins) => plugins.settled).pipe(Effect.andThen(Agent.Service.use((agent) => agent.list()))))
    }),
  ),
)
