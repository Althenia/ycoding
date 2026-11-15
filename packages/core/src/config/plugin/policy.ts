export * as ConfigPolicyPlugin from "./policy"

import { define } from "../../plugin/catalog-host"
import { Event } from "@ycoding-ai/schema/config"
import { Effect, Stream } from "effect"
import { Config } from "../../config"
import { EventRuntime } from "../../event"
import { Wildcard } from "../../util/wildcard"
import { Catalog } from "../../catalog"

export const apply = (catalog: Catalog.Draft, entries: readonly Config.Entry[]) => {
  const policies = entries
    .filter((entry): entry is Config.Document => entry.type === "document")
    .toReversed()
    .flatMap((entry) => entry.info.experimental?.policies ?? [])
  for (const record of catalog.provider.list()) {
    const policy = policies.findLast((policy) => Wildcard.match(record.provider.id, policy.resource))
    if (policy?.effect === "deny") catalog.provider.remove(record.provider.id)
  }
}

export const Plugin = define({
  id: "ycoding.config.policy",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const events = yield* EventRuntime.Service
    const catalog = yield* Catalog.Service
    const loaded = { entries: yield* config.entries() }
    yield* catalog.transform((draft) => apply(draft, loaded.entries))
    yield* events.subscribe(Event.Updated).pipe(
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
          Effect.andThen(ctx.catalog.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
