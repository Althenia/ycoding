export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Stream, Types } from "effect"
import { FileSystem } from "@ycoding-ai/schema/filesystem"
import { Skill } from "@ycoding-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { EventV2 } from "./event"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info
export const ID = Skill.ID
export type ID = Skill.ID
export const Name = Skill.Name
export type Name = Skill.Name
export const Conflicts = Skill.Conflicts
export type Conflicts = Skill.Conflicts

export const Event = Skill.Event

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.id, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
  metadata: Schema.Unknown.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)
const decodeConflicts = Schema.decodeUnknownOption(Skill.Conflicts)

const metadataBoolean = (metadata: unknown, key: string) => {
  if (metadata === undefined || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined
  }
  const value = (metadata as { readonly [key: string]: unknown })[key]
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return undefined
}

const metadataConflicts = (metadata: unknown): Skill.Conflicts | undefined | false => {
  if (metadata === undefined || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined
  }
  const value = (metadata as { readonly [key: string]: unknown })["ycoding/conflicts"]
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const declarations = value as { readonly [key: string]: unknown }
  const normalize = (items: unknown) => {
    if (items === undefined) return [] as string[]
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || item.trim() === "")) return undefined
    return Array.from(new Set(items.map((item) => item.trim())))
  }
  const skills = normalize(declarations.skills)
  const instructions = normalize(declarations.instructions)
  if (!skills || !instructions) return false
  return decodeConflicts({ skills, instructions }).valueOrUndefined ?? false
}

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service

    const state = State.create<Data, Draft>({
      name: "skill",
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
      finalize: () => events.publish(Event.Updated, {}).pipe(Effect.asVoid),
    })

    // Only the network pull is memoized. Skill files are re-read on every list because the
    // directories holding them are not all watched: ecosystem roots such as ~/.claude/skills
    // and user-configured skill paths never emit filesystem events, so a cached read would keep
    // serving skills that were edited or deleted on disk.
    const pulled = new Map<string, readonly string[]>()

    const directories = Effect.fn("SkillV2.directories")(function* (source: Source) {
      if (source.type === "embedded") return [] as readonly string[]
      if (source.type === "directory") return [source.path] as readonly string[]
      const cached = pulled.get(source.url)
      if (cached) return cached
      const resolved = yield* discovery.pull(source.url)
      pulled.set(source.url, resolved)
      return resolved
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") {
        yield* Effect.logDebug("skill source loaded", {
          source: Source.key(source),
          type: source.type,
          directories: [],
          skills: [source.skill.id],
        })
        return [source.skill]
      }
      const resolved = yield* directories(source)
      for (const directory of resolved) {
        const files = yield* fs
          .scan("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const conflicts = metadataConflicts(frontmatter.metadata)
          if (conflicts === false) continue
          const id =
            path.dirname(filepath) === directory
              ? path.basename(filepath, ".md")
              : path.basename(path.dirname(filepath))
          skills.push({
            id: ID.make(id),
            name: Name.make(frontmatter.name ?? id),
            description: frontmatter.description,
            slash: metadataBoolean(frontmatter.metadata, "ycoding/slash") ?? frontmatter.slash,
            autoinvoke: metadataBoolean(frontmatter.metadata, "ycoding/autoinvoke"),
            conflicts,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      yield* Effect.logDebug("skill source loaded", {
        source: Source.key(source),
        type: source.type,
        directories: resolved,
        skills: skills.map((skill) => skill.id),
      })
      return skills
    })

    const changed = Effect.fn("SkillV2.changedFromWatcher")(function* (file: string) {
      const matched = state
        .get()
        .sources.flatMap((source) =>
          source.type === "directory" && FSUtil.contains(source.path, file) ? [source.path] : [],
        )
      if (matched.length === 0) return
      yield* Effect.logInfo("skill directory changed", { file, directories: matched })
      yield* events.publish(Event.Updated, {}).pipe(Effect.asVoid)
    })

    yield* events.subscribe(FileSystem.Event.Changed).pipe(
      Stream.runForEach((event) => changed(event.data.file)),
      Effect.forkScoped({ startImmediately: true }),
    )

    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<ID, Info>()
      for (const source of state.get().sources) for (const skill of yield* load(source)) skills.set(skill.id, skill)
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillDiscovery.node, FSUtil.node, EventV2.node],
})
