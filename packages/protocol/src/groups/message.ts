import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionCapturedChanges } from "@ycoding-ai/schema/session-captured-changes"
import { NonNegativeInt, PositiveInt } from "@ycoding-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionNotFoundError, UnknownError } from "../errors.js"

export const CapturedInputsQuery = Schema.Struct({
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(200))), Schema.optional),
})

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      success: Schema.Struct({
        data: Schema.Array(SessionMessage.Info),
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "message.list",
        summary: "Get session messages",
        description: "Retrieve every current projected message for a session in canonical ascending order.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("session.capturedInputs", "/api/session/:sessionID/message/captured-inputs", {
      params: { sessionID: Session.ID },
      query: CapturedInputsQuery,
      success: SessionCapturedChanges.Page,
      error: [SessionNotFoundError, UnknownError],
    }).annotateMerge(OpenApi.annotations({
      identifier: "message.capturedInputs",
      summary: "Get captured change summary inputs",
      description: "Retrieve canonical prompt and dispatch boundaries, assistant placement IDs and recorded edit metadata without transcript text or tool output. Pages use an exclusive message sequence cursor; limit defaults to 200 and must be between 1 and 200. Recorded patch bytes are preserved for validation and grouping.",
    })),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "session",
      description: "Experimental message routes.",
    }),
  )
