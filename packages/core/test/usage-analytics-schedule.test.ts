import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { RetentionSettings } from "../src/retention-settings"
import { UsageAnalytics } from "../src/usage-analytics"
import { testEffect } from "./lib/effect"

let sweeps = 0
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, UsageAnalytics.node]), [
    [
      RetentionSettings.node,
      Layer.succeed(RetentionSettings.Service, {
        read: () =>
          Effect.sync(() => {
            sweeps++
            return { recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays: 30 }
          }),
      }),
    ],
  ]),
)

it.effect("analytics cleanup runs at startup and every subsequent hour", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(0)
    expect(sweeps).toBe(1)
    for (const expected of [2, 3, 4]) {
      yield* TestClock.adjust("1 hour")
      expect(sweeps).toBe(expected)
    }
  }),
)
