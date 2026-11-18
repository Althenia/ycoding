import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { Markdown, safeHref } from "./markdown"

test("allows only navigable links, and never loads image or script protocols", () => {
  expect(safeHref("https://example.com/a")).toBe("https://example.com/a")
  expect(safeHref("mailto:person@example.com")).toBe("mailto:person@example.com")
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:alert(1)", "file:///etc/passwd", "//example.com", "JaVaScRiPt:alert(1)"]) {
    expect(safeHref(url)).toBeUndefined()
  }
})

test("fences label the language and provide an icon-led Copy control", () => {
  const html = renderToString(() => createComponent(Markdown, { text: "``` ts  \n  const answer = 42\n\n    return answer\n```\n\n```\nplain\n```" }))
  for (const label of ["ts", "text"]) expect(html).toMatch(new RegExp(`class="transcript-md__code-head"[^>]*><span[^>]*>${label}</span><button[^>]*>.*?<svg[\\s\\S]*?<span[^>]*>Copy</span>`))
  expect(html).toContain("  const answer = 42\n\n    return answer")
})
