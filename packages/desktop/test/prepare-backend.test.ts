import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { prepareBackend } from "../script/prepare-backend"

const source = await fs.readFile(path.join(import.meta.dir, "../script/prepare-backend.ts"), "utf8")

test("backend preparation reads the version from build metadata without executing the built binary", () => {
  expect(source.match(/Bun\.spawn\(/g)).toHaveLength(1)
  expect(source).not.toContain("--version")
  expect(source).toContain('"script/build.ts"')
  expect(source).toMatch(/cli-\$\{process\.platform\}-\$\{process\.arch\}["`]?,\s*"package\.json"/)
  expect(source).toMatch(/typeof metadata\.version === "string" && metadata\.version/)
  expect(source).toContain('path.join(desktop, "runtime")')
  expect(source).not.toContain("fs.rm(")
  expect(source).toContain("Desktop runtime already exists")
})

async function fixture() {
  const tasks = path.join(os.homedir(), ".local/share/ycoding/tasks")
  await fs.mkdir(tasks, { recursive: true })
  const root = await fs.mkdtemp(path.join(tasks, "desktop-prepare-test-"))
  const desktop = path.join(root, "packages/desktop")
  const cli = path.join(root, "packages/cli")
  await fs.mkdir(desktop, { recursive: true })
  await fs.mkdir(cli, { recursive: true })
  await fs.mkdir(path.join(cli, "script"))
  await fs.writeFile(path.join(cli, "script/build.ts"), "synthetic producer source")
  return { root, desktop, cli, dist: path.join(cli, "dist"), runtime: path.join(desktop, "runtime") }
}

test("backend preparation builds at the canonical CLI output and copies metadata and bytes", async () => {
  const f = await fixture()
  const calls: unknown[] = []
  try {
    const result = await prepareBackend(f.desktop, async (command, cwd) => {
      calls.push({ command, cwd })
      const target = path.join(f.dist, `cli-${process.platform}-${process.arch}`)
      await fs.mkdir(path.join(target, "bin"), { recursive: true })
      await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ version: "1.2.3" }))
      await fs.writeFile(path.join(target, "bin/ycoding"), "synthetic-backend")
      return 0
    })
    expect(calls).toEqual([{ command: [process.execPath, "run", "script/build.ts", "--single"], cwd: f.cli }])
    expect(result.version).toBe("1.2.3")
    expect(result.producer.argv).toEqual([process.execPath, "run", "script/build.ts", "--single"])
    expect(result.producer.cwd).toBe(f.cli)
    expect(result.producer.executable.sha256).toBe(createHash("sha256").update("synthetic-backend").digest("hex"))
    expect(await fs.readFile(path.join(f.runtime, "backend/ycoding"), "utf8")).toBe("synthetic-backend")
    expect(JSON.parse(await fs.readFile(path.join(f.runtime, "backend.json"), "utf8"))).toEqual({ executable: "backend/ycoding", version: "1.2.3", files: [{ path: "backend/ycoding", sha256: createHash("sha256").update("synthetic-backend").digest("hex") }] })
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test.each(["directory", "file", "dangling symlink"] as const)("existing CLI output %s is preserved before spawning", async (kind) => {
  const f = await fixture()
  let calls = 0
  try {
    if (kind === "directory") { await fs.mkdir(f.dist); await fs.writeFile(path.join(f.dist, "keep"), "original") }
    if (kind === "file") await fs.writeFile(f.dist, "original")
    if (kind === "dangling symlink") await fs.symlink("missing-target", f.dist)
    await expect(prepareBackend(f.desktop, async () => { calls++; return 0 })).rejects.toThrow("CLI build output already exists")
    expect(calls).toBe(0)
    if (kind === "directory") expect(await fs.readFile(path.join(f.dist, "keep"), "utf8")).toBe("original")
    if (kind === "file") expect(await fs.readFile(f.dist, "utf8")).toBe("original")
    if (kind === "dangling symlink") expect(await fs.readlink(f.dist)).toBe("missing-target")
    expect(await fs.lstat(f.runtime).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test("backend preparation refuses an existing runtime and a failed producer", async () => {
  const f = await fixture()
  let calls = 0
  try {
    await fs.mkdir(f.runtime)
    await fs.writeFile(path.join(f.runtime, "keep"), "original")
    await expect(prepareBackend(f.desktop, async () => { calls++; return 0 })).rejects.toThrow("Desktop runtime already exists")
    expect(calls).toBe(0)
    expect(await fs.readFile(path.join(f.runtime, "keep"), "utf8")).toBe("original")
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
  const failed = await fixture()
  try {
    await expect(prepareBackend(failed.desktop, async () => 1)).rejects.toThrow("owning CLI backend build failed")
    expect(await fs.lstat(failed.runtime).then(() => true, () => false)).toBe(false)
  } finally { await fs.rm(failed.root, { recursive: true, force: true }) }
})
