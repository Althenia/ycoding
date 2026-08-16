export * as CommandAdapter from "./command"

import path from "path"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Schema } from "effect"
import { ConfigMarkdown } from "../../config/markdown"
import { AbsolutePath } from "../../schema"
import type { Adapter } from "./index"

const decode = Schema.decodeUnknownSync(ProjectArtifact.CommandDefinition)

export const adapter: Adapter<ProjectArtifact.CommandDefinition> = {
  kind: "command",
  phase: "enabled",
  decode,
  render: (input) =>
    `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\nsubtask: false\n---\n${input.template}`,
  parse: (content) => {
    const markdown = ConfigMarkdown.parse(content)
    return decode({
      kind: "command",
      name: requiredField(markdown.data, "name"),
      description: field(markdown.data, "description"),
      template: markdown.content,
      subtask: false,
    })
  },
  projectPath: (root, id) => path.join(root, "active", "commands", `${id}.md`),
  globalPath: (global, id) => path.join(global.config, "commands", `${id}.md`),
  activate: (version, draft) => {
    const definition = version.definition
    if (definition.kind !== "command") return
    draft.command?.update(version.id, (command) => {
      command.template = definition.template
      command.description = definition.description
      command.subtask = false
      command.locations = [AbsolutePath.make(version.contentPath)]
      delete command.agent
      delete command.model
    })
  },
}

function field(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value) || typeof value[key as keyof typeof value] !== "string") {
    return undefined
  }
  return value[key as keyof typeof value]
}

function requiredField(value: unknown, key: string) {
  const result = field(value, key)
  if (result === undefined) throw new Error(`Invalid command ${key}`)
  return result
}
