import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.join(import.meta.dir, "release-archive.ts")
const version = "9.9.9"
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"] as const
const extension = ["icons/ycoding-128.png", "icons/ycoding-16.png", "icons/ycoding-32.png", "icons/ycoding-48.png", "manifest.json", "popup.css", "popup.html", "popup.js", "protocol.js", "service-worker.js"]
const app = "YCoding Computer Use.app"

function execute(root: string, args: string[]) {
  return Bun.spawnSync([process.execPath, script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
}

async function fixture(root: string, target: string) {
  const source = path.join(root, target)
  await fs.mkdir(source)
  await Bun.write(path.join(source, target === "windows-x64" ? "ycoding.exe" : "ycoding"), "synthetic executable\n")
  await fs.chmod(path.join(source, target === "windows-x64" ? "ycoding.exe" : "ycoding"), 0o755)
  for (const file of extension) await Bun.write(path.join(source, "ycoding-chrome-extension", file), "synthetic extension\n")
  if (target.startsWith("darwin")) {
    await Bun.write(path.join(source, app, "Contents/MacOS/ycoding-computer-use"), "synthetic helper\n")
    await fs.chmod(path.join(source, app, "Contents/MacOS/ycoding-computer-use"), 0o755)
    await Bun.write(path.join(source, app, "Contents/Resources/YCoding.icns"), "synthetic icon\n")
    await Bun.write(path.join(source, app, "Contents/_CodeSignature/CodeResources"), "synthetic signature\n")
    await Bun.write(path.join(source, app, "Contents/Info.plist"), "<key>CFBundleIdentifier</key><string>app.ycoding.computer-use</string><key>CFBundleDisplayName</key><string>YCoding Computer Use</string><key>CFBundleIconFile</key><string>YCoding.icns</string>")
  }
  return source
}

async function archives(root: string) {
  const input = path.join(root, "downloaded")
  await fs.mkdir(input)
  for (const target of targets) {
    const source = await fixture(root, target)
    const filename = path.join(input, `ycoding-${version}-${target}.${target === "windows-x64" ? "zip" : "tar.gz"}`)
    const result = target === "windows-x64"
      ? Bun.spawnSync(["zip", "-qr", filename, "ycoding.exe", "ycoding-chrome-extension"], { cwd: source })
      : Bun.spawnSync(["tar", "-czf", filename, "ycoding", "ycoding-chrome-extension", ...(target.startsWith("darwin") ? [app] : [])], { cwd: source, env: { ...process.env, COPYFILE_DISABLE: "1" } })
    expect(result.exitCode).toBe(0)
  }
  return input
}

for (const target of targets.filter((target) => target !== "windows-x64"))
  test(`native archive create preserves the complete ${target} payload and executable modes`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-archive-"))
    try {
      const source = await fixture(root, target)
      const result = execute(root, ["create", target, version, source, "prepared"])
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(await fs.readdir(path.join(root, "prepared"))).toEqual([`ycoding-${version}-${target}.tar.gz`])
      const extract = path.join(root, "extracted")
      await fs.mkdir(extract)
      expect(Bun.spawnSync(["tar", "-xzf", path.join(root, "prepared", `ycoding-${version}-${target}.tar.gz`), "-C", extract]).exitCode).toBe(0)
      expect((await fs.stat(path.join(extract, "ycoding"))).mode & 0o111).not.toBe(0)
      for (const file of extension) expect(await Bun.file(path.join(extract, "ycoding-chrome-extension", file)).text()).toBe("synthetic extension\n")
      if (target.startsWith("darwin")) expect((await fs.stat(path.join(extract, app, "Contents/MacOS/ycoding-computer-use"))).mode & 0o111).not.toBe(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

for (const [release, included] of [["0.7.0", false], ["0.7.1-rc.1", false], ["0.7.1+build.1", true]] as const)
  test(`native archive create retains the signed-app version boundary for ${release}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-version-"))
    try {
      const source = await fixture(root, "darwin-arm64")
      const result = execute(root, ["create", "darwin-arm64", release, source, "prepared"])
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      const listing = Bun.spawnSync(["tar", "-tzf", path.join(root, "prepared", `ycoding-${release}-darwin-arm64.tar.gz`)], { stdout: "pipe" })
      expect(listing.stdout.toString().includes(app)).toBe(included)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

if (process.platform === "darwin") test("native archive create excludes macOS extended-attribute metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-xattr-"))
  try {
    const source = await fixture(root, "darwin-arm64")
    expect(Bun.spawnSync(["xattr", "-w", "com.ycoding.fixture", "synthetic", path.join(source, "ycoding")]).exitCode).toBe(0)
    const result = execute(root, ["create", "darwin-arm64", version, source, "prepared"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const listing = Bun.spawnSync(["tar", "-tzf", path.join(root, "prepared", `ycoding-${version}-darwin-arm64.tar.gz`)], { stdout: "pipe" })
    expect(listing.stdout.toString()).not.toContain("._")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const invalid of ["missing executable", "nonexecutable", "extra LICENSE", "extra NOTICE", "extra unknown", "extra nested extension", "extra app file", "missing icon", "empty signature", "invalid plist", "symlink"])
  test(`native archive create rejects ${invalid} before writing an archive`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-invalid-"))
    try {
      const source = await fixture(root, "darwin-arm64")
      if (invalid === "missing executable") await fs.unlink(path.join(source, "ycoding"))
      if (invalid === "nonexecutable") await fs.chmod(path.join(source, "ycoding"), 0o644)
      if (invalid.startsWith("extra ")) await Bun.write(path.join(source, invalid === "extra nested extension" ? "ycoding-chrome-extension/extra.js" : invalid === "extra app file" ? `${app}/Contents/extra` : invalid.slice(6)), "unexpected\n")
      if (invalid === "missing icon") await fs.unlink(path.join(source, app, "Contents/Resources/YCoding.icns"))
      if (invalid === "empty signature") await Bun.write(path.join(source, app, "Contents/_CodeSignature/CodeResources"), "")
      if (invalid === "invalid plist") await Bun.write(path.join(source, app, "Contents/Info.plist"), "<plist>wrong</plist>")
      if (invalid === "symlink") {
        await fs.unlink(path.join(source, app, "Contents/Resources/YCoding.icns"))
        await fs.symlink("../Info.plist", path.join(source, app, "Contents/Resources/YCoding.icns"))
      }
      const result = execute(root, ["create", "darwin-arm64", version, source, "prepared"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("Invalid release payload")
      expect(await Bun.file(path.join(root, "prepared", `ycoding-${version}-darwin-arm64.tar.gz`)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

test("native archive finalize needs no installed dependencies and publishes only the checksum-covered files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-finalize-"))
  try {
    const input = await archives(root)
    const checkout = path.join(root, "checkout")
    for (const file of ["script/release-archive.ts", "packages/core/src/browser/extension.ts", "LICENSE", "NOTICE"])
      await Bun.write(path.join(checkout, file), Bun.file(path.join(import.meta.dir, "..", file)))
    const result = Bun.spawnSync([process.execPath, path.join(checkout, "script/release-archive.ts"), "finalize", version, input, "release"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const files = await fs.readdir(path.join(root, "release"))
    expect(files.sort()).toEqual(["LICENSE", "NOTICE", `ycoding-${version}-checksums.txt`, ...targets.map((target) => `ycoding-${version}-${target}.${target === "windows-x64" ? "zip" : "tar.gz"}`)].sort())
    const lines = (await Bun.file(path.join(root, "release", `ycoding-${version}-checksums.txt`)).text()).trim().split("\n")
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line).toMatch(/^[a-f0-9]{64}  /)
      expect(new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(root, "release", line.slice(66))).arrayBuffer()).digest("hex")).toBe(line.slice(0, 64))
    }
    expect(await Bun.file(path.join(root, "release", "LICENSE")).text()).toBe(await Bun.file(path.join(import.meta.dir, "../LICENSE")).text())
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const target of targets)
  test(`native archive finalize rejects the missing ${target} target`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-missing-"))
    try {
      const input = await archives(root)
      await fs.unlink(path.join(input, `ycoding-${version}-${target}.${target === "windows-x64" ? "zip" : "tar.gz"}`))
      const result = execute(root, ["finalize", version, input, "release"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("Expected exactly four release archives")
      expect(await Bun.file(path.join(root, "release", `ycoding-${version}-checksums.txt`)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

for (const invalid of ["wrong version", "extra file", "corrupt archive", "nonexecutable archive", "missing archive app", "extra archive entry", "oversized archive listing", "symlink archive entry", "linked archive", "nonempty output"])
  test(`native archive finalize rejects ${invalid} without a checksum manifest`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-received-"))
    try {
      const input = await archives(root)
      const linux = path.join(input, `ycoding-${version}-linux-x64.tar.gz`)
      if (invalid === "wrong version") await fs.rename(linux, path.join(input, "ycoding-9.9.8-linux-x64.tar.gz"))
      if (invalid === "extra file") await Bun.write(path.join(input, "private.json"), "{}")
      if (invalid === "corrupt archive") await Bun.write(linux, "invalid archive")
      if (invalid === "nonexecutable archive") {
        await fs.chmod(path.join(root, "linux-x64/ycoding"), 0o644)
        expect(Bun.spawnSync(["tar", "-czf", linux, "ycoding", "ycoding-chrome-extension"], { cwd: path.join(root, "linux-x64"), env: { ...process.env, COPYFILE_DISABLE: "1" } }).exitCode).toBe(0)
      }
      if (invalid === "missing archive app") expect(Bun.spawnSync(["tar", "-czf", path.join(input, `ycoding-${version}-darwin-arm64.tar.gz`), "ycoding", "ycoding-chrome-extension"], { cwd: path.join(root, "darwin-arm64"), env: { ...process.env, COPYFILE_DISABLE: "1" } }).exitCode).toBe(0)
      if (invalid === "extra archive entry" || invalid === "oversized archive listing") {
        const extra = Array.from({ length: invalid === "oversized archive listing" ? 500 : 1 }, (_, index) => `${index}-${"fixture".repeat(20)}`)
        for (const name of extra) await Bun.write(path.join(root, "linux-x64", name), "unexpected\n")
        expect(Bun.spawnSync(["tar", "-czf", linux, "ycoding", "ycoding-chrome-extension", ...extra], { cwd: path.join(root, "linux-x64"), env: { ...process.env, COPYFILE_DISABLE: "1" } }).exitCode).toBe(0)
      }
      if (invalid === "symlink archive entry") {
        await fs.unlink(path.join(root, "linux-x64/ycoding"))
        await fs.symlink("ycoding-chrome-extension/manifest.json", path.join(root, "linux-x64/ycoding"))
        expect(Bun.spawnSync(["tar", "-czf", linux, "ycoding", "ycoding-chrome-extension"], { cwd: path.join(root, "linux-x64"), env: { ...process.env, COPYFILE_DISABLE: "1" } }).exitCode).toBe(0)
      }
      if (invalid === "linked archive") {
        await fs.rename(linux, path.join(root, "outside.tar.gz"))
        await fs.symlink(path.join(root, "outside.tar.gz"), linux)
      }
      if (invalid === "nonempty output") await Bun.write(path.join(root, "release/private.json"), "{}")
      const result = execute(root, ["finalize", version, input, "release"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/release archives|release archive|Release archive|Release output/)
      expect(await Bun.file(path.join(root, "release", `ycoding-${version}-checksums.txt`)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
