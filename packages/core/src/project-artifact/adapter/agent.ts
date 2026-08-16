export * as AgentAdapter from "./agent"

import path from "path"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Permission } from "@ycoding-ai/schema/permission"
import { Schema } from "effect"
import { AgentV2 } from "../../agent"
import { ConfigMarkdown } from "../../config/markdown"
import { PermissionV2 } from "../../permission"
import { AbsolutePath } from "../../schema"
import type { Adapter } from "./index"

const decode = Schema.decodeUnknownSync(ProjectArtifact.AgentDefinition)

export const managedDefaults: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "write", resource: "*", effect: "ask" },
  { action: "patch", resource: "*", effect: "ask" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "deny" },
]

export const adapter: Adapter<ProjectArtifact.AgentDefinition> = {
  kind: "agent",
  phase: "enabled",
  decode,
  render: (input) =>
    `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\nmode: subagent\n${renderPermissions(input.permissions)}\n---\n${input.system}`,
  parse: (content) => {
    const markdown = ConfigMarkdown.parse(content)
    return decode({
      kind: "agent",
      name: requiredField(markdown.data, "name"),
      description: field(markdown.data, "description"),
      system: markdown.content,
      mode: "subagent",
      permissions: property(markdown.data, "permissions") ?? [],
    })
  },
  projectPath: (root, id) => path.join(root, "active", "agents", `${id}.md`),
  globalPath: (global, id) => path.join(global.config, "agents", `${id}.md`),
  activate: (version, draft) => {
    const definition = version.definition
    if (definition.kind !== "agent") return
    draft.agent?.update(AgentV2.ID.make(version.id), (agent) => {
      agent.name = AgentV2.Name.make(definition.name)
      agent.description = definition.description
      agent.system = definition.system
      agent.mode = "subagent"
      agent.hidden = false
      agent.model = undefined
      agent.request = { settings: {}, headers: {}, body: {} }
      agent.permissions = [...PermissionV2.merge(managedDefaults, definition.permissions)]
      agent.locations = [AbsolutePath.make(version.contentPath)]
    })
  },
}

function renderPermissions(rules: Permission.Ruleset) {
  if (rules.length === 0) return "permissions: []"
  return [
    "permissions:",
    ...rules.flatMap((rule) => [
      `  - action: ${JSON.stringify(rule.action)}`,
      `    resource: ${JSON.stringify(rule.resource)}`,
      `    effect: ${rule.effect}`,
    ]),
  ].join("\n")
}

function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined
  return value[key as keyof typeof value]
}

function field(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value) || typeof value[key as keyof typeof value] !== "string") {
    return undefined
  }
  return value[key as keyof typeof value]
}

function requiredField(value: unknown, key: string) {
  const result = field(value, key)
  if (result === undefined) throw new Error(`Invalid agent ${key}`)
  return result
}
