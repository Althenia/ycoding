import { Skill } from "@ycoding-ai/core/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Api } from "../api"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers.handle("skill.list", () => response(PluginSupervisor.Service.use((plugins) => plugins.settled).pipe(Effect.andThen(Skill.Service.use((skill) => skill.list()))))),
)
