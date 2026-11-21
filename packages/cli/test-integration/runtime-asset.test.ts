import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { platformBinary } from "../src/binary"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function compile(directory: string, payload: Uint8Array, digests: { sha256: string; payloadSha256: string }) {
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
      YCODING_RUNTIME_SHA256: JSON.stringify(digests.sha256),
      YCODING_RUNTIME_PAYLOAD_SHA256: JSON.stringify(digests.payloadSha256),
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

test("compiled runtime embeds one compressed asset without a raw copy and extracts offline after relocation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-asset-"))
  try {
    const runtime = Buffer.concat(
      Array.from({ length: 16 }, () => randomBytes(4096)).flatMap((block) => [block, block]),
    )
    const payload = brotliCompressSync(runtime)
    const sha256 = digest(runtime)
    const built = await compile(directory, payload, { sha256, payloadSha256: digest(payload) })
    const binary = await readFile(built.executable)
    const offset = binary.indexOf(payload)
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(binary.indexOf(payload, offset + payload.length)).toBe(-1)
    expect(binary.includes(runtime)).toBe(false)
    expect(binary.includes(runtime.toString("base64"))).toBe(false)
    const relocated = path.join(directory, "relocated")
    await mkdir(relocated)
    const executable = path.join(relocated, platformBinary("ycoding"))
    await copyFile(built.executable, executable)
    await rm(built.asset)
    const cold = await run(executable, relocated)
    expect(cold.status, cold.stderr).toBe(0)
    const cached = JSON.parse(cold.stdout).executable as string
    expect(await readFile(cached)).toEqual(runtime)
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

test("compiled runtime rejects an asset that differs from its payload or runtime build digest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-digest-"))
  try {
    const runtime = randomBytes(1024)
    const payload = brotliCompressSync(runtime)
    for (const digests of [
      { sha256: digest(runtime), payloadSha256: "0".repeat(64) },
      { sha256: "0".repeat(64), payloadSha256: digest(payload) },
    ]) {
      const built = await compile(directory, payload, digests)
      const result = await run(built.executable, directory)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("Packaged runtime does not match its embedded digest")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
