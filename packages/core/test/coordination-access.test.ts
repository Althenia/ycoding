import { describe, expect, test } from "bun:test"
import { CoordinationAccess } from "../src/session/coordination-access"

describe("coordination role tool restrictions", () => {
  test("ordinary Sessions retain their configured tools", () => {
    expect(CoordinationAccess.allowsTool(undefined, "shell")).toBe(true)
  })

  test("coordinators can inspect and delegate but cannot implement through direct or namespaced tools", () => {
    const access = { role: "coordinator" as const }
    for (const name of ["read", "glob", "grep", "decision", "question", "coordination", "subagent", "subagent_control", "task_complete", "execute"])
      expect(CoordinationAccess.allowsTool(access, name), name).toBe(true)
    for (const name of ["shell", "patch", "edit", "write", "browser", "computer", "custom_shell", "mcp_database_update"])
      expect(CoordinationAccess.allowsTool(access, name), name).toBe(false)
    expect(CoordinationAccess.rules(access, ["read", "patch", "mcp_database_update"])).toEqual([
      { action: "patch", resource: "*", effect: "deny" },
      { action: "mcp_database_update", resource: "*", effect: "deny" },
    ])
  })

  test("observers cannot delegate or execute mutations", () => {
    for (const name of ["subagent", "subagent_control", "shell", "patch", "question", "goal"])
      expect(CoordinationAccess.allowsTool({ role: "observer" }, name), name).toBe(false)
    expect(CoordinationAccess.allowsTool({ role: "observer" }, "read")).toBe(true)
  })

  test("worker assignments restrict tools without granting subdelegation", () => {
    const access = { role: "worker" as const, allowedTools: ["read", "patch"] }
    expect(CoordinationAccess.allowsTool(access, "read")).toBe(true)
    expect(CoordinationAccess.allowsTool(access, "patch")).toBe(true)
    expect(CoordinationAccess.allowsTool(access, "shell")).toBe(false)
    expect(CoordinationAccess.allowsTool(access, "subagent")).toBe(false)
    expect(CoordinationAccess.allowsTool({ role: "worker" }, "patch")).toBe(false)
  })
})
