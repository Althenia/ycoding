import { expect, test } from "bun:test"
import { previewBuildNumber } from "../src/preview-build"

test("local preview builds are unique within the same minute", () => {
  const first = previewBuildNumber({ now: new Date("2026-07-21T09:42:10.123Z") })
  const second = previewBuildNumber({ now: new Date("2026-07-21T09:42:11.456Z") })

  expect(first).not.toBe(second)
  expect(first).toBe("20260721094210123")
  expect(second).toBe("20260721094211456")
})

test("GitHub preview build numbering remains stable", () => {
  expect(previewBuildNumber({ runNumber: "42" })).toBe("42")
  expect(previewBuildNumber({ runNumber: "42", runAttempt: "1" })).toBe("42")
  expect(previewBuildNumber({ runNumber: "42", runAttempt: "3" })).toBe("42.3")
})
