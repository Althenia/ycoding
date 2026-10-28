import { expect, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
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
  const tar = Bun.spawnSync(["tar", "-czf", "release.tar.gz", "ycoding", "ycoding-chrome-extension"], {
    cwd: bin,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  expect(tar.exitCode, tar.stderr.toString()).toBe(0)
  return new Uint8Array(await readFile(path.join(bin, "release.tar.gz")))
}

test("copies the Chrome extension runtime files beside a built executable", async () => {
  await packaged(async (_, extension) => {
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extension })))
      .map((file) => file.split(path.sep).join("/"))
      .sort()
    expect(files).toEqual([...BrowserExtension.files])
    expect(files).toEqual(releasedExtensionFiles)
    expect(await readFile(path.join(extension, "manifest.json"), "utf8")).toBe(
      await readFile(path.join(chromeExtensionSource, "manifest.json"), "utf8"),
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
    expect([...worker.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1])).toEqual([
      "./protocol.js",
    ])
    expect(worker).toContain('"\u24CE "')
    expect(worker).toContain("M40 40h40l48 64 48-64h40l-64 96v80h-48v-80z")
    expect(worker).toContain("[data-ycoding-agent-marker]")
  })
})

test("bundles the Geist Sans data into service-worker.js once, without shipping fonts.js or Geist Mono there", async () => {
  await packaged(async (bin, extension) => {
    const worker = await readFile(path.join(extension, "service-worker.js"), "utf8")
    const sans = Buffer.from(
      await readFile(path.join(chromeExtensionSource, "../../assets/brand/fonts/Geist.woff2")),
    ).toString("base64")
    const mono = Buffer.from(
      await readFile(path.join(chromeExtensionSource, "../../assets/brand/fonts/GeistMono.woff2")),
    ).toString("base64")
    expect(worker.split(sans).length - 1).toBe(1)
    expect(worker).not.toContain(mono)
    expect(await Bun.file(path.join(extension, "fonts.js")).exists()).toBe(false)
    const css = await readFile(path.join(extension, "popup.css"), "utf8")
    expect(css).not.toBe(await readFile(path.join(chromeExtensionSource, "popup.css"), "utf8"))
    expect(css).toContain(sans)
    expect(css).toContain(mono)
    const license = (
      await readFile(path.join(chromeExtensionSource, "../../assets/brand/fonts/OFL.txt"), "utf8")
    ).trim()
    expect(worker.replaceAll("\r\n", "\n")).toContain(license.replaceAll("\r\n", "\n"))
    expect(css.replaceAll("\r\n", "\n")).toContain(license.replaceAll("\r\n", "\n"))
    await releasedUpdaterAcceptsLinuxArchive(await archive(bin))
  })
})

test("the packaged service worker passes the extension lifecycle and marker suite without indicator.js", async () => {
  await packaged(async (bin, extension) => {
    const mirror = path.join(bin, "mirror")
    await cp(extension, mirror, { recursive: true })
    await writeFile(
      path.join(mirror, "indicator.js"),
      `export { timing } from ${JSON.stringify(pathToFileURL(path.join(chromeExtensionSource, "indicator.js")).href)}\n`,
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

test("ships only bundled, minified entries plus manifest and assets, with no source modules or sourcemaps", async () => {
  await packaged(async (_, extension) => {
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extension })))
      .map((file) => file.split(path.sep).join("/"))
      .sort()
    expect(files).toEqual([...BrowserExtension.files])
    expect(files.some((file) => file.endsWith(".map"))).toBe(false)
    for (const sourceOnly of ["indicator.js", "fonts.js", "DESIGN.md"]) expect(files).not.toContain(sourceOnly)

    const codeLines = (text: string) =>
      text
        .replace(/\/\*![\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => line.trim()).length
    for (const entry of ["service-worker.js", "protocol.js", "popup.js", "popup.css"] as const) {
      const packagedText = await readFile(path.join(extension, entry), "utf8")
      expect(packagedText, entry).not.toBe(await readFile(path.join(chromeExtensionSource, entry), "utf8"))
      expect(codeLines(packagedText), entry).toBeLessThanOrEqual(2)
      expect(packagedText, entry).not.toContain("sourceMappingURL")
    }

    const popup = await readFile(path.join(extension, "popup.js"), "utf8")
    expect(popup).toContain("#pairing-form")
    expect(popup).not.toContain("actionRevision")

    const protocol = await import(pathToFileURL(path.join(extension, "protocol.js")).href)
    const sourceProtocol = await import(pathToFileURL(path.join(chromeExtensionSource, "protocol.js")).href)
    expect(protocol.VERSION).toBe(sourceProtocol.VERSION)
    expect(protocol.connectURL("http://127.0.0.1:4096")).toBe("ws://127.0.0.1:4096/api/browser/connect")
    expect(protocol.tabID()).toMatch(/^btab_[0-9a-f]{32}$/)

    const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"))
    expect(manifest.background.service_worker).toBe("service-worker.js")
    expect(manifest.action.default_popup).toBe("popup.html")
    const html = await readFile(path.join(extension, "popup.html"), "utf8")
    expect(html).toContain('src="popup.js"')
    expect(html).toContain('href="popup.css"')
  })
})
