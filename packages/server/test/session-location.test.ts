import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Api } from "../src/api"
import { sessionLocationID } from "../src/middleware/session-location"

test("resolves Session location from standard and parent route parameters", () => {
  expect(sessionLocationID({ sessionID: "ses_direct" })).toBe("ses_direct")
  expect(sessionLocationID({ parentID: "ses_parent" })).toBe("ses_parent")
})

test("declares the location-scoped session skills endpoint", () => {
  const endpoint = Api.groups["server.session"].endpoints["session.skills"]

  expect(endpoint.path).toBe("/api/session/:sessionID/skills")
  expect(endpoint.method).toBe("GET")
  expect(endpoint.middlewares.size).toBeGreaterThan(0)
  expect(endpoint.success.size).toBe(1)
  expect(endpoint.error.size).toBe(1)
  const response: unknown = {
    data: [
      {
        id: "skill_test",
        name: "test",
        activatedBy: "reference",
        activationMessageID: "msg_test",
        content: "# Test",
        conflicts: [],
        declarations: { skills: [], instructions: [] },
        state: "active",
      },
    ],
  }
  const success = endpoint.success.values().next().value
  expect(success).toBeDefined()
  expect(success ? Schema.is(success)(response) : false).toBe(true)
})

test("keeps a missing session failure typed in the session skills handler", async () => {
  const source = await Bun.file(new URL("../src/handlers/session.ts", import.meta.url)).text()
  const handler = source.slice(source.indexOf('"session.skills"'), source.indexOf('"session.synthetic"'))

  expect(handler).toContain('Effect.catchTag("Session.NotFoundError"')
  expect(handler).not.toContain("Effect.orDie")
})
