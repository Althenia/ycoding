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

test("declares the location-scoped durable session usage endpoint", () => {
  const endpoint = Api.groups["server.session"].endpoints["session.usage"]

  expect(endpoint.path).toBe("/api/session/:sessionID/usage")
  expect(endpoint.method).toBe("GET")
  expect(endpoint.middlewares.size).toBeGreaterThan(0)
  const success = endpoint.success.values().next().value
  expect(success).toBeDefined()
  expect(
    success
      ? Schema.is(success)({
          data: {
            logical: 1,
            physical: 1,
            helpers: 0,
            continued: 0,
            fallback: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        })
      : false,
  ).toBe(true)
})

test("declares the bounded paged subagent endpoint without changing control routes", () => {
  const endpoint = Api.groups["server.session"].endpoints["session.subagent.list"]

  expect(endpoint.path).toBe("/api/session/:parentID/subagent")
  expect(endpoint.method).toBe("GET")
  expect(endpoint.middlewares.size).toBeGreaterThan(0)
  const success = endpoint.success.values().next().value
  expect(success ? Schema.is(success)({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} }) : false).toBe(true)
  expect(Api.groups["server.session"].endpoints["session.subagent.message"].path).toBe(
    "/api/session/:parentID/subagent/:childID/message",
  )
  expect(Api.groups["server.session"].endpoints["session.subagent.cancel"].path).toBe(
    "/api/session/:parentID/subagent/:childID/cancel",
  )
  expect(Api.groups["server.session"].endpoints["session.subagent.resume"].path).toBe(
    "/api/session/:parentID/subagent/:childID/resume",
  )
})

test("rejects malformed and cross-parent subagent cursors before the paged read", async () => {
  const source = await Bun.file(new URL("../src/handlers/session.ts", import.meta.url)).text()
  const handler = source.slice(source.indexOf('"session.subagent.list"'), source.indexOf('"session.subagent.launch"'))

  expect(handler).toContain("SubagentCursor.parse")
  expect(handler).toContain("parsed.parentID !== ctx.params.parentID")
  expect(handler).toContain('new InvalidCursorError({ message: "Invalid cursor" })')
})

test("keeps a missing session failure typed in the session skills handler", async () => {
  const source = await Bun.file(new URL("../src/handlers/session.ts", import.meta.url)).text()
  const handler = source.slice(source.indexOf('"session.skills"'), source.indexOf('"session.synthetic"'))

  expect(handler).toContain('Effect.catchTag("Session.NotFoundError"')
  expect(handler).not.toContain("Effect.orDie")
})

test("passes compact job IDs through and maps compaction conflicts by durable job ID", async () => {
  const source = await Bun.file(new URL("../src/handlers/session.ts", import.meta.url)).text()
  const handler = source.slice(source.indexOf('"session.compact"'), source.indexOf('"session.wait"'))

  expect(handler).toContain("session.compact({ sessionID: ctx.params.sessionID, id: ctx.payload.id })")
  expect(handler).toContain("data: yield* session.compact")
  expect(handler).toContain('Effect.catchTag("Session.CompactionConflictError"')
  expect(handler).toContain("resource: error.jobID")
  expect(handler).toContain("${error.jobID}")
  expect(handler).not.toContain("SessionPending")
  expect(handler).not.toContain("summary")
})
