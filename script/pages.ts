import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const siteURL = "https://althenia.github.io/ycoding/"
const schemaPath = "ycoding.schema.json"

const groups = ["Concepts", "Components", "Configuration", "Runtime", "Capabilities"] as const

const documents = [
  {
    name: "product-direction",
    title: "Product direction",
    group: "Concepts",
    summary: "Product identity, priorities, autonomy vocabulary, and the compatibility policy every change must respect.",
  },
  {
    name: "architecture",
    title: "Architecture",
    group: "Components",
    summary: "Package graph, ownership boundaries, runtime flow, and dependency direction.",
  },
  {
    name: "runtime",
    title: "Runtime",
    group: "Runtime",
    summary: "Sessions, steps, autonomy, subagents, skills, project artifacts, transcript history, and cache diagnostics.",
  },
  {
    name: "configuration",
    title: "Configuration reference",
    group: "Configuration",
    summary: "Runtime, CLI/TUI, and managed-service configuration surfaces with every top-level field.",
  },
  {
    name: "repository-resources",
    title: "Repository resources",
    group: "Configuration",
    summary: "Agents, commands, skills, plugins, hooks, tools, themes, and instructions discovered under .ycoding.",
  },
  {
    name: "guardrails-and-provider-usage",
    title: "Guardrails and provider usage",
    group: "Configuration",
    summary: "Agent permissions, Session guardrail rules and reviews, and normalized provider quota reporting.",
  },
  {
    name: "provider-efficiency",
    title: "Provider efficiency",
    group: "Capabilities",
    summary: "Stable provider prefixes, prompt-cache controls, continuation, diagnostics, and reproducible benchmarks.",
  },
  {
    name: "browser-extension",
    title: "Chrome selected-tab bridge",
    group: "Capabilities",
    summary: "Installation, pairing, and operations for operating tabs you explicitly share from Chrome.",
  },
  {
    name: "computer-use",
    title: "Native computer use",
    group: "Capabilities",
    summary: "macOS iTerm and Finder capabilities, helper discovery, packaging, and validation limits.",
  },
  {
    name: "memory",
    title: "Knowledge memory",
    group: "Capabilities",
    summary: "Repository memories shared across every worktree of one local Git repository, plus shared knowledge, stored under the YCoding data directory.",
  },
] as const

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
      ...renderMarkdown(await documentSource(options.root, document.name)),
    })),
  )

  await fs.rm(outdir, { recursive: true, force: true })
  await fs.mkdir(outdir, { recursive: true })

  await Promise.all([
    Bun.write(path.join(outdir, "index.html"), indexPage()),
    ...pages.map(async (document) => {
      const output = path.join(outdir, document.name, "index.html")
      await fs.mkdir(path.dirname(output), { recursive: true })
      await Bun.write(output, documentPage(document))
    }),
    Bun.write(path.join(outdir, schemaPath), JSON.stringify(schema, null, 2) + "\n"),
    Bun.write(path.join(outdir, "examples", "ycoding.jsonc"), example),
  ])

  await Bun.write(path.join(outdir, "install.sh"), installer)
}

