export * as ConfigCoordination from "./coordination"

import { Schema } from "effect"
import { Wildcard } from "../util/wildcard"

export const Category = Schema.Literals(["question", "permission", "review"])
export type Category = typeof Category.Type
const patterns = Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))).check(Schema.isMaxLength(32))

export class Info extends Schema.Class<Info>("Config.Coordination")({
  delegated_decisions: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional),
    categories: Schema.Array(Category).check(Schema.isMaxLength(3)).pipe(Schema.optional),
    actions: patterns.pipe(Schema.optional),
    resources: patterns.pipe(Schema.optional),
    expires_at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  }).pipe(Schema.optional),
}) {}

export type Policy = {
  readonly categories?: readonly Category[]
  readonly actions?: readonly string[]
  readonly resources?: readonly string[]
  readonly expiresAt?: number
}

export function resolve(info?: Info) {
  const policy = info?.delegated_decisions
  return {
    enabled: policy?.enabled ?? true,
    categories: policy?.categories ?? ["question", "permission", "review"] as const,
    ...(policy?.actions === undefined ? {} : { actions: policy.actions }),
    ...(policy?.resources === undefined ? {} : { resources: policy.resources }),
    ...(policy?.expires_at === undefined ? {} : { expiresAt: policy.expires_at }),
  }
}

export type Resolved = ReturnType<typeof resolve>

export function permits(global: Resolved, group: Policy | undefined, input: {
  readonly category: Category
  readonly action: string
  readonly resources: readonly string[]
  readonly now: number
}) {
  if (!global.enabled) return false
  return [global, group].every((policy) => policy === undefined || (
    (policy.expiresAt === undefined || policy.expiresAt > input.now) &&
    (policy.categories === undefined || policy.categories.includes(input.category)) &&
    (policy.actions === undefined || policy.actions.some((pattern) => Wildcard.match(input.action, pattern))) &&
    (policy.resources === undefined || input.resources.every((resource) => policy.resources!.some((pattern) => Wildcard.match(resource, pattern))))
  ))
}
