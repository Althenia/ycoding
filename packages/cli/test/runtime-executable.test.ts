import { expect, test } from "bun:test"
import { mkdtemp, lstat, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extractRuntime } from "../src/runtime-executable"

test("runtime extraction preserves exact bytes, private executable mode and concurrent reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-payload-"))
  try {
    const payload = new Uint8Array([0, 255, 127, 1, 2, 3])
    const files = await Promise.all(Array.from({ length: 4 }, () => extractRuntime(payload, root, "1.2.3")))
    expect(new Set(files).size).toBe(1)
    expect(new Uint8Array(await readFile(files[0]))).toEqual(payload)
    const before = await lstat(files[0])
    if (process.platform !== "win32") expect(before.mode & 0o777).toBe(0o700)
    expect(await extractRuntime(payload, root, "1.2.3")).toBe(files[0])
    expect((await lstat(files[0])).mtimeMs).toBe(before.mtimeMs)
    expect(await extractRuntime(payload, root, "1.2.4")).not.toBe(files[0])
    expect(await extractRuntime(new Uint8Array([1]), root, "1.2.3")).not.toBe(files[0])
    await writeFile(files[0], "corrupt")
    await expect(extractRuntime(payload, root, "1.2.3")).rejects.toThrow("does not match")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
