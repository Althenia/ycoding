export * as ConfigDecisions from "./decisions"

import { Effect, Schema } from "effect"
import { ConfigModel } from "./model"
import { PositiveInt } from "../schema"

export const Provider = Schema.Literals(["openai", "typesafe"])
export const Probability = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))

export class Policy extends Schema.Class<Policy>("Config.Decisions.Policy")({
  provider: Provider,
  min_probability: Probability,
  min_confidence: Schema.Never.pipe(Schema.optional),
}) {}

export class AgentPolicy extends Schema.Class<AgentPolicy>("Config.Decisions.AgentPolicy")({
  provider: Schema.Literal("agent"),
  min_confidence: Probability,
  min_probability: Schema.Never.pipe(Schema.optional),
}) {}

const AllowBelow = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })).pipe(
  Schema.optional,
  Schema.withDecodingDefault(Effect.succeed(2)),
)

export class Guardrails extends Schema.Class<Guardrails>("Config.Decisions.Guardrails")({
  ...Policy.fields,
  allow_below: AllowBelow,
}) {}

export class AgentGuardrails extends Schema.Class<AgentGuardrails>("Config.Decisions.AgentGuardrails")({
  ...AgentPolicy.fields,
  allow_below: AllowBelow,
}) {}

export class Candidate extends Schema.Class<Candidate>("Config.Decisions.Candidate")({
  id: Schema.NonEmptyString.check(Schema.makeFilter((id) => id !== "keep-current", { expected: "a non-reserved decision route ID" })),
  description: Schema.NonEmptyString,
  agent: Schema.NonEmptyString.pipe(Schema.optional),
  model: ConfigModel.Selection.pipe(Schema.optional),
}) {}

const Candidates = Schema.Array(Candidate).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(254),
    Schema.makeFilter((candidates) => new Set(candidates.map((candidate) => candidate.id)).size === candidates.length, {
      expected: "unique decision route IDs",
    }),
  )

export class Routing extends Schema.Class<Routing>("Config.Decisions.Routing")({
  ...Policy.fields,
  candidates: Candidates,
}) {}

export class AgentRouting extends Schema.Class<AgentRouting>("Config.Decisions.AgentRouting")({
  ...AgentPolicy.fields,
  candidates: Candidates,
}) {}

const AdvisoryCandidates = Schema.Array(Schema.Struct({
  id: Candidate.fields.id,
  description: Candidate.fields.description,
  model: ConfigModel.Selection,
})).check(Schema.isMinLength(1), Schema.isMaxLength(254),
  Schema.makeFilter((candidates) => new Set(candidates.map((candidate) => candidate.id)).size === candidates.length))

const Directions = Schema.Array(Schema.Struct({
  id: Candidate.fields.id,
  description: Candidate.fields.description,
})).check(Schema.isMinLength(1), Schema.isMaxLength(254),
  Schema.makeFilter((directions) => new Set(directions.map((direction) => direction.id)).size === directions.length))

export class Advisory extends Schema.Class<Advisory>("Config.Decisions.Advisory")({
  ...Policy.fields,
  candidates: AdvisoryCandidates,
  directions: Directions,
}) {}

export class AgentAdvisory extends Schema.Class<AgentAdvisory>("Config.Decisions.AgentAdvisory")({
  ...AgentPolicy.fields,
  candidates: AdvisoryCandidates,
  directions: Directions,
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
  guardrails: Schema.Union([Guardrails, AgentGuardrails]).pipe(Schema.optional),
  routing: Schema.Union([Routing, AgentRouting]).pipe(Schema.optional),
  goal: Schema.Union([Policy, AgentPolicy]).pipe(Schema.optional),
  questions: Schema.Union([Policy, AgentPolicy]).pipe(Schema.optional),
  advisory: Schema.Union([Advisory, AgentAdvisory]).pipe(Schema.optional),
}) {}
