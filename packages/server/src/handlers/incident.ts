import { Config } from "@ycoding-ai/core/config"
import { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"
import { ModelIncident } from "@ycoding-ai/core/model-incident/index"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const IncidentHandler = HttpApiBuilder.group(Api, "server.incident", (handlers) =>
  Effect.gen(function* () {
    const incidents = yield* ModelIncident.Service
    return handlers
      .handle("incident.report", (ctx) =>
        incidents.report(ctx.query).pipe(Effect.mapError(invalid), Effect.map(envelope)),
      )
      .handle("incident.recent", (ctx) =>
        incidents.recent(ctx.query).pipe(Effect.mapError(invalid), Effect.map(envelope)),
      )
      .handle(
        "incident.guidance.get",
        Effect.fn(function* (ctx) {
          const allowed = yield* guidanceAllowed
          return envelope(yield* incidents.guidance({ provider: ctx.query.provider, model: ctx.query.model }, allowed))
        }),
      )
      .handle(
        "incident.guidance.clear",
        Effect.fn(function* (ctx) {
          const allowed = yield* guidanceAllowed
          const query = { provider: ctx.query.provider, model: ctx.query.model }
          yield* incidents.clear(query)
          return envelope(yield* incidents.guidance(query, allowed))
        }),
      )
  }),
)

const guidanceAllowed = Effect.gen(function* () {
  const config = yield* Config.Service
  return ConfigCapabilities.allows(
    Config.capabilities(yield* config.entries()).builtin_instructions,
    "model-guidance",
  )
})

const envelope = <A>(data: A) => ({ data })

const invalid = (error: ModelIncident.InvalidInputError) => new InvalidRequestError({ message: error.message })
