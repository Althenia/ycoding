import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { extractRuntime } from "../src/runtime-executable"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("runtime extraction decompresses exact bytes into a raw-digest path with private mode and concurrent reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-payload-"))
  try {
    const runtime = new Uint8Array([0, 255, 127, 1, 2, 3])
    const payload = brotliCompressSync(runtime)
    const files = await Promise.all(
      Array.from({ length: 4 }, () => extractRuntime(payload, digest(runtime), root, "1.2.3")),
    )
    expect(new Set(files).size).toBe(1)
    expect(files[0]).toBe(path.join(root, "runtime", "1.2.3", digest(runtime), path.basename(files[0])))
    expect(new Uint8Array(await readFile(files[0]))).toEqual(runtime)
    const before = await lstat(files[0])
    if (process.platform !== "win32") expect(before.mode & 0o777).toBe(0o700)
    expect(await extractRuntime(payload, digest(runtime), root, "1.2.3")).toBe(files[0])
    expect((await lstat(files[0])).mtimeMs).toBe(before.mtimeMs)
    expect(await extractRuntime(payload, digest(runtime), root, "1.2.4")).not.toBe(files[0])
    const other = new Uint8Array([1])
    expect(await extractRuntime(brotliCompressSync(other), digest(other), root, "1.2.3")).not.toBe(files[0])
    await writeFile(files[0], "corrupt")
    await expect(extractRuntime(payload, digest(runtime), root, "1.2.3")).rejects.toThrow(
      "Extracted runtime does not match the embedded payload",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("runtime extraction refuses a payload that decompresses to other bytes or cannot be decoded and creates nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-payload-"))
  try {
    const runtime = new Uint8Array([4, 5, 6])
    await expect(
      extractRuntime(brotliCompressSync(new Uint8Array([7, 8, 9])), digest(runtime), root, "1.2.3"),
    ).rejects.toThrow("Packaged runtime does not match its embedded digest")
    await expect(extractRuntime(runtime, digest(runtime), root, "1.2.3")).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
