import { expect, test } from "bun:test"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionContext } from "@ycoding-ai/core/session/context"

const configured = [
  { action: "*", resource: "*", effect: "allow" as const },
  { action: "edit", resource: "*", effect: "deny" as const },
]

test("subagents retain configured tools except nested orchestration tools", () => {
  const permissions = SessionContext.toolPermissions({ mode: "subagent", permissions: configured }, [])

  expect(Permission.evaluate("shell", "pwd", permissions).effect).toBe("allow")
  expect(Permission.evaluate("read", "README.md", permissions).effect).toBe("allow")
  expect(Permission.evaluate("edit", "README.md", permissions).effect).toBe("deny")
  expect(Permission.evaluate("subagent", "general", permissions).effect).toBe("deny")
  expect(Permission.evaluate("subagent_control", "send", permissions).effect).toBe("deny")
})

test("primary agents retain configured orchestration tools and inherited ceilings", () => {
  const permissions = SessionContext.toolPermissions(
    { mode: "primary", permissions: configured },
    [{ action: "shell", resource: "*", effect: "deny" }],
  )

  expect(Permission.evaluate("subagent", "general", permissions).effect).toBe("allow")
  expect(Permission.evaluate("subagent_control", "send", permissions).effect).toBe("allow")
  expect(Permission.evaluate("shell", "pwd", permissions).effect).toBe("deny")
})
