export * as CoordinationAccess from "./coordination-access"

import type { Permission } from "@ycoding-ai/schema/permission"

export type Access = {
  readonly role: "coordinator" | "worker" | "observer"
  readonly allowedTools?: readonly string[]
}

const inspect = new Set(["read", "glob", "grep", "coordination", "task_complete", "execute"])
const coordinate = new Set([...inspect, "decision", "question", "todowrite", "goal", "subagent", "subagent_control"])

export function allowsTool(access: Access | undefined, name: string) {
  if (access === undefined) return true
  if (access.role === "coordinator") return coordinate.has(name)
  if (access.role === "observer") return inspect.has(name)
  if (name === "execute") return true
  return access.allowedTools?.includes(name) ?? false
}

export function rules(access: Access | undefined, tools: Iterable<string>): Permission.Ruleset {
  return Array.from(tools).filter((name) => !allowsTool(access, name))
    .map((action) => ({ action, resource: "*", effect: "deny" as const }))
}
