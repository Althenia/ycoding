import { AutonomyDefaults } from "@ycoding-ai/core/autonomy-defaults"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const AutonomyDefaultsHandler = HttpApiBuilder.group(Api, "server.autonomyDefaults", (handlers) =>
  Effect.gen(function* () {
    const defaults = yield* AutonomyDefaults.Service
    return handlers
      .handle("autonomyDefaults.get", () => defaults.get.pipe(Effect.map((data) => ({ data }))))
      .handle("autonomyDefaults.set", (ctx) =>
        defaults.set(ctx.payload).pipe(
          Effect.map((data) => ({ data })),
          Effect.catchTag("AutonomyDefaults.Refused", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message, ...(error.reason === "risk-not-accepted" ? { field: "acceptYolo" } : {}) })),
          ),
          Effect.catchTag("AutonomyDefaults.WriteFailed", (error) => Effect.fail(new InvalidRequestError({ message: error.message }))),
        ),
      )
  }),
)
