import { expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Image } from "@ycoding-ai/core/image"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { GoalTool } from "@ycoding-ai/core/tool/goal"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const authority = { denied: false }
const plugin = makeLocationNode({
  name: "test/goal-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GoalTool.Plugin)),
  deps: [Database.node, SessionAutonomy.node, ToolRegistry.toolsNode, Permission.node],
})
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, SessionAutonomy.node, ToolRegistry.node, plugin]),
  [
    [Permission.node, Layer.mock(Permission.Service, {
      evaluateEffective: () => Effect.succeed("ask" as const),
      assert: (input) => authority.denied
        ? Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }))
        : Effect.void,
    })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ],
))

it.effect("R7 registered goal tool preserves objective ownership, permissions, and bounded reporting", () =>
  Effect.gen(function* () {
    authority.denied = false
    const database = yield* Database.Service
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    const sessionID = Session.ID.make("ses_goal_tool_ownership")
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Goal tool ownership" }).run().pipe(Effect.orDie)
    const call = (input: Record<string, unknown>) => executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-goal", name: "goal", input },
    })
    expect((yield* call({ action: "set", text: "Agent-created objective" })).type).toBe("error")
    expect((yield* autonomy.get(sessionID)).goal).toBeUndefined()

    yield* autonomy.setGoal({ sessionID, text: "User objective", rawText: "User request", maxNoProgress: 2 })
    const original = yield* autonomy.get(sessionID)
    expect(yield* call({ action: "update", text: "Agent replacement", maxNoProgress: 9 })).toMatchObject({ type: "text", value: expect.stringContaining("Goal unchanged") })
    expect(yield* autonomy.get(sessionID)).toEqual(original)

    authority.denied = true
    expect((yield* call({ action: "report" })).type).toBe("error")
    expect(yield* autonomy.get(sessionID)).toEqual(original)
    authority.denied = false
    expect((yield* call({ action: "report" })).type).toBe("text")
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ text: "User objective", noProgress: 1, status: "active" })
    expect((yield* call({ action: "report" })).type).toBe("text")
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ text: "User objective", noProgress: 2, status: "exhausted" })
    expect((yield* call({ action: "report" })).type).toBe("error")
    expect((yield* call({ action: "update", status: "active" })).type).toBe("error")
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ status: "exhausted", noProgress: 2 })

    yield* autonomy.setGoal({ sessionID, text: "User replacement" })
    expect((yield* call({ action: "complete" })).type).toBe("text")
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ text: "User replacement", status: "completed" })
    yield* autonomy.setGoal({ sessionID, text: "User final objective" })
    expect((yield* call({ action: "stop" })).type).toBe("text")
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ text: "User final objective", status: "stopped" })
  }),
)

it.effect("records rework from a child on the goal owner and keeps a bare complete valid", () =>
  Effect.gen(function* () {
    authority.denied = false
    const database = yield* Database.Service
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    const ownerID = Session.ID.make("ses_goal_tool_rework_owner")
    const childID = Session.ID.make("ses_goal_tool_rework_child")
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({ id: ownerID, project_id: Project.ID.global, directory: "/project", title: "Owner" }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({ id: childID, parent_id: ownerID, project_id: Project.ID.global, directory: "/project", title: "Child" }).run().pipe(Effect.orDie)
    const call = (sessionID: Session.ID, input: Record<string, unknown>) => executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-goal", name: "goal", input },
    })
    yield* autonomy.setGoal({ sessionID: ownerID, text: "Finish every lane" })

    expect((yield* call(childID, { action: "rework", unit: "lane F", state: "opened" })).type).toBe("error")
    expect((yield* call(childID, { action: "rework", unit: "lane F", state: "resolved", evidence: "lane F relaunch completed and f.txt exists" })).type).toBe("error")
    expect((yield* autonomy.get(ownerID)).goal?.rework).toBeUndefined()

    expect(yield* call(childID, { action: "rework", unit: "lane F", reason: "lane F attempt 1 failed", state: "opened" }))
      .toMatchObject({ type: "text", value: expect.stringContaining("Rework opened for lane F") })
    expect((yield* autonomy.get(ownerID)).goal).toMatchObject({
      status: "active",
      phase: "rework",
      noProgress: 0,
      rework: 1,
      reworkOpen: [{ unit: "lane F", reason: "lane F attempt 1 failed" }],
    })
    expect((yield* autonomy.get(childID)).goal).toBeUndefined()

    expect((yield* call(ownerID, { action: "rework", unit: "lane F", state: "resolved" })).type).toBe("error")
    expect(yield* call(ownerID, { action: "rework", unit: "lane F", state: "resolved", evidence: "lane F relaunch completed and f.txt exists" }))
      .toMatchObject({ type: "text", value: expect.stringContaining("Rework resolved for lane F") })
    const resolved = (yield* autonomy.get(ownerID)).goal
    expect(resolved).toMatchObject({ status: "active", rework: 1, noProgress: 0 })
    expect(resolved?.reworkOpen).toBeUndefined()
    expect(resolved?.phase).toBeUndefined()

    expect(yield* call(ownerID, { action: "complete" })).toMatchObject({ type: "text", value: expect.stringContaining("Goal completed") })
    expect((yield* autonomy.get(ownerID)).goal).toMatchObject({ status: "completed", rework: 1 })
  }),
)

