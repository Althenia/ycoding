import { readModelRef, type ModelRefView } from "./projection"

export type CatalogTarget = { readonly sessionID: string } | { readonly workspaceID: string }

type PromptMentionInput = { readonly start: number; readonly end: number; readonly text: string }

type AgentOption = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly mode: "primary" | "subagent" | "all"
  readonly hidden: boolean
  readonly model?: ModelRefView
}

export type ModelOption = {
  readonly providerID: string
  readonly providerName?: string
  readonly id: string
  readonly name: string
  readonly variants: readonly string[]
}

type CommandOption = { readonly name: string; readonly description?: string }

type SkillOption = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly slash: boolean
}

type ResourceOption = { readonly name: string; readonly uri: string; readonly description?: string }

export type FileOption = { readonly path: string; readonly uri: string; readonly kind: "file" | "directory" }

export type FileAttachmentInput = {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly mention?: PromptMentionInput
}

export type AgentAttachmentInput = { readonly name: string; readonly mention?: PromptMentionInput }

export type CatalogView = {
  readonly status: "loading" | "ready" | "unsupported" | "error"
  readonly message?: string
  readonly agents: readonly AgentOption[]
  readonly models: readonly ModelOption[]
  readonly defaultModel?: ModelRefView
  readonly commands: readonly CommandOption[]
  readonly skills: readonly SkillOption[]
  readonly references: readonly ResourceOption[]
  readonly resources: readonly ResourceOption[]
}

export type FileFindResult =
  | { readonly status: "ok"; readonly files: readonly FileOption[] }
  | { readonly status: "unsupported" | "failed"; readonly message: string }

export function catalogKey(target: CatalogTarget): string {
  return "sessionID" in target ? `session:${target.sessionID}` : `workspace:${target.workspaceID}`
}

export function modelDisplayLabel(model: ModelRefView, models: readonly ModelOption[] = []): string {
  const name = models.find((option) => option.providerID === model.providerID && option.id === model.id)?.name
  return `${model.providerID}/${name ?? model.id.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}`
}

export function readCatalog(value: unknown): CatalogView | undefined {
  const catalog = record(value)
  if (!catalog) return undefined
  const agents = Array.isArray(catalog.agents) ? catalog.agents : undefined
  const models = Array.isArray(catalog.models) ? catalog.models : undefined
  const commands = Array.isArray(catalog.commands) ? catalog.commands : undefined
  const skills = Array.isArray(catalog.skills) ? catalog.skills : undefined
  const references = Array.isArray(catalog.references) ? catalog.references : undefined
  const resourceItems = Array.isArray(catalog.resources) ? catalog.resources : undefined
  if (!agents || !models || !commands || !skills || !references || !resourceItems) return undefined
  const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined
  const optional = (value: unknown) => text(value) === undefined ? {} : { description: text(value) }
  const resources = (items: readonly unknown[]) => items.flatMap((item) => {
    const entry = record(item)
    return entry && text(entry.name) && text(entry.uri) ? [{ name: text(entry.name)!, uri: text(entry.uri)!, ...optional(entry.description) }] : []
  })
  return {
    status: "ready",
    agents: agents.flatMap((item) => {
      const entry = record(item)
      if (!entry || !text(entry.id) || !text(entry.name) || (entry.mode !== "primary" && entry.mode !== "subagent" && entry.mode !== "all") || typeof entry.hidden !== "boolean") return []
      return [{ id: text(entry.id)!, name: text(entry.name)!, mode: entry.mode, hidden: entry.hidden,
        ...optional(entry.description), ...(readModelRef(entry.model) === undefined ? {} : { model: readModelRef(entry.model) }) }]
    }),
    models: models.flatMap((item) => {
      const entry = record(item)
      if (!entry || !text(entry.providerID) || !text(entry.id) || !text(entry.name) || !Array.isArray(entry.variants) || !entry.variants.every((variant) => typeof variant === "string")) return []
      return [{ providerID: text(entry.providerID)!, id: text(entry.id)!, name: text(entry.name)!, variants: entry.variants,
        ...(text(entry.providerName) === undefined ? {} : { providerName: text(entry.providerName) }) }]
    }),
    commands: commands.flatMap((item) => {
      const entry = record(item)
      return entry && text(entry.name) ? [{ name: text(entry.name)!, ...optional(entry.description) }] : []
    }),
    skills: skills.flatMap((item) => {
      const entry = record(item)
      return entry && text(entry.id) && text(entry.name) && typeof entry.slash === "boolean"
        ? [{ id: text(entry.id)!, name: text(entry.name)!, slash: entry.slash, ...optional(entry.description) }] : []
    }),
    references: resources(references),
    resources: resources(resourceItems),
    ...(readModelRef(catalog.defaultModel) === undefined ? {} : { defaultModel: readModelRef(catalog.defaultModel) }),
  }
}

export function readFileFind(value: unknown): readonly FileOption[] | undefined {
  const data = record(value)
  if (!data || !Array.isArray(data.files)) return undefined
  return data.files.flatMap((item: unknown) => {
    const entry = record(item)
    return entry && typeof entry.path === "string" && typeof entry.uri === "string" && (entry.kind === "file" || entry.kind === "directory")
      ? [{ path: entry.path, uri: entry.uri, kind: entry.kind }] : []
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}
