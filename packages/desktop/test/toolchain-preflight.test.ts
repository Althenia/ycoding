import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertToolchain } from "../script/build"

const tasks = path.join(os.homedir(), ".local/share/ycoding/tasks")
await fs.mkdir(tasks, { recursive: true })
const root = await fs.mkdtemp(path.join(tasks, "desktop-toolchain-preflight-"))
const shared = ["package.json", "bin/electrobun", "bin/electrobun.cjs", "dist/main.js", "dist/api/bun/index.ts"]
const native = ["bun", "bsdiff", "bspatch", "zig-zstd", "launcher", "libNativeWrapper.dylib", "libasar.dylib", "extractor"]
const files = (arch: string) => [...shared, ...native.map((name) => `dist-macos-${arch}/${name}`)]

async function fixture(arch: string, omitted?: string, directory?: string) {
  const dependency = await fs.mkdtemp(path.join(root, "fixture-"))
  for (const name of files(arch)) {
    if (name === omitted) continue
    const target = path.join(dependency, name)
    if (name === directory) await fs.mkdir(target, { recursive: true })
    else {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, "synthetic asset", { flag: "wx" })
    }
  }
  return dependency
}

test("a complete local toolchain is accepted without changing its files", async () => {
  const dependency = await fixture("arm64")
  const before = (await fs.readdir(dependency, { recursive: true })).sort()
  expect(await assertToolchain(dependency, "arm64")).toBeUndefined()
  expect((await fs.readdir(dependency, { recursive: true })).sort()).toEqual(before)
  for (const name of files("arm64")) expect(await fs.readFile(path.join(dependency, name), "utf8")).toBe("synthetic asset")
})

test.each(files("arm64"))("a missing %s is refused without provisioning it", async (missing) => {
  const dependency = await fixture("arm64", missing)
  const error: unknown = await assertToolchain(dependency, "arm64").then(() => null, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("automatic downloads are refused")
  expect(await fs.lstat(path.join(dependency, missing)).then(() => true, () => false)).toBe(false)
})

test("a directory in place of a required asset is refused", async () => {
  const dependency = await fixture("arm64", undefined, "dist-macos-arm64/libasar.dylib")
  const error: unknown = await assertToolchain(dependency, "arm64").then(() => null, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("automatic downloads are refused")
  expect((await fs.stat(path.join(dependency, "dist-macos-arm64/libasar.dylib"))).isDirectory()).toBe(true)
})

test("assets for another architecture do not satisfy the requested architecture", async () => {
  const dependency = await fixture("x64")
  const error: unknown = await assertToolchain(dependency, "arm64").then(() => null, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("automatic downloads are refused")
  expect(await fs.lstat(path.join(dependency, "dist-macos-arm64")).then(() => true, () => false)).toBe(false)
  expect(await assertToolchain(dependency, "x64")).toBeUndefined()
})

test("a symlink to the package directory retains normal package resolution", async () => {
  const dependency = await fixture("arm64")
  const link = dependency + "-link"
  await fs.symlink(dependency, link)
  expect(await assertToolchain(link, "arm64")).toBeUndefined()
})

test("a symlink to a regular asset is accepted", async () => {
  const dependency = await fixture("arm64", "dist-macos-arm64/extractor")
  await fs.symlink("launcher", path.join(dependency, "dist-macos-arm64/extractor"))
  expect(await assertToolchain(dependency, "arm64")).toBeUndefined()
})

const iconEntries: [string, number][] = [["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64], ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512], ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024]]
const pngHeader = (size: number) => { const bytes = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12); bytes.writeUInt32BE(size, 16); bytes.writeUInt32BE(size, 20); return bytes }
async function iconsetFixture(omit?: string, wrongSize?: string) {
  const dir = await fs.mkdtemp(path.join(root, "iconset-"))
  for (const [name, size] of iconEntries) if (name !== omit) await fs.writeFile(path.join(dir, name), pngHeader(name === wrongSize ? size + 1 : size))
  return dir
}

test("a complete iconset is accepted and incomplete iconsets are refused", async () => {
  const dependency = await fixture("arm64")
  expect(await assertToolchain(dependency, "arm64", await iconsetFixture())).toBeUndefined()
  await expect(assertToolchain(dependency, "arm64", await iconsetFixture("icon_512x512@2x.png"))).rejects.toThrow("icon_512x512@2x.png")
  await expect(assertToolchain(dependency, "arm64", await iconsetFixture(undefined, "icon_32x32.png"))).rejects.toThrow("icon_32x32.png")
})
