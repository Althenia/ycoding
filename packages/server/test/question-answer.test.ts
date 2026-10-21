import { expect, test } from "bun:test"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { QuestionHandler } from "../src/handlers/question"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { SessionLocationMiddleware } from "../src/middleware/session-location"

test("question validation returns a corrective client error and preserves Session ownership", async () => {
  const request: Question.Request = {
    id: Question.ID.make("que_owned"), sessionID: Session.ID.make("ses_owner"),
    questions: [{ header: "Choice", question: "Select a value", options: [{ label: "One", description: "An offered value" }] }],
  }
  const calls: Question.ReplyInput[] = []
  const location = Context.makeUnsafe<LocationServices>(Context.make(Question.Service, Question.Service.of({
    ask: () => Effect.die("unused"),
    list: () => Effect.succeed([request]),
    reply: (input) => Effect.gen(function* () {
      calls.push(input)
      if (input.answers[0]?.[0] !== "One")
        yield* new Question.InvalidAnswerError({ requestID: request.id, message: "Select an offered answer" })
    }),
    reject: () => Effect.die("unused"),
    deferPending: () => Effect.die("unused"),
    cancelPending: () => Effect.die("unused"),
  })).mapUnsafe)
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.question"])).pipe(
    Layer.provide(QuestionHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, location)),
      Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, location)),
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
  ))
  const reply = (sessionID: string, answer: string) => handler.handler(new Request(
    `http://localhost/api/session/${sessionID}/question/${request.id}/reply`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [[answer]] }) },
  ))
  try {
    const invalid = await reply(request.sessionID, "Not offered")
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ _tag: "InvalidRequestError", field: "answers", message: "Select an offered answer" })
    expect((await reply("ses_other", "One")).status).toBe(404)
    expect((await reply(request.sessionID, "One")).status).toBe(204)
    expect(calls).toEqual([
      { requestID: request.id, answers: [["Not offered"]] },
      { requestID: request.id, answers: [["One"]] },
    ])
  } finally {
    await handler.dispose()
  }
})
