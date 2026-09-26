import { describe, expect, test } from "bun:test"
import { DOC_INDEX, DOC_PAGES, sectionId } from "../content/docs/registry"
import type { DocPage } from "../content/docs/types"
import { docMarkdownPath, renderDocMarkdown } from "./markdown"

const origin = "https://example.test"
const related = DOC_PAGES[0]!

const page: DocPage = {
  slug: "sample/page",
  title: "Sample page",
  group: "Use",
  description: "A page with every block kind.",
  sections: [
    {
      heading: "Blocks & more",
      blocks: [
        { kind: "paragraph", text: "Run `ycoding` in a project." },
        { kind: "code", language: "sh", label: "Install", code: "bun install\nbun run dev" },
        { kind: "code", language: "json", code: '{ "a": 1 }' },
        { kind: "list", items: ["First `one`", "Second"] },
        { kind: "list", ordered: true, items: ["Alpha", "Beta"] },
        { kind: "steps", items: [{ title: "Install", text: "Get the build." }, { title: "Run", text: "Start `ycoding`." }] },
        { kind: "callout", tone: "info", title: "Note", text: "Informational." },
        { kind: "callout", tone: "warning", title: "Careful", text: "Warning text." },
        { kind: "callout", tone: "tip", title: "Hint", text: "Tip text." },
        { kind: "table", head: ["Key", "Value"], rows: [["`a|b`", "one"], ["c", "two"]] },
        {
          kind: "cards",
          items: [
            { title: "Docs home", text: "Overview.", href: "/docs" },
            { title: "Related page", text: "Internal.", href: `/docs/${related.slug}#intro` },
            { title: "Releases", text: "External.", href: "https://github.com/Althenia/ycoding/releases" },
            { title: "Changelog", text: "Site route.", href: "/changelog" },
          ],
        },
        { kind: "related", slugs: [related.slug, "does-not-exist"] },
      ],
    },
  ],
}

describe("renderDocMarkdown", () => {
  test("renders the page header with its description and canonical page URL", () => {
    expect(renderDocMarkdown(page, origin).startsWith(
      "# Sample page\n\n> A page with every block kind.\n\nCanonical page: https://example.test/docs/sample/page\n\n",
    )).toBe(true)
  })

  test("anchors each section heading with the site's section id", () => {
    expect(renderDocMarkdown(page, origin)).toContain(`<a id="${sectionId(page, 0)}"></a>\n## Blocks & more\n\n`)
    expect(sectionId(page, 0)).toBe("blocks-more")
  })

  test("keeps inline code in paragraphs and lists", () => {
    const markdown = renderDocMarkdown(page, origin)
    expect(markdown).toContain("\n\nRun `ycoding` in a project.\n\n")
    expect(markdown).toContain("- First `one`\n- Second\n\n")
    expect(markdown).toContain("1. Alpha\n2. Beta\n\n")
  })

  test("fences code with its language and optional label", () => {
    const markdown = renderDocMarkdown(page, origin)
    expect(markdown).toContain('```sh title="Install"\nbun install\nbun run dev\n```\n\n')
    expect(markdown).toContain('```json\n{ "a": 1 }\n```\n\n')
  })

  test("widens the fence when the code itself contains a fence", () => {
    const fenced: DocPage = { ...page, sections: [{ heading: "Code", blocks: [{ kind: "code", language: "md", code: "```sh\nls\n```" }] }] }
    expect(renderDocMarkdown(fenced, origin)).toContain("````md\n```sh\nls\n```\n````\n")
  })

  test("renders steps as a numbered list with bold titles", () => {
    expect(renderDocMarkdown(page, origin)).toContain("1. **Install**: Get the build.\n2. **Run**: Start `ycoding`.\n\n")
  })

  test("renders callouts as alerts that keep their tone and title", () => {
    const markdown = renderDocMarkdown(page, origin)
    expect(markdown).toContain("> [!NOTE]\n> **Note**\n> Informational.\n\n")
    expect(markdown).toContain("> [!WARNING]\n> **Careful**\n> Warning text.\n\n")
    expect(markdown).toContain("> [!TIP]\n> **Hint**\n> Tip text.\n\n")
  })

  test("renders tables with a header separator and escaped cell pipes", () => {
    expect(renderDocMarkdown(page, origin)).toContain("| Key | Value |\n| --- | --- |\n| `a\\|b` | one |\n| c | two |\n\n")
  })

  test("renders cards as a link list pointing documentation links at their Markdown copies", () => {
    expect(renderDocMarkdown(page, origin)).toContain(
      [
        "- [Docs home](https://example.test/docs/index.md): Overview.",
        `- [Related page](https://example.test/docs/${related.slug}.md#intro): Internal.`,
        "- [Releases](https://github.com/Althenia/ycoding/releases): External.",
        "- [Changelog](https://example.test/changelog): Site route.",
      ].join("\n") + "\n\n",
    )
  })

  test("renders related pages as a titled link list and skips unknown slugs", () => {
    const markdown = renderDocMarkdown(page, origin)
    expect(markdown.endsWith(`- [${related.title}](https://example.test/docs/${related.slug}.md)\n`)).toBe(true)
    expect(markdown).not.toContain("does-not-exist")
  })
})

describe("docMarkdownPath", () => {
  test("maps published pages to their slug and the docs index to index.md", () => {
    expect(docMarkdownPath(page)).toBe("docs/sample/page.md")
    expect(docMarkdownPath(DOC_INDEX)).toBe("docs/index.md")
  })

  test("renders the docs index with the /docs canonical URL", () => {
    expect(renderDocMarkdown(DOC_INDEX, origin)).toContain("Canonical page: https://example.test/docs\n")
  })
})
