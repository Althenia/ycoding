import { expect, test } from "bun:test"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { ProviderUsagePaceAlerts } from "@ycoding-ai/core/provider-usage/pace-alerts"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Integration } from "@ycoding-ai/schema/integration"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Deferred, Effect, Layer, Queue, Schema } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([ProviderUsagePaceAlerts.node, EventRuntime.node, Credential.node, Database.node])),
)
const now = 1_800_000_000_000
const resetAt = now + 1_800_000
const providerID = Provider.ID.make("anthropic")

const quota = (used: number, updatedAt: number) =>
  new ProviderUsage.Snapshot({
    providerID,
    label: "Claude",
    profile: "Private profile",
    status: "available",
    source: "response_headers",
    stability: "observed",
    updatedAt,
    windows: [
      new ProviderUsage.Window({
        id: "five-hour",
        label: "Session",
        unit: "percent",
        used,
        limit: 100,
        resetAt,
        periodSeconds: 3600,
      }),
    ],
  })

const observation = (used: number, updatedAt: number) => ({
  account: "synthetic-account",
  semantics: "fixed-reset" as const,
  now,
  snapshot: quota(used, updatedAt),
})

it.effect("two Locations sharing one process-global service publish each milestone once without a Location", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: Integration.ID.make(providerID),
      label: "Work",
      value: { type: "key", key: "fixture-private-key" },
    })
    const alerts = yield* ProviderUsagePaceAlerts.Service
    const events = yield* EventRuntime.Service
    const received = yield* Queue.unbounded<{ readonly location?: unknown; readonly type: string; readonly data: unknown }>()
    yield* events.listen((event) =>
      event.type === ProviderUsage.Event.QuotaPace.type ? Queue.offer(received, event).pipe(Effect.asVoid) : Effect.void,
    )
    let used = 40
    const create = () =>
      ProviderUsageRuntime.make({
        credentials,
        providers: { available: () => Effect.succeed([{ id: providerID }]) },
        adapters: { [providerID]: (input) => Effect.succeed(quota(used, input.updatedAt)) },
        now: () => now,
        alerts,
      })
    const left = create()
    const right = create()
    const read = (service: ProviderUsageRuntime.Interface, directory: string) =>
      service.get({ providerID, refresh: true }).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
        ),
      )
    yield* read(left, "/private/left-location")
    yield* read(right, "/private/right-location")
    used = 46
    yield* read(left, "/private/left-location")
    yield* read(right, "/private/right-location")
    used = 60
    yield* read(right, "/private/right-location")
    yield* read(left, "/private/left-location")
    const first = yield* Queue.take(received)
    const second = yield* Queue.take(received)
    expect([first, second].map((event) => (event.data as { milestone: string }).milestone)).toEqual([
      "cutting-it-close",
      "will-run-out",
    ])
    for (const event of [first, second]) {
      expect(event.location).toBeUndefined()
      expect(Object.keys(event.data as object).toSorted()).toEqual([
        "body",
        "milestone",
        "providerID",
        "resetAt",
        "title",
        "windowID",
      ])
      const encoded = JSON.stringify(event)
      for (const forbidden of ["/private", "Private profile", "fixture-private-key", "synthetic-account", "Work"])
        expect(encoded).not.toContain(forbidden)
    }
    expect(Schema.is(ProviderUsage.QuotaPaceAlert)(first.data)).toBe(true)
  }),
)

test("enqueueing never waits on a held publish, and queued edges publish in order after release", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const published = yield* Queue.unbounded<string>()
      const events = Layer.mock(EventRuntime.Service, {
        publish: ((_: unknown, data: { readonly milestone: string }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            yield* Queue.offer(published, data.milestone)
            return {}
          })) as unknown as EventRuntime.Interface["publish"],
      })
      const layer = AppNodeBuilder.build(LayerNode.group([ProviderUsagePaceAlerts.node]), [
        [EventRuntime.node, events],
      ])
      yield* Effect.gen(function* () {
        const service = yield* ProviderUsagePaceAlerts.Service
        yield* service.observe(observation(40, now))
        yield* service.observe(observation(46, now + 1))
        yield* Deferred.await(entered)
        yield* service.observe(observation(60, now + 2))
        for (let index = 0; index < 400; index++) yield* service.observe(observation(95, now + 3 + index))
        yield* Deferred.succeed(release, undefined)
        const order = [yield* Queue.take(published), yield* Queue.take(published), yield* Queue.take(published)]
        expect(order).toEqual(["cutting-it-close", "will-run-out", "almost-out"])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped),
  ))
