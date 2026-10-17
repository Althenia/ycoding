import { expect, test } from "bun:test"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { Api } from "../src/api"
import { SessionLocationMiddleware } from "../src/middleware/session-location"

const nativeOnly = [
  "providerUsage.forecast",
  "session.promptCosts",
  "session.taskCosts",
  "session.review.list",
  "session.review.decide",
  "incident.report",
  "incident.recent",
  "incident.guidance.get",
  "incident.guidance.clear",
]

test("the reference API exposes implemented routes without narrowing the client contract", () => {
  const client = Object.values(ClientApi.groups).flatMap((group) => Object.keys(group.endpoints))
  const reference = Object.values(Api.groups).flatMap((group) => Object.keys(group.endpoints))
  for (const name of nativeOnly) {
    expect(client).toContain(name)
    expect(reference).not.toContain(name)
  }
  expect(reference.sort()).toEqual(client.filter((name) => !nativeOnly.includes(name)).sort())
})

test("the reference API retains no incident group or route until its handlers exist", () => {
  expect(Object.keys(Api.groups)).not.toContain("server.incident")
  expect(Object.keys(ClientApi.groups)).toContain("server.incident")
})

test("reference composition preserves endpoint authorization and Session placement", () => {
  for (const group of Object.values(Api.groups)) {
    for (const endpoint of Object.values(group.endpoints)) {
      if (endpoint.name === "health.get") continue
      expect(endpoint.middlewares.has(Authorization)).toBe(true)
    }
  }
  expect(
    Api.groups["server.session"].endpoints["session.autonomy.get"].middlewares.has(SessionLocationMiddleware),
  ).toBe(true)
})
