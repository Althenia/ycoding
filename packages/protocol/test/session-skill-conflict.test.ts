import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionSkillConflictResolve } from "../src/groups/session.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionLocationMiddleware",
) {}

test("declares the location-scoped session skill conflict resolution operation", () => {
  const endpoint = makeSessionGroup(SessionLocationMiddleware).endpoints["session.resolveSkillConflict"]

  expect(endpoint.path).toBe("/api/session/:sessionID/skill/resolve")
  expect(endpoint.method).toBe("POST")
  expect(endpoint.middlewares.size).toBeGreaterThan(0)
  expect(endpoint.success.size).toBe(1)
  expect(endpoint.error.size).toBe(2)
  expect(Schema.is(SessionSkillConflictResolve)({ winner: "skill_winner", loser: "skill_loser" })).toBe(true)
})
