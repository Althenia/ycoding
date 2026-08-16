import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { CommandV2 } from "@ycoding-ai/core/command"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Database } from "@ycoding-ai/core/database/database"
import { EventV2 } from "@ycoding-ai/core/event"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Project } from "@ycoding-ai/schema/project"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { ProjectArtifactAdapterRegistry } from "@ycoding-ai/core/project-artifact/adapter/index"
import { managedDefaults } from "@ycoding-ai/core/project-artifact/adapter/agent"
import { ProjectArtifactPackage } from "@ycoding-ai/core/project-artifact/package"
import { ProjectArtifactSource, ProjectArtifactStandardSourceRegistry } from "@ycoding-ai/core/project-artifact/source"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionTable, SessionMessageTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { WorkspaceTable } from "@ycoding-ai/core/control-plane/workspace.sql"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { Hash } from "@ycoding-ai/core/util/hash"
import { testEffect } from "./lib/effect"
import { Money } from "@ycoding-ai/schema/money"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { WorkspaceV2 } from "@ycoding-ai/core/workspace"

const projectID = Project.ID.make("source-project")
const dataRoot = path.join(os.tmpdir(), `ycoding-project-artifact-source-${process.pid}`)
const storageID = ProjectArtifact.StorageID.make("11111111-1111-4111-8111-111111111111")
const scopeID = ProjectArtifact.ScopeID.make("pas_source")
const modelRef = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") }
const details = new Map<string, ProjectArtifact.ArtifactDetails>()
let listFailure = false
const observed: ProjectArtifactAccounting.ObserveInput[] = []
const governors: ProjectArtifactStore.GovernorEvaluationInput[] = []
let observeResult: ReadonlyArray<ProjectArtifact.Observation> = []
const store = Layer.mock(ProjectArtifactStore.Service, {
  list: (input) => {
    if (listFailure)
      return Effect.fail(
        new ProjectArtifactStore.StoreError({ code: "StorageUnavailable", message: "fixture refresh failure" }),
      )
    return Effect.succeed(
      Array.from(details.values())
        .filter((item) => item.artifact.stage === input.stage)
        .map((item) => ({
          scope: item.artifact.scope,
          kind: item.artifact.kind,
          id: item.artifact.id,
          name: item.definition.name,
          description: item.definition.description,
          stage: item.artifact.stage,
          revision: item.artifact.revision,
          currentVersionID: item.currentVersion.id,
          currentDigest: item.currentVersion.contentDigest,
          timeUpdated: item.artifact.timeUpdated,
        })),
    )
  },
  get: (input) => {
    const item = details.get(`${input.kind}:${input.id}`)
    return item
      ? Effect.succeed(item)
      : Effect.fail(new ProjectArtifactStore.StoreError({ code: "ArtifactNotFound", message: "not found" }))
  },
  resolveGlobalScope: () =>
    Effect.succeed({ type: "global", id: ProjectArtifact.ScopeID.make("pas_global"), storageID }),
  evaluateGovernor: (input) =>
    Effect.sync(() => governors.push(input)).pipe(
      Effect.as({
        action: "none" as const,
        state: { firstQualifiedAt: null },
        cohort: { candidate: { sampleCount: 0, successCount: 0 }, baseline: { sampleCount: 0, successCount: 0 }, projectBuckets: [] },
      }),
    ),
})
const accounting = Layer.mock(ProjectArtifactAccounting.Service, {
  activate: (input) => Effect.succeed(input),
  observe: (input) => Effect.sync(() => observed.push(input)).pipe(Effect.as(observeResult)),
})
const sessions = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(undefined),
  context: () => Effect.succeed([]),
})
const autonomy = Layer.mock(SessionAutonomy.Service, {
  get: () => Effect.succeed(SessionAutonomy.defaultState),
})
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make("/workspace/source-project"),
    project: { id: projectID, directory: AbsolutePath.make("/workspace/source-project") },
    vcs: { type: "git", store: AbsolutePath.make("/workspace/source-project/.git") },
  }),
)
const sourceIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ProjectArtifactSource.node, SkillV2.node, CommandV2.node, AgentV2.node]),
    [
    [ProjectArtifactStore.node, store],
    [ProjectArtifactAccounting.node, accounting],
    [SessionStore.node, sessions],
    [SessionAutonomy.node, autonomy],
    [Location.node, locationLayer],
    [
      Global.node,
      Global.layerWith({
        data: dataRoot,
        config: path.join(dataRoot, "config"),
        home: path.join(dataRoot, "home"),
      }),
    ],
    ],
  ),
)
const terminalIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ProjectArtifactSource.node,
      EventV2.node,
      Database.node,
      SessionStore.node,
      SessionAutonomy.node,
    ]),
    [
      [ProjectArtifactStore.node, store],
      [ProjectArtifactAccounting.node, accounting],
      [Location.node, locationLayer],
      [
        Global.node,
        Global.layerWith({
          data: dataRoot,
          config: path.join(dataRoot, "config"),
          home: path.join(dataRoot, "home"),
        }),
      ],
    ],
  ),
)

