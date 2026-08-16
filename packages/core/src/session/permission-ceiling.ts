export * as SessionPermissionCeiling from "./permission-ceiling"

import { Permission } from "@ycoding-ai/schema/permission"
import { Schema } from "effect"

const isRuleset = Schema.is(Permission.Ruleset)

export function denyOnly(...rulesets: ReadonlyArray<Permission.Ruleset | undefined>): Permission.Ruleset {
  const seen = new Set<string>()
  return rulesets.flatMap((rules) =>
    (rules ?? []).flatMap((rule) => {
      if (rule.effect !== "deny") return []
      const key = `${rule.action}\u0000${rule.resource}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{ action: rule.action, resource: rule.resource, effect: "deny" as const }]
    }),
  )
}

export function inherit(
  existing: Permission.Ruleset | undefined,
  caller: Permission.Ruleset | undefined,
): Permission.Ruleset {
  return denyOnly(existing, caller)
}

export function read(value: unknown): Permission.Ruleset {
  return isRuleset(value) ? denyOnly(value) : []
}