it.effect("rejects complete while the owner's own failure is unresolved and accepts it once the failing tool succeeds", () =>
  Effect.gen(function* () {
    authority.denied = false
    const database = yield* Database.Service
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    const sessionID = Session.ID.make("ses_goal_tool_failure_guard")
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Failure guard" }).run().pipe(Effect.orDie)
    const call = (input: Record<string, unknown>) => executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-goal", name: "goal", input },
    })
    yield* autonomy.setGoal({ sessionID, text: "Ship it" })
    yield* autonomy.recordStall({ sessionID, failure: { fingerprint: "tool.stalled:tool/shell", class: "tool.stalled", unit: "tool/shell" } })

    expect(yield* call({ action: "complete" })).toMatchObject({ type: "error", value: expect.stringContaining("tool.stalled:tool/shell") })
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ status: "active", phase: "rework", stalls: 1 })

    yield* autonomy.resolveFailure({ sessionID, tool: "read" })
    expect((yield* call({ action: "complete" })).type).toBe("error")
    yield* autonomy.resolveFailure({ sessionID, tool: "shell" })
    expect((yield* call({ action: "complete" })).type).toBe("text")
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ status: "completed", stalls: 1 })
  }),
)

it.effect("derives required checks from the user's goal request when the objective paraphrases it", () =>
  Effect.gen(function* () {
    authority.denied = false
    const database = yield* Database.Service
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    const sessionID = Session.ID.make("ses_goal_tool_raw_check")
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Raw check" }).run().pipe(Effect.orDie)
    const call = (input: Record<string, unknown>) => executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-goal", name: "goal", input },
    })
    const record = (seq: number, id: string, name: string, input: Record<string, unknown>, structured: Record<string, unknown>) => {
      const time = { created: DateTime.makeUnsafe(seq * 1_000), completed: DateTime.makeUnsafe(seq * 1_000) }
      const message = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make(`msg_raw_check_${id}`),
        type: "assistant",
        agent: Agent.defaultID,
        model: CatalogModel.Ref.make({ providerID: Provider.ID.make("fake"), id: CatalogModel.ID.make("fake-model") }),
        time,
        content: [{ type: "tool", id: `call_${id}`, name, time, state: { status: "completed", content: [], input, structured } }],
      })
      const { id: messageID, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
      return database.db.insert(SessionMessageTable)
        .values({ id: SessionMessage.ID.make(messageID), type, data, session_id: sessionID, seq, time_created: seq * 1_000 })
        .run()
        .pipe(Effect.orDie)
    }
    yield* autonomy.setGoal({ sessionID, text: "Finish and run the verification script", rawText: "Fix the parser, run ./verify.sh and complete only after it passes" })
    yield* record(1, "edit", "edit", { path: "src/parser.ts" }, { path: "src/parser.ts" })

    expect(yield* call({ action: "complete" })).toMatchObject({ type: "error", value: expect.stringContaining("Required check ./verify.sh is unrun") })
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ status: "active", noProgress: 0 })

    yield* record(2, "verify", "shell", { command: "./verify.sh" }, { exit: 0, truncated: false })
    expect(yield* call({ action: "complete" })).toMatchObject({ type: "text", value: expect.stringContaining("Goal completed") })
    expect((yield* autonomy.get(sessionID)).goal).toMatchObject({ status: "completed" })
  }),
)
