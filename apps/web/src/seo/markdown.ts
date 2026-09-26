import { findDocPage, sectionId } from "../content/docs/registry"
import type { DocBlock, DocPage } from "../content/docs/types"
import { SITE } from "../content/site"

const CALLOUT_ALERTS = { info: "NOTE", warning: "WARNING", tip: "TIP" } as const

/**
 * Renders one documentation page to Markdown for agents and other text readers.
 * Section anchors reuse the site's section ids, and documentation links point at
 * the Markdown copies so a reader can follow them without rendering HTML.
 */
export function renderDocMarkdown(page: DocPage, origin: string = SITE.origin): string {
  const header = [`# ${page.title}`, `> ${page.description}`, `Canonical page: ${origin}${pagePath(page)}`]
  const sections = page.sections.flatMap((section, index) => [
    `<a id="${sectionId(page, index)}"></a>\n## ${section.heading}`,
    ...section.blocks.map((block) => renderBlock(block, origin)),
  ])
  return [...header, ...sections].join("\n\n") + "\n"
}

/** Output file for a page's Markdown copy, relative to the site root. */
export function docMarkdownPath(page: DocPage): string {
  return `docs/${page.slug === "" ? "index" : page.slug}.md`
}

function renderBlock(block: DocBlock, origin: string): string {
  switch (block.kind) {
    case "paragraph":
      return block.text
    case "code": {
      const fence = "`".repeat(Math.max(3, ...[...block.code.matchAll(/`+/g)].map((match) => match[0].length + 1)))
      return `${fence}${block.language}${block.label ? ` title="${block.label}"` : ""}\n${block.code}\n${fence}`
    }
    case "list":
      return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n")
    case "steps":
      return block.items.map((item, index) => `${index + 1}. **${item.title}**: ${item.text}`).join("\n")
    case "callout":
      return `> [!${CALLOUT_ALERTS[block.tone]}]\n> **${block.title}**\n> ${block.text}`
    case "table":
      return [block.head, block.head.map(() => "---"), ...block.rows].map((row) => `| ${row.map(tableCell).join(" | ")} |`).join("\n")
    case "cards":
      return block.items.map((item) => `- [${item.title}](${linkURL(item.href, origin)}): ${item.text}`).join("\n")
    case "related":
      return block.slugs
        .flatMap((slug) => findDocPage(slug) ?? [])
        .map((page) => `- [${page.title}](${origin}/${docMarkdownPath(page)})`)
        .join("\n")
  }
}

function pagePath(page: DocPage): string {
  return page.slug === "" ? "/docs" : `/docs/${page.slug}`
}

function tableCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ")
}

/** Absolute link target; published documentation routes resolve to their Markdown copies. */
function linkURL(href: string, origin: string): string {
  const hashIndex = href.indexOf("#")
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex)
  if (path === "/docs") return `${origin}/docs/index.md${hash}`
  if (path.startsWith("/docs/") && findDocPage(path.slice("/docs/".length))) return `${origin}${path}.md${hash}`
  if (href.startsWith("/")) return `${origin}${href}`
  return href
}
