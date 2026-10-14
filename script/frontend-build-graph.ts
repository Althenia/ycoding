import path from "node:path"
import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { checkBundleGraph, checkFrontendBoundary, type BundleGraph } from "./ycoding-workspace"

const root = path.resolve(
  process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? path.resolve(import.meta.dirname, ".."),
)
const frontend = process.argv.find((arg) => arg.startsWith("--frontend="))?.slice(11)
const directory = process.argv.find((arg) => arg.startsWith("--outdir="))?.slice(9)
if (!directory || !frontend || !["cli", "tui", "web"].includes(frontend))
  throw new Error("Specify --frontend=cli|tui|web and a fresh --outdir=<directory>")
const outdir = path.resolve(directory)
if (existsSync(outdir)) throw new Error("Use a fresh output directory")
const graph: BundleGraph = { frontend, outputs: [] }
const source = await checkFrontendBoundary(root, { frontends: [frontend] })
for (const declaration of source.loaders) console.log(`Declared boundary site: ${declaration}`)
if (source.violations.some((entry) => entry.kind === "stale-loader" || entry.kind === "stale-reader"))
  throw new Error("Stale boundary declaration")

if (frontend === "web") {
  process.chdir(path.join(root, "apps/web"))
  const { build }: typeof import("vite") = await import(
    import.meta.resolve("vite", pathToFileURL(path.resolve(import.meta.dirname, "../apps/web/vite.config.ts")).href)
  )
  await build({
    root: path.join(root, "apps/web"),
    configFile: path.join(root, "apps/web/vite.config.ts"),
    build: { outDir: path.join(outdir, "assets"), emptyOutDir: false },
    plugins: [
      {
        name: "ycoding-frontend-boundary-evidence",
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue
            const edges = Object.keys(output.modules).flatMap((id) => {
              const info = this.getModuleInfo(id)
              return [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]
                .filter((target) => this.getModuleInfo(target)?.isExternal)
                .map((specifier) => ({ file: id, specifier }))
            })
            graph.outputs.push({
              file: path.join(outdir, "assets", output.fileName),
              modules: Object.keys(output.modules),
              edges,
              imports: [...new Set(edges.map((edge) => edge.specifier))],
            })
          }
        },
      },
    ],
  })
} else {
  const build = Bun.build
  Bun.build = async (config) => {
    const result = await build({ ...config, metafile: true })
    if (!result.success || !result.metafile) throw new Error("Production build did not produce a successful metafile")
    const external = [
      ...new Set(
        Object.values(result.metafile.inputs).flatMap((input) =>
          input.imports.filter((entry) => entry.external).map((entry) => entry.original ?? entry.path),
        ),
      ),
    ]
    const edges = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      input.imports
        .filter((entry) => entry.external)
        .map((entry) => ({ file: path.resolve(process.cwd(), file), specifier: entry.original ?? entry.path })),
    )
    graph.outputs.push(
      ...Object.entries(result.metafile.outputs)
        .filter(([, output]) => Object.keys(output.inputs).length)
        .map(([file, output]) => ({
          file:
            typeof config.compile === "object" && config.compile.outfile
              ? path.resolve(process.cwd(), config.compile.outfile)
              : path.basename(file),
          modules: Object.keys(output.inputs).map((input) => path.resolve(process.cwd(), input)),
          imports: external,
          edges,
        })),
    )
    return result
  }
  process.argv = [
    process.argv[0],
    path.join(root, "packages/cli/script/build.ts"),
    "--single",
    ...(frontend === "tui" ? ["--tui-only"] : []),
    `--outdir=${path.join(outdir, "assets")}`,
  ]
  await import(pathToFileURL(path.join(root, "packages/cli/script/build.ts")).href)
  Bun.build = build
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(outdir, "assets"), absolute: true }))
  for (const output of graph.outputs) {
    if (path.isAbsolute(output.file)) continue
    const matches = files.filter((file) => path.basename(file) === output.file)
    if (matches.length !== 1) throw new Error(`Ambiguous shipped output: ${output.file}`)
    output.file = matches[0]
  }
}

for (const output of graph.outputs)
  if (!(await Bun.file(output.file).exists())) throw new Error(`Missing shipped output: ${output.file}`)
await Bun.write(path.join(outdir, "graph.json"), JSON.stringify(graph, null, 2))
const violations = checkBundleGraph(graph)
console.log(
  `${frontend}: ${graph.outputs.length} outputs, ${new Set(graph.outputs.flatMap((output) => output.modules)).size} modules; graph: ${path.join(outdir, "graph.json")}`,
)
for (const entry of violations)
  console.error(`${entry.file}:${entry.line} ${JSON.stringify(entry.specifier)} -> ${entry.owner}`)
if (violations.length) process.exit(1)
