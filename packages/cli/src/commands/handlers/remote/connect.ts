import { Effect, Option } from "effect"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, relayOrigin, remoteClient } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.connect,
  Effect.fnUntraced(function* (input) {
    const client = yield* remoteClient({ server: Option.getOrUndefined(input.server), standalone: input.standalone })
    const status = yield* Effect.tryPromise(() => client.remote.get())
    if (!status.device)
      return yield* Effect.fail(
        new Error("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first"),
      )
    const requested = Option.getOrUndefined(input.relay) ?? process.env.YCODING_REMOTE_URL
    if (requested && (yield* Effect.try(() => relayOrigin(requested))) !== status.device.relayOrigin)
      return yield* Effect.fail(
        new Error("This device is enrolled at another relay; enroll a device for the requested relay instead"),
      )
    line(
      `Connecting ${status.device.name} to ${status.device.relayOrigin}; all existing and future backend Sessions are available to its owner.`,
    )
    yield* Effect.tryPromise(() => client.remote.set({ enabled: true }))
    yield* Effect.gen(function* () {
      while (true) {
        const next = yield* Effect.tryPromise(() => client.remote.get())
        if (next.state === "error") return yield* Effect.fail(new Error(next.message ?? "Remote connection failed"))
        if (next.state === "on") return
        if (next.state === "off")
          return yield* Effect.fail(new Error("Remote connection was disabled before connecting"))
        yield* Effect.sleep("250 millis")
      }
    }).pipe(Effect.timeout("30 seconds"))
    line("Remote connection on.")
    if (!input.standalone) return
    line("Press Ctrl-C to stop the private server.")
    while (true) {
      yield* Effect.sleep("1 second")
      const next = yield* Effect.tryPromise(() => client.remote.get())
      if (next.state === "error") return yield* Effect.fail(new Error(next.message ?? "Remote connection failed"))
      if (next.state === "off") return
    }
  }),
)
