import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const executableName = process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime"
const harness = `
  import { mock } from "bun:test"
  import path from "node:path"
  if (process.env.STAGED_RUNTIME !== undefined || process.env.SCENARIO === "missing-artifact") {
    Object.defineProperty(process, "platform", { value: "darwin" })
    Object.defineProperty(process, "arch", { value: "arm64" })
    process.env.GITHUB_ACTIONS = "true"
    process.env.GITHUB_EVENT_NAME = process.env.RELEASE_EVENT
    process.env.GITHUB_REPOSITORY = "example/ycoding"
    process.env.GITHUB_REF = process.env.RELEASE_EVENT === "push" ? "refs/tags/v0.13.5" : "refs/heads/main"
    process.env.GITHUB_WORKFLOW_REF = "example/ycoding/.github/workflows/release.yml@" + process.env.GITHUB_REF
    if (process.env.STAGED_RUNTIME !== undefined) process.env.YCODING_RELEASE_RUNTIME_DIR = process.env.STAGED_RUNTIME
  }
  const file = Bun.file
  Bun.file = (value, ...options) => {
    const name = String(value)
    if (name.endsWith("ycoding-runtime") || name.endsWith("ycoding-runtime.exe")) {
      const expected = path.join(process.env.METADATA_TARGET, "release", process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime")
      if (name !== expected && name !== verifiedRuntime) throw new Error("Attempted to read a runtime that was not built or verified")
    }
    return file(value, ...options)
  }
  const childProcess = await import("node:child_process")
  const calls = []
  let verifiedRuntime
  mock.module("node:child_process", () => ({
    ...childProcess,
    spawnSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd, env: { CARGO_TARGET_DIR: options.env.CARGO_TARGET_DIR, YCODING_BUNDLED_MODELS_PATH: options.env.YCODING_BUNDLED_MODELS_PATH }, stdio: options.stdio })
      if (process.env.SCENARIO === "missing-artifact") throw new Error("Attempted to build without a staged runtime")
      if (process.env.STAGED_RUNTIME !== undefined) {
        if (command !== "bash" || args[0] !== "script/runtime-receipt.sh" || args[1] !== "verify" || args[2] !== process.env.STAGED_RUNTIME || options.env.RECEIPT_TARGET !== "darwin-arm64" || options.env.RECEIPT_PROFILE !== "release")
          throw new Error("The staged runtime consumer attempted an unverified build")
        if (process.env.SCENARIO === "receipt-failure") return { status: 1 }
        verifiedRuntime = args[3]
        require("node:fs").writeFileSync(verifiedRuntime, "verified staged runtime")
        return { status: 0 }
      }
      if (process.env.SCENARIO === "missing") return { error: Object.assign(new Error("cargo missing"), { code: "ENOENT" }), status: null, signal: null }
      if (args[0] === "metadata") {
        if (process.env.SCENARIO === "metadata-failure") return { error: undefined, status: 7, signal: null, stdout: "" }
        return { error: undefined, status: 0, signal: null, stdout: JSON.stringify({ target_directory: process.env.METADATA_TARGET, packages: [{ name: "ycoding-runtime", id: "ycoding-runtime-id" }] }) }
      }
      if (process.env.SCENARIO === "build-failure") return { error: undefined, status: 9, signal: null, stdout: "" }
      const fs = require("node:fs")
      const { metadata } = require(path.join(process.env.RUNTIME_MODULE, "../regex-worker-metadata"))
      const recipe = metadata()
      const outDir = fs.mkdtempSync(path.join(process.env.METADATA_TARGET, "regex-out-"))
      fs.writeFileSync(path.join(outDir, "regex_worker.metadata"), recipe.sha256 + "\\n" + recipe.byteLength + "\\n")
      const stdout = JSON.stringify({ reason: "build-script-executed", package_id: "ycoding-runtime-id", out_dir: outDir }) + "\\n"
      return { error: undefined, status: 0, signal: null, stdout }
    },
  }))
  const { buildRuntime } = await import(process.env.RUNTIME_MODULE)
  try {
    const result = await buildRuntime(JSON.parse(process.env.TARGET))
    const fs = await import("node:fs/promises")
    const { createHash } = await import("node:crypto")
    const { brotliDecompressSync } = await import("node:zlib")
    const source = path.join(process.env.METADATA_TARGET, "release", process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime")
    if (process.env.SCENARIO === "replace") await fs.writeFile(source, "subsequent Cargo output")
    const asset = await fs.readFile(result.path)
    const decoded = { contents: brotliDecompressSync(asset).toString("utf8"), assetSha256: createHash("sha256").update(asset).digest("hex") }
    await result.dispose()
    console.log(JSON.stringify({ result, calls, ...decoded, disposed: !(await fs.stat(result.path).then(() => true, () => false)), sourceRetained: verifiedRuntime ? undefined : await fs.readFile(source, "utf8"), verifiedRuntimeCleaned: verifiedRuntime ? !(await fs.stat(verifiedRuntime).then(() => true, () => false)) : undefined }))
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, code: error.code, calls }))
  }
`

