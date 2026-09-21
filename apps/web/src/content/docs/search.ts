import type { DocPage } from "./types"
import { DOC_PAGES } from "./registry"

export type DocSearchHit = {
  readonly page: DocPage
  readonly matchedHeading?: string
  readonly score: number
}

/**
 * Lexical search over the published documentation pages only. Titles rank above
 * headings, headings above descriptions, and descriptions above body text.
 */
export function searchDocs(query: string, limit = 12): readonly DocSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []

  const hits = DOC_PAGES.flatMap((page) => {
    const inTitle = page.title.toLowerCase().includes(needle)
    const section = page.sections.find((entry) => entry.heading.toLowerCase().includes(needle))
    const inDescription = page.description.toLowerCase().includes(needle)
    const inBody = page.sections.some((entry) =>
      entry.blocks.some((block) => JSON.stringify(block).toLowerCase().includes(needle)),
    )
    const score = inTitle ? 100 : section ? 60 : inDescription ? 40 : inBody ? 20 : 0
    if (score === 0) return []
    return [{ page, ...(section === undefined ? {} : { matchedHeading: section.heading }), score }]
  })

  return hits
    .sort((left, right) => right.score - left.score || left.page.slug.localeCompare(right.page.slug))
    .slice(0, limit)
}
