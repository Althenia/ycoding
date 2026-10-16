import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Decision } from "@ycoding-ai/core/decision"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { Session } from "@ycoding-ai/core/session"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { DecisionTool } from "@ycoding-ai/core/tool/decision"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ReadTool } from "@ycoding-ai/core/tool/read"
import { TodoWriteTool } from "@ycoding-ai/core/tool/todowrite"
import { GoalTool } from "@ycoding-ai/core/tool/goal"
import { Tools } from "@ycoding-ai/core/tool/tools"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const it = testEffect(reviewLayer())

for (const name of ["read", "question", "decision", "todowrite", "goal"] as const) it.effect(`${name} permission approval cannot authorize a changed payload`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const placement = yield* reviewLocation
  yield* Effect.promise(() => Bun.write(path.join(placement.directory, "page.txt"), "first\nsecond\n"))
  const root = yield* sessions.create({ location: placement })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(toolIdentity.agent, (agent) => { agent.permissions = [
    { action: "*", resource: "*", effect: "allow" }, { action: name, resource: "*", effect: "ask" },
  ] }))
  const permission = yield* Permission.Service.pipe(Effect.provide(located))
  const tools = yield* Tools.Service.pipe(Effect.provide(located))
  const registry = yield* ToolRegistry.Service.pipe(Effect.provide(located))
  const toolName = `review_${name}`
  if (name === "read") {
    const fs = yield* FSUtil.Service.pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node)))
    yield* registerToolPlugin(ReadTool.Plugin, toolName).pipe(Effect.provideService(Permission.Service, permission), Effect.provide(located), Effect.provideService(FSUtil.Service, fs))
  }
  if (name === "question") {
    const forms = yield* Form.Service.pipe(Effect.provide(located))
    yield* registerToolPlugin(QuestionTool.Plugin, toolName).pipe(Effect.provideService(Tools.Service, tools), Effect.provideService(Form.Service, forms), Effect.provideService(Permission.Service, permission))
  }
  if (name === "decision") {
    const decisions = yield* Decision.Service.pipe(Effect.provide(located))
    yield* registerToolPlugin(DecisionTool.Plugin, toolName).pipe(Effect.provideService(Tools.Service, tools), Effect.provideService(Decision.Service, decisions), Effect.provideService(Permission.Service, permission))
  }
  if (name === "todowrite") {
    const todos = yield* SessionTodo.Service.pipe(Effect.provide(located))
    yield* registerToolPlugin(TodoWriteTool.Plugin, toolName).pipe(Effect.provideService(Tools.Service, tools), Effect.provideService(SessionTodo.Service, todos), Effect.provideService(Permission.Service, permission))
  }
  if (name === "goal") {
    const autonomy = yield* SessionAutonomy.Service
    yield* registerToolPlugin(GoalTool.Plugin, toolName).pipe(Effect.provideService(Tools.Service, tools), Effect.provideService(SessionAutonomy.Service, autonomy), Effect.provideService(Permission.Service, permission))
  }
  const input = (changed: boolean) => name === "read" ? { path: "page.txt", offset: changed ? 2 : 1, limit: 1 }
    : name === "question" ? { questions: [{ header: "Evidence", question: changed ? "Changed question" : "Approved question", options: [] }] }
    : name === "decision" ? { provider: "agent", request: { state: changed ? "Changed evidence" : "Approved evidence", questions: [{ type: "predicate", name: "ready", instructions: "Is the evidence sufficient?" }] } }
    : name === "goal" ? { action: "update", status: changed ? "active" : "completed" }
    : { todos: [{ content: changed ? "Changed task" : "Approved task", status: "pending", priority: "high" }] }
  const call = (id: string, changed: boolean) => executeTool(registry, { sessionID: root.id, ...toolIdentity,
    call: { type: "tool-call", id, name: toolName, input: input(changed) } }).pipe(Effect.exit)
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  expect(Exit.isFailure(yield* call("first", false))).toBe(true)
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(root.id))[0]
  expect(item?.kind).toBe("permission")
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  expect(Exit.isFailure(yield* call("changed", true))).toBe(true)
  expect(Exit.isSuccess(yield* call("identical", false))).toBe(true)
}))
