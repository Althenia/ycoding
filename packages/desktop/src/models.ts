import path from "node:path"
import type { YCodingClient } from "@ycoding-ai/client"
import { DesktopError, utf8Length, type ModelOption, type ModelProfileOption, type ModelSelection, type ModelSource, type ModelStatus } from "./contract"
import { isRevision, session } from "./requests"

export type ModelLocation = NonNullable<NonNullable<Parameters<YCodingClient["model"]["list"]>[0]>["location"]>

const invalid = "This model is not in the current list. Refresh models and choose again."
const repository = "Choose a previously opened repository."
const keys = ["id", "providerID", "variant", "profile"]
const statuses: readonly ModelStatus[] = ["alpha", "beta", "deprecated", "active"]

export function own(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

export const text = (value: unknown): value is string => typeof value === "string"
export const bounded = (value: unknown): value is string => text(value) && utf8Length(value) <= 1024
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(bounded)
export const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const limitCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const status = (value: unknown): value is ModelStatus => statuses.some((item) => item === value)
const profileName = (value: unknown): value is string => text(value) && value.length > 0 && utf8Length(value) <= 256

function projectProfile(value: unknown): ModelProfileOption | undefined {
  const name = own(value, "name")
  const active = own(value, "active")
  const variants = own(value, "variants")
  if (!profileName(name) || typeof active !== "boolean" || (variants !== undefined && !ids(variants))) return undefined
  return { name, active, variants: [...(variants ?? [])] }
}

function projectModel(value: unknown): ModelOption | undefined {
  const id = own(value, "id")
  const providerID = own(value, "providerID")
  const name = own(value, "name")
  const enabled = own(value, "enabled")
  const state = own(value, "status")
  const limit = own(value, "limit")
  const context = own(limit, "context")
  const output = own(limit, "output")
  const variants = own(value, "variants")
  const profiles = own(value, "profiles")
  if (!bounded(id) || !bounded(providerID) || !bounded(name) || typeof enabled !== "boolean" || !status(state) || !limitCount(context) || !limitCount(output) ||
    !Array.isArray(variants) || (profiles !== undefined && !Array.isArray(profiles))) return undefined
  const variantIDs = variants.map((variant) => own(variant, "id"))
  const projected = (profiles ?? []).map(projectProfile)
  if (!ids(variantIDs) || projected.some((profile) => profile === undefined)) return undefined
  return { id, providerID, name, enabled, status: state, limit: { context, output }, variants: variantIDs, profiles: projected.filter((profile) => profile !== undefined) }
}

function reference(value: unknown): ModelSelection | undefined {
  const id = own(value, "id")
  const providerID = own(value, "providerID")
  const variant = own(value, "variant")
  const profile = own(value, "profile")
  if (!bounded(id) || !bounded(providerID) || (variant !== undefined && !bounded(variant)) || (profile !== undefined && !profileName(profile))) return undefined
  return { id, providerID, ...(variant === undefined ? {} : { variant }), ...(profile === undefined ? {} : { profile }) }
}

export function modelSource(value: unknown): ModelSource {
  if (typeof value === "string") return { sessionID: session(value) }
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== "directory")) throw new DesktopError(repository)
  if (!("directory" in value) || value.directory === "") return {}
  const directory = value.directory
  if (typeof directory !== "string" || utf8Length(directory) > 4096 || !path.isAbsolute(directory)) throw new DesktopError(repository)
  return { directory }
}

export function switchRequest(value: unknown) {
  if (typeof value !== "object" || value === null || Object.keys(value).sort().join() !== "model,revision,sessionID" ||
    !("sessionID" in value) || !("revision" in value) || !("model" in value)) throw new DesktopError(invalid)
  const revision = value.revision
  if (!isRevision(revision)) throw new DesktopError(invalid)
  return { sessionID: session(value.sessionID), revision, model: value.model }
}

export function sessionModelLocation(sessionID: string, value: unknown): ModelLocation {
  if (own(value, "id") !== sessionID) throw new DesktopError("The backend returned a different Session. Refresh and choose again.")
  const location = own(value, "location")
  const directory = own(location, "directory")
  const workspace = own(location, "workspaceID")
  if (!text(directory) || !path.isAbsolute(directory) || (workspace !== undefined && !text(workspace)))
    throw new DesktopError("The backend returned an invalid Session location. Refresh to retry.")
  return { directory, ...(workspace === undefined ? {} : { workspace }) }
}

export function openedModelLocation(directory: string, inventory: unknown): ModelLocation {
  if (!Array.isArray(inventory)) throw new DesktopError("The backend returned an invalid repository list. Refresh to retry.")
  if (!inventory.some((entry) => own(entry, "available") === true && own(entry, "directory") === directory))
    throw new DesktopError("Choose an available, previously opened repository for the new chat.")
  return { directory }
}

export function sameModelLocation(value: unknown, expected: ModelLocation) {
  const location = own(value, "location")
  return own(location, "directory") === expected.directory && own(location, "workspaceID") === expected.workspace
}

export function currentModel(value: unknown): ModelSelection | null {
  const model = own(value, "model")
  if (model === undefined) return null
  const current = reference(model)
  if (!current) throw new DesktopError("The backend returned an invalid Session model. Refresh to retry.")
  return current
}

export function running(value: unknown, sessionID: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DesktopError("The backend returned an invalid Session state. Refresh to retry.")
  const entry = own(value, sessionID)
  if (entry === undefined) return false
  if (own(entry, "type") !== "running") throw new DesktopError("The backend returned an invalid Session state. Refresh to retry.")
  return true
}

export function projectModels(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) throw new DesktopError("The backend returned an invalid model list. Refresh to retry.")
  return value.flatMap((model) => projectModel(model) ?? [])
}

export function projectDefault(value: unknown): ModelSelection | null {
  if (value === null) return null
  const selection = reference(own(value, "selection"))
  if (!selection) throw new DesktopError("The backend returned an invalid default model. Refresh to retry.")
  return selection
}

export function modelSelection(value: unknown, catalog: readonly ModelOption[]): ModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new DesktopError(invalid)
  const id = "id" in value ? value.id : undefined
  const providerID = "providerID" in value ? value.providerID : undefined
  const variant = "variant" in value ? value.variant : undefined
  const profile = "profile" in value ? value.profile : undefined
  if (typeof id !== "string" || typeof providerID !== "string" || (variant !== undefined && typeof variant !== "string") || (profile !== undefined && typeof profile !== "string"))
    throw new DesktopError(invalid)
  const model = catalog.find((item) => item.id === id && item.providerID === providerID)
  if (!model || (profile === undefined && !model.enabled)) throw new DesktopError(invalid)
  const listed = profile === undefined ? model : model.profiles.find((item) => item.name === profile)
  if (!listed || (variant !== undefined && !listed.variants.includes(variant))) throw new DesktopError(invalid)
  return { id: model.id, providerID: model.providerID, ...(variant === undefined ? {} : { variant }), ...(profile === undefined ? {} : { profile }) }
}
