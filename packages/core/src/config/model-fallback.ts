export * as ConfigModelFallback from "./model-fallback"

import { Schema } from "effect"
import { ConfigModel } from "./model"

const Chain = Schema.Array(ConfigModel.Selection).check(
  Schema.isMaxLength(3),
  Schema.makeFilter((chain) => new Set(chain.map(identity)).size === chain.length, {
    expected: "distinct fallback models",
  }),
)

export const Info = Schema.Record(Schema.String, Chain).check(
  Schema.makeFilter((record) => Object.keys(record).every((key) => /^[^/#]+\/[^#]+$/.test(key)), {
    expected: "keys of the form provider/model",
  }),
  Schema.makeFilter(
    (record) =>
      Object.entries(record).every(([key, chain]) =>
        chain.every(
          (entry) =>
            entry.variant !== undefined || entry.profile !== undefined || `${entry.providerID}/${entry.model}` !== key,
        ),
      ),
    { expected: "fallback models that differ from the model they replace" },
  ),
)
export type Info = typeof Info.Type

function identity(entry: ConfigModel.Selection) {
  return [entry.profile ?? "", entry.providerID, entry.model, entry.variant ?? ""].join("#")
}
