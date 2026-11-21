import { expect, test } from "bun:test"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { checkBundleGraph } from "../../../script/ycoding-workspace"
import { nativeBuildTarget } from "../script/native-target"
import { Codec } from "../src/plugin-host/codec"
import pkg from "../package.json"

const root = path.resolve(import.meta.dirname, "../../..")
const packageRoot = path.join(root, "packages/cli")
const publicEntries = Object.entries(pkg.exports).map(([specifier, entry]) => ({
  specifier,
  entry: typeof entry === "string" ? entry : entry.import,
  declarations: typeof entry === "string" ? undefined : entry.types,
}))
const graphEntries = [
  "src/tui.ts",
  "src/index.ts",
  "src/node/index.ts",
  ...publicEntries.map(({ entry }) => entry),
  "src/server-process.ts",
]

test("C07 public export inventory distinguishes runtime and declaration conditions", () => {
  expect(publicEntries).toEqual([
    { specifier: "./run", entry: "./src/run/index.ts", declarations: undefined },
    { specifier: "./server-process", entry: "./lib/server-process.mjs", declarations: "./lib/server-process.d.ts" },
  ])
})

test("C07 source and shipped graph inventory retains every public runtime and producer source", () => {
  expect(graphEntries).toEqual([
    "src/tui.ts",
    "src/index.ts",
    "src/node/index.ts",
    "./src/run/index.ts",
    "./lib/server-process.mjs",
    "src/server-process.ts",
  ])
})

