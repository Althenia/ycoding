import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Database } from "@ycoding-ai/core/database/database"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { ProjectDirectories } from "@ycoding-ai/core/project/directories"
import { ProjectInventory } from "@ycoding-ai/core/project/inventory"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const alpha = ProjectV2.ID.make("prj_alpha")
const beta = ProjectV2.ID.make("prj_beta")
const roots = { alpha: "", beta: "" }

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) =>
      Effect.succeed(
        directory.startsWith(roots.alpha)
          ? { id: alpha, directory: AbsolutePath.make(roots.alpha) }
          : { id: beta, directory: AbsolutePath.make(roots.beta) },
      ),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionExecution.node,
      ProjectDirectories.node,
      ProjectInventory.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const workspace = Effect.acquireRelease(
  Effect.promise(async () => {
    const tmp = await tmpdir()
    roots.alpha = path.join(tmp.path, "alpha")
    roots.beta = path.join(tmp.path, "beta")
    await fs.mkdir(path.join(roots.alpha, "packages", "tui"), { recursive: true })
    await fs.mkdir(roots.beta, { recursive: true })
    return tmp
  }),
  (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
)

const at = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

describe("ProjectInventory", () => {
  it.live("lists recorded and Session directories grouped by project with counts and availability", () =>
    Effect.gen(function* () {
      yield* workspace
      const sessions = yield* SessionV2.Service
      const directories = yield* ProjectDirectories.Service
      const inventory = yield* ProjectInventory.Service
      const copy = AbsolutePath.make(path.join(roots.alpha, ".worktrees", "gone"))

      yield* sessions.create({ location: at(roots.alpha) })
      yield* sessions.create({ location: at(roots.alpha) })
      yield* sessions.create({ location: at(path.join(roots.alpha, "packages", "tui")) })
      yield* sessions.create({ location: at(roots.beta) })
      yield* directories.create({ projectID: alpha, directory: copy, strategy: "git_worktree" })

      const page = yield* inventory.list({ limit: 50 })
      expect(page.next).toBeUndefined()
      expect(
        page.data.map((entry) => ({
          projectID: entry.projectID,
          directory: entry.directory,
          strategy: entry.strategy,
          sessions: entry.sessions,
          available: entry.available,
        })),
      ).toEqual([
        {
          projectID: alpha,
          directory: AbsolutePath.make(roots.alpha),
          strategy: undefined,
          sessions: 2,
          available: true,
        },
        { projectID: alpha, directory: copy, strategy: "git_worktree", sessions: 0, available: false },
        {
          projectID: alpha,
          directory: AbsolutePath.make(path.join(roots.alpha, "packages", "tui")),
          strategy: undefined,
          sessions: 1,
          available: true,
        },
        {
          projectID: beta,
          directory: AbsolutePath.make(roots.beta),
          strategy: undefined,
          sessions: 1,
          available: true,
        },
      ])
      expect(page.data[0]?.projectWorktree).toBe(AbsolutePath.make(roots.alpha))
    }),
  )

  it.live("pages with a keyset anchor and filters by search", () =>
    Effect.gen(function* () {
      yield* workspace
      const sessions = yield* SessionV2.Service
      const inventory = yield* ProjectInventory.Service
      yield* sessions.create({ location: at(roots.alpha) })
      yield* sessions.create({ location: at(path.join(roots.alpha, "packages", "tui")) })
      yield* sessions.create({ location: at(roots.beta) })

      const first = yield* inventory.list({ limit: 2 })
      expect(first.data.map((entry) => entry.directory)).toEqual([
        AbsolutePath.make(roots.alpha),
        AbsolutePath.make(path.join(roots.alpha, "packages", "tui")),
      ])
      expect(first.next).toBeDefined()
      const second = yield* inventory.list({ limit: 2, after: first.next })
      expect(second.data.map((entry) => entry.directory)).toEqual([AbsolutePath.make(roots.beta)])
      expect(second.next).toBeUndefined()

      const searched = yield* inventory.list({ limit: 50, search: "PACKAGES/T" })
      expect(searched.data.map((entry) => entry.directory)).toEqual([
        AbsolutePath.make(path.join(roots.alpha, "packages", "tui")),
      ])
      expect((yield* inventory.list({ limit: 50, search: "%" })).data).toEqual([])
    }),
  )

  it.live("forget deletes the project's Sessions in the directory with their children and removes the record", () =>
    Effect.gen(function* () {
      yield* workspace
      const sessions = yield* SessionV2.Service
      const directories = yield* ProjectDirectories.Service
      const inventory = yield* ProjectInventory.Service
      const directory = AbsolutePath.make(roots.alpha)
      const root = yield* sessions.create({ location: at(roots.alpha) })
      yield* directories.create({ projectID: alpha, directory })
      const child = yield* sessions.create({ parentID: root.id })
      const other = yield* sessions.create({ location: at(roots.beta) })

      yield* inventory.forget({ projectID: alpha, directory })

      expect(yield* sessions.get(root.id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
      expect(yield* sessions.get(child.id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
      expect((yield* sessions.get(other.id)).id).toBe(other.id)
      expect(yield* directories.contains({ projectID: alpha, directory })).toBe(false)
      expect((yield* inventory.list({ limit: 50 })).data.map((entry) => entry.directory)).toEqual([
        AbsolutePath.make(roots.beta),
      ])
    }),
  )
})
