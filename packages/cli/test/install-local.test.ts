import { expect, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { COMPUTER_HELPER_APPLICATION } from "../script/computer-use"
import { installLocalBuild } from "../script/install-local"

async function build(root: string, label: string, platform: NodeJS.Platform) {
  const source = path.join(root, `source-${label}`)
  await mkdir(path.join(source, BrowserExtension.directory), { recursive: true })
  await writeFile(path.join(source, "ycoding"), `binary-${label}`, { mode: 0o755 })
  await writeFile(path.join(source, BrowserExtension.directory, "manifest.json"), `manifest-${label}`)
  if (platform === "darwin") {
    const executable = path.join(source, COMPUTER_HELPER_APPLICATION, "Contents", "MacOS")
    await mkdir(executable, { recursive: true })
    await writeFile(
      path.join(source, COMPUTER_HELPER_APPLICATION, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>helper</string><key>CFBundleIdentifier</key><string>test.ycoding.helper</string></dict></plist>`,
    )
    await Bun.write(path.join(executable, "helper"), Bun.file("/usr/bin/true"))
    const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", path.join(source, COMPUTER_HELPER_APPLICATION)])
    if (signed.exitCode !== 0) throw new Error(signed.stderr.toString())
  }
  return source
}

test("installs the executable and Chrome extension together and replaces a previous install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const running = await stat(path.join(destination, "ycoding"))
    await writeFile(path.join(destination, BrowserExtension.directory, "stale.js"), "stale")

    await installLocalBuild({ source: await build(root, "second", "linux"), destination, platform: "linux" })

    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-second")
    expect((await stat(path.join(destination, "ycoding"))).mode & 0o111).not.toBe(0)
    expect((await stat(path.join(destination, "ycoding"))).ino).not.toBe(running.ino)
    expect(await readdir(path.join(destination, BrowserExtension.directory))).toEqual(["manifest.json"])
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe(
      "manifest-second",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("leaves the previous install untouched when the build is incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const incomplete = await build(root, "second", "linux")
    await rm(path.join(incomplete, BrowserExtension.directory), { recursive: true })

    await expect(installLocalBuild({ source: incomplete, destination, platform: "linux" })).rejects.toThrow(
      "bun run build:tui",
    )

    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-first")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "darwin")("installs the signed computer helper app beside the executable on macOS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "mac", "darwin"), destination, platform: "darwin" })
    expect((await readdir(destination)).sort()).toEqual(
      ["ycoding", COMPUTER_HELPER_APPLICATION, BrowserExtension.directory].sort(),
    )
    const verified = Bun.spawnSync([
      "/usr/bin/codesign",
      "--verify",
      "--deep",
      "--strict",
      path.join(destination, COMPUTER_HELPER_APPLICATION),
    ])
    expect(verified.exitCode).toBe(0)

    const tampered = await build(root, "tampered", "darwin")
    await Bun.write(path.join(tampered, COMPUTER_HELPER_APPLICATION, "Contents", "MacOS", "helper"), "altered")
    await expect(installLocalBuild({ source: tampered, destination, platform: "darwin" })).rejects.toThrow(
      "signature verification failed",
    )
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-mac")
    expect((await readdir(destination)).sort()).toEqual(
      ["ycoding", COMPUTER_HELPER_APPLICATION, BrowserExtension.directory].sort(),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
