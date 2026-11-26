import { Effect, FileSystem, Option } from "effect"
import { FrontendPaths } from "../../../paths"
import { RemoteAgent } from "../../../remote-bridge"
import { RemoteConfig } from "../../../remote-config"
import { RemoteCredentials } from "../../../remote-credentials"
import { Runtime } from "../../../framework/runtime"
import { RemoteCommand } from "../../remote"
import { line, requireIdentity } from "./shared"
import { createRemoteConnector } from "./connector"
import { RemoteLocal } from "../../../remote-local"
import type { Endpoint } from "@ycoding-ai/client/effect/service"
import { frontendClient } from "../../../services/client"
import { ServerConnection } from "../../../services/server-connection"
import { RemoteSetupError, type RemoteDiagnostic } from "../../../remote-error"

export function privateLocalServer(endpoint: Endpoint) {
  RemoteLocal.assertPrivateEndpoint(endpoint)
  return RemoteLocal.createLocalServer(endpoint)
}

export const makeRemoteConnector = Effect.fn("cli.remote.connector")(function* (input: {
  endpoint: Endpoint
  onDiagnostic?: RemoteDiagnostic
}) {
  const identity = yield* requireIdentity()
  const relayURL = yield* Effect.try({
    try: () => RemoteConfig.assertEnrolledRelay({
      requested: RemoteConfig.normalizeRelayURL(process.env[RemoteConfig.envVar] ?? identity.relayURL),
      enrolled: RemoteConfig.normalizeRelayURL(identity.relayURL),
    }),
    catch: (error) => new RemoteSetupError(error instanceof Error ? error.message : "Invalid enrolled relay origin"),
  })
  const local = yield* Effect.try({
    try: () => privateLocalServer(input.endpoint),
    catch: (error) => new RemoteSetupError(error instanceof Error ? error.message : "Invalid local remote backend"),
  })
  const services = yield* Effect.context<FileSystem.FileSystem | FrontendPaths.Service>()
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | FrontendPaths.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(services)))
  const global = yield* FrontendPaths.Service
  const notice = `Connecting ${identity.name} to ${relayURL}; all backend Sessions are available to its owner.`
  return createRemoteConnector({
    directory: global.data,
    notice,
    onDiagnostic: input.onDiagnostic,
    makeBridge: (hooks) => new RemoteAgent({
      relayURL,
      local,
      credentials: (signal) => run(Effect.gen(function* () {
        const current = yield* RemoteCredentials.read()
        if (current === undefined) return yield* Effect.fail(new RemoteSetupError("The device identity disappeared; enroll this device again"))
        return yield* RemoteCredentials.credentials(current, { signal })
      })),
      onDiagnostic: hooks.onDiagnostic,
      onTerminal: hooks.onTerminal,
    }),
  })
})

export default Runtime.handler(
  RemoteCommand.commands.connect,
  Effect.fn("cli.remote.connect")(function* (input) {
    const requestedServer = Option.getOrUndefined(input.server)
    if (requestedServer !== undefined)
      yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint({ url: requestedServer }))
    const server = yield* ServerConnection.resolve({ server: requestedServer, standalone: input.standalone })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(server.endpoint))
    const client = yield* frontendClient(server.endpoint)
    const { device } = yield* Effect.tryPromise((signal) => client.remote.get({ signal }))
    if (device === undefined)
      return yield* Effect.fail(new RemoteSetupError("This backend is not enrolled; run `ycoding remote enroll <enrollmentID>` first"))
    const relay = yield* Effect.try(() => RemoteConfig.assertEnrolledRelay({
      requested: Option.getOrUndefined(input.relay) ?? process.env[RemoteConfig.envVar] ?? device.relayOrigin,
      enrolled: device.relayOrigin,
    }))
    line(`Connecting ${device.name} to ${relay}; all backend Sessions are available to its owner.`)
    let status = yield* Effect.tryPromise((signal) => client.remote.set({ enabled: true }, { signal }))
    while (status.state === "connecting") {
      yield* Effect.sleep("250 millis")
      status = yield* Effect.tryPromise((signal) => client.remote.get({ signal }))
    }
    if (status.state !== "on")
      return yield* Effect.fail(new Error(status.message ?? (status.state === "off" ? "Remote connection stayed off." : "Remote connection failed")))
    line("Remote connection on.")
    if (input.standalone) {
      line("Press Ctrl-C to stop the private server.")
      while (true) {
        yield* Effect.sleep("1 second")
        const status = yield* Effect.tryPromise((signal) => client.remote.get({ signal }))
        if (status.state === "error") yield* Effect.fail(new Error(status.message ?? "Remote connection failed"))
        if (status.state === "off") break
      }
    }
    return undefined
  }),
)
