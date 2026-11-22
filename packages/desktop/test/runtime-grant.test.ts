import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readRuntime, stageRuntime } from "./runtime-grant"

const bytes = Buffer.from("synthetic native payload")
const sha256 = createHash("sha256").update(bytes).digest("hex")

async function fixture(run: (root: string, source: string, frontend: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desktop-runtime-grant-")))
  try {
    const source = path.join(root, "producer-runtime")
    const frontend = path.join(root, "frontend")
    await Promise.all([fs.writeFile(source, bytes, { mode: 0o500 }), fs.writeFile(frontend, `payload digest: ${sha256}`)])
    await run(root, source, frontend)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("only reads the reviewed executable bytes bound to the frontend", () => fixture(async (root, source, frontend) => {
  expect(await readRuntime(source, sha256, frontend)).toEqual({ bytes, sha256 })
  const link = path.join(root, "other")
  await fs.symlink(source, link)
  await rejects(readRuntime(link, sha256, frontend), /canonical/)
  await rejects(readRuntime(source, "0".repeat(64), frontend), /digest/)
  await fs.chmod(source, 0o700)
  await rejects(readRuntime(source, sha256, frontend), /read-only/)
  await fs.chmod(source, 0o500)
  await fs.writeFile(frontend, "different frontend")
  await rejects(readRuntime(source, sha256, frontend), /digest/)
}))

test("stages a separate read-only copy only in the fixture's normal runtime cache", () => fixture(async (root, source, frontend) => {
  const runtime = await readRuntime(source, sha256, frontend)
  const own = path.join(root, "fixture")
  const env = { XDG_CACHE_HOME: path.join(own, "cache") }
  await rejects(stageRuntime(own, { XDG_CACHE_HOME: path.join(root, "other") }, "0.13.0", runtime), /normal cache path/)
  await rejects(stageRuntime(own, env, "..", runtime), /version/)
  const staged = await stageRuntime(own, env, "0.13.0", runtime)
  expect(staged.executable).toBe(path.join(own, "cache/ycoding/bin/runtime/0.13.0", sha256, "ycoding-runtime"))
  expect((await fs.lstat(staged.executable)).mode & 0o777).toBe(0o500)
  expect(await fs.readFile(staged.executable)).toEqual(bytes)
  await rejects(stageRuntime(own, env, "0.13.0", runtime), { code: "EEXIST" })
}))
