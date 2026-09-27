import { expect, test } from "bun:test"
import { safeHref } from "./markdown"

test("allows only navigable links, and never loads image or script protocols", () => {
  expect(safeHref("https://example.com/a")).toBe("https://example.com/a")
  expect(safeHref("mailto:person@example.com")).toBe("mailto:person@example.com")
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:alert(1)", "file:///etc/passwd", "//example.com", "JaVaScRiPt:alert(1)"]) {
    expect(safeHref(url)).toBeUndefined()
  }
})
