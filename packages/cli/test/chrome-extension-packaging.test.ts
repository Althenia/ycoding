import { expect, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromeExtensionSource, copyChromeExtension } from "../script/chrome-extension"
import { releasedExtensionFiles, releasedUpdaterAcceptsLinuxArchive } from "./fixtures/v0.7.15-updater"

async function packaged<T>(use: (bin: string, extension: string) => Promise<T>) {
  const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-extension-package-"))
  try {
    await copyChromeExtension(bin)
    return await use(bin, path.join(bin, "ycoding-chrome-extension"))
  } finally {
    await rm(bin, { recursive: true, force: true })
  }
}

async function archive(bin: string, extra: string[] = []) {
  await writeFile(path.join(bin, "ycoding"), "executable\n")
  for (const file of extra) await writeFile(path.join(bin, "ycoding-chrome-extension", file), `${file}\n`)
  const tar = Bun.spawnSync(["tar", "-C", bin, "-czf", path.join(bin, "release.tar.gz"), "ycoding", "ycoding-chrome-extension"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  expect(tar.exitCode, tar.stderr.toString()).toBe(0)
  return new Uint8Array(await readFile(path.join(bin, "release.tar.gz")))
}

test("copies the Chrome extension runtime files beside a built executable", async () => {
  await packaged(async (_, extension) => {
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extension }))).sort()
    expect(files).toEqual([...BrowserExtension.files])
    expect(files).toEqual(releasedExtensionFiles)
    expect(await readFile(path.join(extension, "manifest.json"), "utf8")).toBe(
      await readFile(path.join(chromeExtensionSource, "manifest.json"), "utf8"),
    )
    expect(await readFile(path.join(extension, "protocol.js"), "utf8")).toBe(
      await readFile(path.join(chromeExtensionSource, "protocol.js"), "utf8"),
    )
  })
})

test("packages an archive that the released v0.7.15 updater accepts", async () => {
  await packaged(async (bin) => {
    await releasedUpdaterAcceptsLinuxArchive(await archive(bin))
  })
})

test("the released v0.7.15 updater rejects an archive with an additional extension file", async () => {
  await packaged(async (bin) => {
    await expect(releasedUpdaterAcceptsLinuxArchive(await archive(bin, ["indicator.js"]))).rejects.toThrow(
      "did not contain the exact direct entries",
    )
  })
})

test("bundles the indicator module into service-worker.js and keeps protocol.js external", async () => {
  await packaged(async (_, extension) => {
    const worker = await readFile(path.join(extension, "service-worker.js"), "utf8")
    expect([...worker.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1])).toEqual(["./protocol.js"])
    expect(worker).toContain("[YCoding] ")
    expect(worker).toContain("markerScript")
  })
})

test("the packaged service worker passes the extension lifecycle and marker suite without indicator.js", async () => {
  await packaged(async (bin, extension) => {
    const mirror = path.join(bin, "mirror")
    await cp(extension, mirror, { recursive: true })
    await writeFile(
      path.join(mirror, "indicator.js"),
      `export { timing } from ${JSON.stringify(path.join(chromeExtensionSource, "indicator.js"))}\n`,
    )
    await mkdir(path.join(mirror, "test/fixtures"), { recursive: true })
    for (const file of ["service-worker.case.js", "fake-page.js"])
      await copyFile(path.join(chromeExtensionSource, "test/fixtures", file), path.join(mirror, "test/fixtures", file))
    const child = Bun.spawn([process.execPath, "test", "./test/fixtures/service-worker.case.js"], {
      cwd: mirror,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stdout + stderr).toBe(0)
    expect(stderr).toMatch(/\d+ pass/)
  })
}, 60000)
