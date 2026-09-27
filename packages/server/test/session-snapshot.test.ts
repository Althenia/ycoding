import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { EventV2 } from "@ycoding-ai/core/event"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Api } from "../src/api"
import { SessionHandler } from "../src/handlers/session"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { processIdentityLayer } from "../src/process-identity"

const sessionID = SessionV2.ID.make("ses_window_http")

function fixture(snapshot: SessionV2.Interface["snapshot"], attachmentRead?: SessionV2.Interface["attachmentRead"]) {
  const location = Context.empty() as Context.Context<LocationServices>
  const services = Layer.mergeAll(
    Layer.mock(SessionV2.Service, {
      snapshot,
      attachmentRead,
      daybreak: { set: () => Effect.die("unused") },
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
      revert: { stage: () => Effect.die("unused"), clear: () => Effect.die("unused"), commit: () => Effect.die("unused") },
    }),
    Layer.mock(SessionOrchestration.Service, {}),
    processIdentityLayer(ServiceStatus.Epoch.make("epoch_window_test")),
    Layer.succeed(SessionLocationMiddleware, effect => Effect.provide(effect, location)),
    Layer.succeed(LocationMiddleware, effect => Effect.provide(effect, location)),
    Layer.succeed(Authorization, effect => effect),
    Layer.succeed(SchemaErrorMiddleware, effect => effect),
  )
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.session"])).pipe(
    Layer.provide(SessionHandler.pipe(Layer.provide(services))),
    Layer.provide(HttpServer.layerServices),
  ))
  return {
    request: (query = "") => handler.handler(new Request(`http://localhost/api/session/${sessionID}/snapshot${query}`)),
    attachmentRequest: (digest: string) => handler.handler(new Request(`http://localhost/api/session/${sessionID}/attachment/${digest}`)),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("snapshot HTTP forwards bounded window input, preserves watermark, and maps invalid cursors", async () => {
  const received: unknown[] = []
  await using f = fixture((id, options) => {
    received.push([id, options])
    if (options?.before === "invalid") return Effect.fail(new SessionV2.InvalidCursorError())
    return Effect.succeed({
      session: SessionV2.Info.make({
        id: sessionID, projectID: ProjectV2.ID.global, title: "Window", cost: Schema.decodeUnknownSync(SessionV2.Info.fields.cost)(0),
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
      }),
      messages: [],
      watermark: { type: "log.synced" as const, aggregateID: id, seq: EventV2.Seq.make(7) },
      ...(options?.limit === undefined ? {} : { before: "opaque_cursor" }),
    })
  })
  const page = await f.request("?limit=20&before=opaque_previous")
  expect(page.status).toBe(200)
  expect(await page.json()).toMatchObject({ sourceEpoch: "epoch_window_test", messages: [], before: "opaque_cursor", watermark: { seq: 7 } })
  expect(received.at(-1)).toEqual([sessionID, { limit: 20, before: "opaque_previous" }])
  expect((await f.request("?limit=0")).status).toBe(400)
  expect((await f.request("?before=opaque_previous")).status).toBe(400)
  const malformed = await f.request("?limit=1&before=invalid")
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toMatchObject({ _tag: "InvalidCursorError" })
  const full = await f.request()
  expect(full.status).toBe(200)
  expect(await full.json()).not.toHaveProperty("before")
})

test("attachment HTTP reads only a scoped digest and maps missing or oversized content", async () => {
  const digest = "a".repeat(64)
  const received: unknown[] = []
  await using f = fixture(() => Effect.die("unused"), (id, value) => {
    received.push([id, value])
    if (value === "b".repeat(64)) return Effect.fail(new SessionV2.AttachmentReadError({ reason: "not-found" }))
    if (value === "c".repeat(64)) return Effect.fail(new SessionV2.AttachmentReadError({ reason: "too-large" }))
    return Effect.succeed({ mime: "image/png", bytes: 3, data: "YWJj" })
  })
  const image = await f.attachmentRequest(digest)
  expect(image.status).toBe(200)
  expect(await image.json()).toEqual({ mime: "image/png", bytes: 3, data: "YWJj" })
  expect(received.at(-1)).toEqual([sessionID, digest])
  expect((await f.attachmentRequest("not-a-digest")).status).toBe(400)
  expect((await f.attachmentRequest("b".repeat(64))).status).toBe(404)
  expect((await f.attachmentRequest("c".repeat(64))).status).toBe(413)
})
