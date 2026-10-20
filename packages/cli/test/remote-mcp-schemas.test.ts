import { describe, expect, test } from "bun:test"
import { RemoteMcpSchemas } from "../src/remote-mcp-schemas"

type InputSchema = {
  pattern?: string
  properties?: Record<string, InputSchema>
  items?: InputSchema
}

function schema(name: string, ...path: string[]): InputSchema {
  const tool = RemoteMcpSchemas.tools.find((tool) => tool.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return path.reduce((value, key) => {
    const next = key === "items" ? value.items : value.properties?.[key]
    if (!next) throw new Error(`Missing schema ${name}.${path.join(".")}`)
    return next
  }, tool.inputSchema as InputSchema)
}

// Some MCP consumers use a full-string matcher for JSON Schema patterns.
// Published patterns must consume valid values, not merely match a prefix.
function matches(pattern: string, value: string, full: boolean) {
  const match = new RegExp(pattern).exec(value)
  return match !== null && (!full || match[0] === value)
}

describe("MCP catalog pattern interoperability", () => {
  for (const [name, path, prefix] of [
    ["session_prompt", ["input", "id"], "msg_"],
    ["session_command", ["input", "id"], "msg_"],
    ["session_skill", ["input", "id"], "msg_"],
    ["session_prompt_costs", ["input", "inputIDs", "items"], "msg_"],
    ["session_permission_reply", ["input", "requestID"], "per_"],
    ["session_guardrail_reply", ["input", "requestID"], "grq_"],
  ] as const) {
    test(`${name} accepts complete unique IDs and rejects malformed IDs`, () => {
      const pattern = schema(name, ...path).pattern!
      for (const full of [false, true]) {
        for (const value of [`${prefix}dot_helloworld_20261018_0326`, `${prefix}14d0f9000001QuestionPocA`, `${prefix}next-id`]) {
          expect(matches(pattern, value, full)).toBe(true)
        }
        for (const value of [prefix, `other_${prefix}id`, `${prefix}bad id`, `${prefix}bad/id`]) {
          expect(matches(pattern, value, full)).toBe(false)
        }
      }
    })
  }

  for (const [name, path] of [
    ["session_prompt", ["input", "skills", "items"]],
    ["session_prompt_generate", ["input", "intent"]],
  ] as const) {
    test(`${name} accepts nonblank multi-character and multiline values`, () => {
      const pattern = schema(name, ...path).pattern!
      for (const full of [false, true]) {
        for (const value of ["a", "code-review", " Draft a greeting ", "first line\nsecond line", "\ncontent\n"]) {
          expect(matches(pattern, value, full)).toBe(true)
        }
        for (const value of ["", " ", "\n\t\r"]) expect(matches(pattern, value, full)).toBe(false)
      }
    })
  }
})

describe("MCP autonomy schema", () => {
  test("session_autonomy_set offers one boolean toggle per branch and no numeric yolo", () => {
    const tool = RemoteMcpSchemas.tools.find((tool) => tool.name === "session_autonomy_set")
    if (!tool) throw new Error("Missing tool session_autonomy_set")
    const serialized = JSON.stringify(tool.inputSchema)
    for (const field of ["yolo", "autoPermission", "autoGuardrail", "autoAnswer", "sleep"])
      expect(serialized).toContain(`"${field}":{"type":"boolean"}`)
    expect(serialized).not.toContain('"maximum":2')
    expect(tool.description).toContain("approves nothing by itself")
    expect(tool.description).toContain("hard reviews still ask a human")
  })

  test("session_goal_set keeps its optional boolean yolo beside the goal", () => {
    const tool = RemoteMcpSchemas.tools.find((tool) => tool.name === "session_goal_set")
    if (!tool) throw new Error("Missing tool session_goal_set")
    expect(JSON.stringify(tool.inputSchema)).toContain('"yolo":{"type":"boolean"}')
  })
})
