import { resolve, relative, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { cssAuditExitCode, validateRawCssAudit } from "../src/styles/css-audit"
import { stylesheetImports } from "../src/styles/css-rules"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const entry = "apps/web/src/main.tsx"
const files = ["apps/web/src/styles/tokens.css", "apps/web/src/styles/base.css", "apps/web/src/styles/site.css", "apps/web/src/styles/remote.css", "apps/web/src/styles/docs.css", "apps/web/src/remote/ui/composer.css", "apps/web/src/remote/ui/projects.css", "apps/web/src/remote/ui/team-view.css", "apps/web/src/remote/ui/command-palette.css", "apps/web/src/remote/ui/device-alias.css", "apps/web/src/ui/custom-select.css", "apps/web/src/ui/modal.css", "apps/web/src/remote/ui/file-change-card.css"]

export async function loadCssAuditSources(): Promise<Readonly<Record<string, string>>> {
  const sources: Record<string, string> = {}
  async function visit(file: string): Promise<void> {
    if (sources[file] !== undefined) return
    const source = await Bun.file(resolve(root, file)).text()
    sources[file] = source
    if (file.endsWith(".css")) {
      const imports = stylesheetImports(source)
      if (!imports) throw new Error(`Cannot establish stylesheet imports: ${file}`)
      for (const path of imports) {
        const target = relative(root, resolve(root, dirname(file), path))
        if (!target.startsWith("apps/web/src/")) throw new Error(`Stylesheet import leaves the web source boundary: ${file} → ${path}`)
        await visit(target)
      }
      return
    }
    const loader = file.endsWith(".tsx") || file.endsWith(".jsx") ? "tsx" : "ts"
    const imports = new Bun.Transpiler({ loader }).scanImports(source)
    for (const item of imports) {
      if (!item.path.startsWith(".") || !["import-statement", "dynamic-import"].includes(item.kind)) continue
      const target = resolve(root, dirname(file), item.path)
      const extension = extname(target)
      if (extension && ![".css", ".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(extension)) continue
      const candidates = extension ? [target] : [target + ".ts", target + ".tsx", target + ".js", target + ".jsx", resolve(target, "index.ts"), resolve(target, "index.tsx")]
      const found = await Promise.all(candidates.map(async candidate => await Bun.file(candidate).exists() ? candidate : undefined))
      const path = found.find(candidate => candidate !== undefined)
      if (!path) throw new Error(`Cannot resolve CSS audit source import ${file} → ${item.path}`)
      const local = relative(root, path)
      if (local.startsWith("apps/web/src/")) await visit(local)
    }
  }
  const html = await Bun.file(resolve(root, "apps/web/index.html")).text()
  if (!/<script\s+type="module"\s+src="\/src\/main\.tsx"\s*>/.test(html)) throw new Error("Cannot establish the web module entry")
  await visit(entry)
  for (const file of files) if (sources[file] === undefined) throw new Error(`Audited stylesheet is not reachable from the web entry: ${file}`)
  return sources
}

export async function runCssAudit(scanner: string) {
  await loadCssAuditSources()
  const process = Bun.spawn(["python3", scanner, ...files, "--tokens", "apps/web/src/styles/tokens.css", "--design", "apps/web/DESIGN.md", "--fail-on", "warning"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (exit !== 0 && exit !== 1) throw new Error(`CSS scanner exited ${exit}: ${stderr.trim()}`)
  const raw: unknown = JSON.parse(stdout)
  validateRawCssAudit(raw)
  if (raw.files !== files.length || exit !== (raw.error === 0 && raw.warning === 0 ? 0 : 1)) throw new Error("CSS scanner scope or exit status does not match its result")
  return raw
}

if (import.meta.main) {
  const scanner = Bun.argv[2]
  if (!scanner || Bun.argv.length !== 3) {
    console.error("Usage: bun run --cwd apps/web audit:css /path/to/audit_css.py")
    process.exitCode = 1
  } else {
    try {
      const report = await runCssAudit(scanner)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = cssAuditExitCode(report)
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    }
  }
}
