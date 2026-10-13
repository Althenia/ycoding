import { enrollmentCodePattern } from "@ycoding-ai/remote"
import { Effect, Option } from "effect"
import { hostname } from "node:os"
import { Runtime } from "../../../framework/runtime"
import { RemotePrompt } from "../../../remote-prompt"
import { RemoteCommand } from "../../remote"
import { line, relayOrigin, remoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.enroll,
  Effect.fnUntraced(function* (input) {
    const requested = (Option.getOrUndefined(input.relay) ?? process.env.YCODING_REMOTE_URL)?.trim()
    if (!requested)
      return yield* Effect.fail(new Error("A relay origin is required; pass --relay or set YCODING_REMOTE_URL"))
    const origin = yield* Effect.try(() => relayOrigin(requested))
    const client = yield* remoteClient({})
    const status = yield* Effect.tryPromise(() => client.remote.get())
    if (status.device && !input.replace)
      return yield* Effect.fail(
        new Error("This machine is already enrolled; revoke the old device first or re-run with --replace"),
      )
    const code = (yield* Effect.tryPromise(() => RemotePrompt.readHidden("Enrollment code: "))).trim()
    if (!enrollmentCodePattern.test(code))
      return yield* Effect.fail(new Error("That enrollment code is not in the expected format"))
    const enrolled = yield* Effect.tryPromise(() =>
      client.remote.enroll({
        relayOrigin: origin,
        enrollmentID: input.enrollmentID.trim(),
        code,
        name: Option.getOrUndefined(input.name)?.trim() || hostname(),
        replace: input.replace,
      }),
    )
    line(`Device ${enrolled.name} (${enrolled.deviceID}) enrolled at ${enrolled.relayOrigin}.`)
    line("Run `ycoding remote connect` to serve every existing and future backend Session to the device owner.")
  }),
)
