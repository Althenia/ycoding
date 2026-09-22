import { enrollmentCodePattern } from "@ycoding-ai/remote"
import { Effect, Option } from "effect"
import { EOL, hostname } from "node:os"
import { Runtime } from "../../../framework/runtime"
import { RemoteConfig } from "../../../remote-config"
import { RemoteCredentials } from "../../../remote-credentials"
import { RemotePrompt } from "../../../remote-prompt"
import { RemoteCommand } from "../../remote"

export default Runtime.handler(
  RemoteCommand.commands.enroll,
  Effect.fn("cli.remote.enroll")(function* (input) {
    const requested = (Option.getOrUndefined(input.relay) ?? process.env[RemoteConfig.envVar])?.trim()
    if (requested === undefined || requested === "")
      return yield* Effect.fail(new Error(`A relay origin is required; pass --relay or set ${RemoteConfig.envVar}`))
    const relayURL = yield* Effect.try(() => RemoteConfig.normalizeRelayURL(requested))

    const existing = yield* RemoteCredentials.read()
    if (existing !== undefined && !input.replace)
      return yield* Effect.fail(
        new Error("This machine is already enrolled; revoke the old device first or re-run with --replace"),
      )

    // The enrollment code is a one-use secret: it is read from the terminal, not argv.
    const code = (yield* Effect.tryPromise(() => RemotePrompt.readHidden("Enrollment code: "))).trim()
    if (!enrollmentCodePattern.test(code))
      return yield* Effect.fail(new Error("That enrollment code is not in the expected format"))

    const name = Option.getOrUndefined(input.name)?.trim() || hostname()
    const key = yield* Effect.tryPromise(() => RemoteCredentials.generateDeviceKey())
    const enrolled = yield* Effect.tryPromise(() =>
      RemoteCredentials.enroll({
        relayURL,
        enrollmentID: input.enrollmentID.trim(),
        code,
        name,
        privateKey: key.privateKey,
        publicKey: key.publicKey,
      }),
    )
    const identity = RemoteCredentials.Identity.make({
      deviceID: enrolled.deviceID,
      name,
      relayURL,
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      enrolledAt: Date.now(),
    })
    yield* existing === undefined ? RemoteCredentials.create(identity) : RemoteCredentials.update(identity)

    process.stdout.write(
      [
        "",
        `  Device      ${identity.name} (${identity.deviceID})`,
        `  Relay       ${identity.relayURL}`,
        `  Identity    ${yield* RemoteCredentials.file}`,
        "",
        "  Run `ycoding remote connect` to serve this backend's Sessions to the device owner.",
        "",
      ].join(EOL) + EOL,
    )
  }),
)
