export * as ProjectArtifactLegacyCleanup from "./legacy-cleanup"

import fs from "fs/promises"
import type { Dirent } from "fs"
import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"

const Marker = Schema.Struct({
  generated: Schema.Literal(true),
  locationID: Schema.NonEmptyString,
  artifactID: Schema.NonEmptyString,
  versionID: Schema.NonEmptyString,
  versionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.optional),
})
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Marker))
const legacyName = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([a-f0-9]{12})$/

export interface Input {
  readonly root: string
  readonly cursor?: string
  readonly limit?: number
}

export interface Dependencies {
  readonly beforeRemove?: (directory: string) => Promise<void>
  readonly remove?: (directory: string) => Promise<void>
}

export interface Report {
  readonly status: "partial" | "complete" | "failed"
  readonly cursor?: string
  readonly scanned: number
  readonly removed: number
  readonly skipped: number
  readonly failed: number
  readonly errorCode?: "root-unavailable" | "entry-unavailable" | "remove-failed"
}

export interface Interface {
  readonly run: (input?: Pick<Input, "cursor" | "limit">) => Effect.Effect<Report>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProjectArtifactLegacyCleanup") {}

export function run(input: Input, dependencies: Dependencies = {}) {
  return Effect.promise(async () => {
    const limit = Math.min(Math.max(input.limit ?? 256, 1), 256)
    const rootPath = path.resolve(input.root)
    const root = await fs.lstat(rootPath).catch(() => undefined)
    if (!root || !root.isDirectory() || root.isSymbolicLink()) return empty("failed", "root-unavailable")
    const parent = await fs.lstat(path.dirname(rootPath)).catch(() => undefined)
    const real = await fs.realpath(rootPath).catch(() => undefined)
    if (!parent?.isDirectory() || parent.isSymbolicLink() || real !== rootPath) return empty("failed", "root-unavailable")
    const listed = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => undefined)
    if (!listed) return empty("failed", "entry-unavailable")
    const entries = listed
      .filter((entry) => input.cursor === undefined || entry.name > input.cursor)
      .toSorted((a, b) => a.name.localeCompare(b.name))
    const selected = entries.slice(0, limit)
    let cursor = input.cursor
    let scanned = 0
    let removed = 0
    let skipped = 0
    let failed = 0
    let errorCode: Report["errorCode"]
    for (const entry of selected) {
      const result = await inspect(rootPath, identity(root), identity(parent), entry, dependencies)
      scanned++
      if (result.outcome === "failed") {
        failed++
        errorCode = result.errorCode
        break
      }
      if (result.outcome === "removed") removed++
      if (result.outcome === "skipped") skipped++
      cursor = entry.name
    }
    const status: Report["status"] = failed > 0 || entries.length > scanned ? "partial" : "complete"
    return {
      status,
      ...(cursor === undefined ? {} : { cursor }),
      scanned,
      removed,
      skipped,
      failed,
      ...(errorCode === undefined ? {} : { errorCode }),
    }
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return Service.of({ run: (input = {}) => run({ root: path.join(global.config, "generated"), ...input }) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

interface Identity {
  readonly dev: number
  readonly ino: number
}

async function inspect(
  root: string,
  rootIdentity: Identity,
  parentIdentity: Identity,
  entry: Dirent<string>,
  dependencies: Dependencies,
) {
  const match = entry.name.match(legacyName)
  if (!entry.isDirectory() || entry.isSymbolicLink() || !match) return { outcome: "skipped" as const }
  const child = path.join(root, entry.name)
  const relative = path.relative(root, child)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { outcome: "skipped" as const }
  const childInfo = await fs.lstat(child).catch(() => undefined)
  if (!childInfo) return { outcome: "failed" as const, errorCode: "entry-unavailable" as const }
  if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) return { outcome: "skipped" as const }
  const markerPath = path.join(child, ".ycoding-generated.json")
  const markerInfo = await fs.lstat(markerPath).catch(() => undefined)
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) return { outcome: "skipped" as const }
  const content = await fs.readFile(markerPath, "utf8").catch(() => undefined)
  if (content === undefined) return { outcome: "failed" as const, errorCode: "entry-unavailable" as const }
  const parsed = Option.getOrUndefined(decodeMarker(content))
  if (!parsed || match[2] !== legacySuffix(parsed.locationID, parsed.artifactID)) {
    return { outcome: "skipped" as const }
  }
  await dependencies.beforeRemove?.(child)
  const currentRoot = await fs.lstat(root).catch(() => undefined)
  const currentParent = await fs.lstat(path.dirname(root)).catch(() => undefined)
  const currentChild = await fs.lstat(child).catch(() => undefined)
  const currentMarker = await fs.lstat(markerPath).catch(() => undefined)
  const currentContent = await fs.readFile(markerPath, "utf8").catch(() => undefined)
  if (
    !currentRoot?.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    !sameIdentity(rootIdentity, currentRoot) ||
    !currentParent?.isDirectory() ||
    currentParent.isSymbolicLink() ||
    !sameIdentity(parentIdentity, currentParent) ||
    !currentChild?.isDirectory() ||
    currentChild.isSymbolicLink() ||
    !sameIdentity(identity(childInfo), currentChild) ||
    !currentMarker?.isFile() ||
    currentMarker.isSymbolicLink() ||
    !sameIdentity(identity(markerInfo), currentMarker) ||
    currentContent !== content
  ) {
    return { outcome: "failed" as const, errorCode: "entry-unavailable" as const }
  }

  const quarantine = path.join(
    path.dirname(root),
    `.ycoding-cleanup-${path.basename(root)}-${entry.name}-${currentChild.dev}-${currentChild.ino}`,
  )
  if (await fs.lstat(quarantine).catch(() => undefined)) {
    return { outcome: "failed" as const, errorCode: "entry-unavailable" as const }
  }
  const moved = await fs.rename(child, quarantine).then(
    () => true,
    () => false,
  )
  if (!moved) return { outcome: "failed" as const, errorCode: "remove-failed" as const }
  const quarantined = await fs.lstat(quarantine).catch(() => undefined)
  const stableRoot = await fs.lstat(root).catch(() => undefined)
  const stableParent = await fs.lstat(path.dirname(root)).catch(() => undefined)
  if (
    !quarantined ||
    !sameIdentity(identity(childInfo), quarantined) ||
    !stableRoot ||
    !sameIdentity(rootIdentity, stableRoot) ||
    !stableParent ||
    !sameIdentity(parentIdentity, stableParent)
  ) {
    return { outcome: "failed" as const, errorCode: "entry-unavailable" as const }
  }
  const removed = await (dependencies.remove ? dependencies.remove(quarantine) : fs.rm(quarantine, { recursive: true })).then(
    () => true,
    () => false,
  )
  if (removed) return { outcome: "removed" as const }
  if (!(await fs.lstat(child).catch(() => undefined))) await fs.rename(quarantine, child).catch(() => undefined)
  return { outcome: "failed" as const, errorCode: "remove-failed" as const }
}

function identity(value: { readonly dev: number; readonly ino: number }): Identity {
  return { dev: value.dev, ino: value.ino }
}

function sameIdentity(expected: Identity, actual: { readonly dev: number; readonly ino: number }) {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

function legacySuffix(locationID: string, artifactID: string) {
  return new Bun.CryptoHasher("sha256").update(`${locationID}\0${artifactID}`).digest("hex").slice(0, 12)
}

function empty(status: Report["status"], errorCode: Report["errorCode"]): Report {
  return { status, scanned: 0, removed: 0, skipped: 0, failed: status === "failed" ? 1 : 0, errorCode }
}
