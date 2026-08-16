import { expect, test } from "bun:test"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"

const allow = { action: "shell", resource: "*", effect: "allow" as const }
const denyShell = { action: "shell", resource: "*", effect: "deny" as const }
const denyRead = { action: "read", resource: "/secret/*", effect: "deny" as const }

test("persists only unique deny rules", () => {
  expect(
    SessionPermissionCeiling.denyOnly([
      allow,
      denyShell,
      denyShell,
      { action: "edit", resource: "*", effect: "ask" },
    ]),
  ).toEqual([denyShell])
})

test("inherits every existing and caller deny without inheriting allows", () => {
  expect(SessionPermissionCeiling.inherit([denyRead], [allow, denyShell])).toEqual([denyRead, denyShell])
})

test("ignores malformed stored permission data", () => {
  expect(SessionPermissionCeiling.read([{ effect: "deny" }])).toEqual([])
})
