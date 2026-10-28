import { Reference } from "@ycoding-ai/core/reference"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Api } from "../api"
import { response } from "../location"

export const ReferenceHandler = HttpApiBuilder.group(Api, "server.reference", (handlers) =>
  handlers.handle("reference.list", () => response(PluginSupervisor.Service.use((plugins) => plugins.settled).pipe(Effect.andThen(Reference.Service.use((reference) => reference.list()))))),
)
