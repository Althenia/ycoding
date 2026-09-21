import { isSessionID } from "@ycoding-ai/remote"
import { Effect, Option } from "effect"
import { RemoteConfig } from "../../../remote-config"
import { RemoteLocal } from "../../../remote-local"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, resolveLocalServer } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.allow,
  Effect.fn("cli.remote.allow")(function* (input) {
    const sessionID = input.sessionID.trim()
    if (!isSessionID(sessionID))
      return yield* Effect.fail(new Error(`That is not a YCoding session ID: ${sessionID}`))

    const local = yield* resolveLocalServer({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const directory = Option.getOrUndefined(input.directory)
    // Without a directory the session is located through the local server, so the
    // caller never has to know how YCoding stores sessions across projects.
    const found = yield* Effect.tryPromise(() =>
      directory === undefined
        ? RemoteLocal.findSession(local, sessionID)
        : local.getSession(sessionID, { directory }).then((info) => info),
    ).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (found === undefined)
      return yield* Effect.fail(
        new Error(`No local session ${sessionID} was found; pass --directory with the session's directory`),
      )

    yield* RemoteConfig.allow({
      sessionID,
      directory: found.location.directory,
      workspaceID: found.location.workspaceID,
      title: found.title,
    })
    line(`Shared ${sessionID} (${found.title}) from ${found.location.directory}.`)
    line("Run `ycoding remote connect` to serve it; an active connection picks it up within a moment.")
  }),
)
