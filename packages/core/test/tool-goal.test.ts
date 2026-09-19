import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Image } from "@ycoding-ai/core/image"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
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
  deps: [SessionAutonomy.node, ToolRegistry.toolsNode, PermissionV2.node],
})
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, SessionAutonomy.node, ToolRegistry.node, plugin]),
  [
    [PermissionV2.node, Layer.mock(PermissionV2.Service, {
      evaluateEffective: () => Effect.succeed("ask" as const),
      assert: (input) => authority.denied
        ? Effect.fail(new PermissionV2.BlockedError({ rules: [], permission: input.action, resources: input.resources }))
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
    const sessionID = SessionV2.ID.make("ses_goal_tool_ownership")
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
