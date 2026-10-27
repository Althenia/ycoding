import { describe, expect, test } from "bun:test"
import { ToolInvocation } from "../src/tool-invocation.js"
import { SessionEvent } from "../src/session-event.js"
import { Durable } from "../src/durable-event-manifest.js"

describe("logical tool invocations", () => {
  test("normalizes direct and nested invocations without treating discovery as a call", () => {
    const direct = {
      type: "tool",
      id: "direct",
      name: "skill",
      state: { status: "completed", input: { id: "a" }, structured: { name: "a" } },
    }
    const execute = {
      type: "tool",
      id: "outer",
      name: "execute",
      state: {
        status: "running",
        structured: {
          toolCalls: [
            { tool: "search", status: "completed" },
            {
              id: "inner",
              name: "skill",
              tool: "tools.skill",
              status: "completed",
              input: { id: "b" },
              structured: { name: "b" },
            },
          ],
        },
      },
    }
    expect(ToolInvocation.list(direct)).toEqual([
      {
        id: "direct",
        outerCallID: "direct",
        name: "skill",
        status: "completed",
        input: { id: "a" },
        structured: { name: "a" },
      },
    ])
    expect(ToolInvocation.list(execute)).toEqual([
      {
        id: "inner",
        outerCallID: "outer",
        name: "skill",
        status: "completed",
        input: { id: "b" },
        structured: { name: "b" },
      },
    ])
    expect(
      ToolInvocation.list({ type: "tool", name: "edit", state: { status: "completed", structured: { files: [] } } }),
    ).toEqual([{ name: "edit", status: "completed", structured: { files: [] } }])
    expect(ToolInvocation.list({ type: "tool", name: "edit", state: { structured: { files: [] } } })).toEqual([
      { name: "edit", structured: { files: [] } },
    ])
  })

  test("merges out-of-order leaf facts, stale progress, and terminal metadata without losing discovery", () => {
    const first: ToolInvocation.Settled = {
      id: "opaque-a",
      index: 0,
      name: "skill",
      tool: "tools.skill",
      status: "completed",
      input: { id: "audit" },
      structured: { name: "Audit" },
    }
    const second: ToolInvocation.Settled = {
      id: "opaque-b",
      index: 1,
      name: "question",
      tool: "tools.question",
      status: "error",
    }
    const discovery = { tool: "search", status: "completed", input: { query: "skill" } }
    const settled = ToolInvocation.settle(ToolInvocation.settle({}, second), first)
    expect(settled).toEqual({ toolCalls: [first, second] })
    expect(ToolInvocation.settle(settled, first)).toEqual(settled)
    expect(ToolInvocation.mergeStructured(settled, { output: "done", error: true, toolCalls: [discovery] })).toEqual({
      output: "done",
      error: true,
      toolCalls: [discovery, first, second],
    })
    expect(
      ToolInvocation.mergeStructured(settled, {
        toolCalls: [{ ...first, status: "running", structured: undefined }, discovery, second],
      }),
    ).toEqual({ toolCalls: [first, discovery, second] })
    expect(ToolInvocation.isSettled(discovery)).toBe(false)
    expect(ToolInvocation.isSettled({ ...first, index: -1 })).toBe(false)
    expect(Durable.get("session.tool.invocation-settled.1")).toBe(SessionEvent.Tool.InvocationSettled)
    expect(SessionEvent.Tool.Progress.durability).toBe("ephemeral")
  })
})
