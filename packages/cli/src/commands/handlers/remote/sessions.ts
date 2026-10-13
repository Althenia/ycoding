import { Effect, Option } from "effect"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, remoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.sessions,
  Effect.fnUntraced(function* (input) {
    const client = yield* remoteClient({ server: Option.getOrUndefined(input.server), standalone: input.standalone })
    let cursor: string | undefined
    while (true) {
      const sessions = yield* Effect.tryPromise(() => client.session.list({ limit: 100, cursor }))
      if (!cursor && sessions.data.length === 0) line("The backend has no Sessions.")
      for (const session of sessions.data) line(`${session.id}  ${session.title}  ${session.location.directory}`)
      if (!sessions.cursor.next) return
      cursor = sessions.cursor.next
    }
  }),
)