describe("ProjectArtifactSource", () => {
  test("keeps replacement-safe snapshots isolated by Location", async () => {
    const registry = ProjectArtifactStandardSourceRegistry.make()
    registry.replace("first", [
      {
        scope: "project",
        projectID: Project.ID.make("project-one"),
        kind: "skill",
        id: ProjectArtifact.ID.make("review"),
      },
    ])
    registry.replace("second", [
      {
        scope: "global",
        kind: "skill",
        id: ProjectArtifact.ID.make("review"),
        managedScopeID: ProjectArtifact.ScopeID.make("pas_global"),
        managedVersionID: ProjectArtifact.VersionID.make("pav_global"),
        managedDigest: ProjectArtifact.Digest.make("a".repeat(64)),
      },
    ])
    expect(registry.size()).toBe(2)
    expect(
      await Effect.runPromise(
        registry.resolve({
          scope: "project",
          projectID: Project.ID.make("project-one"),
          kind: "skill",
          id: ProjectArtifact.ID.make("review"),
        }),
      ),
    ).toEqual([{ scope: "project" }])
    expect(
      await Effect.runPromise(
        registry.resolve({ scope: "global", kind: "skill", id: ProjectArtifact.ID.make("review") }),
      ),
    ).toEqual([
      {
        scope: "global",
        managedScopeID: ProjectArtifact.ScopeID.make("pas_global"),
        managedVersionID: ProjectArtifact.VersionID.make("pav_global"),
        managedDigest: ProjectArtifact.Digest.make("a".repeat(64)),
      },
    ])
    registry.remove("first")
    expect(registry.size()).toBe(1)
  })

  sourceIt.effect("keeps one replaceable managed SkillV2 source across caller scopes and refreshes", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await fs.rm(dataRoot, { recursive: true, force: true })
        await fs.mkdir(dataRoot, { recursive: true })
      }),
      () =>
        Effect.gen(function* () {
          details.clear()
          listFailure = false
          yield* writeSkill("pav_source-one", "First guidance", 1)
          yield* writeDefinition(
            "review-command",
            "pav_source-command",
            {
              kind: "command",
              name: "Review command",
              description: "Reusable command",
              template: "Review the change.",
              subtask: false,
            },
            1,
          )
          yield* writeDefinition(
            "review-agent",
            "pav_source-agent",
            {
              kind: "agent",
              name: "Review agent",
              description: "Reusable agent",
              system: "Review without editing.",
              mode: "subagent",
              permissions: [],
            },
            1,
          )
          yield* writeDefinition(
            "blocked-plugin",
            "pav_source-plugin",
            {
              kind: "plugin",
              name: "Blocked plugin",
              description: "Executable plugin",
              draft: "export default {}",
            },
            1,
            "active",
          )
          const source = yield* ProjectArtifactSource.Service
          const skills = yield* SkillV2.Service
          const commands = yield* CommandV2.Service
          const agents = yield* AgentV2.Service

          yield* Effect.scoped(source.refresh())
          expect((yield* skills.list()).filter((skill) => skill.id === "review")).toMatchObject([
            { id: "review", content: "First guidance" },
          ])
          expect(yield* commands.get("review-command")).toMatchObject({ template: "Review the change." })
          expect(yield* agents.get(AgentV2.ID.make("review-agent"))).toMatchObject({
            system: "Review without editing.",
            permissions: managedDefaults,
          })
          expect(yield* source.provenance("plugin", "blocked-plugin")).toBeUndefined()

          yield* writeSkill("pav_source-two", "Updated guidance", 2)
          yield* source.refresh()
          expect((yield* skills.list()).filter((skill) => skill.id === "review")).toMatchObject([
            { id: "review", content: "Updated guidance" },
          ])

          listFailure = true
          yield* source.refresh()
          expect((yield* skills.list()).filter((skill) => skill.id === "review")).toMatchObject([
            { id: "review", content: "Updated guidance" },
          ])
        }),
      () => Effect.promise(() => fs.rm(dataRoot, { recursive: true, force: true })),
    ),
  )

  terminalIt.effect("observes terminal identities once and deduplicates governor evaluation", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await fs.rm(dataRoot, { recursive: true, force: true })
        await fs.mkdir(dataRoot, { recursive: true })
      }),
      () =>
        Effect.gen(function* () {
          details.clear()
          observed.length = 0
          governors.length = 0
          listFailure = false
          observeResult = []
          yield* writeSkill("pav_terminal", "Terminal guidance", 7)
          const source = yield* ProjectArtifactSource.Service
          yield* source.refresh()
          const db = (yield* Database.Service).db
          const events = yield* EventV2.Service
          const autonomy = yield* SessionAutonomy.Service
          const outcomes = [
            { type: "succeeded" as const },
            { type: "failed" as const },
            { type: "interrupted" as const },
          ]
          for (const [index, outcome] of outcomes.entries()) {
            const sessionID = SessionV2.ID.make(`ses_terminal_${outcome.type}`)
            yield* seedTerminalSession(db, sessionID, index)
            yield* autonomy.setGoal({ sessionID, text: "Finish terminal proof" })
            yield* TestClock.setTime(1_000 + index * 1_000)
            yield* events.publish(SessionEvent.Execution.Started, { sessionID })
            if (outcome.type === "succeeded")
              yield* autonomy.advance({ sessionID, progress: "Complete", completed: true })
            else yield* autonomy.stop(sessionID)
            yield* TestClock.setTime(1_075 + index * 1_000)
            if (outcome.type === "succeeded") yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
            else if (outcome.type === "failed")
              yield* events.publish(SessionEvent.Execution.Failed, {
                      sessionID,
                      error: { type: "fixture", message: "private failure text" },
                    })
            else yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })
            yield* waitFor(() => observed.length === index + 1)
            if (index === 0) {
              const first = observed[0]
              yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
              yield* Effect.promise(() => Bun.sleep(5))
              expect(observed).toEqual([first])
            }
          }

          expect(observed.map((input) => input.terminalOutcome)).toEqual(["succeeded", "failed", "interrupted"])
          expect(observed.map((input) => input.goalStatus)).toEqual(["completed", "stopped", "stopped"])
          expect(observed.map((input) => input.latencyMs)).toEqual([75, 75, 75])
          expect(observed.map((input) => input.kind)).toEqual(["command", "command", "command"])
          expect(observed[0]).toMatchObject({
            projectID,
            terminalMessageID: "msg_terminal_latest_0",
            kind: "command",
            agentID: "build",
            modelID: "test/model",
            goalMode: true,
            goalStatus: "completed",
            latencyMs: 75,
            inputTokens: 11,
            outputTokens: 12,
            cacheReadTokens: 13,
            completedToolCount: 2,
            failedToolCount: 1,
            standardInvocationCount: 2,
            externalConfounded: true,
            repeatFix: false,
          })
          expect(Object.keys(observed[0] ?? {})).not.toEqual(
            expect.arrayContaining(["prompt", "output", "error", "path", "url"]),
          )

          const identity = {
            scopeID,
            kind: "skill" as const,
            id: ProjectArtifact.ID.make("review"),
            versionID: ProjectArtifact.VersionID.make("pav_terminal"),
          }
          observeResult = [observation(identity, "pao_terminal-one"), observation(identity, "pao_terminal-two")]
          const governorSession = SessionV2.ID.make("ses_terminal_governor")
          yield* seedTerminalSession(db, governorSession, 9)
          yield* events.publish(SessionEvent.Execution.Started, { sessionID: governorSession })
          yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: governorSession })
          yield* waitFor(() => governors.length === 1)
          const expectedDigest = details.get("skill:review")?.currentVersion.contentDigest
          if (!expectedDigest) return yield* Effect.die(new Error("Terminal fixture digest missing"))
          expect(governors).toEqual([
            {
              scopeID,
              kind: "skill",
              id: ProjectArtifact.ID.make("review"),
              expectedRevision: ProjectArtifact.Revision.make(7),
              expectedVersionID: ProjectArtifact.VersionID.make("pav_terminal"),
              expectedDigest,
              agentID: AgentV2.ID.make("build"),
              modelID: "test/model",
              goalMode: false,
            },
          ])

          observeResult = [
            observation({ ...identity, versionID: ProjectArtifact.VersionID.make("pav_stale") }, "pao_terminal-stale"),
            observation(
              { ...identity, id: ProjectArtifact.ID.make("missing"), versionID: ProjectArtifact.VersionID.make("pav_missing") },
              "pao_terminal-missing",
            ),
          ]
          const staleSession = SessionV2.ID.make("ses_terminal_stale")
          yield* seedTerminalSession(db, staleSession, 10)
          yield* events.publish(SessionEvent.Execution.Started, { sessionID: staleSession })
          yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: staleSession })
          yield* waitFor(() => observed.length === 5)
          expect(governors).toHaveLength(1)

          const otherWorkspace = SessionV2.ID.make("ses_terminal_other_workspace")
          yield* seedTerminalSession(db, otherWorkspace, 11, WorkspaceV2.ID.make("wrk_other"))
          yield* events.publish(SessionEvent.Execution.Started, { sessionID: otherWorkspace })
          yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: otherWorkspace })
          yield* Effect.yieldNow
          expect(observed).toHaveLength(5)
        }),
      () => Effect.promise(() => fs.rm(dataRoot, { recursive: true, force: true })),
    ),
  )

  terminalIt.effect("classifies managed and standard SkillTool and subagent calls from captured activations", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await fs.rm(dataRoot, { recursive: true, force: true })
        await fs.mkdir(dataRoot, { recursive: true })
      }),
      () =>
        Effect.gen(function* () {
          details.clear()
          observed.length = 0
          governors.length = 0
          listFailure = false
          observeResult = []
          yield* writeSkill("pav_terminal-skill", "Terminal skill", 1)
          yield* writeDefinition(
            "review-agent",
            "pav_terminal-agent",
            {
              kind: "agent",
              name: "Review agent",
              description: "Terminal agent",
              system: "Review safely.",
              mode: "subagent",
              permissions: [],
            },
            1,
          )
          const source = yield* ProjectArtifactSource.Service
          yield* source.refresh()
          const db = (yield* Database.Service).db
          const events = yield* EventV2.Service
          const profiles = [
            { id: "managed_skill", tools: ["skill"], managed: "skill" as const },
            { id: "managed_subagent", tools: ["subagent"], managed: "agent" as const },
            { id: "standard_tools", tools: ["skill", "subagent"], managed: undefined },
          ]
          for (const [index, profile] of profiles.entries()) {
            const sessionID = SessionV2.ID.make(`ses_${profile.id}`)
            yield* seedTerminalSession(db, sessionID, 20 + index, undefined, profile.tools)
            if (profile.managed === "skill")
              yield* source.activate({
                kind: "skill",
                id: "review",
                sessionID,
                agentID: AgentV2.ID.make("build"),
                source: "skill-tool",
                boundarySeq: ProjectArtifact.Revision.make(0),
                messageID: `msg_terminal_latest_${20 + index}`,
                callID: `call-skill-${20 + index}`,
              })
            if (profile.managed === "agent")
              yield* source.activate({
                kind: "agent",
                id: "review-agent",
                sessionID,
                agentID: AgentV2.ID.make("review-agent"),
                source: "subagent-launch",
                boundarySeq: ProjectArtifact.Revision.make(0),
                messageID: `msg_terminal_latest_${20 + index}`,
                callID: `call-subagent-${20 + index}`,
              })
            yield* events.publish(SessionEvent.Execution.Started, { sessionID })
            yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
            yield* waitFor(() => observed.length === index + 1)
          }

          expect(observed.map((input) => input.standardInvocationCount)).toEqual([0, 0, 2])
          expect(observed.map((input) => input.kind)).toEqual(["skill", "agent", "skill"])
          expect(observed.map((input) => input.externalConfounded)).toEqual([false, false, false])
        }),
      () => Effect.promise(() => fs.rm(dataRoot, { recursive: true, force: true })),
    ),
  )
})

