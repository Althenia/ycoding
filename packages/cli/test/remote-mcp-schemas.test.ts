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
