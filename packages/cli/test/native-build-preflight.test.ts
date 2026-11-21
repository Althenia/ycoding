import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each([
  process.platform === "darwin" ? "linux-x64" : "darwin-arm64",
  "linux-x64-musl",
  "linux-arm64",
  "win32-arm64",
])("target %s is rejected before output cleanup or compilation", async (target) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-native-preflight-"))
  const out = path.join(root, "output")
  const marker = path.join(out, "existing")
  try {
    await mkdir(out)
    await writeFile(marker, "preserved")
    const preload = path.join(root, "preload.ts")
    await writeFile(preload, 'Bun.build = async () => { console.log("COMPILED"); process.exit(0) }')
    const child = Bun.spawn([process.execPath, "--preload", preload, "script/build.ts", `--target=${target}`, `--outdir=${out}`], {
      cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain("native host")
    expect(stdout).not.toContain("COMPILED")
    expect(await readFile(marker, "utf8")).toBe("preserved")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("multiple target arguments are rejected before touching output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-native-targets-"))
  const out = path.join(root, "output")
  const marker = path.join(out, "existing")
  try {
    await mkdir(out)
    await writeFile(marker, "preserved")
    const child = Bun.spawn([process.execPath, "script/build.ts", `--target=${process.platform}-${process.arch}`, "--target=linux-x64-musl", `--outdir=${out}`], {
      cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain("Target must be specified once")
    expect(await readFile(marker, "utf8")).toBe("preserved")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the Node frontend rejects a foreign native target before cleanup or downloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-node-native-preflight-"))
  const out = path.join(root, "output")
  const marker = path.join(out, "existing")
  try {
    await mkdir(out)
    await writeFile(marker, "preserved")
    const preload = path.join(root, "preload.ts")
    await writeFile(preload, `
      import { mock } from "bun:test"
      import * as child from "node:child_process"
      mock.module("node:child_process", () => ({ ...child, spawnSync: () => ({ status: 1 }) }))
      globalThis.fetch = async () => { throw new Error("Unexpected network request") }
    `)
    const foreign = process.platform === "darwin" ? "linux-x64" : "darwin-arm64"
    const child = Bun.spawn([process.execPath, "--preload", preload, "script/build-node.ts", "--skip-install", `--target=${foreign}`, `--outdir=${out}`], {
      cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain("native host")
    expect(stderr).not.toContain("Unexpected network request")
    expect(stdout).not.toContain("building cli-node")
    expect(await readFile(marker, "utf8")).toBe("preserved")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
