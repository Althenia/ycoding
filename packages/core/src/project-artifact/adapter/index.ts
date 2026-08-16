export * as ProjectArtifactAdapterRegistry from "./index"

import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { AgentV2 } from "../../agent"
import { CommandV2 } from "../../command"
import { Global } from "../../global"
import { SkillV2 } from "../../skill"
import { AgentAdapter } from "./agent"
import { CommandAdapter } from "./command"
import { PluginAdapter } from "./plugin"
import { SkillAdapter } from "./skill"

export interface GlobalPaths extends Pick<Global.Interface, "home" | "config"> {}

export interface VersionIndex {
  readonly scopeID: ProjectArtifact.ScopeID
  readonly versionID: ProjectArtifact.VersionID
  readonly id: ProjectArtifact.ID
  readonly contentPath: string
  readonly definition: ProjectArtifact.Definition
}

export interface RuntimeDraft {
  readonly skill?: SkillV2.Draft
  readonly command?: CommandV2.Draft
  readonly agent?: AgentV2.Draft
}

export interface Adapter<Definition extends ProjectArtifact.Definition = ProjectArtifact.Definition> {
  readonly kind: ProjectArtifact.Kind
  readonly phase: "enabled" | "quarantine-only" | "unsupported"
  readonly decode: (input: unknown) => Definition
  readonly render: (input: Definition, provenance: ProjectArtifact.Provenance) => string
  readonly parse: (content: string) => Definition
  readonly projectPath: (scopeRoot: string, id: string) => string
  readonly globalPath: (global: GlobalPaths, id: string) => string
  readonly activate: (version: VersionIndex, draft: RuntimeDraft) => void
}

const adapters = [SkillAdapter.adapter, CommandAdapter.adapter, AgentAdapter.adapter, PluginAdapter.adapter] as const
type AnyAdapter = (typeof adapters)[number]

export function list(): ReadonlyArray<AnyAdapter> {
  return adapters
}

export function get(kind: "skill"): Adapter<ProjectArtifact.SkillDefinition>
export function get(kind: "command"): Adapter<ProjectArtifact.CommandDefinition>
export function get(kind: "agent"): Adapter<ProjectArtifact.AgentDefinition>
export function get(kind: "plugin"): Adapter<ProjectArtifact.PluginDefinition>
export function get(kind: ProjectArtifact.Kind): AnyAdapter
export function get(kind: ProjectArtifact.Kind): AnyAdapter {
  if (kind === "skill") return SkillAdapter.adapter
  if (kind === "command") return CommandAdapter.adapter
  if (kind === "agent") return AgentAdapter.adapter
  return PluginAdapter.adapter
}

export function decode(kind: ProjectArtifact.Kind, input: unknown): ProjectArtifact.Definition {
  if (kind === "skill") return SkillAdapter.adapter.decode(input)
  if (kind === "command") return CommandAdapter.adapter.decode(input)
  if (kind === "agent") return AgentAdapter.adapter.decode(input)
  return PluginAdapter.adapter.decode(input)
}

export function render(input: ProjectArtifact.Definition, provenance: ProjectArtifact.Provenance) {
  if (input.kind === "skill") return SkillAdapter.adapter.render(input, provenance)
  if (input.kind === "command") return CommandAdapter.adapter.render(input, provenance)
  if (input.kind === "agent") return AgentAdapter.adapter.render(input, provenance)
  return PluginAdapter.adapter.render(input, provenance)
}

export function parse(kind: ProjectArtifact.Kind, content: string): ProjectArtifact.Definition {
  if (kind === "skill") return SkillAdapter.adapter.parse(content)
  if (kind === "command") return CommandAdapter.adapter.parse(content)
  if (kind === "agent") return AgentAdapter.adapter.parse(content)
  return PluginAdapter.adapter.parse(content)
}

export function globalPath(kind: ProjectArtifact.Kind, global: GlobalPaths, id: string) {
  if (kind === "skill") return SkillAdapter.adapter.globalPath(global, id)
  if (kind === "command") return CommandAdapter.adapter.globalPath(global, id)
  if (kind === "agent") return AgentAdapter.adapter.globalPath(global, id)
  return PluginAdapter.adapter.globalPath(global, id)
}

export interface CollisionInput {
  readonly kind: ProjectArtifact.Kind
  readonly id: string
  readonly existing: ReadonlyArray<{
    readonly scope: "project" | "global"
    readonly scopeID?: string
    readonly versionID: string
  }>
  readonly shadow?: { readonly scopeID: string; readonly versionID: string }
}

export function collision(input: CollisionInput) {
  if (input.existing.length === 0) return undefined
  const shadow = input.shadow
  const exact = shadow
    ? input.existing.find(
        (item) => item.scope === "global" && item.scopeID === shadow.scopeID && item.versionID === shadow.versionID,
      )
    : undefined
  if (exact && input.existing.length === 1) {
    return { type: "project-over-global-shadow" as const, kind: input.kind, id: input.id, allowed: true }
  }
  return {
    type: input.existing.some((item) => item.scope === "global") ? ("cross-scope" as const) : ("existing-source" as const),
    kind: input.kind,
    id: input.id,
    allowed: false,
  }
}