function bounded(value: string) {
  const text = value.replace(/\b(Bearer|Basic)\s+[^\s"'\\]+/gi, "$1 [redacted]")
  return text.length > 4096 ? text.slice(0, 2048) + "\n[output omitted]\n" + text.slice(-2048) : text
}

test.each(["src/tui.ts", "src/index.ts", "src/node/index.ts"])(
  "C06 real %s source entry routes plugin-host frames before normal CLI setup",
  async (entry) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-real-host-entry-"))
    const cache = path.join(directory, "cache-is-a-file")
    await writeFile(cache, "synthetic setup refusal")
    const child = Bun.spawn([process.execPath, "--conditions=browser", path.join(packageRoot, entry), "plugin-host"], {
      cwd: packageRoot,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:YCODING_|OTEL_)/.test(key))),
        HOME: directory,
        USERPROFILE: directory,
        APPDATA: path.join(directory, "config"),
        LOCALAPPDATA: path.join(directory, "data"),
        YCODING_TEST_HOME: directory,
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_STATE_HOME: path.join(directory, "state"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        YCODING_CONFIG_DIR: path.join(directory, "config", "ycoding"),
        YCODING_CONFIG_CONTENT: "{}",
        YCODING_CONFIG_PROJECT_DISABLE: "1",
        YCODING_DISABLE_MODELS_FETCH: "1",
        YCODING_DISABLE_FILEWATCHER: "1",
        YCODING_RUNTIME_EXECUTABLE: path.join(directory, "must-not-start-a-backend"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const settled = Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ])
    try {
      child.stdin.write(
        Codec.frame(
          Codec.encode("HostFrame", {
            generation: "ext_entry",
            hello: {
              revision: 5,
              identity: "entry-fixture",
              generation: "ext_entry",
              grants: [],
              registration_order: 0,
              plugin: {
                target: Codec.text(path.join(directory, "unused-module.mjs")),
                options: Codec.value({}),
                cache: Codec.text(cache),
              },
            },
          }),
        ),
      )
      const [code, stdout, stderr] = await settled
      const frames = new Codec.FrameReader()
        .push(new Uint8Array(stdout))
        .map((frame) => Codec.decode("ChildFrame", frame))
      expect(frames).toHaveLength(1)
      expect(frames[0].ready).toEqual({ revision: 5, identity: "entry-fixture", generation: "ext_entry" })
      expect(frames[0].generation).toBe("ext_entry")
      expect(code).toBe(1)
      expect(stderr).toContain("Plugin setup failed")
      expect(await Bun.file(path.join(directory, "unused-module.mjs")).exists()).toBe(false)
    } catch (cause) {
      const [code, stdout, stderr] = await settled
      throw new Error(
        "Frontend entry evidence: " +
          JSON.stringify({
            entry,
            exitCode: code,
            signal: child.signalCode,
            stdoutBytes: stdout.byteLength,
            stdout: bounded(new TextDecoder().decode(new Uint8Array(stdout))),
            stderr: bounded(stderr),
          }),
        { cause },
      )
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)

for (const entry of graphEntries) {
  const declarations = publicEntries.find((item) => item.entry === entry)?.declarations
  test(`C07 real compiler graph for ${entry} contains no runtime execution owner`, async () => {
    if (declarations !== undefined) {
      const modulePath = path.resolve(packageRoot, entry)
      const moduleFile = Bun.file(modulePath)
      const declarationFile = Bun.file(path.resolve(packageRoot, declarations))
      if (!(await moduleFile.exists()) || !(await declarationFile.exists()))
        throw new Error(
          `C07 emitted artifact prerequisite missing: ${entry} and ${declarations} require the canonical CLI build`,
        )
      expect(await declarationFile.text()).toBe(await Bun.file(path.join(packageRoot, "src/user-app-api.d.ts")).text())
      const surface: unknown = await import(pathToFileURL(modulePath).href)
      expect(surface).toMatchObject({
        run: expect.any(Function),
        openUserApp: expect.any(Function),
        ServerProcess: { run: expect.any(Function), openUserApp: expect.any(Function) },
      })
    }
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-native-frontend-graph-"))
    const executable = ["src/tui.ts", "src/index.ts", "src/node/index.ts"].includes(entry)
    const host = executable ? nativeBuildTarget({ os: process.platform, arch: process.arch, single: true }) : undefined
    try {
      const result = await Bun.build({
        entrypoints: [path.resolve(packageRoot, entry)],
        tsconfig: path.join(packageRoot, "tsconfig.json"),
        plugins: declarations === undefined ? [createSolidTransformPlugin()] : [],
        external: ["node-gyp"],
        target: declarations === undefined ? "bun" : "node",
        format: "esm",
        splitting: true,
        minify: true,
        metafile: true,
        ...(host
          ? {
              compile: {
                target: `bun-${host.os === "win32" ? "windows" : host.os}-${host.arch}` as Bun.Build.CompileTarget,
                outfile: path.join(directory, "frontend"),
              },
              define: {
                YCODING_LIBC: host.os === "linux" ? "'glibc'" : "undefined",
                FFF_LIBC: host.os === "linux" ? "'gnu'" : "undefined",
                ...(host.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : {}),
              },
            }
          : { outdir: directory }),
      })
      if (!result.success)
        throw new Error(
          `C07 compiler prerequisite failed for ${entry} (${host ? "native frontend" : "module exports"}):\n` +
            bounded(result.logs.map(String).join("\n")),
        )
      if (!result.metafile) throw new Error("Real frontend compiler produced no audit graph")
      const modules = Object.keys(result.metafile.inputs).map((file) => path.resolve(packageRoot, file))
      if (host)
        expect(
          modules.some((file) => file.replaceAll(path.sep, "/").includes(`/@opentui/core-${host.os}-${host.arch}/`)),
          `C07 missing installed host compiler input @opentui/core-${host.os}-${host.arch}`,
        ).toBe(true)
      const edges = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
        input.imports.map((imported) => ({ file: path.resolve(packageRoot, file), specifier: imported.path })),
      )
      const graph = {
        frontend: entry,
        outputs: Object.entries(result.metafile.outputs).map(([file, output]) => ({
          file,
          modules,
          imports: [...output.imports.map((imported) => imported.path), ...edges.map((edge) => edge.specifier)],
          edges,
        })),
      }
      const violations = checkBundleGraph(graph)
      expect(violations.length, JSON.stringify(violations.slice(0, 5))).toBe(0)
      if (entry === "src/tui.ts") {
        const files = modules.map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
        expect(files).toContain("packages/cli/src/commands/handlers/tui.ts")
        expect(files.some((file) => file.startsWith("packages/tui/src/"))).toBe(true)
        expect(files).not.toContain("packages/cli/src/commands/commands.ts")
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 90_000)
}
