import { Effect, FileSystem, Option } from "effect"
import { Global } from "@ycoding-ai/core/global"
import { RemoteAgent } from "../../../remote-bridge"
import { RemoteConfig } from "../../../remote-config"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, requireIdentity } from "./shared"
import { createRemoteConnector } from "./connector"
import { RemoteLocal } from "../../../remote-local"
import type { Endpoint } from "@ycoding-ai/client/effect/service"
import { Service } from "@ycoding-ai/client/effect/service"
import { YCoding } from "@ycoding-ai/client/promise"
import { ServerConnection } from "../../../services/server-connection"

export function privateLocalServer(endpoint: Endpoint) {
  RemoteLocal.assertPrivateEndpoint(endpoint)
  return RemoteLocal.createLocalServer(endpoint)
}

export const makeRemoteConnector = Effect.fn("cli.remote.connector")(function* (input: {
  endpoint: Endpoint
}) {
  const identity = yield* requireIdentity()
  const relayURL = yield* Effect.try(() => RemoteConfig.assertEnrolledRelay({
    requested: process.env[RemoteConfig.envVar] ?? identity.relayURL,
    enrolled: identity.relayURL,
  }))
  const local = yield* Effect.try(() => privateLocalServer(input.endpoint))
  const services = yield* Effect.context<FileSystem.FileSystem | Global.Service>()
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Global.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(services)))
  const global = yield* Global.Service
  const notice = `Connecting ${identity.name} to ${relayURL}; all backend Sessions are available to its owner.`
  return createRemoteConnector({
    directory: global.data,
    notice,
    makeBridge: (hooks) => new RemoteAgent({
      relayURL,
      local,
      credentials: () => run(Effect.gen(function* () {
        const current = yield* RemoteCredentials.read()
        if (current === undefined) return yield* Effect.fail(new Error("The device identity disappeared"))
        return yield* RemoteCredentials.credentials(current)
      })),
      onDiagnostic: hooks.onDiagnostic,
      onTerminal: hooks.onTerminal,
    }),
  })
})

export default Runtime.handler(
  RemoteCommand.commands.connect,
  Effect.fn("cli.remote.connect")(function* (input) {
    const identity = yield* requireIdentity()
    yield* Effect.try(() => RemoteConfig.assertEnrolledRelay({
      requested: Option.getOrUndefined(input.relay) ?? process.env[RemoteConfig.envVar] ?? identity.relayURL,
      enrolled: identity.relayURL,
    }))
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(server.endpoint))
    const client = YCoding.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    line(`Connecting ${identity.name} to ${identity.relayURL}; all backend Sessions are available to its owner.`)
    yield* Effect.tryPromise(() => client.remote.set({ enabled: true }))
    const awaitConnection = Effect.gen(function* () {
      while (true) {
        const status = yield* Effect.tryPromise(() => client.remote.get())
        if (status.state === "error") yield* Effect.fail(new Error(status.message ?? "Remote connection failed"))
        if (status.state === "on") break
        yield* Effect.sleep("250 millis")
      }
    })
    yield* awaitConnection
    line("Remote connection on.")
    if (!input.standalone) return
    line("Press Ctrl-C to stop the private server.")
    while (true) {
      yield* Effect.sleep("1 second")
      const status = yield* Effect.tryPromise(() => client.remote.get())
      if (status.state === "error") yield* Effect.fail(new Error(status.message ?? "Remote connection failed"))
      if (status.state === "off") break
    }
  }),
)
