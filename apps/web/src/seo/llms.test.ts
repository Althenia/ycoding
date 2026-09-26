import { describe, expect, test } from "bun:test"
import { DOC_INDEX, DOC_PAGES, docsByGroup } from "../content/docs/registry"
import { SITE } from "../content/site"
import { renderDocMarkdown } from "./markdown"
import { buildLlmsFullTxt, buildLlmsTxt, markdownAssets } from "./llms"

const INTERNAL_DOC_SLUGS = ["architecture", "runtime", "repository-resources", "provider-efficiency", "okf", "releases", "README"]

function entries(document: string) {
  return [...document.matchAll(/^- \[([^\]]+)\]\(([^)]+)\): (.+)$/gm)].map((match) => ({
    title: match[1],
    url: match[2],
    description: match[3],
  }))
}

describe("llms.txt", () => {
  test("starts with the product title and a summary", () => {
    const document = buildLlmsTxt()
    expect(document.startsWith(`# YCoding\n\n> ${SITE.description}\n\n`)).toBe(true)
    expect(document).toContain(`${SITE.origin}/llms-full.txt`)
    expect(document).toContain(`${SITE.origin}/docs/index.md`)
  })

  test("lists every published page exactly once with its description and Markdown URL", () => {
    expect(entries(buildLlmsTxt())).toEqual(
      DOC_PAGES.map((page) => ({ title: page.title, url: `${SITE.origin}/docs/${page.slug}.md`, description: page.description })),
    )
  })

  test("groups entries under one section per non-empty documentation group", () => {
    const document = buildLlmsTxt()
    const groups = docsByGroup().filter((group) => group.pages.length > 0)
    expect([...document.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual(groups.map((group) => group.group))
    for (const group of groups) {
      const section = document.split(`## ${group.group}\n\n`)[1]!.split("\n## ")[0]!
      expect(entries(section).map((entry) => entry.title)).toEqual(group.pages.map((page) => page.title))
    }
  })

  test("never lists unpublished engineering documents", () => {
    const urls = entries(buildLlmsTxt()).map((entry) => entry.url)
    for (const slug of INTERNAL_DOC_SLUGS) expect(urls).not.toContain(`${SITE.origin}/docs/${slug}.md`)
  })
})

describe("llms-full.txt", () => {
  test("concatenates every published page in registry order", () => {
    expect(buildLlmsFullTxt()).toBe(DOC_PAGES.map((page) => renderDocMarkdown(page)).join("\n"))
    const document = buildLlmsFullTxt()
    const offsets = DOC_PAGES.map((page) => document.indexOf(`# ${page.title}\n\n> ${page.description}\n\n`))
    expect(offsets.every((offset) => offset >= 0)).toBe(true)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  })
})

describe("markdown assets", () => {
  test("emits the index files and one Markdown file per published page plus the docs index", () => {
    expect(markdownAssets().map((asset) => asset.fileName)).toEqual([
      "llms.txt",
      "llms-full.txt",
      "docs/index.md",
      ...DOC_PAGES.map((page) => `docs/${page.slug}.md`),
    ])
    const index = markdownAssets().find((asset) => asset.fileName === "docs/index.md")
    expect(index?.source).toBe(renderDocMarkdown(DOC_INDEX))
  })

  test("is deterministic", () => {
    expect(markdownAssets()).toEqual(markdownAssets())
  })
})
