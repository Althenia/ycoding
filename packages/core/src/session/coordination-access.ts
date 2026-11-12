export * as CoordinationAccess from "./coordination-access"

import type { Permission } from "@ycoding-ai/schema/permission"
import type { CoordinationService } from "../coordination/index"
import { SessionGuardrailStandard } from "./guardrail-standard"

export const tool = "project"

const editDeny: Permission.Rule = { action: "edit", resource: "*", effect: "deny" }

export function visibility(role: CoordinationService.Access["role"] | undefined, coordinating: boolean): Permission.Ruleset {
  return [
    ...(role === "master" || role === "supervisor" ? [] : [{ action: tool, resource: "*", effect: "deny" } as const]),
    ...(coordinating ? [editDeny] : []),
  ]
}

export function execution(coordinating: boolean, input: { readonly action: string; readonly resources: ReadonlyArray<string> }): Permission.Ruleset {
  if (!coordinating) return []
  return [
    editDeny,
    ...(input.action === "shell"
      ? input.resources
          .filter((resource) => !SessionGuardrailStandard.readOnlyShell(resource))
          .map((resource) => ({ action: "shell", resource, effect: "deny" }) as const)
      : []),
  ]
}
