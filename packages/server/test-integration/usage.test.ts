import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedRoutes } from "../src/routes"

const summaryResponse = Schema.Struct({
  data: Schema.Struct({
    logical: Schema.Number,
    physical: Schema.Number,
    cost: Schema.optional(Schema.Number),
    tokens: Schema.Struct({ input: Schema.Number, output: Schema.Number, reasoning: Schema.Number }),
    models: Schema.optional(
      Schema.Array(
        Schema.Struct({
          model: Schema.Struct({ id: Schema.String }),
          requests: Schema.Number,
          cost: Schema.optional(Schema.Number),
          costProvenance: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
})
const reportResponse = Schema.Struct({
  data: Schema.Struct({
    group: Schema.String,
    rowCount: Schema.Number,
    rows: Schema.Array(Schema.Struct({ cost: Schema.optional(Schema.Number) })),
    total: Schema.Struct({ logical: Schema.Number, cost: Schema.optional(Schema.Number) }),
  }),
})

test("serves retained global usage through the real Server and Core graph when historical pricing is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-usage-"))
  const firstDirectory = join(directory, "first")
  const historicalDirectory = join(directory, "historical")
  await Promise.all([mkdir(firstDirectory), mkdir(historicalDirectory), mkdir(join(directory, "config"))])

  const handler = HttpRouter.toWebHandler(
    createEmbeddedRoutes({
      database: { path: join(directory, "usage.db") },
      config: { directory: join(directory, "config"), project: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          const session = Context.get(context, SessionV2.Service)
          const events = Context.get(context, EventV2.Service)
          const first = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(firstDirectory) }),
          })
          const historical = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(historicalDirectory) }),
          })
          const fields = SessionEvent.ProviderRequestRecorded.fields.data.fields
          const record = Effect.fnUntraced(function* (input: {
            sessionID: SessionV2.ID
            id: string
            model: string
            request: number
            cost?: number
          }) {
            yield* events.publish(SessionEvent.ProviderRequestRecorded, {
              id: fields.id.make(`prq_${input.id}`),
              sessionID: input.sessionID,
              source: "step",
              agent: AgentV2.ID.make("build"),
              model: ModelV2.Ref.make({
                providerID: ProviderV2.ID.make("unavailable"),
                id: ModelV2.ID.make(input.model),
              }),
              routeID: `test-${input.id}`,
              promptCacheKey: "cache-key",
              systemDigest: "system",
              toolDigest: "tools",
              request: fields.request.make(input.request),
              attempts: 1,
              invalidation: "first-request",
              continuation: "full",
              ...(input.cost === undefined ? {} : { cost: fields.cost.from.make(input.cost) }),
              tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
              time: yield* DateTime.now,
            })
          })
          yield* record({ sessionID: first.id, id: "recorded", model: "recorded-model", request: 1, cost: 0.1 })
          yield* record({
            sessionID: historical.id,
            id: "historical-recorded",
            model: "recorded-model",
            request: 1,
            cost: 0.15,
          })
          yield* record({ sessionID: historical.id, id: "historical", model: "historical-model", request: 2 })
          yield* Effect.promise(() => rm(historicalDirectory, { recursive: true, force: true }))
        }),
      ),
    ),
  )

  try {
    const summary = await handler.handler(new Request("http://localhost/api/usage"))
    const report = await handler.handler(new Request("http://localhost/api/usage/report?group=session"))
    expect([summary.status, report.status]).toEqual([200, 200])
    const summaryBody = Schema.decodeUnknownSync(summaryResponse)(await summary.json())
    expect(summaryBody).toMatchObject({
      data: {
        logical: 3,
        physical: 3,
        tokens: { input: 30, output: 6, reasoning: 3 },
        models: [
          {
            model: { id: "recorded-model" },
            requests: 2,
            cost: 0.25,
            costProvenance: "recorded",
          },
          { model: { id: "historical-model" } },
        ],
      },
    })
    expect(summaryBody.data).not.toHaveProperty("cost")
    expect(summaryBody.data.models?.[1]).not.toHaveProperty("cost")

    const reportBody = Schema.decodeUnknownSync(reportResponse)(await report.json())
    expect(reportBody).toMatchObject({
      data: { group: "session", rowCount: 2, total: { logical: 3 } },
    })
    expect(reportBody.data.total).not.toHaveProperty("cost")
    expect(reportBody.data.rows.map((row) => row.cost)).toEqual(expect.arrayContaining([0.1, undefined]))
  } finally {
    await handler.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
