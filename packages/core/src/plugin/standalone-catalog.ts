export * as StandaloneCatalog from "./standalone-catalog"

import { Context, type Effect } from "effect"
import type { Catalog } from "../catalog"
import type { StandaloneConfig } from "../config/standalone"
import type { CatalogModel } from "../model"

export class Service extends Context.Service<Service, {
  readonly refresh: () => Effect.Effect<number, StandaloneConfig.InvalidError>
  readonly model: {
    readonly get: (...args: Parameters<Catalog.Interface["model"]["get"]>) => Effect.Effect<CatalogModel.Info | undefined, StandaloneConfig.InvalidError>
  }
}>()("@ycoding/StandaloneCatalogContributions") {}