async function run(input: { targetDirectory?: string; cargoTargetDir?: string; scenario?: string; target?: object; stagedRuntime?: string; releaseEvent?: "workflow_dispatch" | "push" }) {
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !["CARGO_TARGET_DIR", "YCODING_RELEASE_RUNTIME_DIR", "STAGED_RUNTIME"].includes(name))),
    RUNTIME_MODULE: path.join(root, "packages/cli/script/runtime.ts"),
    TARGET: JSON.stringify(input.target ?? { os: process.platform, arch: process.arch }),
    METADATA_TARGET: input.targetDirectory ?? "",
    ...(input.cargoTargetDir === undefined ? {} : { CARGO_TARGET_DIR: input.cargoTargetDir }),
    ...(input.stagedRuntime === undefined ? {} : { STAGED_RUNTIME: input.stagedRuntime }),
    SCENARIO: input.scenario ?? "success",
    RELEASE_EVENT: input.releaseEvent ?? "workflow_dispatch",
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
    result?: { path: string; sha256: string; payloadSha256: string }
    error?: string
    code?: string
    contents?: string
    assetSha256?: string
    disposed?: boolean
    sourceRetained?: string
    verifiedRuntimeCleaned?: boolean
    calls: Array<{
      command: string
      args: string[]
      cwd: string
      env: Record<string, string | undefined>
      stdio?: string[]
    }>
  }
}

test.each(["workflow_dispatch", "push"] as const)("buildRuntime embeds verified Apple Silicon bytes without compiling or falling back on %s", async (releaseEvent) => {
  const target = { os: "darwin", arch: "arm64" }
  const stagedRuntime = path.join(os.tmpdir(), "release-runtime")
  const accepted = await run({ target, stagedRuntime, releaseEvent })
  expect(accepted.contents).toBe("verified staged runtime")
  expect(accepted.result?.sha256).toBe(createHash("sha256").update("verified staged runtime").digest("hex"))
  expect(accepted.verifiedRuntimeCleaned).toBe(true)
  expect(accepted.calls.map(({ command }) => command)).toEqual(["bash"])

  const rejected = await run({ target, stagedRuntime, releaseEvent, scenario: "receipt-failure" })
  expect(rejected.error).toContain("Verifying the Apple Silicon release runtime failed")
  expect(rejected.result).toBeUndefined()
  expect(rejected.calls.map(({ command }) => command)).toEqual(["bash"])

  expect(await run({ target, releaseEvent, scenario: "missing-artifact" })).toMatchObject({
    error: "Apple Silicon release packaging requires the staged runtime", calls: [],
  })
})

test("buildRuntime uses Cargo metadata's configured target directory and preserves Cargo inputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-build-"))
  const targetDirectory = path.join(directory, "cargo-target")
  const artifact = path.join(targetDirectory, "release", executableName)
  try {
    await mkdir(path.dirname(artifact), { recursive: true })
    await writeFile(artifact, "synthetic authoritative runtime")
    for (const cargoTargetDir of [undefined, path.relative(root, targetDirectory)]) {
      const result = await run({ targetDirectory, cargoTargetDir })
      expect(result.result?.path).not.toBe(artifact)
      expect(result.result?.sha256).toBe(createHash("sha256").update("synthetic authoritative runtime").digest("hex"))
      expect(result.contents).toBe("synthetic authoritative runtime")
      expect(result.result?.payloadSha256).toBe(result.assetSha256)
      expect(result.result?.payloadSha256).not.toBe(result.result?.sha256)
      expect(result.disposed).toBe(true)
      expect(result.sourceRetained).toBe("synthetic authoritative runtime")
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
          "--message-format=json-render-diagnostics",
          "--timings",
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
        stdio: ["ignore", "pipe", "inherit"],
      })
      expect(result.calls[0].env.YCODING_BUNDLED_MODELS_PATH).toContain("models")
      for (const call of result.calls.slice(1)) {
        expect(call.env.YCODING_BUNDLED_MODELS_PATH).toBe(result.calls[0].env.YCODING_BUNDLED_MODELS_PATH)
        expect(call.env.CARGO_TARGET_DIR).toBe(cargoTargetDir)
      }
      expect(result.calls[0].env.CARGO_TARGET_DIR).toBe(cargoTargetDir)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("buildRuntime snapshots the selected bytes before a subsequent Cargo build replaces the source", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-snapshot-"))
  const artifact = path.join(directory, "release", executableName)
  try {
    await mkdir(path.dirname(artifact), { recursive: true })
    await writeFile(artifact, "synthetic authoritative runtime")
    const result = await run({ targetDirectory: directory, scenario: "replace" })
    expect(result.contents).toBe("synthetic authoritative runtime")
    expect(result.result?.sha256).toBe(createHash("sha256").update(result.contents!).digest("hex"))
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
