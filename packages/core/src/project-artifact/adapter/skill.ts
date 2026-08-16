export * as SkillAdapter from "./skill"

import path from "path"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Schema } from "effect"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { ConfigMarkdown } from "../../config/markdown"
import type { Adapter } from "./index"

const decode = Schema.decodeUnknownSync(ProjectArtifact.SkillDefinition)

export const adapter: Adapter<ProjectArtifact.SkillDefinition> = {
  kind: "skill",
  phase: "enabled",
  decode,
  render: (input) =>
    `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n${input.content}`,
  parse: (content) => {
    const markdown = ConfigMarkdown.parse(content)
    return decode({
      kind: "skill",
      name: field(markdown.data, "name"),
      description: field(markdown.data, "description"),
      content: markdown.content,
    })
  },
  projectPath: (root, id) => path.join(root, "active", "skills", id, "SKILL.md"),
  globalPath: (global, id) => path.join(global.home, ".agents", "skills", id, "SKILL.md"),
  activate: (version, draft) => {
    draft.skill?.source(
      SkillV2.DirectorySource.make({
        type: "directory",
        path: AbsolutePath.make(path.dirname(path.dirname(version.contentPath))),
      }),
    )
  },
}

function field(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value) || typeof value[key as keyof typeof value] !== "string") {
    throw new Error(`Invalid skill ${key}`)
  }
  return value[key as keyof typeof value]
}
