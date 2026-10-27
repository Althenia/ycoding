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

describe("MCP native decision tools", () => {
  test("publishes the six typed feature operations without custom metadata", () => {
    const names = RemoteMcpSchemas.tools.map((tool) => tool.name)
    const operations = ["session.permission.reply", "session.guardrail.reply", "session.form.reply", "session.form.cancel", "session.review.decide", "session.subagent.answer"]
    for (const operation of operations) {
      const tool = RemoteMcpSchemas.tools.find((tool) => tool.operation === operation)
      expect(tool).toBeDefined()
      expect(names).toContain(operation.replaceAll(".", "_"))
      expect(tool?.inputSchema.additionalProperties).toBe(false)
      expect(Object.keys(tool?.annotations ?? {}).toSorted()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"])
      expect(JSON.stringify(tool)).not.toContain("requireExplicitDecision")
    }
    for (const operation of operations) expect(RemoteMcpSchemas.excludedOperations.map(String)).not.toContain(operation)
  })
})

describe("MCP Dots device delegation", () => {
  test("publishes authenticated device grant administration and decision inventory tools", () => {
    const tools = RemoteMcpSchemas.tools
    const byOperation = (operation: string) => tools.find((tool) => tool.operation === operation)
    for (const operation of [
      "session.dots.delegation.device.create",
      "session.dots.delegation.device.read",
      "session.dots.delegation.device.revoke",
      "session.dots.decisions.list",
    ]) expect(byOperation(operation)).toBeDefined()
    expect(byOperation("session.dots.delegation.device.create")?.mutation).toBe(true)
    expect(byOperation("session.dots.delegation.device.read")?.mutation).toBe(false)
    expect(byOperation("session.dots.delegation.device.revoke")?.mutation).toBe(true)
    expect(byOperation("session.dots.decisions.list")?.mutation).toBe(false)
    expect(tools.find((tool) => tool.name === "session_dots_exchange_create")?.operation).toBe("session.dots.exchange.create")
    expect(tools.find((tool) => tool.name === "session_dots_decision_form")?.operation).toBe("session.dots.exchange.create")
    expect(byOperation("session.review.decide")?.name).toBe("session_review_decide")
    expect(byOperation("session.permission.reply")?.name).toBe("session_permission_reply")
  })
})

describe("MCP autonomy schema", () => {
  test("session_autonomy_set takes category modes, strict enums, and a separate sleep", () => {
    const tool = RemoteMcpSchemas.tools.find((tool) => tool.name === "session_autonomy_set")
    if (!tool) throw new Error("Missing tool session_autonomy_set")
    const serialized = JSON.stringify(tool.inputSchema)
    for (const field of ["permissions", "guardrails", "answers"])
      expect(serialized).toContain(`"${field}":{"type":"string","enum":["manual","yolo","auto"]}`)
    expect(serialized).toContain('"sleep":{"type":"boolean"}')
    expect(serialized).toContain('"minProperties":1')
    for (const removed of ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"])
      expect(serialized).not.toContain(`"${removed}":`)
    expect(tool.description).toContain("manual")
    expect(tool.description).toContain("hard or custom-rule review approvals require an authorized typed decision")
    expect(tool.description).not.toContain("approves nothing by itself")
  })

  test("session_goal_set takes no yolo field", () => {
    const tool = RemoteMcpSchemas.tools.find((tool) => tool.name === "session_goal_set")
    if (!tool) throw new Error("Missing tool session_goal_set")
    expect(JSON.stringify(tool.inputSchema)).not.toContain("yolo")
  })
})
