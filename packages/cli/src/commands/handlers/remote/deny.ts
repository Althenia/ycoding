import { isSessionID } from "@ycoding-ai/remote"
import { Effect } from "effect"
import { RemoteConfig } from "../../../remote-config"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.deny,
  Effect.fn("cli.remote.deny")(function* (input) {
    const sessionID = input.sessionID.trim()
    if (!isSessionID(sessionID))
      return yield* Effect.fail(new Error(`That is not a YCoding session ID: ${sessionID}`))
    const removed = yield* RemoteConfig.deny(sessionID)
    if (!removed) return yield* Effect.fail(new Error(`${sessionID} is not shared`))
    line(`Stopped sharing ${sessionID}.`)
    line("A running `ycoding remote connect` drops it from the relay within a moment.")
  }),
)
