export * as Skill from "./skill"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema, Stream, Types } from "effect"
import { FileSystem } from "@ycoding-ai/schema/filesystem"
import { Skill } from "@ycoding-ai/schema/skill"
import { Agent } from "./agent"
import { Config } from "./config"
import { ConfigCapabilities } from "./config/capabilities"
import { EventRuntime } from "./event"
import { LocationAnnouncements } from "./location-announcements"
import { FSUtil } from "./fs-util"
import { MCP } from "./mcp"
import { MCPSkills } from "./mcp/skills"
import { nativeResource } from "./native-resources"
import { Permission } from "./permission"
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

export const available = <A extends { readonly id: ID }>(skills: ReadonlyArray<A>, agent: Agent.Info) =>
  skills.filter((skill) => Permission.evaluate("skill", skill.id, agent.permissions).effect !== "deny")

const decodeSkills = Schema.decodeUnknownSync(Schema.Array(Info))

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

/**
 * Metadata-only view of one MCP-served skill, the projection the model-facing surface consumes.
 * It carries the origin pair as the ID, so identity is never the bare URI or the bare name.
 */
export type MCPSkillInfo = {
  readonly id: ID
  readonly server: string
  readonly uri: string
  readonly name: Name
  readonly description: string
  readonly entry: MCPSkills.Entry
}

/**
 * Collision-safe skill identity for an MCP-served skill. The extension defines a skill's identity as
 * the pair of the host's server label and the `SKILL.md` URI. The canonical encoding is reversible
 * and length-unambiguous, so delimiter characters in either half cannot collide.
 */
export const mcpSkillID = (server: string, uri: string) => ID.make(MCPSkills.id(server, uri))

/** Recovers the origin pair from an ID produced by `mcpSkillID`, or undefined for a local skill. */
export const mcpSkillOrigin = (id: string) => MCPSkills.origin(id)

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  /**
   * Metadata-only projection of every connected MCP server's skill entries. This reads the extension's
   * listings and never retrieves a skill file, so it is safe at startup and on instruction reload.
   * Entries the host must not load are already dropped by the MCP layer.
   */
  readonly mcp: () => Effect.Effect<MCPSkillInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const events = yield* EventRuntime.Service
    const announcements = yield* LocationAnnouncements.Current
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const permitted = Effect.fnUntraced(function* <A extends { readonly id: ID }>(skills: ReadonlyArray<A>) {
      const capabilities = Config.capabilities(yield* config.entries())
      return skills.filter((skill) => ConfigCapabilities.allows(capabilities.skills, skill.id))
    })

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
      announce: { gate: announcements, publish: events.publish(Event.Updated, {}) },
    })

    // Only the network pull is memoized. Skill files are re-read on every list because the
    // directories holding them are not all watched: ecosystem roots such as ~/.claude/skills
    // and user-configured skill paths never emit filesystem events, so a cached read would keep
    // serving skills that were edited or deleted on disk.
    const pulled = new Map<string, readonly string[]>()

    const resolveSource = Effect.fn("Skill.resolveSource")(function* (source: Source) {
      if (source.type !== "url") return [source]
      const cached = pulled.get(source.url)
      const directories = cached ?? (yield* discovery.pull(source.url))
      if (cached === undefined) pulled.set(source.url, directories)
      return directories.map((directory) => ({ type: "directory" as const, path: AbsolutePath.make(directory) }))
    })

    const changed = Effect.fn("Skill.changedFromWatcher")(function* (file: string) {
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

    const list = Effect.fn("Skill.list")(function* () {
      const sources = (yield* Effect.forEach(state.get().sources, resolveSource)).flat()
      if (sources.length === 0) return []
      const skills = yield* nativeResource({ operation: "skill", sources }).pipe(
        Effect.map((reply) => {
          if (!reply.ok) throw new Error(`Native skill catalog failed: ${reply.code}`)
          return decodeSkills(reply.value)
        }),
        Effect.orDie,
      )
      return yield* permitted(skills)
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("Skill.sources")(function* () {
        return state.get().sources
      }),
      list,
      mcp: Effect.fn("Skill.mcp")(function* () {
        const entries = yield* mcp.skillCatalog()
        return yield* permitted(entries.map((entry) => ({
          id: mcpSkillID(entry.server, entry.uri),
          server: entry.server,
          uri: entry.uri,
          name: Name.make(entry.frontmatter.name),
          description: entry.frontmatter.description,
          entry,
        })))
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, SkillDiscovery.node, EventRuntime.node, MCP.node],
})
