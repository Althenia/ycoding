import { expect } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const repository = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"])
if (repository.exitCode !== 0) throw new Error("Cannot locate the installed oracle dependencies")
const require = createRequire(
  join(dirname(resolve(repository.stdout.toString().trim())), "packages/codemode/package.json"),
)
const { Effect, Layer, Option } = await import(require.resolve("effect"))
const { HttpClient, HttpClientRequest, HttpClientResponse } = await import(require.resolve("effect/unstable/http"))

const read = (path: string) => {
  const result = Bun.spawnSync(["git", "show", `main:${path}`])
  if (result.exitCode !== 0) throw new Error(`Cannot read committed ${path}`)
  return result.stdout.toString()
}
const temporary = await mkdtemp(join(tmpdir(), "ycoding-code-mode-oracle-"))
try {
  const listing = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", "main", "packages/codemode/src"])
  if (listing.exitCode !== 0) throw new Error("Cannot enumerate committed Code Mode sources")
  for (const file of listing.stdout.toString().trim().split("\n")) await Bun.write(join(temporary, file), read(file))
  for (const file of ["openapi-happy-path.json", "ycoding-openapi.json"])
    await Bun.write(
      join(temporary, "packages/codemode/test/fixtures", file),
      read(`packages/codemode/test/fixtures/${file}`),
    )
  await mkdir(join(temporary, "node_modules"), { recursive: true })
  for (const name of ["effect", "typescript", "acorn"])
    await symlink(dirname(require.resolve(`${name}/package.json`)), join(temporary, "node_modules", name))
  const { CodeMode, OpenAPI, Tool } = await import(
    pathToFileURL(join(temporary, "packages/codemode/src/index.ts")).href
  )
  const { inputTypeScript, outputTypeScript } = await import(
    pathToFileURL(join(temporary, "packages/codemode/src/tool-schema.ts")).href
  )
  const jobs: Array<{ name: string; run: () => Promise<unknown> }> = []
  const cases: Array<unknown> = []
  let current = ""
  const wrapped = {
    ...OpenAPI,
    fromSpec(options: { spec: unknown; baseUrl?: string; headers?: unknown }) {
      const result = OpenAPI.fromSpec(options)
      if (current.includes("diamond-shaped")) return result
      const tools: Array<unknown> = []
      const visit = (value: Record<string, unknown>, path: Array<string>) => {
        for (const [name, child] of Object.entries(value)) {
          if (Tool.isDefinition(child)) {
            const toolPath = [...path, name].join(".")
            tools.push({
              path: toolPath,
              description: child.description,
              signature: `tools.${toolPath}(input: ${inputTypeScript(child, true)}): Promise<${outputTypeScript(child, true)}>`,
            })
            continue
          }
          if (typeof child === "object" && child !== null) visit(child as Record<string, unknown>, [...path, name])
        }
      }
      visit(result.tools, [])
      cases.push({ test: current, spec: options.spec, baseUrl: options.baseUrl, tools, skipped: result.skipped })
      return result
    },
  }
  const source = read("packages/codemode/test/openapi.test.ts")
    .replace(/^import .*$/gm, "")
    .replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(join(temporary, "packages/codemode/test/openapi.test.ts")).href),
    )
  const describe = (_name: string, run: () => void) => run()
  const test = (name: string, run: () => Promise<unknown>) => jobs.push({ name, run })
  new Function(
    "describe",
    "expect",
    "test",
    "Effect",
    "Layer",
    "Option",
    "HttpClient",
    "HttpClientRequest",
    "HttpClientResponse",
    "CodeMode",
    "OpenAPI",
    "Tool",
    "inputTypeScript",
    "outputTypeScript",
    new Bun.Transpiler({ loader: "ts" }).transformSync(source),
  )(
    describe,
    expect,
    test,
    Effect,
    Layer,
    Option,
    HttpClient,
    HttpClientRequest,
    HttpClientResponse,
    CodeMode,
    wrapped,
    Tool,
    inputTypeScript,
    outputTypeScript,
  )
  for (const job of jobs) {
    current = job.name
    await job.run()
  }
  const frontends = []
  for (const code of [
    "import fs from 'fs';",
    "return (await [1, 2]).length",
    "return ['\\377'.charCodeAt(0),'\\400']",
    "interface Row {id: number}; const row: Row={id:1}; return row!.id as number",
  ])
    frontends.push({ code, result: await Effect.runPromise(CodeMode.execute({ code })) })
  await Bun.write(
    new URL("openapi-corpus.json", import.meta.url),
    JSON.stringify({ tests: jobs.map((job) => job.name), cases, frontends }, null, 2) + "\n",
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
