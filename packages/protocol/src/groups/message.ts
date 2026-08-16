import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionNotFoundError, UnknownError } from "../errors.js"

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
        identifier: "v2.message.list",
        summary: "Get session messages",
        description: "Retrieve every current projected message for a session in canonical ascending order.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "session",
      description: "Experimental message routes.",
    }),
  )
