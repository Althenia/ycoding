import { describe, expect, test } from "bun:test"
import { shouldShowOfflineNotice } from "./online"

describe("offline notice", () => {
  test("shows only while the browser reports no connectivity", () => {
    expect(shouldShowOfflineNotice(false)).toBe(true)
    expect(shouldShowOfflineNotice(true)).toBe(false)
  })
})
