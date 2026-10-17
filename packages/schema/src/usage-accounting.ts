export * as UsageAccounting from "./usage-accounting.js"

import { Schema } from "effect"
import { Money } from "./money.js"
import { ProviderRequest } from "./provider-request.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { ID } from "./session-message-id.js"
import { TokenUsage } from "./token-usage.js"
import { UsageAnchor } from "./usage-anchor.js"

export const Cost = Schema.Struct({
  total: Money.USD.pipe(optional),
  known: Money.USD.pipe(optional),
  pricedRequests: NonNegativeInt,
  unpricedRequests: NonNegativeInt,
  provenance: ProviderRequest.CostProvenance.pipe(optional),
})
  .check(
    Schema.makeFilter(
      (value) =>
        (value.known === undefined) === (value.provenance === undefined) &&
        (value.known === undefined) === (value.pricedRequests === 0) &&
        (value.total === undefined || (value.unpricedRequests === 0 && value.total === value.known)),
      {
        expected: "known price coverage and a total only for completely priced requests",
        meta: { _tag: "isMaxProperties", maxProperties: 5 },
        arbitrary: { constraint: { maxLength: 5 } },
      },
    ),
  )
  .annotate({ identifier: "UsageAccounting.Cost" })
export interface Cost extends Schema.Schema.Type<typeof Cost> {}

export const Breakdown = Schema.Struct({
  requests: NonNegativeInt,
  tokens: TokenUsage.Info,
  cost: Cost,
}).annotate({ identifier: "UsageAccounting.Breakdown" })
export interface Breakdown extends Schema.Schema.Type<typeof Breakdown> {}

export const Helper = Schema.Struct({ source: ProviderRequest.Source, ...Breakdown.fields }).annotate({
  identifier: "UsageAccounting.Helper",
})
export interface Helper extends Schema.Schema.Type<typeof Helper> {}

export const Attribution = Schema.Literals(["complete", "partial", "unattributed"])
export type Attribution = typeof Attribution.Type
export const History = Schema.Literals(["retained", "partial"])
export type History = typeof History.Type
export const Status = Schema.Literals(["settled", "so-far"])
export type Status = typeof Status.Type

const unique = Schema.makeFilter<ReadonlyArray<string>>((value) => new Set(value).size === value.length, {
  expected: "distinct identities",
  meta: { _tag: "isMaxLength", maxLength: 100 },
  arbitrary: { constraint: { maxLength: 100 } },
})

export const PromptInput = Schema.Struct({
  inputIDs: Schema.NonEmptyArray(ID).check(Schema.isMaxLength(100), unique),
}).annotate({ identifier: "UsageAccounting.PromptInput" })
export interface PromptInput extends Schema.Schema.Type<typeof PromptInput> {}

export const TaskInput = Schema.Struct({
  sessionIDs: Schema.NonEmptyArray(SessionID).check(Schema.isMaxLength(100), unique),
}).annotate({ identifier: "UsageAccounting.TaskInput" })
export interface TaskInput extends Schema.Schema.Type<typeof TaskInput> {}

export const PromptCost = Schema.Struct({
  anchor: UsageAnchor.Ref,
  status: Status,
  attribution: Attribution,
  history: History,
  total: Breakdown,
  main: Breakdown,
  children: Breakdown,
  helpers: Schema.Array(Helper),
}).annotate({ identifier: "UsageAccounting.PromptCost" })
export interface PromptCost extends Schema.Schema.Type<typeof PromptCost> {}

export const PromptCosts = Schema.Struct({
  units: Schema.Array(PromptCost),
  unattributed: Breakdown,
  history: History,
}).annotate({ identifier: "UsageAccounting.PromptCosts" })
export interface PromptCosts extends Schema.Schema.Type<typeof PromptCosts> {}

export const TaskCost = Schema.Struct({
  sessionID: SessionID,
  usageAnchor: UsageAnchor.Ref.pipe(optional),
  status: Status,
  attribution: Attribution,
  history: History,
  total: Breakdown,
  main: Breakdown,
  children: Breakdown,
  helpers: Schema.Array(Helper),
}).annotate({ identifier: "UsageAccounting.TaskCost" })
export interface TaskCost extends Schema.Schema.Type<typeof TaskCost> {}

export const TaskCosts = Schema.Struct({ tasks: Schema.Array(TaskCost), total: Breakdown, history: History }).annotate({
  identifier: "UsageAccounting.TaskCosts",
})
export interface TaskCosts extends Schema.Schema.Type<typeof TaskCosts> {}
