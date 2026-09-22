import { Effect, FileSystem, Option } from "effect"
import { EOL } from "node:os"
import { Global } from "@ycoding-ai/core/global"
import { RemoteAgent } from "../../../remote-bridge"
import { RemoteConfig } from "../../../remote-config"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, requireIdentity, resolveLocalServer } from "./shared"

export default Runtime.handler(
  RemoteCommand.commands.connect,
  Effect.fn("cli.remote.connect")(function* (input) {
    const identity = yield* requireIdentity()
    // Device credentials are bound to the enrolled origin; an override that
    // changes the origin is refused before any credential is sent.
    const relayURL = yield* Effect.try(() =>
      RemoteConfig.assertEnrolledRelay({
        requested: Option.getOrUndefined(input.relay) ?? process.env[RemoteConfig.envVar] ?? identity.relayURL,
        enrolled: identity.relayURL,
      }),
    )
    const endpoint = yield* resolveLocalServer({ server: Option.getOrUndefined(input.server), standalone: input.standalone })

    // Providers run outside this Effect, so bind the services the handler already
    // has before handing them to the bridge.
    const services = yield* Effect.context<FileSystem.FileSystem | Global.Service>()
    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Global.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services)))
    const bridge = new RemoteAgent({
      relayURL,
      local: endpoint,
      credentials: () =>
        run(
          Effect.gen(function* () {
            const current = yield* RemoteCredentials.read()
            if (current === undefined) return yield* Effect.fail(new Error("The device identity disappeared"))
            return yield* RemoteCredentials.credentials(current)
          }),
        ),
      onDiagnostic: (message) => process.stderr.write(`remote: ${message}${EOL}`),
      onTerminal: (message) => process.stderr.write(`remote: ${message}${EOL}`),
    })

    line(`Connecting ${identity.name} to ${relayURL}; all backend Sessions are available to its owner. Press Ctrl-C to stop.`)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.tryPromise(() => bridge.connect()),
          () => Effect.promise(() => bridge.close()),
        )
        while (bridge.currentState === "live") yield* Effect.sleep(1_000)
      }),
    )
    if (bridge.currentState === "terminal")
      return yield* Effect.fail(new Error(bridge.failure ?? "The relay rejected this device"))
    line("Disconnected.")
  }),
)
