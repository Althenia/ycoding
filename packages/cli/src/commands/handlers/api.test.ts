import { describe, expect, test } from "bun:test"
import { namedOperation } from "@ycoding-ai/client/v5"
import { rawRequest } from "./api"

describe("api request resolution", () => {
  test("preserves an opaque snapshot cursor and converts a numeric page limit", () => {
    expect(
      namedOperation("session.snapshot", { sessionID: "ses_fixture", limit: "1", before: "001" }, undefined, new Headers()),
    ).toMatchObject({ data: { params: { sessionID: "ses_fixture" }, query: { limit: 1, before: "001" } } })
  })

  test("rejects a missing path parameter", () => {
    expect(() =>
      namedOperation("session.get", {}, undefined, new Headers()),
    ).toThrow("Missing path parameter: sessionID")
  })

  test("keeps legacy names for documented operations", () => {
    expect(namedOperation("message.list", { sessionID: "ses_fixture" }, undefined, new Headers()).binding.method)
      .toBe("session.messages")
    expect(namedOperation("session.review.decide", { sessionID: "ses_fixture", itemID: "review_fixture" }, '{"decision":{"kind":"permission","reply":"once"}}', new Headers()).binding.method)
      .toBe("session.review.decide")
  })

  test("rejects selectors that cannot be represented without losing scope", () => {
    const headers = new Headers({ "x-ycoding-directory": "/selected" })
    expect(() => namedOperation("session.get", { sessionID: "ses_fixture" }, undefined, headers)).toThrow("Location overrides")
    expect(() => namedOperation("config.diagnostics", { "location[directory]": "/other" }, undefined, headers)).toThrow("Conflicting Location")
    expect(() => namedOperation("session.snapshot", { sessionID: "ses_fixture", limit: "one" }, undefined, new Headers())).toThrow("Invalid parameter: limit")
  })

  test("resolves curl-like method and path input", () => {
    expect(rawRequest(["post", "/api/foo"])).toEqual({ method: "POST", path: "/api/foo" })
    expect(rawRequest(["session.list"])).toBeUndefined()
  })
})
