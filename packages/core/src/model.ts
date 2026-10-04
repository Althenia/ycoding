import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "./provider"
import type { DeepMutable } from "./schema"

export const ID = Model.ID
export type ID = typeof ID.Type

export const VariantID = Model.VariantID
export type VariantID = typeof VariantID.Type

// Grouping of models, eg claude opus, claude sonnet
export const Family = Model.Family
export type Family = Model.Family

export const Capabilities = Model.Capabilities
export type Capabilities = Model.Capabilities

export const Cost = Model.Cost

export const Ref = Model.Ref
export type Ref = typeof Ref.Type

export const Info = Model.Info
export type Info = Model.Info

export type MutableInfo = DeepMutable<Info>

export function parse(input: string): { providerID: Provider.ID; modelID: ID } {
  const [providerID, ...modelID] = input.split("/")
  return {
    providerID: Provider.ID.make(providerID),
    modelID: ID.make(modelID.join("/")),
  }
}

export * as CatalogModel from "./model"
