import { expect } from "bun:test"
import { Agent } from "@ycoding-ai/core/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Form } from "@ycoding-ai/core/form"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { Database } from "@ycoding-ai/core/database/database"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(ToolRegistry.standaloneNode, [
  [Form.node, Layer.mock(Form.Service, {})],
  [Permission.node, Layer.mock(Permission.Service, {})],
  [SessionTodo.node, Layer.mock(SessionTodo.Service, {})],
  [SessionAutonomy.node, Layer.mock(SessionAutonomy.Service, {})],
  [Database.node, Layer.mock(Database.Service, { db: undefined as unknown as Database.Interface["db"] })],
]))
const sessionID = Session.ID.make("ses_output")
const input = { sessionID, agent: Agent.ID.make("build"), messageID: SessionMessage.ID.make("msg_output"),
  call: { type: "tool-call" as const, id: "call_output", name: "question", input: {} } }

it.effect("standalone exposes only approved direct tools and refuses forbidden dispatch", () => Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = Tool.make({ description: "Synthetic tool", input: Schema.Struct({}), output: Schema.Struct({}), execute: () => Effect.succeed({}) })
  yield* registry.register({ question: tool, todowrite: tool, goal: tool, task_complete: tool, shell: tool }, { codemode: false })
  const request = yield* registry.materialize()
  expect(request.definitions.map((item) => item.name)).toEqual(["goal", "question", "task_complete", "todowrite"])
  for (const name of ["shell", "execute"]) {
    const result = yield* request.settle({ ...input, call: { ...input.call, name } })
    expect(result.error?.type).toBe("tool.unknown")
  }
}))

for (const [name, content, fails] of [
  ["bounded text", [{ type: "text", text: "hello" }], false],
  ["byte limit", [{ type: "text", text: "x".repeat(50 * 1024 + 1) }], true],
  ["line limit", [{ type: "text", text: "x\n".repeat(2000) }], true],
  ["file", [{ type: "file", data: "eA==", mime: "text/plain" }], true],
] as const) it.effect(`standalone rejects unsafe ${name} output and progress`, () => Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  for (const progress of [false, true]) {
    yield* Effect.scoped(Effect.gen(function* () {
      yield* registry.register({ question: Tool.make({
        description: "Synthetic output", input: Schema.Struct({}), output: Schema.Struct({}),
        execute: (_, context) => progress ? context.progress({ structured: {}, content }).pipe(Effect.as({})) : Effect.succeed({}),
        toModelOutput: () => progress ? [{ type: "text", text: "done" }] : content,
      }) }, { codemode: false })
      const materialized = yield* registry.materialize()
      const result = yield* materialized.settle({ ...input, progress: () => Effect.void })
      expect(result.result.type === "error").toBe(fails)
      expect(result.outputPaths).toBeUndefined()
      if (!fails && !progress) expect(result.output?.content).toEqual(content)
    }))
  }
}))

it.effect("standalone rejects oversized structured-only output and progress", () => Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  for (const progress of [false, true]) {
    yield* Effect.scoped(Effect.gen(function* () {
      yield* registry.register({ question: Tool.make({
        description: "Synthetic output", input: Schema.Struct({}), output: Schema.Struct({ text: Schema.String }),
        execute: (_, context) => progress
          ? context.progress({ structured: { text: "x".repeat(50 * 1024 + 1) } }).pipe(Effect.as({ text: "ok" }))
          : Effect.succeed({ text: "x".repeat(50 * 1024 + 1) }),
        toModelOutput: () => [],
      }) }, { codemode: false })
      const result = yield* (yield* registry.materialize()).settle({ ...input, progress: () => Effect.void })
      expect(result.result.type).toBe("error")
      expect(result.outputPaths).toBeUndefined()
    }))
  }
}))
