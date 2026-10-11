import { expect, test } from "bun:test"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { MessageHandler } from "../src/handlers/message"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import type { LocationServices } from "../src/location"

const sessionID = Session.ID.make("ses_message_response")
const decode = Schema.decodeUnknownSync(SessionMessage.Info)
const encode = Schema.encodeSync(Schema.toCodecJson(Schema.Struct({ data: Schema.Array(SessionMessage.Info) })))
const messages = [
  decode({ id: "msg_response_user", type: "user", text: "Quotes \" \\ \n ไทย 🦉 \ud800", time: { created: 1 } }),
  decode({
    id: "msg_response_assistant", type: "assistant", agent: "god", model: { providerID: "test", id: "model" },
    metadata: { "2": "numeric key", nested: { valid: true, absent: null } },
    content: [
      { type: "reasoning", text: "思考", time: { created: 2, completed: 3 } },
      { type: "tool", id: "call_response", name: "read", state: {
        status: "completed", input: { path: "example.ts" }, structured: { number: 1.25 },
        content: [{ type: "text", text: "x".repeat(100_000) + "🦉" }], result: { absent: null },
      }, time: { created: 4, completed: 5 } },
      { type: "text", text: "Finished", phase: "final_answer" },
    ], time: { created: 2, completed: 6 },
  }),
  decode({ id: "msg_response_compaction", type: "compaction", reason: "manual", status: "completed", summary: "Checkpoint", recent: "Recent", time: { created: 7 } }),
]

function application(read: Session.Interface["messages"]) {
  const services = Layer.mergeAll(
    Layer.mock(Session.Service, {
      messages: read,
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
      daybreak: { set: () => Effect.die("unused") },
      revert: {
        stage: () => Effect.die("unused"),
        clear: () => Effect.die("unused"),
        commit: () => Effect.die("unused"),
      },
    }),
    Layer.succeed(Authorization, (effect) => effect),
    Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, Context.makeUnsafe<LocationServices>(new Map()))),
  )
  return HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.message"])).pipe(
    Layer.provide(MessageHandler.pipe(Layer.provide(services))),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  )
}

for (const data of [messages, []]) {
  test(`complete message response streams byte-identical JSON for ${data.length} messages`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(application((input) => {
          expect(input).toEqual({ sessionID, order: "asc" })
          return Effect.succeed(data)
        }))
        const response = yield* Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(`http://localhost/api/session/${sessionID}/message`))),
        )
        expect(response.status).toBe(200)
        expect(response.body._tag).toBe("Stream")
        if (response.body._tag !== "Stream") throw new Error("Message response must not flatten its JSON body")
        const chunks = yield* Stream.runCollect(response.body.stream)
        const actual = Buffer.concat(chunks)
        const expected = Buffer.from(JSON.stringify(encode({ data })))
        expect(actual.equals(expected)).toBe(true)
        expect(response.body.contentLength).toBe(expected.length)
        expect(response.body.contentType).toBe("application/json")
        expect(chunks).toHaveLength(data.length + 2)
      }).pipe(Effect.scoped),
    ),
  )
}

test("complete message response rejects a failed decode before publishing a successful body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(application(() => Effect.fail(new Session.MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make("msg_bad_response") }))))
      const response = yield* Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(`http://localhost/api/session/${sessionID}/message`))),
      )
      expect(response.status).toBe(500)
      expect(response.body._tag).toBe("Uint8Array")
      if (response.body._tag !== "Uint8Array") throw new Error("Decode errors must settle before body streaming")
      expect(JSON.parse(Buffer.from(response.body.body).toString())).toMatchObject({ _tag: "UnknownError" })
    }).pipe(Effect.scoped),
  ),
)

test("complete message response validates the last message before creating a streamed body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const invalid = { ...messages[0], metadata: { unencodable: undefined } }
      const context = yield* Layer.build(application(() => Effect.succeed([...messages, invalid])))
      const result = yield* Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(`http://localhost/api/session/${sessionID}/message`))),
        Effect.exit,
      )
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.scoped),
  ),
)
