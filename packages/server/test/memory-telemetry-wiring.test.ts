import { expect, spyOn } from "bun:test"
import { Clock, Effect, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Logging } from "@ycoding-ai/core/observability/logging"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.effect(
  "application memory telemetry uses its logger once per tick and stops when its scope closes",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir("ycoding-memory-wiring-")),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const records: unknown[] = []
      const sink = spyOn(Logging, "loggers").mockReturnValue([
        Effect.succeed(
          Logger.make(({ message }) => {
            if (Array.isArray(message) && message[0] === "runtime memory telemetry") records.push(message[1])
          }),
        ),
      ])
      const level = spyOn(Logging, "minimumLogLevel").mockReturnValue("Debug")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          sink.mockRestore()
          level.mockRestore()
        }),
      )
      const clock = yield* Clock.Clock
      const handler = HttpRouter.toWebHandler(
        createRoutes({
          database: { path: ":memory:" },
          config: { directory: directory.path, project: false },
          models: { fetch: false },
          fs: { filewatcher: false, fff: false },
        }).pipe(Layer.provide(HttpServer.layerServices), Layer.provide(Layer.succeed(Clock.Clock, clock))),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
      const response = yield* Effect.promise(() => handler.handler(new Request("http://localhost/api/health")))
      expect(response.status).toBe(200)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        component: "memory",
        timestampMs: 0,
        rssBytes: expect.any(Number),
        loadedLocations: 0,
        boundLocations: 0,
        standaloneLocations: 0,
        fullLocations: 0,
        builtServicesTotal: 0,
      })
      yield* TestClock.adjust("60 seconds")
      expect(records).toHaveLength(2)
      yield* Effect.promise(() => handler.dispose())
      yield* TestClock.adjust("120 seconds")
      expect(records).toHaveLength(2)
    }),
  60_000,
)