function writeSkill(version: string, content: string, revision: number) {
  return writeDefinition(
    "review",
    version,
    { kind: "skill", name: "Review", description: "Reusable review guidance", content },
    revision,
  )
}

function writeDefinition(
  artifactID: string,
  version: string,
  definition: ProjectArtifact.Definition,
  revision: number,
  stage: ProjectArtifact.Stage = "trial",
) {
  return Effect.promise(async () => {
    const id = ProjectArtifact.ID.make(artifactID)
    const versionID = ProjectArtifact.VersionID.make(version)
    const rendered = ProjectArtifactAdapterRegistry.render(definition, { source: "agent" })
    const digest = ProjectArtifact.Digest.make(Hash.sha256(rendered))
    const root = path.join(dataRoot, "project-artifacts", storageID)
    const contentPath = ProjectArtifactPackage.activeContentPath(root, definition.kind, id)
    const markerPath = ProjectArtifactPackage.activeMarkerPath(root, definition.kind, id)
    await fs.mkdir(path.dirname(contentPath), { recursive: true })
    await fs.mkdir(path.dirname(markerPath), { recursive: true })
    await fs.writeFile(contentPath, rendered)
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        schema: 1,
        scopeID,
        storageID,
        kind: definition.kind,
        id,
        versionID,
        contentDigest: digest,
        contentRelpath: ProjectArtifact.ContentRelpath.make(path.basename(contentPath)),
      }),
    )
    const currentVersion: ProjectArtifact.Version = {
      id: versionID,
      state: stage,
      contentDigest: digest,
      contentRelpath: ProjectArtifact.ContentRelpath.make(path.basename(contentPath)),
      provenance: { source: "agent" },
      timeCreated: ProjectArtifact.TimestampMillis.make(1),
      timeStateChanged: ProjectArtifact.TimestampMillis.make(1),
    }
    details.set(`${definition.kind}:${id}`, {
      artifact: {
        scope: { type: "project", id: scopeID, projectID, storageID },
        kind: definition.kind,
        id,
        revision: ProjectArtifact.Revision.make(revision),
        stage,
        currentVersionID: versionID,
        timeCreated: ProjectArtifact.TimestampMillis.make(1),
        timeUpdated: ProjectArtifact.TimestampMillis.make(revision),
      },
      definition,
      currentVersion,
      versions: [currentVersion],
      diagnostics: [],
    })
  })
}

