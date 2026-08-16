import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { MoveSession } from "@ycoding-ai/core/control-plane/move-session"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Job } from "@ycoding-ai/core/job"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProjectDirectories } from "@ycoding-ai/core/project/directories"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Records the execution serialization a move must perform before relocating.
const executionCalls: string[] = []
const accountingCalls: Parameters<ProjectArtifactAccounting.Interface["deactivateProject"]>[0][] = []
const sourceActivations: Parameters<ProjectArtifactSource.Interface["activate"]>[0][] = []
const recordingExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: (sessionID) => Effect.sync(() => void executionCalls.push(`interrupt:${sessionID}`)),
    awaitIdle: (sessionID) => Effect.sync(() => void executionCalls.push(`awaitIdle:${sessionID}`)),
  }),
)
const recordingAccounting = Layer.succeed(
  ProjectArtifactAccounting.Service,
  ProjectArtifactAccounting.Service.of({
    activate: () => Effect.die(new Error("unused")),
    observe: () => Effect.die(new Error("unused")),
    feedback: () => Effect.die(new Error("unused")),
    feedbackInTransaction: () => Effect.die(new Error("unused")),
    deactivateProject: (input) => Effect.sync(() => accountingCalls.push(input)).pipe(Effect.as(1)),
    metrics: () => Effect.die(new Error("unused")),
    cohort: () => Effect.die(new Error("unused")),
    decide: () => Effect.die(new Error("unused")),
    decideInTransaction: () => Effect.die(new Error("unused")),
  }),
)
const recordingSource = Layer.mock(ProjectArtifactSource.Service, {
  refresh: () => Effect.void,
  provenance: (kind, id) =>
    Effect.succeed(
      kind === "agent" && id === "managed-agent"
        ? {
            scope: "project",
            scopeID: ProjectArtifact.ScopeID.make("pas_move-agent"),
            versionID: ProjectArtifact.VersionID.make("pav_move-agent"),
            kind: "agent",
            id: ProjectArtifact.ID.make("managed-agent"),
            expectedRevision: ProjectArtifact.Revision.make(1),
            expectedDigest: ProjectArtifact.Digest.make("a".repeat(64)),
          }
        : undefined,
    ),
  activate: (input) => Effect.sync(() => sourceActivations.push(input)),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      MoveSession.node,
      Database.node,
      EventV2.node,
      ProjectDirectories.node,
      Project.node,
      SessionV2.node,
      SessionProjector.node,
      SessionStore.node,
    ]),
    [
      [SessionExecution.node, recordingExecution],
      [ProjectArtifactAccounting.node, recordingAccounting],
      [ProjectArtifactSource.node, recordingSource],
    ],
  ),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@ycoding.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

describe("MoveSession", () => {
  it.live("moves session changes to another project directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-move-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          directory: source,
          title: "move",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      executionCalls.length = 0
      accountingCalls.length = 0
      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      // The move stops active execution before any relocation side effect.
      expect(executionCalls).toEqual([`interrupt:${sessionID}`, `awaitIdle:${sessionID}`])
      expect(accountingCalls).toHaveLength(0)
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("initial\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(source, "untracked.txt")).exists())).toBe(false)
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: moved, path: "" })
    }),
  )

  it.live("moves within a checkout without transferring existing changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          directory: source,
          title: "move nested",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const missing = yield* SessionV2.Service.use((service) =>
        service.move({ sessionID, directory: abs("packages") }).pipe(Effect.flip),
      )
      expect(missing._tag).toBe("Session.DestinationNotFoundError")
      yield* Effect.promise(() => fs.mkdir(destination))

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: abs("packages") }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination, path: "packages" })
    }),
  )

  it.live("moves a session to another project", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-other-project`)
      yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdir(destination, { recursive: true })),
        () => Effect.promise(() => fs.rm(destination, { recursive: true, force: true })),
      )

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const destinationProjectID = (yield* Project.Service.use((service) => service.resolve(destination))).id
      const sessionID = SessionV2.ID.make("ses_move_project")
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          directory: source,
          title: "move project",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      accountingCalls.length = 0
      sourceActivations.length = 0
      const session = yield* SessionV2.Service
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("managed-agent") })
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("ordinary-agent") })
      expect(sourceActivations).toHaveLength(1)
      expect(sourceActivations[0]).toMatchObject({
        kind: "agent",
        id: "managed-agent",
        sessionID,
        agentID: "managed-agent",
        source: "agent-selected",
      })
      const switches = (yield* session.context(sessionID)).filter((message) => message.type === "agent-switched")
      expect(switches[0]).toMatchObject({
        agent: "managed-agent",
        artifact: { sourceScope: "project", versionID: "pav_move-agent" },
      })
      expect(switches[1]).toMatchObject({ agent: "ordinary-agent" })
      expect(switches[1] && "artifact" in switches[1]).toBe(false)
      yield* SessionV2.Service.use((service) =>
        service.move({ sessionID, directory: destination }),
      )

      const history = Array.from(yield* Stream.runCollect(events.log({ aggregateID: sessionID }))).filter(
        (event): event is EventV2.Payload => !EventV2.isSynced(event),
      )
      const ended = history.find((event) => event.type === "session.project-artifacts-ended")
      const movedEvent = history.find((event) => event.type === "session.moved")
      const managedAgent = history.find((event) => event.type === "session.agent.selected")
      expect(Number(sourceActivations[0]?.boundarySeq)).toBe(Number(managedAgent?.durable?.seq))
      expect(ended).toMatchObject({
        data: { sessionID, oldProjectID: projectID, newProjectID: destinationProjectID },
      })
      expect(ended?.durable?.seq).toBeLessThan(movedEvent?.durable?.seq ?? -1)
      expect(accountingCalls).toHaveLength(1)
      expect(accountingCalls[0]?.sessionID).toBe(sessionID)
      expect(accountingCalls[0]?.projectID).toBe(projectID)
      expect(Number(accountingCalls[0]?.boundarySeq)).toBe(Number(ended?.durable?.seq))
      expect(typeof accountingCalls[0]?.deactivatedAt).toBe("number")

      expect(
        yield* db
          .select({ projectID: SessionTable.project_id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ projectID: destinationProjectID, directory: destination })
    }),
  )

  it.live("moves nested session changes without cleaning unrelated files", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const sourceDirectory = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(sourceDirectory))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "initial\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "initial\n"))
      yield* Effect.promise(() => $`git add packages/tracked.txt packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => $`git commit -m packages`.cwd(source).quiet())
      const destination = abs(`${root.path}-move-nested-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(source).quiet())
      const moved = abs(path.join(yield* Effect.promise(() => fs.realpath(destination)), "packages"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "staged\n"))
      yield* Effect.promise(() => $`git add packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "untracked.txt"), "new\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "unrelated\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "unrelated\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested_checkout")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          directory: sourceDirectory,
          title: "move nested checkout",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "staged.txt"), "utf8"))).toBe("staged\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "tracked.txt"), "utf8"))).toBe(
        "initial\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(sourceDirectory, "untracked.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "staged.txt"), "utf8"))).toBe(
        "staged\n",
      )
      expect(yield* Effect.promise(() => $`git status --porcelain -- packages/staged.txt`.cwd(source).text())).toBe(
        "M  packages/staged.txt\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("unrelated\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("unrelated\n")
    }),
  )
})
