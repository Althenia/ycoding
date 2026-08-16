import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProcessIdentity } from "../process-identity"

export const HealthHandler = HttpApiBuilder.group(Api, "server.health", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* ProcessIdentity
    return handlers
      .handle("health.get", () =>
        Effect.succeed({
          healthy: true as const,
          version: InstallationVersion,
          pid: process.pid,
          sourceEpoch: identity.sourceEpoch,
        }),
      )
      .handle("health.stop", () => Effect.succeed({ accepted: false }))
  }),
)
