export * as ModelIncident from "./model-incident.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { Provider } from "./provider.js"
import { NonNegativeInt, optional, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("inc_")).pipe(
  Schema.brand("ModelIncident.ID"),
  Schema.annotate({ identifier: "ModelIncident.ID" }),
  statics((schema) => ({
    create: () => schema.make("inc_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const Kind = Schema.Literals(["fallback", "guardrail-escalated", "guardrail-rejected"]).annotate({
  identifier: "ModelIncident.Kind",
})
export type Kind = typeof Kind.Type

export const DecidedBy = Schema.Literals(["decision-model", "human"]).annotate({ identifier: "ModelIncident.DecidedBy" })
export type DecidedBy = typeof DecidedBy.Type

export const Group = Schema.Literals(["model", "agent"]).annotate({ identifier: "ModelIncident.Group" })
export type Group = typeof Group.Type

export interface ReportRow extends Schema.Schema.Type<typeof ReportRow> {}
export const ReportRow = Schema.Struct({
  providerID: Provider.ID,
  modelID: Model.ID,
  agent: Agent.ID.pipe(optional),
  fallbacks: NonNegativeInt,
  escalated: NonNegativeInt,
  rejected: NonNegativeInt,
  last: NonNegativeInt,
}).annotate({ identifier: "ModelIncident.ReportRow" })

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  rows: Schema.Array(ReportRow),
  groups: NonNegativeInt,
}).annotate({ identifier: "ModelIncident.Report" })

export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  id: ID,
  time: NonNegativeInt,
  kind: Kind,
  category: Schema.String,
  ruleIDs: Schema.Array(Schema.String),
  agent: Agent.ID,
  variant: Model.VariantID.pipe(optional),
  profile: Model.ProfileName.pipe(optional),
  target: Model.Ref.pipe(optional),
  decidedBy: DecidedBy.pipe(optional),
}).annotate({ identifier: "ModelIncident.Item" })

export interface Recent extends Schema.Schema.Type<typeof Recent> {}
export const Recent = Schema.Struct({
  items: Schema.Array(Item),
}).annotate({ identifier: "ModelIncident.Recent" })

export interface Guidance extends Schema.Schema.Type<typeof Guidance> {}
export const Guidance = Schema.Struct({
  text: Schema.String.pipe(optional),
  clearedAt: NonNegativeInt.pipe(optional),
  enabled: Schema.Boolean,
}).annotate({ identifier: "ModelIncident.Guidance" })