const encodeMessage = Schema.encodeSync(SessionMessage.Info)

function seedTerminalSession(
  db: Database.Interface["db"],
  sessionID: SessionV2.ID,
  index: number,
  workspaceID?: WorkspaceV2.ID,
  toolNames?: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: AbsolutePath.make("/workspace/source-project"),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
    if (workspaceID)
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: workspaceID,
          type: "local",
          name: "other",
          directory: "/workspace/source-project",
          project_id: projectID,
        })
        .onConflictDoNothing()
        .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        directory: "/workspace/source-project",
        workspace_id: workspaceID,
        agent: AgentV2.ID.make("build"),
        model: modelRef,
        title: "terminal",
      })
      .run()
    const time = DateTime.makeUnsafe(index + 1)
    const messages: SessionMessage.Info[] = [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make(`msg_terminal_old_${index}`),
        type: "assistant",
        agent: AgentV2.ID.make("build"),
        model: modelRef,
        content: [],
        tokens: { input: 91, output: 92, reasoning: 0, cache: { read: 93, write: 0 } },
        time: { created: time, completed: time },
      }),
      ...(toolNames ? [] : [SessionMessage.Skill.make({
        id: SessionMessage.ID.make(`msg_terminal_standard_${index}`),
        type: "skill",
        skill: SkillV2.ID.make("standard"),
        name: SkillV2.Name.make("Standard"),
        text: "standard prompt text",
        conflicts: { skills: [], instructions: [] },
        time: { created: time },
      })]),
      ...(toolNames ? [] : [SessionMessage.Skill.make({
        id: SessionMessage.ID.make(`msg_terminal_managed_${index}`),
        type: "skill",
        skill: SkillV2.ID.make("review"),
        name: SkillV2.Name.make("Review"),
        text: "managed prompt text",
        conflicts: { skills: [], instructions: [] },
        artifact: {
          scopeID,
          versionID: ProjectArtifact.VersionID.make("pav_terminal"),
          kind: "skill",
          id: ProjectArtifact.ID.make("review"),
          sourceScope: "project",
        },
        time: { created: time },
      })]),
      ...(toolNames ? [] : [SessionMessage.User.make({
        id: SessionMessage.ID.make(`msg_terminal_command_${index}`),
        type: "user",
        text: "private command input",
        metadata: {
          projectArtifact: {
            scopeID,
            versionID: ProjectArtifact.VersionID.make("pav_terminal"),
            kind: "command",
            id: ProjectArtifact.ID.make("review"),
            sourceScope: "project",
          },
        },
        time: { created: time },
      })]),
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make(`msg_terminal_latest_${index}`),
        type: "assistant",
        agent: AgentV2.ID.make("build"),
        model: modelRef,
        content: toolNames
          ? toolNames.map((name) => terminalTool(`call-${name}-${index}`, name, "completed", time))
          : [
              terminalTool(`call-skill-${index}`, "skill", "completed", time),
              terminalTool(`call-read-${index}`, "read", "completed", time),
              terminalTool(`call-write-${index}`, "write", "error", time),
            ],
        tokens: { input: 11, output: 12, reasoning: 1, cache: { read: 13, write: 2 } },
        time: { created: time, completed: time },
      }),
    ]
    yield* Effect.forEach(
      messages,
      (message, seq) => {
        const data: typeof SessionMessageTable.$inferInsert.data = encodeMessage(message)
        return db
          .insert(SessionMessageTable)
          .values({
            id: message.id,
            session_id: sessionID,
            type: message.type,
            seq: seq + 1,
            time_created: index + 1,
            data,
          })
          .run()
      },
      { discard: true },
    )
  })
}

