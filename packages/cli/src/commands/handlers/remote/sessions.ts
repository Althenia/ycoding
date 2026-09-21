import { Effect, Option } from "effect"
import { RemoteLocal } from "../../../remote-local"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, resolveLocalServer } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.sessions,
  Effect.fn("cli.remote.sessions")(function* (input) {
    const local = yield* resolveLocalServer({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const sessions = yield* Effect.tryPromise(() => RemoteLocal.listSessions(local))
    if (sessions.length === 0) {
      line("The backend has no Sessions.")
      return
    }
    for (const session of sessions)
      line(`${session.id}  ${session.title}  ${session.location.directory}`)
  }),
)
