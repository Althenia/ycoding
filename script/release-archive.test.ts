import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.join(import.meta.dir, "release-archive.ts")
const version = "0.12.0"
const targets = ["darwin-arm64", "darwin-x64", "linux-x64"] as const
const extension = ["icons/ycoding-128.png", "icons/ycoding-16.png", "icons/ycoding-32.png", "icons/ycoding-48.png", "manifest.json", "popup.css", "popup.html", "popup.js", "protocol.js", "service-worker.js"]
const app = "YCoding Computer Use.app"
const interactionFiles = ["icons/active-16.png", "icons/active-32.png", "icons/idle-128.png", "icons/idle-16.png", "icons/idle-32.png", "icons/idle-48.png",
  "manifest.json", "panel.css", "panel.html", "panel.js", "popup.css", "popup.html", "popup.js", "service-worker.js"]
const desktop = "YCoding Desktop.app"
const desktopArchive = `YCoding-Desktop-v${version}-darwin-arm64.zip`
const windowsArchive = `ycoding-${version}-windows-x64.zip`

async function windowsFixture(root: string) {
  const source = path.join(root, "windows-x64")
  await Bun.write(path.join(source, "ycoding.exe"), "synthetic Windows executable\n")
  for (const file of interactionFiles) await Bun.write(path.join(source, "ycoding-chrome-extension", file), "synthetic extension\n")
  return source
}

