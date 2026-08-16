export * as PluginAdapter from "./plugin"

import path from "path"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Schema } from "effect"
import type { Adapter } from "./index"

const decode = Schema.decodeUnknownSync(ProjectArtifact.PluginDefinition)

export const adapter: Adapter<ProjectArtifact.PluginDefinition> = {
  kind: "plugin",
  phase: "unsupported",
  decode,
  render: (input) => input.draft,
  parse: (content) => decode({ kind: "plugin", name: "Plugin draft", description: "Quarantined plugin draft", draft: content }),
  projectPath: (root, id) => path.join(root, "disabled", "plugins", id, `${id}.ts`),
  globalPath: (global, id) => path.join(global.config, "plugins", `${id}.ts`),
  activate: () => {
    throw new Error("Plugin Project Artifacts are unsupported in Phase 1")
  },
}
