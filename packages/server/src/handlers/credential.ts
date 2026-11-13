import { Integration } from "@ycoding-ai/core/integration"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  handlers
    .handle(
      "credential.update",
      Effect.fn(function* (ctx) {
        const integration = yield* Integration.Service
        yield* integration.connection.update(ctx.params.credentialID, { label: ctx.payload.label })
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "credential.activate",
      Effect.fn(function* (ctx) {
        const integration = yield* Integration.Service
        yield* integration.connection.activate(ctx.params.credentialID)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "credential.refresh",
      Effect.fn(function* (ctx) {
        const integration = yield* Integration.Service
        return yield* response(integration.connection.refresh(ctx.params.credentialID))
      }),
    )
    .handle(
      "credential.remove",
      Effect.fn(function* (ctx) {
        const integration = yield* Integration.Service
        yield* integration.connection.remove(ctx.params.credentialID)
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
