export * as ProviderUsageObservations from "./observations"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export class Service extends Context.Service<Service, Map<string, ProviderUsage.Snapshot>>()("@ycoding/ProviderUsageObservations") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => new Map<string, ProviderUsage.Snapshot>()),
  deps: [],
})