function terminalTool(id: string, name: string, status: "completed" | "error", time: DateTime.Utc) {
  return SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name,
    state:
      status === "completed"
        ? { status, input: {}, content: [], structured: {} }
        : { status, input: {}, content: [], structured: {}, error: { type: "fixture", message: "private error" } },
    time: { created: time, completed: time },
  })
}

function observation(
  artifact: ProjectArtifact.ArtifactVersionIdentity,
  id: string,
) {
  return ProjectArtifact.Observation.make({
    id: ProjectArtifact.ObservationID.make(id),
    artifact,
    projectID,
    activationSetDigest: ProjectArtifact.Digest.make("b".repeat(64)),
    activeArtifactCount: ProjectArtifact.Revision.make(1),
    externalConfounded: false,
    eligible: true,
    terminalOutcome: "succeeded",
    goalStatus: "none",
    repeatFix: false,
    observedAt: ProjectArtifact.TimestampMillis.make(1),
  })
}

function waitFor(predicate: () => boolean, remaining = 100): Effect.Effect<void> {
  if (predicate()) return Effect.void
  if (remaining === 0) return Effect.die(new Error("Timed out waiting for source terminal observer"))
  return Effect.promise(() => Bun.sleep(1)).pipe(Effect.andThen(waitFor(predicate, remaining - 1)))
}
