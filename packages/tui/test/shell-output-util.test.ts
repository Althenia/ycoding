import { expect, test } from "bun:test"
import { appendShellOutputTail, SHELL_OUTPUT_TAIL_LIMIT } from "../src/routes/shell-output/util"

test("appending shell output keeps only the bounded tail", () => {
  expect(SHELL_OUTPUT_TAIL_LIMIT).toBeGreaterThan(0)
  const first = appendShellOutputTail("", "line 1\nline 2\n")
  expect(first).toBe("line 1\nline 2\n")

  const huge = appendShellOutputTail(first, "x".repeat(SHELL_OUTPUT_TAIL_LIMIT + 10_000))
  expect(huge.length).toBeLessThanOrEqual(SHELL_OUTPUT_TAIL_LIMIT)
  expect(huge.endsWith("x".repeat(100))).toBe(true)
  expect(huge).not.toContain("line 1")
})

test("tail trimming prefers a line boundary when one is in range", () => {
  const kept = appendShellOutputTail("", `${"a".repeat(25)}\nkept line kept line\n`, 30)
  expect(kept).toBe("kept line kept line\n")
  expect(appendShellOutputTail("abc", "def", 4)).toBe("cdef")
  expect(appendShellOutputTail("abc", "", 4)).toBe("abc")
})
