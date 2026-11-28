import { Effect, Option } from "effect"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, listBackendSessions, resolveRemoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.sessions,
  Effect.fn("cli.remote.sessions")(function* (input) {
    const { client } = yield* resolveRemoteClient({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const sessions = yield* Effect.tryPromise((signal) => listBackendSessions(client, signal))
    if (sessions.length === 0) {
      line("The backend has no Sessions.")
      return
    }
    for (const session of sessions)
      line(`${session.id}  ${session.title}  ${session.location.directory}`)
  }),
)
