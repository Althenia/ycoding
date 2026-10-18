import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
export { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"

const REASON_LIMIT = 1024

function truncateReason(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`
}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const reason = request.url.split("?")[0].startsWith("/api/remote/mcp/events/")
    ? "Invalid MCP Events request"
    : truncateReason(error.cause.message)
  return yield* Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: error.kind, reason }),
    Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
  )
}))
