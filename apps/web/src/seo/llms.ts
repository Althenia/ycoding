import { DOC_INDEX, DOC_PAGES, docsByGroup } from "../content/docs/registry"
import { SITE } from "../content/site"
import { docMarkdownPath, renderDocMarkdown } from "./markdown"

/**
 * `/llms.txt` in the llmstxt.org format: one link entry per published
 * documentation page, grouped like the site navigation.
 */
export function buildLlmsTxt(origin: string = SITE.origin): string {
  const intro = [
    `# ${SITE.productName}`,
    `> ${SITE.description}`,
    `Each entry links to a Markdown copy of a published documentation page. Start with the [documentation overview](${origin}/${docMarkdownPath(DOC_INDEX)}), or read every page in one file at [llms-full.txt](${origin}/llms-full.txt).`,
  ]
  const groups = docsByGroup()
    .filter((group) => group.pages.length > 0)
    .map(
      (group) =>
        `## ${group.group}\n\n` +
        group.pages.map((page) => `- [${page.title}](${origin}/${docMarkdownPath(page)}): ${page.description}`).join("\n"),
    )
  return [...intro, ...groups].join("\n\n") + "\n"
}

/** `/llms-full.txt`: every published page rendered to Markdown, in registry order. */
export function buildLlmsFullTxt(origin: string = SITE.origin): string {
  return DOC_PAGES.map((page) => renderDocMarkdown(page, origin)).join("\n")
}

/** Every machine-readable documentation file the build emits, with its site-root path. */
export function markdownAssets(origin: string = SITE.origin): readonly { readonly fileName: string; readonly source: string }[] {
  return [
    { fileName: "llms.txt", source: buildLlmsTxt(origin) },
    { fileName: "llms-full.txt", source: buildLlmsFullTxt(origin) },
    ...[DOC_INDEX, ...DOC_PAGES].map((page) => ({ fileName: docMarkdownPath(page), source: renderDocMarkdown(page, origin) })),
  ]
}