test("Windows archive create yields a ZIP with ycoding.exe and exactly the fourteen compatible extension files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-windows-release-"))
  try {
    const source = await windowsFixture(root)
    const result = execute(root, ["create", "windows-x64", version, source, "prepared"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(await fs.readdir(path.join(root, "prepared"))).toEqual([windowsArchive])
    const archive = path.join(root, "prepared", windowsArchive)
    const listing = Bun.spawnSync(["unzip", "-Z1", archive], { stdout: "pipe" })
    expect(listing.exitCode).toBe(0)
    expect(listing.stdout.toString().trim().split("\n").sort()).toEqual([
      "ycoding.exe", "ycoding-chrome-extension/", "ycoding-chrome-extension/icons/",
      ...interactionFiles.map((name) => `ycoding-chrome-extension/${name}`),
    ].sort())
    const extract = path.join(root, "extracted")
    expect(Bun.spawnSync(["unzip", "-q", archive, "-d", extract]).exitCode).toBe(0)
    expect(await Bun.file(path.join(extract, "ycoding.exe")).text()).toBe("synthetic Windows executable\n")
    for (const file of interactionFiles) expect(await Bun.file(path.join(extract, "ycoding-chrome-extension", file)).text()).toBe("synthetic extension\n")
    await fs.rename(path.join(source, "ycoding.exe"), path.join(source, "ycoding"))
    const missing = execute(root, ["create", "windows-x64", version, source, "missing"])
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr.toString()).toContain("unexpected or missing entries")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("Interaction archives use the replacement extension and reject a coexistence payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-interaction-archive-"))
  try {
    const source = path.join(root, "payload")
    const directory = path.join(source, "ycoding-chrome-extension")
    await Bun.write(path.join(source, "ycoding"), "synthetic executable\n")
    await fs.chmod(path.join(source, "ycoding"), 0o755)
    for (const file of interactionFiles) await Bun.write(path.join(directory, file), "synthetic extension\n")
    const application = path.join(source, "YCoding Interaction.app", "Contents")
    await Bun.write(path.join(application, "MacOS/ycoding-interaction"), "synthetic helper\n")
    await fs.chmod(path.join(application, "MacOS/ycoding-interaction"), 0o755)
    await Bun.write(path.join(application, "Resources/YCoding.icns"), "synthetic icon\n")
    await Bun.write(path.join(application, "_CodeSignature/CodeResources"), "synthetic signature\n")
    await Bun.write(path.join(application, "Info.plist"), "<key>CFBundleIdentifier</key><string>app.ycoding.interaction</string><key>CFBundleDisplayName</key><string>YCoding Interaction</string><key>CFBundleIconFile</key><string>YCoding.icns</string>")
    const args = ["create", "darwin-arm64", "0.12.0-rc.1", source, "prepared"]
    const created = execute(root, args)
    expect(created.exitCode, created.stderr.toString()).toBe(0)
    await Bun.write(path.join(directory, "protocol.js"), "legacy artifact\n")
    const coexistence = execute(root, [...args.slice(0, -1), "coexistence"])
    expect(coexistence.exitCode).not.toBe(0)
    expect(coexistence.stderr.toString()).toContain("unexpected or missing entries")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test("Interaction archives require the panel and icons", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-interaction-panel-archive-"))
  try {
    const source = path.join(root, "payload")
    const directory = path.join(source, "ycoding-chrome-extension")
    await Bun.write(path.join(source, "ycoding"), "synthetic executable\n")
    await fs.chmod(path.join(source, "ycoding"), 0o755)
    for (const file of ["manifest.json", "popup.html", "popup.css", "popup.js", "service-worker.js"])
      await Bun.write(path.join(directory, file), "synthetic extension\n")
    const compact = execute(root, ["create", "linux-x64", "0.12.0", source, "compact"])
    expect(compact.exitCode).not.toBe(0)
    expect(compact.stderr.toString()).toContain("unexpected or missing entries")
    for (const file of ["panel.html", "panel.css", "panel.js", "icons/active-16.png", "icons/active-32.png", "icons/idle-16.png",
      "icons/idle-32.png", "icons/idle-48.png", "icons/idle-128.png"]) await Bun.write(path.join(directory, file), "synthetic extension\n")
    const panel = execute(root, ["create", "linux-x64", "0.12.0", source, "panel"])
    expect(panel.exitCode, panel.stderr.toString()).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

const desktopEntries = ["", "Contents/", "Contents/Frameworks/", "Contents/Info.plist", "Contents/MacOS/", "Contents/MacOS/launcher", "Contents/Resources/", "Contents/Resources/AppIcon.icns", "Contents/Resources/metadata.json", "Contents/Resources/1z1pg577pmla1.tar.zst", "Contents/_CodeSignature/", "Contents/_CodeSignature/CodeResources"].map((entry) => `${desktop}/${entry}`).sort()

function execute(root: string, args: string[]) {
  return Bun.spawnSync([process.execPath, script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
}

test("archive executable command prints the canonical member for its target and version", () => {
  for (const [target, release, expected] of [
    ["darwin-arm64", "0.12.1", "ycoding"],
    ["darwin-arm64", "0.13.1", "ycoding-native"],
    ["darwin-arm64", "0.13.1-rc.1", "ycoding-native"],
    ["windows-x64", "0.12.1", "ycoding.exe"],
  ] as const) {
    const result = execute(import.meta.dir, ["executable", target, release])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe(`${expected}\n`)
  }
  for (const [target, release, error] of [["darwin", "0.13.0", "target"], ["darwin-arm64", "v0.13.0", "version"]] as const) {
    const result = execute(import.meta.dir, ["executable", target, release])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(`Invalid release ${error}`)
    expect(result.stdout.toString()).toBe("")
  }
})

test("Gate 4: Rust archives reject retired targets while Bun releases retain them", () => {
  for (const target of ["darwin-x64", "linux-x64", "windows-x64"]) {
    const current = execute(import.meta.dir, ["executable", target, "0.13.0"])
    expect(current.exitCode).not.toBe(0)
    expect(current.stderr.toString()).toContain("Apple Silicon")
    expect(execute(import.meta.dir, ["executable", target, "0.12.2"]).exitCode).toBe(0)
  }
  expect(execute(import.meta.dir, ["executable", "darwin-arm64", "0.13.2"]).stdout.toString()).toBe("ycoding-native\n")
})

async function fixture(root: string, target: string, release = "0.11.12") {
  const current = release === version
  const application = current ? "YCoding Interaction.app" : app
  const helper = current ? "ycoding-interaction" : "ycoding-computer-use"
  const display = current ? "YCoding Interaction" : "YCoding Computer Use"
  const identifier = current ? "app.ycoding.interaction" : "app.ycoding.computer-use"
  const source = path.join(root, target)
  await fs.mkdir(source)
  await Bun.write(path.join(source, "ycoding"), "synthetic executable\n")
  await fs.chmod(path.join(source, "ycoding"), 0o755)
  for (const file of current ? interactionFiles : extension) await Bun.write(path.join(source, "ycoding-chrome-extension", file), "synthetic extension\n")
  if (target.startsWith("darwin")) {
    await Bun.write(path.join(source, application, `Contents/MacOS/${helper}`), "synthetic helper\n")
    await fs.chmod(path.join(source, application, `Contents/MacOS/${helper}`), 0o755)
    await Bun.write(path.join(source, application, "Contents/Resources/YCoding.icns"), "synthetic icon\n")
    await Bun.write(path.join(source, application, "Contents/_CodeSignature/CodeResources"), "synthetic signature\n")
    await Bun.write(path.join(source, application, "Contents/Info.plist"), `<key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleDisplayName</key><string>${display}</string><key>CFBundleIconFile</key><string>YCoding.icns</string>`)
  }
  return source
}

async function desktopFixture(root: string) {
  const source = path.join(root, "desktop", desktop)
  await fs.mkdir(path.join(source, "Contents/Frameworks"), { recursive: true })
  await Bun.write(path.join(source, "Contents/Info.plist"), "<plist>\n<dict>\n    <key>CFBundleExecutable</key>\n    <string>launcher</string>\n    <key>CFBundleIdentifier</key>\n    <string>app.ycoding.desktop</string>\n    <key>CFBundleIconFile</key>\n    <string>AppIcon</string>\n</dict>\n</plist>\n")
  await Bun.write(path.join(source, "Contents/MacOS/launcher"), "synthetic launcher\n")
  await fs.chmod(path.join(source, "Contents/MacOS/launcher"), 0o755)
  await Bun.write(path.join(source, "Contents/Resources/AppIcon.icns"), "synthetic icon\n")
  await Bun.write(path.join(source, "Contents/Resources/metadata.json"), JSON.stringify({ identifier: "app.ycoding.desktop", name: "YCoding Desktop", channel: "stable", hash: "1z1pg577pmla1" }, null, 2))
  await Bun.write(path.join(source, "Contents/Resources/1z1pg577pmla1.tar.zst"), "synthetic payload\n")
  await Bun.write(path.join(source, "Contents/_CodeSignature/CodeResources"), "synthetic signature\n")
  return source
}

async function archives(root: string, release = version) {
  const input = path.join(root, "downloaded")
  await fs.mkdir(input)
  for (const target of targets) {
    const source = await fixture(root, target, version)
    const filename = path.join(input, `ycoding-${release}-${target}.tar.gz`)
    const result = Bun.spawnSync(["tar", "-czf", filename, "ycoding", "ycoding-chrome-extension", ...(target.startsWith("darwin") ? ["YCoding Interaction.app"] : [])], { cwd: source, env: { ...process.env, COPYFILE_DISABLE: "1" } })
    expect(result.exitCode).toBe(0)
  }
  const windows = await windowsFixture(root)
  expect(Bun.spawnSync(["zip", "-qr", path.join(input, `ycoding-${release}-windows-x64.zip`), "ycoding.exe", "ycoding-chrome-extension"], { cwd: windows }).exitCode).toBe(0)
  await desktopFixture(root)
  expect(Bun.spawnSync(["zip", "-qr", path.join(input, `YCoding-Desktop-v${release}-darwin-arm64.zip`), desktop], { cwd: path.join(root, "desktop") }).exitCode).toBe(0)
  return input
}

test("0.13 archive create renames only the archived executable and preserves the public filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-release-layout-"))
  try {
    const release = "0.13.1-rc.1"
    for (const target of ["darwin-arm64"]) {
      const source = await fixture(root, target, version)
      const result = execute(root, ["create", target, release, source, "prepared"])
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      const archive = path.join(root, "prepared", `ycoding-${release}-${target}.tar.gz`)
      const listing = Bun.spawnSync(["tar", "-tzf", archive])
      expect(listing.exitCode).toBe(0)
      const entries = listing.stdout.toString().trim().split("\n")
      expect(entries).toContain("ycoding-native")
      expect(entries).not.toContain("ycoding")
      expect(await Bun.file(path.join(source, "ycoding")).text()).toBe("synthetic executable\n")
      expect(await Bun.file(path.join(source, "ycoding-native")).exists()).toBe(false)
      const extract = path.join(root, `${target}-extract`)
      await fs.mkdir(extract)
      expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", extract]).exitCode).toBe(0)
      expect(await Bun.file(path.join(extract, "ycoding-native")).text()).toBe("synthetic executable\n")
      expect((await fs.stat(path.join(extract, "ycoding-native"))).mode & 0o111).not.toBe(0)
    }
    const windows = await windowsFixture(root)
    const result = execute(root, ["create", "windows-x64", "0.12.1", windows, "prepared"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const listing = Bun.spawnSync(["unzip", "-Z1", path.join(root, "prepared", "ycoding-0.12.1-windows-x64.zip")])
    expect(listing.exitCode).toBe(0)
    expect(listing.stdout.toString().trim().split("\n")).toContain("ycoding.exe")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("0.13 Unix archive finalize rejects the legacy executable but finalizes native archives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-finalize-layout-"))
  try {
    const release = "0.13.1"
    const input = await archives(root, release)
    for (const target of targets.filter((target) => target !== "darwin-arm64")) await fs.rm(path.join(input, `ycoding-${release}-${target}.tar.gz`))
    await fs.rm(path.join(input, `ycoding-${release}-windows-x64.zip`))
    const wrong = execute(root, ["finalize", release, input, "rejected"])
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.stderr.toString()).toContain("Invalid release archive entries")
    await fs.rm(path.join(input, `ycoding-${release}-darwin-arm64.tar.gz`))
    const created = execute(root, ["create", "darwin-arm64", release, path.join(root, "darwin-arm64"), input])
    expect(created.exitCode, created.stderr.toString()).toBe(0)
    const result = execute(root, ["finalize", release, input, "release"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(await Bun.file(path.join(root, "release", `ycoding-${release}-checksums.txt`)).text()).toContain(`  ycoding-${release}-darwin-arm64.tar.gz\n`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const target of targets)
  test(`native archive create preserves the complete ${target} payload and executable modes`, async () => {
    const version = "0.11.12"
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
  const version = "0.11.12"
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

if (process.platform === "darwin") test("desktop archive create preserves the app bundle without macOS metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-archive-"))
  try {
    const source = await desktopFixture(root)
    expect(Bun.spawnSync(["xattr", "-w", "com.ycoding.fixture", "synthetic", path.join(source, "Contents/MacOS/launcher")]).exitCode).toBe(0)
    const result = execute(root, ["create-desktop", version, source, "prepared"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(await fs.readdir(path.join(root, "prepared"))).toEqual([desktopArchive])
    const listing = Bun.spawnSync(["unzip", "-Z1", path.join(root, "prepared", desktopArchive)], { stdout: "pipe" }).stdout.toString().trim().split("\n")
    expect(listing.sort()).toEqual(desktopEntries)
    const extract = path.join(root, "extracted")
    expect(Bun.spawnSync(["unzip", "-q", path.join(root, "prepared", desktopArchive), "-d", extract]).exitCode).toBe(0)
    expect((await fs.stat(path.join(extract, desktop, "Contents/MacOS/launcher"))).mode & 0o111).not.toBe(0)
    expect(Bun.spawnSync(["xattr", path.join(extract, desktop, "Contents/MacOS/launcher")], { stdout: "pipe" }).stdout.toString()).not.toContain("com.ycoding.fixture")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const invalid of ["nonexecutable launcher", "extra file", "missing icon", "payload hash mismatch", "wrong identifier", "renamed application", "unsigned bundle"])
  test(`desktop archive create rejects ${invalid} before writing an archive`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-invalid-"))
    try {
      let source = await desktopFixture(root)
      if (invalid === "nonexecutable launcher") await fs.chmod(path.join(source, "Contents/MacOS/launcher"), 0o644)
      if (invalid === "extra file") await Bun.write(path.join(source, "Contents/Resources/update.json"), "{}")
      if (invalid === "missing icon") await fs.unlink(path.join(source, "Contents/Resources/AppIcon.icns"))
      if (invalid === "payload hash mismatch") await fs.rename(path.join(source, "Contents/Resources/1z1pg577pmla1.tar.zst"), path.join(source, "Contents/Resources/other.tar.zst"))
      if (invalid === "wrong identifier") await Bun.write(path.join(source, "Contents/Resources/metadata.json"), JSON.stringify({ identifier: "app.example.desktop", name: "YCoding Desktop", channel: "stable", hash: "1z1pg577pmla1" }))
      if (invalid === "unsigned bundle") await fs.rm(path.join(source, "Contents/_CodeSignature"), { recursive: true })
      if (invalid === "renamed application") {
        await fs.rename(source, path.join(root, "desktop", "Other.app"))
        source = path.join(root, "desktop", "Other.app")
      }
      const result = execute(root, ["create-desktop", version, source, "prepared"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("Invalid desktop release payload")
      expect(await Bun.file(path.join(root, "prepared", desktopArchive)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

for (const invalid of ["missing executable", "nonexecutable", "extra LICENSE", "extra NOTICE", "extra unknown", "extra nested extension", "extra app file", "missing icon", "empty signature", "invalid plist", "symlink"])
  test(`native archive create rejects ${invalid} before writing an archive`, async () => {
    const version = "0.11.12"
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
    for (const file of ["script/release-archive.ts", "packages/core/src/browser/extension.ts", "packages/cli/src/update/interaction-layout.ts", "LICENSE", "NOTICE"])
      await Bun.write(path.join(checkout, file), Bun.file(path.join(import.meta.dir, "..", file)))
    const result = Bun.spawnSync([process.execPath, path.join(checkout, "script/release-archive.ts"), "finalize", version, input, "release"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const files = await fs.readdir(path.join(root, "release"))
    expect(files.sort()).toEqual(["LICENSE", "NOTICE", `ycoding-${version}-checksums.txt`, desktopArchive, windowsArchive, ...targets.map((target) => `ycoding-${version}-${target}.tar.gz`)].sort())
    const lines = (await Bun.file(path.join(root, "release", `ycoding-${version}-checksums.txt`)).text()).trim().split("\n")
    expect(lines).toHaveLength(7)
    for (const line of lines) {
      expect(line).toMatch(/^[a-f0-9]{64}  /)
      expect(new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(root, "release", line.slice(66))).arrayBuffer()).digest("hex")).toBe(line.slice(0, 64))
    }
    expect(await Bun.file(path.join(root, "release", "LICENSE")).text()).toBe(await Bun.file(path.join(import.meta.dir, "../LICENSE")).text())
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each(["0.13.0", "0.13.1", "0.13.1-rc.1"])("native archive finalize accepts only the two Apple Silicon archives for v%s", async (release) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-apple-silicon-release-"))
  try {
    const source = await fixture(root, "darwin-arm64", version)
    const cli = execute(root, ["create", "darwin-arm64", release, source, "prepared"])
    expect(cli.exitCode, cli.stderr.toString()).toBe(0)
    const application = await desktopFixture(root)
    const desktop = Bun.spawnSync(["zip", "-qr", path.join(root, "prepared", `YCoding-Desktop-v${release}-darwin-arm64.zip`), path.basename(application)], { cwd: path.dirname(application) })
    expect(desktop.exitCode, desktop.stderr.toString()).toBe(0)
    const result = execute(root, ["finalize", release, "prepared", "release"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const lines = (await Bun.file(path.join(root, "release", `ycoding-${release}-checksums.txt`)).text()).trim().split("\n")
    expect(lines.map((line) => line.slice(66)).sort()).toEqual([
      "LICENSE", "NOTICE", `YCoding-Desktop-v${release}-darwin-arm64.zip`, `ycoding-${release}-darwin-arm64.tar.gz`,
    ])
    const extra = `ycoding-${release}-linux-x64.tar.gz`
    await Bun.write(path.join(root, "prepared", extra), "unexpected archive")
    const rejected = execute(root, ["finalize", release, "prepared", "extra"])
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr.toString()).toContain("Expected exactly 2 release archives")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const target of [...targets, "windows-x64", "desktop"])
  test(`native archive finalize rejects the missing ${target} target`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-native-missing-"))
    try {
      const input = await archives(root)
      await fs.unlink(path.join(input, target === "desktop" ? desktopArchive : target === "windows-x64" ? windowsArchive : `ycoding-${version}-${target}.tar.gz`))
      const result = execute(root, ["finalize", version, input, "release"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("Expected exactly 5 release archives")
      expect(await Bun.file(path.join(root, "release", `ycoding-${version}-checksums.txt`)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

for (const invalid of ["wrong version", "extra file", "corrupt archive", "nonexecutable archive", "missing archive app", "extra archive entry", "oversized archive listing", "symlink archive entry", "linked archive", "nonempty output", "extra windows entry", "symlink windows entry", "extra desktop entry", "nonexecutable desktop launcher", "desktop payload hash mismatch", "unsigned desktop bundle"])
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
      if (invalid.includes("windows")) {
        const cwd = path.join(root, "windows-x64")
        const archive = path.join(input, windowsArchive)
        await fs.unlink(archive)
        if (invalid === "extra windows entry") await Bun.write(path.join(cwd, "ycoding-chrome-extension/extra.js"), "unexpected\n")
        else {
          await fs.unlink(path.join(cwd, "ycoding.exe"))
          await fs.symlink("ycoding-chrome-extension/manifest.json", path.join(cwd, "ycoding.exe"))
        }
        expect(Bun.spawnSync(["zip", "-qry", archive, "ycoding.exe", "ycoding-chrome-extension"], { cwd }).exitCode).toBe(0)
      }
      if (invalid.includes("desktop")) {
        const source = path.join(root, "desktop", desktop)
        if (invalid === "extra desktop entry") await Bun.write(path.join(source, "Contents/Resources/update.json"), "{}")
        if (invalid === "unsigned desktop bundle") await fs.rm(path.join(source, "Contents/_CodeSignature"), { recursive: true })
        if (invalid === "nonexecutable desktop launcher") await fs.chmod(path.join(source, "Contents/MacOS/launcher"), 0o644)
        if (invalid === "desktop payload hash mismatch") await fs.rename(path.join(source, "Contents/Resources/1z1pg577pmla1.tar.zst"), path.join(source, "Contents/Resources/other.tar.zst"))
        await fs.unlink(path.join(input, desktopArchive))
        expect(Bun.spawnSync(["zip", "-qr", path.join(input, desktopArchive), desktop], { cwd: path.join(root, "desktop") }).exitCode).toBe(0)
      }
      const result = execute(root, ["finalize", version, input, "release"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/release archives|release archive|Release archive|Release output/)
      expect(await Bun.file(path.join(root, "release", `ycoding-${version}-checksums.txt`)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

async function desktopRelease(root: string, release = version) {
  const input = path.join(root, "downloaded")
  await fs.mkdir(input)
  await desktopFixture(root)
  expect(Bun.spawnSync(["zip", "-qr", path.join(input, `YCoding-Desktop-v${release}-darwin-arm64.zip`), desktop], { cwd: path.join(root, "desktop") }).exitCode).toBe(0)
  return input
}

test("Desktop finalize checksums only the Desktop archive and the license texts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-finalize-"))
  try {
    const input = await desktopRelease(root)
    const result = execute(root, ["finalize-desktop", version, input, "release"])
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe("Validated the Desktop release archive and all 3 asset checksums\n")
    expect((await fs.readdir(path.join(root, "release"))).sort()).toEqual(["LICENSE", "NOTICE", desktopArchive, `ycoding-desktop-${version}-checksums.txt`].sort())
    const lines = (await Bun.file(path.join(root, "release", `ycoding-desktop-${version}-checksums.txt`)).text()).trim().split("\n")
    expect(lines.map((line) => line.slice(66))).toEqual([desktopArchive, "LICENSE", "NOTICE"])
    for (const line of lines) {
      expect(line).toMatch(/^[a-f0-9]{64}  /)
      expect(new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(root, "release", line.slice(66))).arrayBuffer()).digest("hex")).toBe(line.slice(0, 64))
    }
    expect(await Bun.file(path.join(root, "release", "NOTICE")).text()).toBe(await Bun.file(path.join(import.meta.dir, "../NOTICE")).text())
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const invalid of ["CLI archive present", "extra archive present", "missing Desktop archive", "wrong version", "extra desktop entry", "nonexecutable desktop launcher", "nonempty output"])
  test(`Desktop finalize rejects ${invalid} without a checksum manifest`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-finalize-invalid-"))
    try {
      const input = await desktopRelease(root)
      const archive = path.join(input, desktopArchive)
      if (invalid === "CLI archive present") await Bun.write(path.join(input, `ycoding-${version}-darwin-arm64.tar.gz`), "unexpected archive")
      if (invalid === "extra archive present") await Bun.write(path.join(input, "unexpected.zip"), "unexpected archive")
      if (invalid === "missing Desktop archive") await fs.unlink(archive)
      if (invalid === "wrong version") await fs.rename(archive, path.join(input, "YCoding-Desktop-v9.9.8-darwin-arm64.zip"))
      if (invalid === "extra desktop entry" || invalid === "nonexecutable desktop launcher") {
        const source = path.join(root, "desktop", desktop)
        if (invalid === "extra desktop entry") await Bun.write(path.join(source, "Contents/Resources/update.json"), "{}")
        else await fs.chmod(path.join(source, "Contents/MacOS/launcher"), 0o644)
        await fs.unlink(archive)
        expect(Bun.spawnSync(["zip", "-qr", archive, desktop], { cwd: path.join(root, "desktop") }).exitCode).toBe(0)
      }
      if (invalid === "nonempty output") await Bun.write(path.join(root, "release/private.json"), "{}")
      const result = execute(root, ["finalize-desktop", version, input, "release"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/Desktop release archive|desktop release archive|Release output/)
      expect(await Bun.file(path.join(root, "release", `ycoding-desktop-${version}-checksums.txt`)).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
