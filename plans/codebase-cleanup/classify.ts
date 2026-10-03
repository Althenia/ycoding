import path from "node:path"

const root = process.argv[2] ?? process.cwd()
const upstream = process.argv[3] ?? "/tmp/yc-upstream-snap"
const output = process.argv[4] ?? path.join(import.meta.dir, "classification.md")

const tracked = Bun.spawnSync(["git", "ls-files", "packages"], { cwd: root })
  .stdout.toString()
  .split("\n")
  .filter(Boolean)

const brand = (text: string) => text.replace(/opencode|ycoding/gi, "\u0000")
const isTest = (file: string) => /(^|\/)(test|test-integration)\//.test(file) || /\.test\.tsx?$/.test(file)

const rows = await Promise.all(
  tracked.map(async (file) => {
    if (file.startsWith("packages/core/src/cursor/provider/")) return { file, kind: "vendored" as const }
    const mine = Bun.file(path.join(root, file))
    const theirs = Bun.file(path.join(upstream, file))
    if (!(await mine.exists())) return undefined
    if (!(await theirs.exists())) return { file, kind: "ycoding-new" as const }
    const [a, b] = await Promise.all([mine.bytes(), theirs.bytes()])
    if (Buffer.from(a).equals(Buffer.from(b))) return { file, kind: "upstream-unchanged" as const }
    if (brand(Buffer.from(a).toString("utf8")) === brand(Buffer.from(b).toString("utf8")))
      return { file, kind: "upstream-unchanged" as const }
    return { file, kind: "upstream-modified" as const }
  }),
).then((all) => all.filter((row) => row !== undefined))

const kinds = ["upstream-unchanged", "upstream-modified", "ycoding-new", "vendored"] as const
const packages = [...new Set(rows.map((row) => row.file.split("/")[1]!))].toSorted()
const count = (pkg: string, kind: string) => rows.filter((row) => row.file.split("/")[1] === pkg && row.kind === kind).length

const unchanged = await Promise.all(
  rows
    .filter((row) => row.kind === "upstream-unchanged" && !isTest(row.file) && /\.(ts|tsx)$/.test(row.file))
    .map(async (row) => ({ file: row.file, lines: (await Bun.file(path.join(root, row.file)).text()).split("\n").length })),
)

const lines = [
  "# Fork-point classification",
  "",
  `Upstream: anomalyco/opencode v2 @ 39fdd671. Checkout: ${Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim()}. Tracked files under packages/: ${rows.length}.`,
  "",
  `| Package | ${kinds.join(" | ")} |`,
  `|---|${kinds.map(() => "---").join("|")}|`,
  ...packages.map((pkg) => `| ${pkg} | ${kinds.map((kind) => count(pkg, kind)).join(" | ")} |`),
  `| **total** | ${kinds.map((kind) => rows.filter((row) => row.kind === kind).length).join(" | ")} |`,
  "",
  `## Upstream-unchanged source files (non-test .ts/.tsx): ${unchanged.length} files, ${unchanged.reduce((sum, row) => sum + row.lines, 0)} lines`,
  "",
  "| File | Lines |",
  "|---|---|",
  ...unchanged.toSorted((a, b) => a.file.localeCompare(b.file)).map((row) => `| ${row.file} | ${row.lines} |`),
  "",
]
await Bun.write(output, lines.join("\n"))
console.log(JSON.stringify({ total: rows.length, ...Object.fromEntries(kinds.map((kind) => [kind, rows.filter((row) => row.kind === kind).length])), unchangedSourceFiles: unchanged.length }))
