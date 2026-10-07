export * as ConfigDecisions from "./decisions"

import { Schema } from "effect"
import { ConfigModel } from "./model"
import { PositiveInt } from "../schema"

export const Provider = Schema.Literals(["openai", "typesafe"])
export const Probability = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))

export class Policy extends Schema.Class<Policy>("Config.Decisions.Policy")({
  provider: Provider,
  min_probability: Probability,
}) {}

export class Candidate extends Schema.Class<Candidate>("Config.Decisions.Candidate")({
  id: Schema.NonEmptyString.check(Schema.makeFilter((id) => id !== "keep-current", { expected: "a non-reserved decision route ID" })),
  description: Schema.NonEmptyString,
  agent: Schema.NonEmptyString.pipe(Schema.optional),
  model: ConfigModel.Selection.pipe(Schema.optional),
}) {}

export class Routing extends Schema.Class<Routing>("Config.Decisions.Routing")({
  ...Policy.fields,
  candidates: Schema.Array(Candidate).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(254),
    Schema.makeFilter((candidates) => new Set(candidates.map((candidate) => candidate.id)).size === candidates.length, {
      expected: "unique decision route IDs",
    }),
  ),
}) {}

const Connection = Schema.Struct({
  api_key: Schema.NonEmptyString.pipe(Schema.optional),
  base_url: Schema.String.check(Schema.isPattern(/^https?:\/\//)).pipe(Schema.optional),
})

export class Info extends Schema.Class<Info>("Config.Decisions")({
  timeout_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(60_000)).pipe(Schema.optional),
  providers: Schema.Struct({
    openai: Connection.pipe(Schema.optional),
    typesafe: Schema.Struct({ ...Connection.fields, model: Schema.NonEmptyString.pipe(Schema.optional) }).pipe(Schema.optional),
  }).pipe(Schema.optional),
  guardrails: Policy.pipe(Schema.optional),
  routing: Routing.pipe(Schema.optional),
  goal: Policy.pipe(Schema.optional),
}) {}
