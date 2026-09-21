import { Effect } from "effect"
import { RemoteConfig } from "../../../remote-config"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.sessions,
  Effect.fn("cli.remote.sessions")(function* () {
    const sessions = yield* RemoteConfig.sessions()
    if (sessions.length === 0) {
      line("No sessions are shared. Run `ycoding remote allow <sessionID>` to share one.")
      return
    }
    for (const session of sessions)
      line(`${session.sessionID}  ${session.title ?? "(untitled)"}  ${session.directory}`)
  }),
)
