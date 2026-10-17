import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const executableName = process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime"
const harness = `
  import { mock } from "bun:test"
  import path from "node:path"
  const file = Bun.file
  Bun.file = (value, ...options) => {
    const name = String(value)
    if (name.endsWith("ycoding-runtime") || name.endsWith("ycoding-runtime.exe")) {
      const expected = path.join(process.env.METADATA_TARGET, "release", process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime")
      if (name !== expected) throw new Error("Attempted to read an artifact outside Cargo's reported target")
    }
    return file(value, ...options)
  }
  const childProcess = await import("node:child_process")
  const calls = []
  mock.module("node:child_process", () => ({
    ...childProcess,
    spawnSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd, env: { CARGO_TARGET_DIR: options.env.CARGO_TARGET_DIR, YCODING_BUNDLED_MODELS_PATH: options.env.YCODING_BUNDLED_MODELS_PATH }, stdio: options.stdio })
      if (process.env.SCENARIO === "missing") return { error: Object.assign(new Error("cargo missing"), { code: "ENOENT" }), status: null, signal: null }
      if (args[0] === "metadata") {
        if (process.env.SCENARIO === "metadata-failure") return { error: undefined, status: 7, signal: null, stdout: "" }
        return { error: undefined, status: 0, signal: null, stdout: JSON.stringify({ target_directory: process.env.METADATA_TARGET }) }
      }
      if (process.env.SCENARIO === "build-failure") return { error: undefined, status: 9, signal: null }
      return { error: undefined, status: 0, signal: null }
    },
  }))
  const { buildRuntime } = await import(process.env.RUNTIME_MODULE)
  try {
    const result = await buildRuntime(JSON.parse(process.env.TARGET))
    console.log(JSON.stringify({ result, calls }))
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, code: error.code, calls }))
  }
`

async function run(input: { targetDirectory?: string; cargoTargetDir?: string; scenario?: string; target?: object }) {
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CARGO_TARGET_DIR")),
    RUNTIME_MODULE: path.join(root, "packages/cli/script/runtime.ts"),
    TARGET: JSON.stringify(input.target ?? { os: process.platform, arch: process.arch }),
    METADATA_TARGET: input.targetDirectory ?? "",
    ...(input.cargoTargetDir === undefined ? {} : { CARGO_TARGET_DIR: input.cargoTargetDir }),
    SCENARIO: input.scenario ?? "success",
  }
  const child = Bun.spawnSync([process.execPath, "-e", harness], {
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode).toBe(0)
  return JSON.parse(
    child.stdout
      .toString()
      .split("\n")
      .find((line) => line.startsWith("{"))!,
  ) as {
    result?: string
    error?: string
    code?: string
    calls: Array<{
      command: string
      args: string[]
      cwd: string
      env: Record<string, string | undefined>
      stdio?: string
    }>
  }
}

test("buildRuntime uses Cargo metadata's configured target directory and preserves Cargo inputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-build-"))
  const targetDirectory = path.join(directory, "cargo-target")
  const artifact = path.join(targetDirectory, "release", executableName)
  try {
    await mkdir(path.dirname(artifact), { recursive: true })
    await writeFile(artifact, "synthetic authoritative runtime")
    for (const cargoTargetDir of [undefined, path.relative(root, targetDirectory)]) {
      const result = await run({ targetDirectory, cargoTargetDir })
      expect(result.result).toBe(Buffer.from("synthetic authoritative runtime").toString("base64"))
      expect(result.calls).toHaveLength(2)
      expect(result.calls[0]).toMatchObject({
        command: "cargo",
        args: [
          "metadata",
          "--locked",
          "--manifest-path",
          path.join(root, "rust/Cargo.toml"),
          "--no-deps",
          "--format-version",
          "1",
        ],
        cwd: root,
      })
      expect(result.calls[1]).toMatchObject({
        command: "cargo",
        args: [
          "build",
          "--locked",
          "--manifest-path",
          path.join(root, "rust/Cargo.toml"),
          "--release",
          "-p",
          "ycoding-runtime",
          "--bin",
          "ycoding-runtime",
        ],
        cwd: root,
        stdio: "inherit",
      })
      expect(result.calls[0].env.YCODING_BUNDLED_MODELS_PATH).toContain("models")
      expect(result.calls[1].env.YCODING_BUNDLED_MODELS_PATH).toBe(result.calls[0].env.YCODING_BUNDLED_MODELS_PATH)
      expect(result.calls[0].env.CARGO_TARGET_DIR).toBe(cargoTargetDir)
      expect(result.calls[1].env.CARGO_TARGET_DIR).toBe(cargoTargetDir)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("buildRuntime propagates metadata, build, and missing Cargo failures", async () => {
  expect((await run({ scenario: "metadata-failure" })).error).toBe("Rust payload metadata failed (7)")
  expect((await run({ scenario: "build-failure" })).error).toBe("Rust payload build failed (9)")
  expect(await run({ scenario: "missing" })).toMatchObject({ error: "cargo missing", code: "ENOENT" })
})

test("buildRuntime rejects host, architecture, and musl mismatches before spawning Cargo", async () => {
  for (const target of [
    { os: "unsupported-os", arch: process.arch },
    { os: process.platform, arch: "unsupported-arch" },
    { os: process.platform, arch: process.arch, abi: "musl" },
  ]) {
    expect(await run({ target })).toMatchObject({
      error: "Rust payload builds require a matching native host",
      calls: [],
    })
  }
})
