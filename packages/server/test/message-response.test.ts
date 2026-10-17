import { expect, spyOn, test } from "bun:test"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Database } from "@ycoding-ai/core/database/database"
import { ProjectSchema } from "@ycoding-ai/core/project/schema"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { sql } from "drizzle-orm"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { MessageHandler } from "../src/handlers/message"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { summarizeCapturedChanges } from "../../client/src/file-change-summary"
import { SessionCapturedChanges } from "../../schema/src/session-captured-changes"
import type { LocationServices } from "../src/location"

const sessionID = Session.ID.make("ses_message_response")
const decode = Schema.decodeUnknownSync(SessionMessage.Info)
const encode = Schema.encodeSync(Schema.toCodecJson(Schema.Struct({ data: Schema.Array(SessionMessage.Info) })))
const decodeCaptured = Schema.decodeUnknownSync(SessionCapturedChanges.Page)
const messages = [
  decode({ id: "msg_response_user", type: "user", text: 'Quotes " \\ \n ไทย 🦉 \ud800', time: { created: 1 } }),
  decode({
    id: "msg_response_assistant",
    type: "assistant",
    agent: "god",
    model: { providerID: "test", id: "model" },
    metadata: { "2": "numeric key", nested: { valid: true, absent: null } },
    content: [
      { type: "reasoning", text: "思考", time: { created: 2, completed: 3 } },
      {
        type: "tool",
        id: "call_response",
        name: "read",
        state: {
          status: "completed",
          input: { path: "example.ts" },
          structured: { number: 1.25 },
          content: [{ type: "text", text: "x".repeat(100_000) + "🦉" }],
          result: { absent: null },
        },
        time: { created: 4, completed: 5 },
      },
      { type: "text", text: "Finished", phase: "final_answer" },
    ],
    time: { created: 2, completed: 6 },
  }),
  decode({
    id: "msg_response_compaction",
    type: "compaction",
    reason: "manual",
    status: "completed",
    summary: "Checkpoint",
    recent: "Recent",
    time: { created: 7 },
  }),
]

function application<E = never>(
  read: Session.Interface["messages"],
  database: Layer.Layer<Database.Service, E> = Database.layer({ path: ":memory:" }),
) {
  const services = Layer.mergeAll(
    Layer.mock(Session.Service, {
      messages: read,
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused"), effective: () => Effect.die("unused") },
      daybreak: { set: () => Effect.die("unused") },
      revert: {
        stage: () => Effect.die("unused"),
        clear: () => Effect.die("unused"),
        commit: () => Effect.die("unused"),
      },
    }),
    Layer.succeed(Authorization, (effect) => effect),
    schemaErrorLayer,
    Layer.succeed(SessionLocationMiddleware, (effect) =>
      Effect.provide(effect, Context.makeUnsafe<LocationServices>(new Map())),
    ),
  )
  return HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.message"])).pipe(
    Layer.provide(MessageHandler.pipe(Layer.provide(services))),
    HttpRouter.provideRequest(database),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  )
}

for (const data of [messages, []]) {
  test(`complete message response streams byte-identical JSON for ${data.length} messages`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          application((input) => {
            expect(input).toEqual({ sessionID, order: "asc", retained: true })
            return Effect.succeed(data)
          }),
        )
        const response = yield* Context.get(context, HttpRouter.HttpRouter)
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request(`http://localhost/api/session/${sessionID}/message`)),
            ),
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
    ))
}

test("complete message response rejects a failed decode before publishing a successful body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        application(() =>
          Effect.fail(
            new Session.MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make("msg_bad_response") }),
          ),
        ),
      )
      const response = yield* Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(`http://localhost/api/session/${sessionID}/message`)),
          ),
        )
      expect(response.status).toBe(500)
      expect(response.body._tag).toBe("Uint8Array")
      if (response.body._tag !== "Uint8Array") throw new Error("Decode errors must settle before body streaming")
      expect(JSON.parse(Buffer.from(response.body.body).toString())).toMatchObject({ _tag: "UnknownError" })
    }).pipe(Effect.scoped),
  ))

