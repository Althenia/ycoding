import fs from "node:fs/promises"
import path from "node:path"
import { buildDesktop, type BuildBoundary } from "./build-preflight"
import { prepareBackend } from "./prepare-backend"
import { assertLocalArtifactSigning } from "./signing-preflight"

const iconEntries: readonly (readonly [string, number])[] = [["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64], ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512], ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024]]

export async function assertToolchain(dependency: string, arch: string, iconset?: string) {
  const native = path.join(dependency, `dist-macos-${arch}`)
  const shared = ["package.json", "bin/electrobun", "bin/electrobun.cjs", "dist/main.js", "dist/api/bun/index.ts"]
  const binaries = ["bun", "bsdiff", "bspatch", "zig-zstd", "launcher", "libNativeWrapper.dylib", "libasar.dylib", "extractor"]
  for (const file of [...shared.map((name) => path.join(dependency, name)), ...binaries.map((name) => path.join(native, name))]) {
    try { if (!(await fs.stat(file)).isFile()) throw new Error() }
    catch { throw new Error("The Electrobun CLI or native core binaries are not installed. Provision them explicitly before building; automatic downloads are refused.") }
  }
  if (iconset !== undefined) {
    try { await fs.access("/usr/bin/iconutil", fs.constants.X_OK) }
    catch { throw new Error("iconutil is not available at /usr/bin/iconutil. Install the macOS Command Line Tools before building; automatic downloads are refused.") }
    for (const [name, size] of iconEntries) {
      const file = path.join(iconset, name)
      const header = await fs.readFile(file).then((bytes) => bytes.subarray(0, 24), () => undefined)
      if (!header || header.length < 24 || header.subarray(1, 4).toString() !== "PNG" || header.subarray(12, 16).toString() !== "IHDR" || header.readUInt32BE(16) !== size || header.readUInt32BE(20) !== size)
        throw new Error(`The app iconset entry ${name} is missing or is not a ${size}x${size} PNG. Regenerate icon.iconset from assets/brand/ycoding-icon.svg before building.`)
    }
  }
}

async function main() {
  const desktop = path.resolve(import.meta.dir, "..")
  if (process.platform !== "darwin") throw new Error("The native desktop app build currently requires macOS.")
  const dependency = path.join(desktop, "node_modules/electrobun")
  const boundary: BuildBoundary = {
    assertSigning: () => assertLocalArtifactSigning(),
    assertToolchain: () => assertToolchain(dependency, process.arch, path.join(desktop, "icon.iconset")),
    prepare: () => prepareBackend(),
    run: (command) => Bun.spawn([...command], { cwd: desktop, stdout: "inherit", stderr: "inherit" }).exited,
  }
  console.log(JSON.stringify(await buildDesktop(boundary, { argv: process.argv.slice(2), desktop, bun: process.execPath, arch: process.arch })))
}

if (import.meta.main) await main()
