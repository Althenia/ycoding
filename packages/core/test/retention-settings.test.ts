import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { Config } from "../src/config"
import { ConfigAnalyticsRetention } from "../src/config/analytics-retention"
import { ConfigSessionRetention } from "../src/config/session-retention"
import { RetentionSettings } from "../src/retention-settings"
import { AbsolutePath } from "@ycoding-ai/schema/schema"

test("retention fields accept positive integers and reject zero, negative, fractional and nonnumeric values", () => {
  for (const [schema, key] of [
    [ConfigSessionRetention.Info, "records_days"],
    [ConfigAnalyticsRetention.Info, "usage_days"],
    [ConfigAnalyticsRetention.Info, "latency_days"],
    [ConfigAnalyticsRetention.Info, "incident_days"],
  ] as const) {
    const decode = Schema.decodeUnknownSync(schema)
    expect<unknown>(decode({ [key]: 1 })).toEqual({ [key]: 1 })
    for (const value of [0, -1, 0.5, "2", null, Infinity, NaN]) expect(() => decode({ [key]: value })).toThrow()
  }
  expect<unknown>(Schema.decodeUnknownSync(ConfigSessionRetention.Info)({ days: 3, records_days: 2 })).toEqual({
    days: 3,
    records_days: 2,
  })
})

for (const configured of [false, true])
  test(`global retention ${configured ? "combines configured sources per key" : "defaults ignore project overrides"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-retention-settings-"))
    const global = join(directory, "global")
    const project = join(directory, "project")
    await Promise.all([mkdir(global), mkdir(project)])
    await writeFile(
      join(project, "ycoding.json"),
      JSON.stringify({
        session_retention: { records_days: 1 },
        analytics_retention: { usage_days: 1, latency_days: 1, incident_days: 1 },
      }),
    )
    if (configured)
      await writeFile(
        join(global, "ycoding.json"),
        JSON.stringify({
          session_retention: { days: 11, records_days: 2 },
          analytics_retention: { usage_days: 4, latency_days: 5, incident_days: 6 },
        }),
      )
    const file = join(directory, "explicit.json")
    if (configured) await writeFile(file, JSON.stringify({ analytics_retention: { usage_days: 9 } }))
    try {
      const settings = configured
        ? RetentionSettings.configured({
            file,
            content: JSON.stringify({
              session_retention: { records_days: 3 },
              analytics_retention: { latency_days: 8, incident_days: 12 },
            }),
          })
        : RetentionSettings.node
      const values = await Effect.runPromise(
        Effect.gen(function* () {
          const settings = yield* RetentionSettings.Service
          const config = yield* Config.Service
          expect(Config.latest(yield* config.entries(), "analytics_retention")?.usage_days).toBe(1)
          return yield* settings.read()
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([RetentionSettings.node, Config.node]), [
              [RetentionSettings.node, settings],
              [Global.node, Global.layerWith({ config: global, data: join(directory, "data"), home: directory })],
              [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))],
            ]),
          ),
          Effect.scoped,
        ),
      )
      expect(values).toEqual(
        configured
          ? { recordsDays: 3, usageDays: 9, latencyDays: 8, incidentDays: 12 }
          : { recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays: 30 },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
