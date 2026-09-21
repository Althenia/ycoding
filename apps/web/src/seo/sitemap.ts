import { PUBLIC_DOC_PATHS } from "../content/docs/registry"
import { SITE } from "../content/site"

/** Public pages that are not documentation pages, in navigation order. */
const FIXED_PUBLIC_PATHS = ["/", "/docs", "/changelog"] as const

/**
 * Sitemap routes derive from the same published documentation allowlist the
 * registry owns, so a page added to or removed from the allowlist changes the
 * sitemap without a second list to keep in sync. The private workspace never
 * appears here and is disallowed in robots.txt.
 */
export const SITEMAP_PATHS: readonly string[] = [...FIXED_PUBLIC_PATHS, ...PUBLIC_DOC_PATHS]

export function buildSitemap(origin: string = SITE.origin): string {
  const urls = SITEMAP_PATHS.map((path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}
