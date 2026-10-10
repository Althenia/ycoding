export * as LocationMutation from "./location-mutation"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { Project } from "./project"
import { AbsolutePath } from "./schema"
import { Hash } from "./util/hash"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths resolve
 * from the active Location. Paths outside it require separate
 * `external_directory` approval.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("LocationMutation.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["location_escape", "non_directory_ancestor"]),
}) {}

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical existing directory used as the external approval boundary. */
  readonly directory: string
  /** `external_directory` permission resource. */
  readonly resource: string
  readonly save: string
}

export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization) => ({
  action: input.action,
  resources: [input.resource],
  save: [input.save],
})

export interface Target {
  /** Canonical existing path, or missing path below a canonical directory. */
  readonly canonical: string
  /** Permission resource: Location-relative for internal paths, canonical for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve a path and derive its permission resources. Relative paths resolve
   * from the Location. Paths outside it require separate `external_directory`
   * approval. This does not approve the mutation.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, PathError | FSUtil.Error>
  readonly managedWorktree: (target: string) => Effect.Effect<boolean, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/LocationMutation") {}

interface ResolvedPath {
  readonly canonical: string
  readonly type?:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly directory: string
}

const slash = (value: string) => value.replaceAll("\\", "/")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const locationRoot = yield* fs.realPath(location.directory)

    const managedWorktree = Effect.fnUntraced(function* (target: string) {
      const managedRoot = yield* fs.resolve(path.join(global.data, "worktrees"))
      if (!FSUtil.contains(managedRoot, target)) return false
      const repository = yield* git.repo.discover(location.directory)
      if (!repository) return false
      const commonDirectory = yield* fs.realPath(repository.commonDirectory)
      const root = path.join(managedRoot, `repo_${Hash.sha256(commonDirectory)}`)
      if (!FSUtil.contains(root, target)) return false
      const entries = yield* git.worktree
        .list(repository)
        .pipe(Effect.catchTag("Git.WorktreeError", () => Effect.succeed([])))
      const trusted = yield* Effect.forEach(
        entries.filter((entry) => entry.kind === "linked"),
        (entry) =>
          Effect.gen(function* () {
            const linked = yield* fs.realPath(entry.directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!linked || !FSUtil.contains(root, linked) || !FSUtil.contains(linked, target)) return false
            const found = yield* git.repo.discover(AbsolutePath.make(linked))
            if (!found) return false
            const foundCommon = yield* fs.realPath(found.commonDirectory)
            return foundCommon === commonDirectory
          }),
      )
      return trusted.some(Boolean)
    })

    function notFound<A>(effect: Effect.Effect<A, FSUtil.Error>) {
      return effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
    }

    const resolvePath = Effect.fnUntraced(function* (absolute: string) {
      const existing = yield* notFound(fs.realPath(absolute))
      if (existing !== undefined) {
        const info = yield* fs.stat(existing)
        return {
          canonical: existing,
          type: info.type,
          directory: info.type === "Directory" ? existing : path.dirname(existing),
        } satisfies ResolvedPath
      }

      let anchor = path.dirname(absolute)
      while (true) {
        const canonical = yield* notFound(fs.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* fs.stat(canonical)
          if (info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          return {
            canonical: path.resolve(canonical, path.relative(anchor, absolute)),
            directory: canonical,
          } satisfies ResolvedPath
        }
        const parent = path.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput) {
      const absolute = path.resolve(location.directory, input.path)
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)

      const resolved = yield* resolvePath(absolute)
      if (lexicallyInternal && !FSUtil.contains(locationRoot, resolved.canonical)) {
        return yield* new PathError({ path: input.path, reason: "location_escape" })
      }

      const external = !lexicallyInternal
      const trustedManagedWorktree = external && (yield* managedWorktree(resolved.canonical))
      const resource = external
        ? slash(resolved.canonical)
        : slash(path.relative(locationRoot, resolved.canonical) || ".")
      const externalDirectory =
        input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory
      const externalResource = slash(path.join(externalDirectory, "*"))
      return {
        canonical: resolved.canonical,
        resource,
        externalDirectory:
          external && !trustedManagedWorktree
            ? {
                action: "external_directory",
                directory: externalDirectory,
                resource: externalResource,
                save: slash(
                  path.join((yield* Project.root(fs, AbsolutePath.make(externalDirectory))) ?? externalDirectory, "*"),
                ),
              }
            : undefined,
      } satisfies Target
    })

    return Service.of({ resolve, managedWorktree })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node, Git.node, Global.node],
})
