export type ArtifactScope = "project" | "global" | "trash"
export type ArtifactKind = "skill" | "command" | "agent" | "plugin"
export type ArtifactStage = "trial" | "active" | "degraded" | "disabled" | "quarantine"

export type ArtifactListItem = {
  scope: { type: "project" | "global" }
  kind: ArtifactKind
  id: string
  name: string
  description: string
  stage?: ArtifactStage
  revision?: number
}

export type ArtifactFilter = {
  scope: ArtifactScope
  kind: ArtifactKind | "all"
  stage: ArtifactStage | "all"
}

export function filterArtifacts<T extends ArtifactListItem>(items: ReadonlyArray<T>, filter: ArtifactFilter) {
  return items.filter((item) => {
    if (filter.scope !== "trash" && item.scope.type !== filter.scope) return false
    if (filter.kind !== "all" && item.kind !== filter.kind) return false
    if (filter.scope !== "trash" && filter.stage !== "all" && item.stage !== filter.stage) return false
    return true
  })
}

export function artifactCategory(item: Pick<ArtifactListItem, "kind">) {
  return artifactKindLabel(item.kind)
}

export function artifactKindLabel(kind: ArtifactKind) {
  return (
    {
      skill: "Skills",
      command: "Commands",
      agent: "Agents",
      plugin: "Unsupported (quarantine only)",
    } satisfies Record<ArtifactKind, string>
  )[kind]
}

export function artifactDescription(item: ArtifactListItem & { stage: ArtifactStage; revision: number }) {
  return `${item.scope.type === "project" ? "Project" : "Global"} · ${title(item.stage)} · r${item.revision} · ${item.description}`
}

export function artifactLoadStatus(stage: ArtifactStage | undefined) {
  if (!stage) return undefined
  return stage === "active" ? { loaded: true, label: "Loaded" } : { loaded: false, label: "Not loaded" }
}

export function artifactActions(input: {
  scope: ArtifactScope
  kind: ArtifactKind
  stage: ArtifactStage
  versions: number
  restorable?: boolean
  shadowable?: boolean
}) {
  if (input.scope === "trash") {
    return {
      restore: input.restorable ?? true,
      enable: false,
      disable: false,
      remove: false,
      revert: false,
      promote: false,
      fork: false,
      shadow: false,
    }
  }
  if (input.kind === "plugin") {
    return {
      restore: false,
      enable: false,
      disable: false,
      remove: false,
      revert: false,
      promote: false,
      fork: false,
      shadow: false,
    }
  }
  return {
    restore: false,
    enable: input.stage === "disabled",
    disable: input.stage !== "disabled",
    remove: true,
    revert: input.versions > 1,
    promote: input.scope === "project",
    fork: input.scope === "global",
    shadow: input.scope === "project" && input.shadowable === true,
  }
}

export function shadowEligible(input: {
  scope: ArtifactScope
  kind: ArtifactKind
  id: string
  diagnostics: ReadonlyArray<{ type: string; kind: ArtifactKind; id: string; [key: string]: unknown }>
}) {
  if (input.scope !== "project" || input.kind === "plugin") return false
  return input.diagnostics.some(
    (diagnostic) =>
      diagnostic.type === "project-over-global-shadow" && diagnostic.kind === input.kind && diagnostic.id === input.id,
  )
}

export function confirmationPreviewLines(preview: { expiresAt: number }) {
  return [`Expires: ${new Date(preview.expiresAt).toISOString()}`]
}

export function promotionPreviewLines(preview: {
  metrics: {
    confidence: {
      sampleCount: number
      lowerBound: number | string
      upperBound: number | string
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  risk: "declarative" | "executable"
  collision?: { message: string; [key: string]: unknown }
  expiresAt: number
  renderedContent: string
  [key: string]: unknown
}) {
  return [
    `Risk: ${title(preview.risk)}`,
    ...(preview.collision ? [`Collision: ${preview.collision.message}`] : ["Collision: None"]),
    `Samples: ${preview.metrics.confidence.sampleCount} · confidence ${confidence(preview.metrics.confidence.lowerBound)}–${confidence(preview.metrics.confidence.upperBound)}`,
    `Expires: ${new Date(preview.expiresAt).toISOString()}`,
    `Content:\n${preview.renderedContent}`,
  ]
}

export function definitionContent(definition: { kind: ArtifactKind; content?: string; template?: string; system?: string; draft?: string }) {
  if (definition.kind === "skill") return definition.content ?? ""
  if (definition.kind === "command") return definition.template ?? ""
  if (definition.kind === "agent") return definition.system ?? ""
  return definition.draft ?? ""
}

function title(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function confidence(value: number | string) {
  return typeof value === "number" ? value.toFixed(2) : value
}
