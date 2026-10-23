export * as CoordinationAccess from "./coordination-access"

import type { Permission } from "@ycoding-ai/schema/permission"

export const tool = "project"

export function rules(scoped: boolean): Permission.Ruleset {
  return scoped ? [] : [{ action: tool, resource: "*", effect: "deny" }]
}
