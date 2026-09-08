import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const siteURL = "https://althenia.github.io/ycoding/"
const schemaPath = "ycoding.schema.json"
const documents = [
  { name: "configuration", title: "Configuration reference" },
  { name: "runtime", title: "Runtime reference" },
  { name: "repository-resources", title: "Repository resources" },
  { name: "guardrails-and-provider-usage", title: "Guardrails and provider usage" },
  { name: "provider-efficiency", title: "Provider efficiency" },
]

export async function buildPages(options: { readonly root: string; readonly outdir: string }) {
  const outdir = outputDirectory(options.root, options.outdir)
  const installer = Bun.file(path.join(options.root, "script", "install.sh"))
  if (!(await installer.exists())) throw new Error("Missing required maintained installer: script/install.sh")

  const example = await Bun.file(path.join(options.root, "docs", "examples", "ycoding.jsonc")).text()
  const schema = await configSchema(options.root)
  const renderMarkdown = await markdownRenderer(options.root)
  const pages = await Promise.all(
    documents.map(async (document) => ({
      ...document,
      content: renderMarkdown(await Bun.file(path.join(options.root, "docs", `${document.name}.md`)).text()),
    })),
  )

  await fs.rm(outdir, { recursive: true, force: true })
  await fs.mkdir(outdir, { recursive: true })

  await Promise.all([
    Bun.write(path.join(outdir, "index.html"), indexPage()),
    ...pages.map(async (document) => {
      const output = path.join(outdir, document.name, "index.html")
      await fs.mkdir(path.dirname(output), { recursive: true })
      await Bun.write(output, documentPage(document.title, document.content))
    }),
    Bun.write(path.join(outdir, schemaPath), JSON.stringify(schema, null, 2) + "\n"),
    Bun.write(path.join(outdir, "examples", "ycoding.jsonc"), example),
  ])

  await Bun.write(path.join(outdir, "install.sh"), installer)
}

async function configSchema(root: string) {
  const process = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `import { JsonSchema, Schema } from "effect"; import { Config } from "@ycoding-ai/core/config"; const document = Schema.toJsonSchemaDocument(Config.Info); console.log(JSON.stringify({ $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, $id: ${JSON.stringify(siteURL + schemaPath)}, title: "YCoding configuration", ...document.schema, $defs: document.definitions }));`,
    ],
    cwd: path.join(root, "packages", "core"),
    stderr: "pipe",
    stdout: "pipe",
  })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) === 0) return JSON.parse(output)
  throw new Error(`Unable to generate the configuration JSON Schema: ${await new Response(process.stderr).text()}`)
}

function indexPage() {
  return page(
    "YCoding documentation",
    `<main><h1>YCoding documentation</h1><p>Static documentation for the terminal application.</p><h2>Documentation</h2><ul>${documents.map((document) => `<li><a href="${document.name}/">${document.title}</a></li>`).join("")}</ul><h2>Configuration</h2><ul><li><a href="${schemaPath}">Configuration JSON Schema</a></li><li><a href="examples/ycoding.jsonc">Example ycoding.jsonc</a></li></ul><h2>Install</h2><p><code>curl -fsSL https://althenia.github.io/ycoding/install.sh | sh</code></p></main>`,
  )
}

function documentPage(title: string, content: string) {
  return page(
    `${title} | YCoding documentation`,
    `<main><p><a href="../">YCoding documentation</a></p><p><a href="/ycoding/${schemaPath}">Download the configuration JSON Schema</a></p>${content}</main>`,
  )
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.5;margin:0;color:#1f2937;background:#fff}main{max-width:72rem;margin:auto;padding:2rem}pre{overflow:auto;padding:1rem;background:#f3f4f6}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #d1d5db;padding:.4rem;text-align:left}a{color:#075985}</style>
</head>
<body>
${body}
</body>
</html>
`
}

async function markdownRenderer(root: string) {
  const marked = await import(
    pathToFileURL(path.join(root, "packages", "ui", "node_modules", "marked", "lib", "marked.esm.js")).href
  )
  return (markdown: string) => {
    const renderer = new marked.Renderer()
    renderer.html = () => ""
    renderer.image = ({ text }: { readonly text: string }) => escape(text)
    renderer.heading = function ({ tokens, depth }: { readonly tokens: unknown; readonly depth: number }) {
      const content = this.parser.parseInline(tokens)
      return `<h${depth} id="${slug(content)}">${content}</h${depth}>\n`
    }
    renderer.link = function ({
      href,
      title,
      tokens,
    }: {
      readonly href: string
      readonly title: string | null
      readonly tokens: unknown
    }) {
      const content = this.parser.parseInline(tokens)
      const target = rewriteLink(href)
      if (!target) return content
      return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ""}>${content}</a>`
    }
    return new marked.Marked({ gfm: true, renderer }).parse(markdown)
  }
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function outputDirectory(root: string, outdir: string) {
  const expected = path.join(path.resolve(root), "dist", "pages")
  if (path.resolve(outdir) !== expected) throw new Error(`Pages output must be ${expected}`)
  return expected
}

function rewriteLink(href: string) {
  if (/^(https?:|mailto:)/i.test(href)) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined
  const [target, fragment] = href.split("#", 2)
  if (!target) return `#${fragment ?? ""}`
  if (target.startsWith("/")) return undefined

  const source = path.posix.normalize(path.posix.join("docs", target))
  if (source.startsWith("../")) return undefined
  const published = documents.find((entry) => source === `docs/${entry.name}.md`)
  if (published) return `../${published.name}/${fragment ? `#${fragment}` : ""}`
  return `https://github.com/Althenia/ycoding/blob/main/${source}${fragment ? `#${fragment}` : ""}`
}

function slug(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}
