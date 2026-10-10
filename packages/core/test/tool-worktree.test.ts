import { afterAll, describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Git } from "@ycoding-ai/core/git"
import { Image } from "@ycoding-ai/core/image"
import { Hash } from "@ycoding-ai/core/util/hash"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectCopy } from "@ycoding-ai/core/project/copy"
import { ProjectDirectories } from "@ycoding-ai/core/project/directories"
import { ProjectDirectoryTable, ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { WorktreeTool } from "@ycoding-ai/core/tool/worktree"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

const projectID = Project.ID.make("worktree-tool-test")
const sessionID = Session.ID.make("ses_worktree_tool_test")
const agentID = toolIdentity.agent
const messageID = SessionMessage.ID.make("msg_worktree_tool_test")
const state = { deny: false, permissions: [] as string[], guardrails: 0 }
const root = await tmpdir()
const nonGitRoot = await tmpdir()
await $`git init`.cwd(root.path).quiet()
await $`git config user.email test@ycoding.test`.cwd(root.path).quiet()
await $`git config user.name Test`.cwd(root.path).quiet()
await $`git commit --allow-empty -m root`.cwd(root.path).quiet()
const source = AbsolutePath.make(await fs.realpath(root.path))
const location = {
  directory: source,
  project: { id: projectID, directory: source },
}
const permission = Layer.succeed(Permission.Service, {
  evaluateEffective: () => Effect.succeed(state.deny ? "deny" : "ask"),
  assert: (input: Permission.AssertInput) =>
    Effect.gen(function* () {
      state.permissions.push(input.action)
      if (state.deny)
        return yield* new Permission.BlockedError({ permission: input.action, resources: input.resources, rules: [] })
    }),
  ask: () => Effect.die("unused"),
} as unknown as Permission.Interface)
const guardrail = Layer.succeed(SessionGuardrail.Service, {
  assert: () =>
    Effect.sync(() => {
      state.guardrails++
      return { release: Effect.void }
    }),
} as unknown as SessionGuardrail.Interface)
const plugin = makeLocationNode({
  name: "test/worktree-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WorktreeTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    Location.node,
    Git.node,
    Global.node,
    ProjectCopy.node,
    Permission.node,
    SessionGuardrail.node,
    FSUtil.node,
  ],
})
const data = path.join(await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "worktree-tool-data-")))
const buildLayer = (activeLocation: Location.Interface) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      plugin,
      ProjectCopy.node,
      Database.node,
      EventRuntime.node,
      ProjectDirectories.node,
      Git.node,
      FSUtil.node,
      LayerNodePlatform.filesystem,
      LayerNodePlatform.path,
    ]),
    [
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(activeLocation))],
      [Global.node, Global.layerWith({ data })],
      [Permission.node, permission],
      [SessionGuardrail.node, guardrail],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  )
const it = testEffect(buildLayer(location))
const nonGitLocation = {
  ...location,
  directory: AbsolutePath.make(nonGitRoot.path),
  project: { id: projectID, directory: AbsolutePath.make(nonGitRoot.path) },
}
const nonGitIt = testEffect(buildLayer(nonGitLocation))

describe("worktree tool", () => {
  afterAll(async () => {
    await root[Symbol.asyncDispose]()
    await nonGitRoot[Symbol.asyncDispose]()
    await fs.rm(data, { recursive: true, force: true })
  })

  it.live("lists the repository's worktrees", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const git = yield* Git.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ProjectDirectoryTable)
        .values({ project_id: projectID, directory: source })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const result = yield* executeTool(registry, {
        sessionID,
        agent: agentID,
        messageID,
        call: { type: "tool-call", id: "list", name: "worktree", input: { action: "list" } },
      })
      expect(result).toMatchObject({ type: "text", value: expect.stringContaining(source) })
      const repository = yield* git.repo.discover(source)
      expect(repository).toBeDefined()
    }),
  )

  nonGitIt.effect("rejects a non-Git Location before permissions or project-copy access", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        agent: agentID,
        messageID,
        call: { type: "tool-call", id: "not-git", name: "worktree", input: { action: "list" } },
      })
      expect(result).toMatchObject({ type: "error", value: expect.stringContaining("not inside a Git repository") })
    }),
  )

  it.live("creates a named branch at the managed destination and rejects invalid, duplicate, and denied requests", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ProjectDirectoryTable)
        .values({ project_id: projectID, directory: source })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const registry = yield* ToolRegistry.Service
      const call = (id: string, input: unknown) =>
        executeTool(registry, {
          sessionID,
          agent: agentID,
          messageID,
          call: { type: "tool-call", id, name: "worktree", input },
        })
      expect((yield* call("invalid", { action: "create", name: "Bad_name" })).type).toBe("error")
      const created = yield* call("create", { action: "create", name: "feature-one" })
      expect(created.type).toBe("text")
      const copies = yield* ProjectCopy.Service
      const repository = yield* (yield* Git.Service).repo.discover(source)
      expect(repository).toBeDefined()
      if (repository) {
        const common = yield* Effect.promise(() => fs.realpath(repository.commonDirectory))
        const directory = path.join(data, "worktrees", `repo_${Hash.sha256(common)}`, "feature-one")
        expect(created).toMatchObject({ type: "text", value: expect.stringContaining(directory) })
        const createdRepository = yield* (yield* Git.Service).repo.discover(AbsolutePath.make(directory))
        expect(createdRepository).toBeDefined()
        if (createdRepository) expect(yield* (yield* Git.Service).history.branch(createdRepository)).toBe("feature-one")
        const listing = yield* call("list-created", { action: "list" })
        expect(listing).toMatchObject({ type: "text", value: expect.stringContaining(directory) })
        yield* copies.remove({ projectID, directory: AbsolutePath.make(directory), force: false })
      }
      expect(state.permissions).toContain("worktree")
      expect(state.guardrails).toBeGreaterThan(0)
      expect((yield* call("duplicate", { action: "create", name: "feature-one" })).type).toBe("error")
      yield* Effect.promise(() => $`git branch feature-two`.cwd(root.path).quiet())
      expect(yield* call("existing-branch", { action: "create", name: "feature-two" })).toMatchObject({
        type: "error",
        value: expect.stringContaining("feature-two"),
      })
      state.deny = true
      expect((yield* call("denied", { action: "create", name: "feature-two" })).type).toBe("error")
      state.deny = false
    }),
  )
})
