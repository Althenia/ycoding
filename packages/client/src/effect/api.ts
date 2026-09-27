import type { ModelApi, ProviderApi } from "./api/api.js"

export type * from "./api/api.js"

export interface CatalogApi<E = never> {
  readonly provider: Pick<ProviderApi<E>, "list" | "get">
  readonly model: ModelApi<E>
}
