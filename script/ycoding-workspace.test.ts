import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import {
  approvedPackageNames,
  checkWorkspace,
  discoverPackageNames,
  checkFrontendBoundary,
  checkBundleGraph,
} from "./ycoding-workspace"

const root = path.resolve(import.meta.dirname, "..")

describe("YCoding workspace", () => {
  test("contains only the approved runtime and client packages", async () => {
    const discovered = await discoverPackageNames(root)
    expect(discovered).toEqual([...approvedPackageNames].sort())
  })

  test("discovers approved web and relay packages while rejecting unrelated apps", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "ycoding-workspace-"))
    try {
      for (const [directory, name] of [
        ["packages/remote", "@ycoding-ai/remote"],
        ["apps/web", "@ycoding-ai/web"],
        ["apps/unapproved", "unapproved-app"],
        ["extensions/meeting", "@ycoding-ai/meeting"],
        ["extensions/unapproved", "unapproved-extension"],
      ] as const) {
        await mkdir(path.join(fixture, directory), { recursive: true })
        await Bun.write(path.join(fixture, directory, "package.json"), JSON.stringify({ name }))
      }
      expect(await discoverPackageNames(fixture)).toEqual([
        "@ycoding-ai/meeting",
        "@ycoding-ai/remote",
        "@ycoding-ai/web",
        "unapproved-app",
        "unapproved-extension",
      ])
      expect(await checkWorkspace(fixture)).toEqual(["unapproved-app", "unapproved-extension"])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

async function workspace(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-boundary-"))
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await Bun.write(path.join(directory, file), content)
    }
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const frontendManifest = JSON.stringify({ name: "@ycoding-ai/tui" })
const backendManifest = JSON.stringify({
  name: "@ycoding-ai/core",
  exports: { "./*": "./src/*.ts", ".": "./src/index.ts" },
})

describe("frontend production boundary (audit §8)", () => {
  test.each([
    ['import { value } from "@ycoding-ai/core"', "@ycoding-ai/core", 1],
    ['import {\n value,\n} from "@ycoding-ai/core/value"', "@ycoding-ai/core/value", 3],
    ['import "@ycoding-ai/core/value"', "@ycoding-ai/core/value", 1],
    ['await import("@ycoding-ai/core/value")', "@ycoding-ai/core/value", 1],
    ['const value = require("@ycoding-ai/core/value")', "@ycoding-ai/core/value", 1],
    ['import type { Value } from "@ycoding-ai/core/value"', "@ycoding-ai/core/value", 1],
    ['export { value } from "@ycoding-ai/core/value"', "@ycoding-ai/core/value", 1],
    ['type Value = import("@ycoding-ai/core/value").Value', "@ycoding-ai/core/value", 1],
    ['import Value = require("@ycoding-ai/core/value")', "@ycoding-ai/core/value", 1],
    ['import { value } from "../../core/src/value.js"', "../../core/src/value.js", 1],
    ['import { value } from "@backend/value"', "@backend/value", 1],
    ['import { value } from "#backend"', "#backend", 1],
  ])("reports syntax/ownership: %s", async (code, specifier, line) => {
    await workspace(
      {
        "packages/tui/package.json": JSON.stringify({
          name: "@ycoding-ai/tui",
          imports: { "#backend": "../core/src/value.ts" },
        }),
        "packages/tui/tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@backend/*": ["../core/src/*"] } },
        }),
        "packages/core/package.json": backendManifest,
        "packages/core/src/value.ts": "export const value = 1; export type Value = string",
        "packages/core/src/index.ts": 'export { value } from "./value"',
        "packages/tui/src/index.ts": code,
      },
      async (root) => {
        const result = await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })
        expect(result.violations).toEqual([
          {
            frontend: "packages/tui",
            file: "packages/tui/src/index.ts",
            line,
            specifier,
            owner: "@ycoding-ai/core",
            kind: "source",
          },
        ])
      },
    )
  })

  test.each(["core", "server", "ai", "store", "codemode", "effect-drizzle-sqlite", "effect-sqlite-node"])(
    "rejects %s even without an installed export",
    async (name) => {
      await workspace(
        {
          "packages/tui/package.json": frontendManifest,
          "packages/tui/src/index.ts": `import "@ycoding-ai/${name}/value"`,
        },
        async (root) => {
          expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations[0]?.owner).toBe(
            `@ycoding-ai/${name}`,
          )
        },
      )
    },
  )

  test("permits safe types/codecs/presentation exports, ignores strings/comments and unreachable fixtures, follows cycles", async () => {
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        "packages/tui/src/index.ts":
          'import type { Value } from "@ycoding-ai/schema"; export { codec } from "@ycoding-ai/plugin/tui"; import "./cycle"; const text = \'import "@ycoding-ai/core"\'; // import("@ycoding-ai/server")\n/* require("@ycoding-ai/ai") */',
        "packages/tui/src/cycle.ts": 'import "./index"',
        "packages/tui/src/fixture.test.ts": 'import "@ycoding-ai/core"',
        "packages/tui/src/fixtures/backend.ts": 'import "@ycoding-ai/server"',
        "packages/schema/package.json": JSON.stringify({ name: "@ycoding-ai/schema", exports: "./src/index.ts" }),
        "packages/schema/src/index.ts": "export type Value = string",
        "packages/plugin/package.json": JSON.stringify({
          name: "@ycoding-ai/plugin",
          exports: { "./tui": "./src/tui.ts" },
        }),
        "packages/plugin/src/tui.ts": "export const codec = (value: string) => value",
        "packages/plugin/src/backend.ts": 'import "@ycoding-ai/ai"',
      },
      async (root) =>
        expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations).toEqual([]),
    )
  })

  test.each(["plugin", "simulation"])(
    "follows conditional wildcard %s exports into forbidden transitive re-exports",
    async (name) => {
      await workspace(
        {
          "packages/tui/package.json": frontendManifest,
          "packages/tui/src/index.ts": `import "@ycoding-ai/${name}/safe"`,
          [`packages/${name}/package.json`]: JSON.stringify({
            name: `@ycoding-ai/${name}`,
            exports: { "./*": { bun: "./src/*.ts", node: "./src/*.node.ts" } },
          }),
          [`packages/${name}/src/safe.ts`]: "export const value = 1",
          [`packages/${name}/src/safe.node.ts`]: 'export * from "@ycoding-ai/server/process"',
        },
        async (root) =>
          expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations).toEqual([
            {
              frontend: "packages/tui",
              file: `packages/${name}/src/safe.node.ts`,
              line: 1,
              specifier: "@ycoding-ai/server/process",
              owner: "@ycoding-ai/server",
              kind: "source",
            },
          ]),
      )
    },
  )

  test("does not exempt a reachable test-only fixture", async () => {
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        "packages/tui/src/index.ts": 'import "./fixtures/backend.test"',
        "packages/tui/src/fixtures/backend.test.ts": 'import "@ycoding-ai/core"',
      },
      async (root) => {
        expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations[0]).toMatchObject({
          file: "packages/tui/src/fixtures/backend.test.ts",
          owner: "@ycoding-ai/core",
        })
      },
    )
  })

  test("a safe declaration file cannot hide a JavaScript runtime re-export", async () => {
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        "packages/tui/src/index.ts": 'import "@ycoding-ai/plugin/tui"',
        "packages/plugin/package.json": JSON.stringify({
          name: "@ycoding-ai/plugin",
          exports: { "./tui": "./src/tui.js" },
        }),
        "packages/plugin/src/tui.d.ts": "export type Value = string",
        "packages/plugin/src/tui.js": 'export * from "./backend.cjs"',
        "packages/plugin/src/backend.cjs": 'module.exports = require("@ycoding-ai/core")',
      },
      async (root) => {
        expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations).toEqual([
          {
            frontend: "packages/tui",
            file: "packages/plugin/src/backend.cjs",
            line: 1,
            specifier: "@ycoding-ai/core",
            owner: "@ycoding-ai/core",
            kind: "source",
          },
        ])
      },
    )
  })

  test("rejects runtime and optional manifests, not dev-only references", async () => {
    await workspace(
      {
        "packages/tui/package.json":
          '{\n "name": "@ycoding-ai/tui",\n "dependencies": {"@ycoding-ai/core": "workspace:*"},\n "optionalDependencies": {"@ycoding-ai/server": "workspace:*"},\n "devDependencies": {"@ycoding-ai/ai": "workspace:*"}\n}',
      },
      async (root) => {
        expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations).toEqual([
          {
            frontend: "packages/tui",
            file: "packages/tui/package.json",
            line: 3,
            specifier: "@ycoding-ai/core",
            owner: "@ycoding-ai/core",
            kind: "manifest",
          },
          {
            frontend: "packages/tui",
            file: "packages/tui/package.json",
            line: 4,
            specifier: "@ycoding-ai/server",
            owner: "@ycoding-ai/server",
            kind: "manifest",
          },
        ])
      },
    )
  })

  test("prints a declared extension loader while checking its static graph", async () => {
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        "packages/tui/src/index.ts":
          'import "@ycoding-ai/core"; async function loadPlugin(entrypoint: string) { return import(entrypoint) }',
      },
      async (root) => {
        const result = await checkFrontendBoundary(root, {
          sqliteReaders: [],
          loaders: [
            {
              file: "packages/tui/src/index.ts",
              function: "loadPlugin",
              reason: "Loads user-configured presentation plugins outside the shipped graph",
            },
          ],
        })
        expect(result.loaders).toEqual([
          "packages/tui/src/index.ts:1 loadPlugin: Loads user-configured presentation plugins outside the shipped graph",
        ])
        expect(result.violations).toHaveLength(1)
        expect(result.violations[0]?.owner).toBe("@ycoding-ai/core")
      },
    )
  })

  test("the command prints the declared loader and passes its backend-free shipped source", async () => {
    await workspace(
      {
        "packages/tui/package.json": JSON.stringify({
          name: "@ycoding-ai/tui",
          imports: {
            "#zed-sqlite": { bun: "./src/editor-zed-sqlite.bun.ts", node: "./src/editor-zed-sqlite.node.ts" },
          },
        }),
        "packages/tui/src/plugin/context.tsx":
          "async function loadPlugin(entrypoint: string) { return import(entrypoint) }",
        "packages/tui/src/editor-zed.ts": 'import { Database } from "#zed-sqlite"',
        "packages/tui/src/editor-zed-sqlite.bun.ts": 'export { Database } from "bun:sqlite"',
        "packages/tui/src/editor-zed-sqlite.node.ts": 'import { DatabaseSync } from "node:sqlite"',
      },
      async (root) => {
        const result = Bun.spawnSync(
          [
            process.execPath,
            path.join(import.meta.dirname, "ycoding-workspace.ts"),
            `--root=${root}`,
            "--frontend=tui",
          ],
          { stdout: "pipe", stderr: "pipe", timeout: 10000 },
        )
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain(
          "Declared boundary site: packages/tui/src/plugin/context.tsx:1 loadPlugin:",
        )
        expect(result.stderr.toString()).toBe("")
      },
    )
  })

  test.each([
    ['YCODING_RUNTIME_ASSET, { with: { type: "file" } }', true],
    ["YCODING_RUNTIME_ASSET", false],
    ['YCODING_RUNTIME_ASSET, { with: { type: "json" } }', false],
    ["YCODING_RUNTIME_ASSET, { with: { type: selected } }", false],
    ['YCODING_RUNTIME_ASSET, { with: { type: "file", ...attributes } }', false],
    ['other, { with: { type: "file" } }', false],
  ])("restricts declared binary assets to the exact raw-file import: %s", async (argumentsSource, allowed) => {
    await workspace(
      {
        "packages/cli/package.json": JSON.stringify({ name: "@ycoding-ai/cli" }),
        "packages/cli/src/runtime-executable.ts": `async function runtimeExecutable() { await import(${argumentsSource}); await import("@ycoding-ai/core") }`,
      },
      async (root) => {
        const result = await checkFrontendBoundary(root, {
          sqliteReaders: [],
          loaders: [
            {
              file: "packages/cli/src/runtime-executable.ts",
              function: "runtimeExecutable",
              asset: "YCODING_RUNTIME_ASSET",
              reason: "Raw native runtime file",
            },
          ],
        })
        expect(result.violations.filter((entry) => entry.kind === "nonliteral")).toHaveLength(allowed ? 0 : 1)
        expect(result.violations.filter((entry) => entry.kind === "stale-loader")).toHaveLength(allowed ? 0 : 1)
        expect(result.violations.filter((entry) => entry.owner === "@ycoding-ai/core")).toHaveLength(1)
      },
    )
  })

  test("rejects undeclared nonliteral import/require and stale declarations", async () => {
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        "packages/tui/src/index.ts":
          "async function other(name: string) { await import(name); require(`@ycoding-ai/${name}`) }",
      },
      async (root) => {
        const result = await checkFrontendBoundary(root, {
          sqliteReaders: [],
          loaders: [
            { file: "packages/tui/src/index.ts", function: "loadPlugin", reason: "Presentation plugin loader" },
          ],
        })
        expect(result.violations.map((entry) => entry.kind)).toEqual(["nonliteral", "nonliteral", "stale-loader"])
        expect(result.violations.map((entry) => entry.specifier)).toEqual([
          "name",
          "`@ycoding-ai/${name}`",
          "loadPlugin",
        ])
      },
    )
  })

  test("checks extension runtime and view modules without scanning build scripts", async () => {
    await workspace(
      {
        "extensions/chrome/service-worker.js": 'import "@ycoding-ai/core"',
        "extensions/meeting/view/app.mjs": 'require("@ycoding-ai/ai")',
        "extensions/meeting/src/tui.tsx": 'export * from "@ycoding-ai/server"',
        "extensions/meeting/src/runtime.ts": 'import "@ycoding-ai/store"',
        "extensions/meeting/script/build.ts": 'import "@ycoding-ai/core"',
      },
      async (root) => {
        expect(
          (await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [] })).violations.map(
            (entry) => entry.owner,
          ),
        ).toEqual(["@ycoding-ai/core", "@ycoding-ai/store", "@ycoding-ai/server", "@ycoding-ai/ai"])
      },
    )
  })

  test("rejects bundled backend modules and external backend imports, permits pure modules", () => {
    expect(
      checkBundleGraph({
        frontend: "web",
        outputs: [{ file: "dist/app.js", modules: ["/repo/packages/schema/src/index.ts"], imports: [] }],
      }),
    ).toEqual([])
    expect(
      checkBundleGraph({
        frontend: "cli",
        outputs: [
          {
            file: "dist/cli",
            modules: [
              "/repo/packages/core/src/index.ts",
              "/repo/node_modules/node-pty/lib/index.js",
              "/repo/node_modules/better-sqlite3/lib/index.js",
            ],
            imports: ["bun:sqlite", "@ycoding-ai/server/process"],
          },
        ],
      }).map((entry) => entry.owner),
    ).toEqual(["@ycoding-ai/core", "node-pty", "sqlite", "sqlite", "@ycoding-ai/server"])
    expect(() => checkBundleGraph({ frontend: "web", outputs: [] })).toThrow("Empty shipped graph")
  })

  test("permits a declared Zed reader only with importer evidence; rejects other SQLite and stale readers", async () => {
    const reader = {
      file: "packages/tui/src/reader.ts",
      module: "packages/tui/src/editor.ts",
      reason: "Reads the editor database, not the YCoding store",
    }
    const output = {
      file: "dist/tui",
      modules: ["/repo/" + reader.module, "/repo/" + reader.file],
      imports: ["bun:sqlite"],
      edges: [{ file: "/repo/" + reader.file, specifier: "bun:sqlite" }],
    }
    const graph = { frontend: "tui", outputs: [output] }
    expect(checkBundleGraph(graph, [reader])).toEqual([])
    expect(
      checkBundleGraph(
        {
          ...graph,
          outputs: [{ ...output, edges: [{ file: "/repo/packages/tui/src/other.ts", specifier: "bun:sqlite" }] }],
        },
        [reader],
      )[0]?.owner,
    ).toBe("sqlite")
    expect(checkBundleGraph({ ...graph, outputs: [{ ...output, imports: ["drizzle-orm"] }] }, [reader])[0]?.owner).toBe(
      "sqlite",
    )
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        [reader.module]: 'import "./reader"',
        [reader.file]: 'export { Database } from "bun:sqlite"',
      },
      async (root) => {
        const result = await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [reader] })
        expect(result.violations).toEqual([])
        expect(result.loaders[0]).toContain("declared SQLite reader")
      },
    )
    await workspace(
      {
        "packages/tui/package.json": frontendManifest,
        [reader.module]: 'import "./reader"',
        [reader.file]: "export const value = 1",
      },
      async (root) => {
        expect((await checkFrontendBoundary(root, { loaders: [], sqliteReaders: [reader] })).violations[0]?.kind).toBe(
          "stale-reader",
        )
      },
    )
  })
})
