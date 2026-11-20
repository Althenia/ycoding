import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { Markdown, safeHref } from "./markdown"

const render = (text: string) => renderToString(() => createComponent(Markdown, { text }))

test("allows only navigable links, and never loads image or script protocols", () => {
  expect(safeHref("https://example.com/a")).toBe("https://example.com/a")
  expect(safeHref("mailto:person@example.com")).toBe("mailto:person@example.com")
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:alert(1)", "file:///etc/passwd", "//example.com", "JaVaScRiPt:alert(1)"]) {
    expect(safeHref(url)).toBeUndefined()
  }
})

test("renders headings, lists, inline code, emphasis, links and tables as semantic elements", () => {
  const html = render("## Plan\n\n1. First `npm test`\n2. **Second** and *third*\n\n- [x] done\n- [ ] open\n\n| Name | Value |\n| --- | --- |\n| a | `b` |\n\n[docs](https://example.com/docs)")
  expect(html).toMatch(/role="heading"[^>]*aria-level="2"[^>]*>Plan<|aria-level="2"[^>]*role="heading"[^>]*>Plan</)
  expect(html).toContain("<ol")
  expect(html).toContain("<code>npm test</code>")
  expect(html).toContain("<strong>Second</strong>")
  expect(html).toContain("<em>third</em>")
  expect(html).toContain("<ul")
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*aria-label="Completed task"|aria-label="Completed task"[^>]*type="checkbox"/)
  expect(html).toContain("<table")
  expect(html).toMatch(/<th[^>]*>Name<\/th>/)
  expect(html).toContain("<code>b</code>")
  expect(html).toMatch(/<a href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer"/)
})

test("keeps raw HTML and dangerous links inert", () => {
  const html = render("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) and ![pic](data:image/png;base64,AAAA) and [ok](https://example.com)\n\n<a href=\"javascript:alert(2)\">raw</a>")
  expect(html).not.toContain("<script")
  expect(html).not.toContain("<img")
  expect(html).not.toMatch(/<a\b[^>]*href="javascript:/i)
  expect(html).not.toMatch(/<a\b[^>]*href="data:/i)
  expect(html).toContain("&lt;script>alert(1)")
  expect(html).toContain("click")
  expect(html).toContain("href=\"https://example.com/\"")
})

test("fences render a card with the </> icon, the language label, a Wrap lines toggle and a Copy code button", () => {
  const html = render("``` ts  \n  const answer = 42\n\n    return answer\n```\n\n```\nplain\n```\n\n```cobol\nDISPLAY 1\n```")
  const cards = html.split("transcript-md__code\"").slice(1)
  expect(cards).toHaveLength(3)
  expect(cards.map((card) => card.match(/transcript-md__code-lang[^>]*>.*?<span[^>]*>([^<]*)<\/span><\/span>/)?.[1])).toEqual(["TypeScript", "Code", "Code"])
  for (const card of cards) {
    expect(card).toContain("<svg")
    expect(card).toMatch(/data-action="wrap"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-action="wrap"/)
    expect(card).toContain("Wrap lines")
    expect(card).toMatch(/aria-label="Copy code"/)
    expect(card).toContain("<span>Copy code</span>")
  }
  expect(cards[0]).toContain("code-token code-token--keyword")
  expect(cards[0]).toContain("code-token--number")
  expect(cards[2]).not.toContain("code-token--")
  expect(html.replace(/<[^>]+>/g, "")).toContain("  const answer = 42\n\n    return answer")
})

test("language labels cover every alias and keep the raw code text intact", () => {
  const labels: Record<string, string> = { md: "Markdown", markdown: "Markdown", ts: "TypeScript", tsx: "TypeScript", typescript: "TypeScript", js: "JavaScript", jsx: "JavaScript", javascript: "JavaScript", rs: "Rust", rust: "Rust", py: "Python", python: "Python", json: "JSON", sh: "Bash", bash: "Bash", shell: "Bash", zsh: "Bash" }
  for (const [alias, label] of Object.entries(labels)) {
    const html = render(`\`\`\`${alias}\nx\n\`\`\``)
    expect(html, alias).toContain(`<span>${label}</span>`)
    expect(html.replace(/<[^>]+>/g, "")).toContain("x")
  }
})

test("a fenced block's text content equals the raw code", () => {
  const code = "const s = \"<b>&</b>\"; // 1 < 2\nif (a && b) { return `x${y}` }"
  const html = render(`\`\`\`ts\n${code}\n\`\`\``)
  const body = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"))
  const decoded = body.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&amp;", "&")
  expect(decoded).toBe(code)
})
