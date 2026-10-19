import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { platformBinary } from "../src/binary"

async function compile(directory: string, payload: Uint8Array, sha256: string) {
  const asset = path.join(directory, "runtime.bin")
  const entry = path.join(directory, "entry.ts")
  await writeFile(asset, payload)
  await writeFile(
    entry,
    `import { runtimeExecutable } from ${JSON.stringify(path.resolve(import.meta.dirname, "../src/runtime-executable.ts"))}
console.log(JSON.stringify({ executable: await runtimeExecutable() }))`,
  )
  const executable = path.join(directory, platformBinary("packaged"))
  const result = await Bun.build({
    entrypoints: [entry],
    format: "esm",
    minify: true,
    splitting: true,
    bytecode: true,
    compile: { outfile: executable },
    define: {
      YCODING_RUNTIME_ASSET: JSON.stringify(asset),
      YCODING_RUNTIME_SHA256: JSON.stringify(sha256),
      YCODING_VERSION: JSON.stringify("0.0.0-runtime-asset"),
      YCODING_CHANNEL: JSON.stringify("test"),
    },
  })
  expect(result.success, result.logs.map(String).join("\n")).toBe(true)
  return { executable, asset }
}

async function run(executable: string, directory: string) {
  const child = Bun.spawn([executable], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
      YCODING_RUNTIME_EXECUTABLE: path.join(directory, "unavailable-source-runtime"),
      YCODING_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { status, stdout, stderr }
}

test("compiled runtime stays a single raw asset and extracts offline after relocation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-asset-"))
  try {
    const payload = randomBytes(65_536)
    const sha256 = createHash("sha256").update(payload).digest("hex")
    const built = await compile(directory, payload, sha256)
    const binary = await readFile(built.executable)
    const offset = binary.indexOf(payload)
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(binary.indexOf(payload, offset + payload.length)).toBe(-1)
    expect(binary.includes(Buffer.from(payload).toString("base64"))).toBe(false)
    const relocated = path.join(directory, "relocated")
    await mkdir(relocated)
    const executable = path.join(relocated, platformBinary("ycoding"))
    await copyFile(built.executable, executable)
    await rm(built.asset)
    const cold = await run(executable, relocated)
    expect(cold.status, cold.stderr).toBe(0)
    const cached = JSON.parse(cold.stdout).executable as string
    expect(await readFile(cached)).toEqual(payload)
    expect(cached).toContain(sha256)
    const metadata = await lstat(cached)
    if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o700)
    const warm = await run(executable, relocated)
    expect(warm.status, warm.stderr).toBe(0)
    expect(JSON.parse(warm.stdout).executable).toBe(cached)
    expect((await lstat(cached)).mtimeMs).toBe(metadata.mtimeMs)
    await writeFile(cached, "corrupt")
    const corrupt = await run(executable, relocated)
    expect(corrupt.status).not.toBe(0)
    expect(corrupt.stderr).toContain("Extracted runtime does not match the embedded payload")
    expect(await readFile(cached, "utf8")).toBe("corrupt")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("compiled runtime rejects a raw asset that differs from its build digest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-digest-"))
  try {
    const built = await compile(directory, randomBytes(1024), "0".repeat(64))
    const result = await run(built.executable, directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Packaged runtime does not match its embedded digest")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
