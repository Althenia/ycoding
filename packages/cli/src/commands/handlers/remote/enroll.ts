import { enrollmentCodePattern } from "@ycoding-ai/remote"
import { Effect, Option } from "effect"
import { EOL, hostname } from "node:os"
import { Runtime } from "../../../framework/runtime"
import { RemoteConfig } from "../../../remote-config"
import { RemoteLocal } from "../../../remote-local"
import { RemotePrompt } from "../../../remote-prompt"
import { frontendClient } from "../../../services/client"
import { ServerConnection } from "../../../services/server-connection"
import { RemoteCommand } from "../../remote"

export default Runtime.handler(
  RemoteCommand.commands.enroll,
  Effect.fn("cli.remote.enroll")(function* (input) {
    const requested = (Option.getOrUndefined(input.relay) ?? process.env[RemoteConfig.envVar])?.trim()
    if (requested === undefined || requested === "")
      return yield* Effect.fail(new Error(`A relay origin is required; pass --relay or set ${RemoteConfig.envVar}`))
    const relayURL = yield* Effect.try(() => RemoteConfig.normalizeRelayURL(requested))

    const requestedServer = Option.getOrUndefined(input.server)
    if (requestedServer !== undefined)
      yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint({ url: requestedServer }))
    const server = yield* ServerConnection.resolve({ server: requestedServer, standalone: input.standalone })
    yield* Effect.try(() => RemoteLocal.assertPrivateEndpoint(server.endpoint))
    const client = yield* frontendClient(server.endpoint)
    const existing = yield* Effect.tryPromise((signal) => client.remote.get({ signal }))
    if (existing.device !== undefined && !input.replace)
      return yield* Effect.fail(
        new Error("This machine is already enrolled; revoke the old device first or re-run with --replace"),
      )

    const code = (yield* Effect.tryPromise(() => RemotePrompt.readHidden("Enrollment code: "))).trim()
    if (!enrollmentCodePattern.test(code))
      return yield* Effect.fail(new Error("That enrollment code is not in the expected format"))

    const name = Option.getOrUndefined(input.name)?.trim() || hostname()
    const device = yield* Effect.tryPromise((signal) =>
      client.remote.enroll({
        relayOrigin: relayURL,
        enrollmentID: input.enrollmentID.trim(),
        code,
        name,
        replace: input.replace,
      }, { signal }),
    )

    process.stdout.write(
      [
        "",
        `  Device      ${device.name} (${device.deviceID})`,
        `  Relay       ${device.relayOrigin}`,
        "",
        "  Run `ycoding remote connect` to serve this backend's Sessions to the device owner.",
        "",
      ].join(EOL) + EOL,
    )
    return undefined
  }),
)
