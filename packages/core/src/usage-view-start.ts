export * as UsageViewStart from "./usage-view-start"

import { Context, Effect, Layer } from "effect"
import { Catalog } from "./catalog"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { CatalogContributions } from "./plugin/catalog-contributions"
import { UsageViews } from "./usage-view"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const views = yield* UsageViews.Service
    const locations = yield* LocationServiceMap.Service
    const identity = (ref: { readonly directory: string; readonly workspaceID?: string | undefined }) =>
      JSON.stringify([ref.directory, ref.workspaceID ?? null])
    yield* views.start(
      (ref) => Effect.map(locations.contextEffect(ref, CatalogContributions.nodes), (context) => Context.get(context, Catalog.Service)),
      (location) =>
        Effect.map(locations.loaded(), (loaded) => loaded.some((entry) => identity(entry.ref) === identity(location))),
    )
  }),
)

export const node = makeGlobalNode({
  name: "usage-view-start",
  layer,
  deps: [UsageViews.node, LocationServiceMap.node],
})
