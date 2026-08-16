import type { CatalogApi } from "@ycoding-ai/client/effect/api"
import type { Model } from "@ycoding-ai/schema/model"
import type { Provider } from "@ycoding-ai/schema/provider"
import type { Effect } from "effect"
import type { Mutable } from "./mutable.js"
import type { Transform } from "./registration.js"

type Overlay = {
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

type ModelVariant = Omit<Mutable<Model.Variant>, keyof Overlay> & Overlay
type ModelInfo = Omit<Mutable<Model.Info>, keyof Overlay | "variants"> & Overlay & { variants: ModelVariant[] }
type ProviderInfo = Omit<Mutable<Provider.Info>, keyof Overlay> & Overlay

export interface CatalogProviderRecord {
  readonly provider: ProviderInfo
  readonly models: ReadonlyMap<string, ModelInfo>
}

export interface CatalogDraft {
  readonly provider: {
    list(): readonly CatalogProviderRecord[]
    get(providerID: string): CatalogProviderRecord | undefined
    update(providerID: string, update: (provider: ProviderInfo) => void): void
    remove(providerID: string): void
  }
  readonly model: {
    get(providerID: string, modelID: string): ModelInfo | undefined
    update(providerID: string, modelID: string, update: (model: ModelInfo) => void): void
    remove(providerID: string, modelID: string): void
    readonly default: {
      get(): { providerID: string; modelID: string } | undefined
      set(providerID: string, modelID: string): void
    }
  }
}

export interface CatalogDomain extends CatalogApi<unknown> {
  readonly model: CatalogApi<unknown>["model"] & {
    readonly get: (providerID: string, modelID: string) => Effect.Effect<ModelGetOutput | undefined>
  }
  readonly transform: Transform<CatalogDraft>
  readonly reload: () => Effect.Effect<void>
}

type ModelGetOutput = Effect.Success<ReturnType<CatalogApi<unknown>["model"]["list"]>>["data"][number]
