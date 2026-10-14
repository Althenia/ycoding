import { expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"
import { operations } from "../src/generated/v5/operations.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()("test/RetainedHistoryLocation") {}

test("fork and revert declare additive HistoryPrunedError as HTTP 410 and v5 typed error", () => {
  const paths = OpenApi.fromApi(HttpApi.make("retained-history").add(makeSessionGroup(SessionLocationMiddleware))).paths
  for (const [name, id, path] of [["session.fork", 4022, "/api/session/{sessionID}/fork"], ["session.revert.stage", 4059, "/api/session/{sessionID}/revert/stage"]] as const) {
    expect(paths[path]?.post?.responses["410"]).toBeDefined()
    expect(paths[path]?.post?.responses["404"]).toBeDefined()
    const operation = operations.find((operation) => operation.diagnosticName === name)
    expect(operation?.operationId).toBe(id)
    expect(operation?.errorTypes).toContain("ycoding.v5.HistoryPrunedError")
    expect(operation?.errorTypes).toContain("ycoding.v5.MessageNotFoundError")
  }
})
