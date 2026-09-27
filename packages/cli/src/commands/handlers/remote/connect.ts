import { Effect, FileSystem, Option } from "effect"
import { EOL } from "node:os"
import { Global } from "@ycoding-ai/core/global"
import { RemoteAgent } from "../../../remote-bridge"
import { RemoteConfig } from "../../../remote-config"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, requireIdentity, resolveLocalServer } from "./shared"
import { createRemoteConnector } from "./connector"
import { RemoteLocal } from "../../../remote-local"
import type { Endpoint } from "@ycoding-ai/client/effect/service"

export function privateLocalServer(endpoint: Endpoint) {
  RemoteLocal.assertPrivateEndpoint(endpoint)
  return RemoteLocal.createLocalServer(endpoint)
}

export const makeRemoteConnector = Effect.fn("cli.remote.connector")(function* (input: {
  relay?: string
  server?: string
  standalone?: boolean
  endpoint?: Endpoint
  onDiagnostic?: (message: string) => void
  onTerminal?: (message: string) => void
}) {
  const identity = yield* requireIdentity()
  const relayURL = yield* Effect.try(() => RemoteConfig.assertEnrolledRelay({
    requested: input.relay ?? process.env[RemoteConfig.envVar] ?? identity.relayURL,
    enrolled: identity.relayURL,
  }))
  const endpoint = input.endpoint
  const local = endpoint
    ? yield* Effect.try(() => privateLocalServer(endpoint))
    : yield* resolveLocalServer({ server: input.server, standalone: input.standalone })
  const services = yield* Effect.context<FileSystem.FileSystem | Global.Service>()
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Global.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(services)))
  const global = yield* Global.Service
  const notice = `Connecting ${identity.name} to ${relayURL}; all backend Sessions are available to its owner.`
  return createRemoteConnector({
    directory: global.data,
    notice,
    onDiagnostic: input.onDiagnostic,
    makeBridge: (hooks) => new RemoteAgent({
      relayURL,
      local,
      credentials: () => run(Effect.gen(function* () {
        const current = yield* RemoteCredentials.read()
        if (current === undefined) return yield* Effect.fail(new Error("The device identity disappeared"))
        return yield* RemoteCredentials.credentials(current)
      })),
      onDiagnostic: hooks.onDiagnostic,
      onTerminal: (message) => { hooks.onTerminal(message); input.onTerminal?.(message) },
    }),
  })
})

export default Runtime.handler(
  RemoteCommand.commands.connect,
  Effect.fn("cli.remote.connect")(function* (input) {
    const connector = yield* makeRemoteConnector({
      relay: Option.getOrUndefined(input.relay),
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      onDiagnostic: (message) => process.stderr.write(`remote: ${message}${EOL}`),
      onTerminal: (message) => process.stderr.write(`remote: ${message}${EOL}`),
    })
    line(`${connector.notice} Press Ctrl-C to stop.`)
    const result = yield* Effect.scoped(Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.promise(() => connector.start()), () => Effect.promise(() => connector.stop()))
      while (["connecting", "on"].includes(connector.status().state)) yield* Effect.sleep(1_000)
      return connector.status()
    }))
    if (result.state === "error") return yield* Effect.fail(new Error(result.message ?? "The relay rejected this device"))
    if (result.state === "other-process") return yield* Effect.fail(new Error(result.message))
    return line("Disconnected.")
  }),
)