async function documentSource(root: string, name: string) {
  const source = Bun.file(path.join(root, "docs", `${name}.md`))
  if (!(await source.exists())) throw new Error(`Missing required documentation source: docs/${name}.md`)
  return source.text()
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

type Heading = { readonly depth: number; readonly text: string; readonly id: string }

function indexPage() {
  return page(
    "YCoding documentation",
    [
      skipLink(),
      `<div class="layout">`,
      rail(),
      `<main id="main" class="doc" tabindex="-1">`,
      `<h1>YCoding documentation</h1>`,
      `<p class="lede">Static documentation for the YCoding terminal agent, generated from the maintained documents in <code>docs/</code>.</p>`,
      `<h2>Install</h2>`,
      `<pre><code>curl -fsSL https://althenia.github.io/ycoding/install.sh | sh</code></pre>`,
      groups
        .map(
          (group) =>
            `<h2>${escape(group)}</h2><ul class="catalog">${documents
              .filter((document) => document.group === group)
              .map(
                (document) =>
                  `<li><a href="${document.name}/">${escape(document.title)}</a><span>${escape(document.summary)}</span></li>`,
              )
              .join("")}</ul>`,
        )
        .join(""),
      `<h2>Configuration</h2>`,
      `<ul class="catalog"><li><a href="${schemaPath}">Configuration JSON Schema</a><span>Generated from the runtime configuration Schema; validate and autocomplete <code>ycoding.jsonc</code>.</span></li><li><a href="examples/ycoding.jsonc">Example ycoding.jsonc</a><span>A minimal project configuration to copy.</span></li></ul>`,
      `</main>`,
      `</div>`,
    ].join("\n"),
  )
}

function documentPage(document: { readonly name: string; readonly title: string; readonly html: string; readonly headings: readonly Heading[] }) {
  return page(
    `${document.title} | YCoding documentation`,
    [
      skipLink(),
      `<div class="layout">`,
      rail(document.name),
      contents(document.headings),
      `<main id="main" class="doc" tabindex="-1">`,
      `<p class="breadcrumb"><a href="../">YCoding documentation</a> · <a href="/ycoding/${schemaPath}">Configuration JSON Schema</a></p>`,
      document.html,
      `</main>`,
      `</div>`,
    ].join("\n"),
  )
}

function skipLink() {
  return `<a class="skip" href="#main">Skip to content</a>`
}

function rail(active?: string) {
  const root = active ? "../" : ""
  const items = [`<li><a href="${root}"${active ? "" : ' aria-current="page"'}>Documentation home</a></li>`]
  const sections = groups.map((group) => {
    const entries = documents.filter((document) => document.group === group)
    const links = entries.map((document) => {
      const current = document.name === active ? ' aria-current="page"' : ""
      return `<li><a href="${active ? `../${document.name}/` : `${document.name}/`}"${current}>${escape(document.title)}</a></li>`
    })
    return `<section class="group"><p class="label">${escape(group)}</p><ul>${links.join("")}</ul></section>`
  })
  return `<nav class="rail" aria-label="Documentation">
<p class="brand"><a href="${root}">YCoding documentation</a></p>
<div class="groups">
<section class="group"><p class="label">Start</p><ul>${items.join("")}</ul></section>
${sections.join("\n")}
</div>
</nav>`
}

function contents(headings: readonly Heading[]) {
  const entries = headings.filter((heading) => heading.depth > 1 && heading.depth < 4)
  if (entries.length === 0) return ""
  return `<nav class="contents" aria-label="On this page">
<p class="label">On this page</p>
<ul>${entries
    .map((heading) => `<li class="depth-${heading.depth}"><a href="#${heading.id}">${escape(heading.text)}</a></li>`)
    .join("")}</ul>
</nav>`
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>${styles}</style>
</head>
<body>
${body}
</body>
</html>
`
}

const styles = `:root{--bg:#fff;--surface:#f5f7fa;--raised:#eef2f7;--ink:#18222c;--muted:#5a6672;--rule:#dde3ea;--accent:#0b5f8a;--accent-soft:#e6f0f7;--code:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--surface:#161b22;--raised:#1b2129;--ink:#e6edf3;--muted:#9da9b5;--rule:#2a313a;--accent:#7cc0ff;--accent-soft:#132433;--code:#151a20}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:1rem;top:1rem;z-index:3;padding:.5rem .75rem;background:var(--bg);border:1px solid var(--rule);border-radius:6px;text-decoration:none}
.layout{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"rail" "contents" "main";gap:1.25rem 2.5rem;max-width:88rem;margin:0 auto;padding:1.25rem}
@media (min-width:60rem){.layout{grid-template-columns:15rem minmax(0,1fr);grid-template-areas:"rail main" "rail contents";padding:2rem}}
@media (min-width:80rem){.layout{grid-template-columns:16rem minmax(0,68rem) 15rem;grid-template-areas:"rail main contents";padding:2.5rem}}
main{grid-area:main;min-width:0}
.lede{color:var(--muted);max-width:60ch}
.rail{grid-area:rail;font-size:.9rem;align-self:start;min-width:0}
@media (min-width:60rem){.rail{position:sticky;top:2rem;max-height:calc(100vh - 4rem);overflow:auto;padding-right:.5rem}}
.rail .brand{margin:0 0 .5rem;font-size:.95rem;font-weight:650;letter-spacing:-.01em}
.rail .brand a{color:inherit;text-decoration:none}
.groups{display:flex;gap:1.5rem;min-width:0;max-width:100%;overflow-x:auto;padding-bottom:.5rem}
@media (min-width:60rem){.groups{display:block;overflow:visible;padding:0}}
.group{flex:0 0 auto;min-width:11rem}
@media (min-width:60rem){.group{min-width:0;margin-bottom:1.15rem}}
.group h2,.group .label,.contents h2{margin:.6rem 0 .3rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-weight:600}
.group ul{list-style:none;margin:0;padding:0}
.group li{margin:.1rem 0}
.group a{display:block;padding:.25rem .5rem;border-radius:6px;color:var(--ink);text-decoration:none}
.group a:hover{background:var(--raised)}
.group a[aria-current=page]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.contents{grid-area:contents;font-size:.87rem;align-self:start}
.contents ul{list-style:none;margin:0;padding:0 0 0 .1rem;border-left:1px solid var(--rule)}
.contents li{margin:.1rem 0}
.contents a{display:block;padding:.2rem .6rem;color:var(--muted);text-decoration:none}
.contents a:hover{color:var(--accent)}
.contents .depth-3 a{padding-left:1.6rem}
@media (min-width:80rem){.contents{position:sticky;top:2.5rem;max-height:calc(100vh - 5rem);overflow:auto}}
.doc h1,.doc h2,.doc h3,.doc h4{scroll-margin-top:1.5rem;line-height:1.3}
.doc h1{margin:0 0 .75rem;font-size:1.9rem;letter-spacing:-.02em}
.doc h2{margin:2.25rem 0 .6rem;font-size:1.3rem}
.doc h3{margin:1.6rem 0 .5rem;font-size:1.05rem}
.doc p,.doc li{max-width:74ch;overflow-wrap:break-word}
.doc pre{background:var(--code);border:1px solid var(--rule);border-radius:8px;padding:.9rem 1rem;overflow:auto}
.doc code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.doc p code,.doc li code,.doc td code{background:var(--raised);padding:.1rem .3rem;border-radius:4px}
.doc table{border-collapse:collapse;display:block;max-width:100%;overflow:auto;font-size:.92rem}
.doc th,.doc td{border:1px solid var(--rule);padding:.4rem .6rem;text-align:left;vertical-align:top}
.doc th{background:var(--surface)}
.doc blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:3px solid var(--rule);color:var(--muted)}
.doc hr{border:0;border-top:1px solid var(--rule);margin:2rem 0}
.breadcrumb{margin:0 0 1rem;font-size:.9rem;color:var(--muted)}
.catalog{list-style:none;margin:0;padding:0}
.catalog li{margin:.6rem 0;max-width:74ch}
.catalog a{font-weight:600;text-decoration:none}
.catalog a:hover{text-decoration:underline}
.catalog span{display:block;color:var(--muted);font-size:.92rem}`

async function markdownRenderer(root: string) {
  const marked = await import(
    pathToFileURL(path.join(root, "packages", "ui", "node_modules", "marked", "lib", "marked.esm.js")).href
  )
  return (markdown: string) => {
    const used = new Set<string>()
    const headings: Heading[] = []
    const renderer = new marked.Renderer()
    renderer.html = () => ""
    renderer.image = ({ text }: { readonly text: string }) => escape(text)
    renderer.heading = function ({ tokens, depth }: { readonly tokens: unknown; readonly depth: number }) {
      const content = this.parser.parseInline(tokens)
      const id = uniqueSlug(content, used)
      headings.push({ depth, text: plainText(content), id })
      return `<h${depth} id="${id}">${content}</h${depth}>\n`
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
    return { html: new marked.Marked({ gfm: true, renderer }).parse(markdown), headings }
  }
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function plainText(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
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

function uniqueSlug(value: string, used: Set<string>) {
  const base = slug(value) || "section"
  let id = base
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`
  used.add(id)
  return id
}

function slug(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}