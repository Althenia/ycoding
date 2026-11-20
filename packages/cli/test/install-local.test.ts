import { expect, spyOn, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { interactionApplication } from "../src/update/interaction-layout"
import { installLocalBuild } from "../script/install-local"

const fs = await import("node:fs/promises")

async function build(root: string, label: string, platform: NodeJS.Platform) {
  const source = path.join(root, `source-${label}`)
  await mkdir(path.join(source, BrowserExtension.directory), { recursive: true })
  await writeFile(path.join(source, "ycoding"), `binary-${label}`, { mode: 0o755 })
  await writeFile(path.join(source, BrowserExtension.directory, "manifest.json"), `manifest-${label}`)
  if (platform === "darwin") {
    const contents = path.join(source, interactionApplication.name, "Contents")
    await mkdir(contents, { recursive: true })
    await writeFile(path.join(contents, "Info.plist"), `helper-${label}`)
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
    // A simulated Linux build still uses the host filesystem; Windows has no POSIX executable bits.
    if (process.platform !== "win32") expect((await stat(path.join(destination, "ycoding"))).mode & 0o111).not.toBe(0)
    expect((await stat(path.join(destination, "ycoding"))).ino).not.toBe(running.ino)
    expect(await readdir(path.join(destination, BrowserExtension.directory))).toEqual(["manifest.json"])
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe(
      "manifest-second",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects Windows installation without changing existing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const executable = path.join(destination, "ycoding")
    const before = await stat(executable)
    const source = await build(root, "second", "linux")

    const result = await installLocalBuild({ source, destination, platform: "win32" }).then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error.message : undefined,
    )
    expect(result).toBe("install:local supports macOS and Linux")

    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(executable, "utf8")).toBe("binary-first")
    expect((await stat(executable)).ino).toBe(before.ino)
    expect(await readdir(path.join(destination, BrowserExtension.directory))).toEqual(["manifest.json"])
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe(
      "manifest-first",
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

test("removes a stale CRX while installing only the executable and unpacked extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-crx-"))
  try {
    const destination = path.join(root, "bin")
    await installLocalBuild({ source: await build(root, "first", "linux"), destination, platform: "linux" })
    const source = await build(root, "second", "linux")
    await writeFile(path.join(destination, "ycoding-chrome-extension.crx"), "stale package")
    const installed = await installLocalBuild({ source, destination, platform: "linux" })
    expect(installed).toEqual([path.join(destination, "ycoding"), path.join(destination, BrowserExtension.directory)])
    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-second")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ignores a CRX in the source build when installing the unpacked extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-unpacked-"))
  try {
    const destination = path.join(root, "bin")
    const source = await build(root, "next", "linux")
    await writeFile(path.join(source, "ycoding-chrome-extension.crx"), "unused package")
    await installLocalBuild({ source, destination, platform: "linux" })
    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory].sort())
    expect(await readFile(path.join(source, "ycoding-chrome-extension.crx"), "utf8")).toBe("unused package")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("installs the CLI, Interaction helper and extension only after both signatures verify", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    const source = await build(root, "mac", "darwin")
    const checked: string[] = []
    await installLocalBuild({ source, destination, platform: "darwin" }, (file, component) => {
      expect(path.dirname(file)).toBe(destination)
      expect(path.basename(file)).toStartWith(component === "cli" ? ".ycoding.install-" : "." + interactionApplication.name + ".install-")
      checked.push(component)
    })
    expect(checked).toEqual(["cli", "helper"])
    expect((await readdir(destination)).sort()).toEqual(["ycoding", interactionApplication.name, BrowserExtension.directory].sort())
    for (const invalid of ["cli", "helper"] as const) {
      await expect(installLocalBuild({ source: await build(root, invalid, "darwin"), destination, platform: "darwin" }, (_, component) => {
        if (component === invalid) throw new Error("untrusted " + invalid)
      })).rejects.toThrow("untrusted " + invalid)
      expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("binary-mac")
      expect(await readFile(path.join(destination, interactionApplication.name, "Contents/Info.plist"), "utf8")).toBe("helper-mac")
      expect((await readdir(destination)).sort()).toEqual(["ycoding", interactionApplication.name, BrowserExtension.directory].sort())
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("retains the installed Interaction helper while replacing only the CLI and extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    const retained = path.join(destination, interactionApplication.name)
    await mkdir(retained, { recursive: true })
    await writeFile(path.join(retained, "retained"), "installed helper")
    await writeFile(path.join(destination, "unrelated"), "preserved")
    const before = await stat(retained)
    const source = await build(root, "next", "linux")
    const checked: string[] = []
    const installed = await installLocalBuild({ source, destination, platform: "darwin", preserveComputerHelper: true }, (file, component) => {
      if (component === "helper") expect(file).toBe(retained)
      checked.push(component)
    })
    expect(checked).toEqual(["helper", "cli"])
    expect(installed).toEqual([path.join(destination, "ycoding"), path.join(destination, BrowserExtension.directory)])
    expect((await stat(retained)).ino).toBe(before.ino)
    expect((await stat(retained)).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(path.join(retained, "retained"), "utf8")).toBe("installed helper")
    expect(await readFile(path.join(destination, "unrelated"), "utf8")).toBe("preserved")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejects a missing retained Interaction helper before staging files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const source = await build(root, "next", "linux")
    const destination = path.join(root, "bin")
    await expect(installLocalBuild({ source, destination, platform: "darwin", preserveComputerHelper: true }, (file, component) => {
      expect(file).toBe(path.join(destination, interactionApplication.name))
      expect(component).toBe("helper")
      throw new Error("untrusted helper")
    })).rejects.toThrow("untrusted helper")
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("install rollback restores the CLI and extension without touching the retained Interaction helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    const helper = path.join(destination, interactionApplication.name)
    await mkdir(helper, { recursive: true })
    await writeFile(path.join(helper, "marker"), "retained")
    const before = await stat(helper)
    await writeFile(path.join(destination, "ycoding"), "previous-cli")
    await mkdir(path.join(destination, BrowserExtension.directory))
    await writeFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "previous-extension")
    const source = await build(root, "rollback", "linux")
    const rename = fs.rename
    const failed = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".install-") && !String(from).endsWith(".previous") && String(to) === path.join(destination, BrowserExtension.directory))
        throw new Error("synthetic extension commit failure")
      return rename(from, to)
    })
    try {
      await expect(installLocalBuild({ source, destination, platform: "darwin", preserveComputerHelper: true }, () => {})).rejects.toThrow("synthetic extension commit failure")
    } finally { failed.mockRestore() }
    expect((await stat(helper)).ino).toBe(before.ino)
    expect(await readFile(path.join(helper, "marker"), "utf8")).toBe("retained")
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("previous-cli")
    expect(await readFile(path.join(destination, BrowserExtension.directory, "manifest.json"), "utf8")).toBe("previous-extension")
    expect((await readdir(destination)).sort()).toEqual([interactionApplication.name, BrowserExtension.directory, "ycoding"].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("retaining the helper is rejected outside macOS without creating the destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-install-local-"))
  try {
    const destination = path.join(root, "bin")
    await expect(installLocalBuild({ source: await build(root, "linux", "linux"), destination, platform: "linux", preserveComputerHelper: true })).rejects.toThrow("requires macOS")
    expect(await Bun.file(path.join(destination, "ycoding")).exists()).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
