import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessagesQuery } from "../src/groups/message.js"

describe("SessionMessagesQuery", () => {
  test("accepts the 1000-message archive page requested by the TUI", () => {
    expect(Schema.decodeUnknownSync(SessionMessagesQuery)({ limit: "1000" })).toEqual({ limit: 1000 })
  })

  test("rejects archive pages above the supported cap", () => {
    expect(() => Schema.decodeUnknownSync(SessionMessagesQuery)({ limit: "1001" })).toThrow()
  })
})
