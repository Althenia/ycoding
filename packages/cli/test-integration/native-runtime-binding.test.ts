import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import type { MetadataInput } from "./fixture/runtime-metadata-owner"

const driver = path.join(import.meta.dirname, "fixture/runtime-metadata-owner.ts")
const filename = process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime"
type Result = {
  ok: boolean
  executable?: string
  message?: string
  request?: { command: string; args: string[]; cwd?: string }
}

async function metadata(response: MetadataInput["response"], createExecutable = true, override = false) {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-runtime-metadata-"))
  const target = path.join(root, "configured target; literal")
  const selected = path.join(target, "debug", filename)
  await mkdir(path.dirname(selected), { recursive: true })
  if (createExecutable) {
    await writeFile(selected, "synthetic executable bytes", { mode: 0o700 })
    await chmod(selected, 0o700)
  }
  const input = path.join(root, "metadata.json")
  await writeFile(input, JSON.stringify({ response, target } satisfies MetadataInput))
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:YCODING_|OTEL_)/.test(key))),
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "config"),
    LOCALAPPDATA: path.join(root, "data"),
    YCODING_TEST_HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
  if (override) env.YCODING_RUNTIME_EXECUTABLE = selected
  else delete env.YCODING_RUNTIME_EXECUTABLE
  const child = Bun.spawn([process.execPath, driver, input], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    return { result: JSON.parse(stdout) as Result, selected }
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}

test("C05 source runtime selection uses Cargo's configured target directory without executing Cargo", async () => {
  const { result, selected } = await metadata("configured")
  expect(result.ok, result.message).toBe(true)
  expect(result.executable).toBe(selected)
  expect(result.request?.command).toBe("cargo")
  expect(result.request?.args).toContain("metadata")
  expect(result.request?.args).toContain("--no-deps")
  expect(result.request?.args).toContain("--locked")
  const args = result.request?.args ?? []
  expect(args.some((value, index) => value === "--format-version=1" ||
    (value === "--format-version" && args[index + 1] === "1"))).toBe(true)
  const index = args.indexOf("--manifest-path")
  const manifest = index < 0 ? path.resolve(result.request?.cwd ?? "", "Cargo.toml")
    : path.resolve(result.request?.cwd ?? "", args[index + 1])
  expect(manifest).toBe(path.resolve(import.meta.dirname, "../../../rust/Cargo.toml"))
})

test("C05 an explicit executable binding takes precedence over unavailable Cargo metadata", async () => {
  const { result, selected } = await metadata("missing-cargo", true, true)
  expect(result.ok, result.message).toBe(true)
  expect(result.executable).toBe(selected)
  expect(result.request).toBeUndefined()
})

test.each(["missing-cargo", "failed", "malformed", "missing-target", "invalid-target"] as const)(
  "C05 %s metadata fails without falling back to a guessed native artifact",
  async (response) => {
    const { result } = await metadata(response)
    expect(result.request?.command).toBe("cargo")
    expect(result.ok).toBe(false)
    expect(result.message?.length).toBeGreaterThan(0)
    expect(result.executable).toBeUndefined()
  },
)

test("C05 a missing executable in Cargo's configured target is refused without a fallback", async () => {
  const { result } = await metadata("configured", false)
  expect(result.request?.command).toBe("cargo")
  expect(result.ok).toBe(false)
  expect(result.executable).toBeUndefined()
})

test("C05 an embedded payload wins over an invalid explicit executable without consulting Cargo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-embedded-runtime-binding-"))
  const runtime = new Uint8Array([0, 255, 127, 5, 9])
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
  const payload = brotliCompressSync(runtime)
  const asset = path.join(root, "payload.bin")
  const entry = path.join(root, "embedded.ts")
  const output = path.join(root, "out")
  await writeFile(asset, payload)
  await writeFile(entry, `import { mock } from "bun:test"
const api = { ...await import("node:child_process") }
mock.module("node:child_process", () => ({ ...api, spawnSync() { throw new Error("Embedded runtime consulted Cargo") } }))
const { runtimeExecutable } = await import(${JSON.stringify(path.resolve(import.meta.dirname, "../src/runtime-executable.ts"))})
console.log(JSON.stringify({ executable: await runtimeExecutable() }))
`)
  try {
    const result = await Bun.build({
      entrypoints: [entry], outdir: output, target: "bun", format: "esm",
      define: {
        YCODING_RUNTIME_ASSET: JSON.stringify(asset),
        YCODING_RUNTIME_SHA256: JSON.stringify(digest(runtime)),
        YCODING_RUNTIME_PAYLOAD_SHA256: JSON.stringify(digest(payload)),
        YCODING_VERSION: JSON.stringify("synthetic-embedded-runtime"),
        YCODING_CHANNEL: JSON.stringify("local"),
      },
    })
    if (!result.success) throw new Error(result.logs.map(String).join("\n"))
    const bundle = result.outputs.find((item) => item.kind === "entry-point")
    if (!bundle) throw new Error("Embedded runtime fixture has no entry output")
    const child = Bun.spawn([process.execPath, bundle.path], {
      cwd: path.dirname(bundle.path),
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:YCODING_|OTEL_)/.test(key))),
        HOME: root,
        USERPROFILE: root,
        APPDATA: path.join(root, "config"),
        LOCALAPPDATA: path.join(root, "data"),
        YCODING_TEST_HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        YCODING_RUNTIME_EXECUTABLE: path.join(root, "must-not-be-selected"),
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
    })
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const selected = (JSON.parse(stdout) as { executable: string }).executable
      expect(new Uint8Array(await readFile(selected))).toEqual(runtime)
      expect(selected).toContain(digest(runtime))
      expect(selected).toContain("synthetic-embedded-runtime")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
