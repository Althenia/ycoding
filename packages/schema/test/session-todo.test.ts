import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionTodo } from "../src/session-todo.js"

const decode = Schema.decodeUnknownSync(SessionTodo.Info)

test("validates current todo statuses and priorities", () => {
  expect(decode({ content: "Run tests", status: "in_progress", priority: "high" })).toEqual({
    content: "Run tests",
    status: "in_progress",
    priority: "high",
  })
  expect(() => decode({ content: "Run tests", status: "unknown", priority: "high" })).toThrow()
  expect(() => decode({ content: "Run tests", status: "pending", priority: "urgent" })).toThrow()
})

test("publishes ordered session todo replacements", () => {
  expect(SessionTodo.Event.Updated.type).toBe("todo.updated")
  expect(SessionTodo.Event.Definitions).toEqual([SessionTodo.Event.Updated])
})
