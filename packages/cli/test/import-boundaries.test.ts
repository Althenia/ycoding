import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const coldBundleTimeout = 60_000

describe("CLI frontend import boundaries", () => {
  test("exposes only the intentional package entrypoints", async () => {
    const run = await import("@ycoding-ai/cli/run")
    const mini = await import("@ycoding-ai/tui/mini")
    const cli = await Bun.file(path.join(root, "packages/cli/package.json")).json()

    expect(Object.keys(run).sort()).toEqual(["runNonInteractive"])
    expect(Object.keys(mini).sort()).toEqual(["runMiniFrontend"])
    expect(Object.keys(cli.exports).filter((key) => key === "./mini" || key.startsWith("./mini/"))).toEqual([])
  }, coldBundleTimeout)

  test("keeps source current-only", async () => {
    const denied = [
      "runV1Bridge",
      "V1RunCommandInput",
      'compatibility: "v1"',
      "Migrate v1 data to v2",
      "TuiConfigV1",
      "migrateV1",
    ]
    const matches: string[] = []
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(root, "packages/cli/src") })) {
      const source = await Bun.file(path.join(root, "packages/cli/src", file)).text()
      for (const value of denied) {
        if (source.includes(value)) matches.push(`${file}: ${value}`)
      }
    }
    expect(matches).toEqual([])
  })

  test("keeps run and Mini on separate evaluation graphs", async () => {
    const run = await bundleInputs("packages/cli/src/commands/handlers/run.ts")
    expect(run).toContain("packages/cli/src/run/run.ts")
    expect(run).toContain("packages/tui/src/mini/tool.ts")
    expect(run).not.toContain("packages/tui/src/mini/runtime.ts")
    expect(run).not.toContain("packages/tui/src/mini/runtime.lifecycle.ts")
    expect(run).not.toContain("packages/tui/src/mini/footer.ts")
    expect(run).not.toContain("packages/tui/src/mini/scrollback.surface.ts")
    expect(run).not.toContain("packages/tui/src/runtime.tsx")

    const mini = await bundleInputs("packages/cli/src/commands/handlers/mini.ts")
    expect(mini).toContain("packages/cli/src/mini.ts")
    expect(mini).toContain("packages/tui/src/mini/index.ts")
    expect(mini).toContain("packages/tui/src/mini/runtime.ts")
    expect(mini).not.toContain("packages/cli/src/run/run.ts")
    expect(mini).not.toContain("packages/cli/src/run/noninteractive.ts")
    expect(mini).not.toContain("packages/cli/src/run/ui.ts")
    expect(mini).not.toContain("packages/tui/src/runtime.tsx")
  }, coldBundleTimeout)

  test("keeps the standalone TUI artifact inside the retained package boundary", async () => {
    const graph = await bundleInputs("packages/cli/src/tui.ts")

    expect(graph).toContain("packages/cli/src/commands/handlers/tui.ts")
    expect(graph.some((file) => file.startsWith("packages/tui/src/"))).toBe(true)
    expect(graph.some((file) => file.startsWith("packages/server/src/"))).toBe(true)
    expect(graph).not.toContain("packages/cli/src/commands/commands.ts")
    const retained = new Set([
      "ai",
      "cli",
      "client",
      "codemode",
      "core",
      "effect-drizzle-sqlite",
      "effect-sqlite-node",
      "http-recorder",
      "httpapi-codegen",
      "plugin",
      "protocol",
      "schema",
      "script",
      "server",
      "simulation",
      "tui",
      "ui",
    ])
    expect(
      graph.filter((file) => {
        const match = /^packages\/([^/]+)\//.exec(file)
        return match ? !retained.has(match[1]) : false
      }),
    ).toEqual([])
    expect(
      graph.filter(
        (file) =>
          file.startsWith("packages/cli/src/commands/handlers/") &&
          file !== "packages/cli/src/commands/handlers/tui.ts" &&
          file !== "packages/cli/src/commands/handlers/tui-serve.ts" &&
          file !== "packages/cli/src/commands/handlers/tui-shared.ts" &&
          file !== "packages/cli/src/commands/handlers/run.ts" &&
          file !== "packages/cli/src/commands/handlers/run-shared.ts" &&
          file !== "packages/cli/src/commands/handlers/update.ts" &&
          file !== "packages/cli/src/commands/handlers/serve-shared.ts",
      ),
    ).toEqual([])
  }, coldBundleTimeout)

  test("keeps TUI Mini independent from Core, Server, and CLI", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}")
    const imports: string[] = []
    for await (const file of glob.scan({ cwd: path.join(root, "packages/tui/src/mini") })) {
      const source = await Bun.file(path.join(root, "packages/tui/src/mini", file)).text()
      if (/["']@ycoding-ai\/(?:core|server|cli)(?:\/[^"']*)?["']/.test(source)) imports.push(file)
    }
    expect(imports).toEqual([])

    const graph = await bundleInputs("packages/tui/src/mini/index.ts")
    expect(graph.filter((file) => file.startsWith("packages/core/"))).toEqual([])
    expect(graph.filter((file) => file.startsWith("packages/cli/") || file.startsWith("packages/server/"))).toEqual([])
  }, coldBundleTimeout)
})

async function bundleInputs(entrypoint: string) {
  const temporary = await mkdtemp(path.join(import.meta.dir, ".import-boundary-"))
  const metafile = path.join(temporary, "meta.json")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        entrypoint,
        "--target=bun",
        "--format=esm",
        "--packages=bundle",
        "--external=@opentui/core-*",
        `--metafile=${metafile}`,
        `--outdir=${path.join(temporary, "out")}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)
    const metadata = await Bun.file(metafile).json()
    return Object.keys(metadata.inputs).map((input) =>
      path.relative(root, path.resolve(root, input)).replaceAll(path.sep, "/"),
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
