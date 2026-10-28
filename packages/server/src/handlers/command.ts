import { Command } from "@ycoding-ai/core/command"
import { LocationAnnouncements } from "@ycoding-ai/core/location-announcements"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Api } from "../api"
import { response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () => response(LocationAnnouncements.read("command").pipe(Effect.andThen(PluginSupervisor.Service.use((plugins) => plugins.settled)), Effect.andThen(Command.Service.use((command) => command.list()))))),
)