test("captured inputs page minimal canonical attribution records without loading transcript payloads", () => {
  let queries: ReadonlyArray<Parameters<Database.Interface["db"]["$client"]["unsafe"]>> = []
  const canonical: Parameters<typeof summarizeCapturedChanges>[0][number][] = []
  let observedDb: Database.Interface["db"] | undefined
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectSchema.ID.global, worktree: AbsolutePath.make("/message-test"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectSchema.ID.global,
          directory: "/message-test",
          title: "Message response fixture",
        })
        .run()
      const records = [
        { id: "msg_capture_user", type: "user", text: "private prompt" },
        {
          id: "msg_capture_step",
          type: "assistant",
          text: "private text",
          content: [
            { type: "text", text: "x".repeat(1_000_000) },
            { type: "reasoning", text: "private reasoning" },
            {
              type: "tool",
              name: "read",
              state: { status: "completed", content: [{ type: "text", text: "private output" }] },
            },
            {
              type: "tool",
              id: "call_edit",
              name: "edit",
              state: {
                status: "completed",
                content: [{ type: "text", text: "private output" }],
                input: { path: "private input" },
                structured: {
                  files: [
                    {
                      file: "a.ts",
                      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
                      secret: "private file metadata",
                    },
                  ],
                  secret: "private extra",
                },
              },
            },
            {
              type: "tool",
              id: "call_send",
              name: "subagent_control",
              state: {
                status: "completed",
                input: { questionID: "question_1", text: "private input" },
                structured: { action: "send", task: { sessionID: "ses_child", secret: "private task" } },
              },
            },
          ],
        },
        {
          id: "msg_capture_ignored",
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "private checkpoint",
        },
        { id: "msg_capture_reply", type: "assistant", content: [{ type: "text", text: "final placement" }] },
        {
          id: "msg_capture_boundary",
          type: "synthetic",
          text: "private synthetic",
          metadata: { kind: "answer", questionID: "question_1", secret: "private metadata" },
        },
      ]
      canonical.push(...records)
      for (const [seq, record] of records.entries())
        yield* db.run(
          sql`INSERT INTO session_message(id, session_id, seq, type, data, time_created, time_updated) VALUES (${record.id}, ${sessionID}, ${seq}, ${record.type}, ${JSON.stringify(record)}, ${seq}, ${seq})`,
        )
      const tracked = spyOn(db.$client, "unsafe")
      queries = tracked.mock.calls
      yield* Effect.addFinalizer(() => Effect.sync(() => tracked.mockRestore()))
      observedDb = db
      return { db }
    }),
  ).pipe(Layer.provide(Database.layer({ path: ":memory:" })))
  return Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        application(() => Effect.die("captured inputs must not read complete messages"), database),
      )
      const router = Context.get(context, HttpRouter.HttpRouter)
      const request = (query: string) =>
        router
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`http://localhost/api/session/${sessionID}/message/captured-inputs${query}`),
              ),
            ),
          )
      const first = yield* request("?limit=2")
      expect(first.status).toBe(200)
      const body = decodeCaptured(yield* Effect.promise(() => HttpServerResponse.toWeb(first).json()))
      expect(body).toEqual({
        data: [
          { id: SessionMessage.ID.make("msg_capture_user"), type: "user" },
          {
            id: SessionMessage.ID.make("msg_capture_step"),
            type: "assistant",
            content: [
              {
                type: "tool",
                id: "call_edit",
                name: "edit",
                state: {
                  status: "completed",
                  structured: { files: [{ file: "a.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" }] },
                },
              },
              {
                type: "tool",
                id: "call_send",
                name: "subagent_control",
                state: {
                  status: "completed",
                  input: { questionID: "question_1" },
                  structured: { action: "send", task: { sessionID: "ses_child" } },
                },
              },
            ],
          },
        ],
        next: 1,
      })
      expect(JSON.stringify(body).length).toBeLessThan(1000)
      const last = yield* request("?limit=2&after=1")
      expect(last.status).toBe(200)
      const lastBody = decodeCaptured(yield* Effect.promise(() => HttpServerResponse.toWeb(last).json()))
      expect(lastBody).toEqual({
        data: [
          { id: SessionMessage.ID.make("msg_capture_reply"), type: "assistant", content: [] },
          {
            id: SessionMessage.ID.make("msg_capture_boundary"),
            type: "synthetic",
            metadata: { kind: "answer", questionID: "question_1" },
          },
        ],
      })
      expect(summarizeCapturedChanges([...body.data, ...lastBody.data], new Map(), () => "unused")).toEqual(
        summarizeCapturedChanges(canonical, new Map(), () => "unused"),
      )
      const empty = yield* request("?after=4")
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(empty).json())).toEqual({ data: [] })
      for (const query of ["?limit=0", "?limit=201", "?limit=1.5", "?after=-1"])
        expect((yield* request(query)).status).toBe(400)
      const read = queries.find((query) => query[0].includes('from "session_message"'))
      expect(read).toBeDefined()
      const plan = yield* observedDb!.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${read![0]}`, read![1])
      expect(
        plan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("session_message_session_seq_idx")),
      ).toBe(true)
      expect(plan.some((row) => /SCAN session_message/.test(row.detail))).toBe(false)
      yield* observedDb!.run(sql`DELETE FROM session_message WHERE seq > 1`)
      const pruned = yield* request("?after=1")
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(pruned).json())).toEqual({ data: [] })
      yield* observedDb!.run(
        sql`INSERT INTO session_message(id, session_id, seq, type, data, time_created, time_updated) VALUES ('msg_bad_captured', ${sessionID}, 5, 'assistant', ${JSON.stringify({ content: [{ type: "tool", name: "edit", state: { status: 42 } }] })}, 5, 5)`,
      )
      const invalid = yield* request("?after=1")
      expect(invalid.status).toBe(500)
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(invalid).json())).toMatchObject({
        _tag: "UnknownError",
      })
    }).pipe(Effect.scoped),
  )
})

test("complete message response validates the last message before creating a streamed body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const invalid = { ...messages[0], metadata: { unencodable: undefined } }
      const context = yield* Layer.build(application(() => Effect.succeed([...messages, invalid])))
      const result = yield* Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(`http://localhost/api/session/${sessionID}/message`)),
          ),
          Effect.exit,
        )
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.scoped),
  ))
