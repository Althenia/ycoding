import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applicationName, numericBundleVersion, preparedVersion, writeBundleMetadata } from "../script/app-bundle"

test("bundle metadata uses the numeric version core while retaining the full prepared semantic version", async () => {
  const root = await fs.mkdtemp(path.join(os.homedir(), ".local/share/ycoding/tasks/desktop-bundle-metadata-"))
  try {
    const version = "0.0.0-desktop-stitch-redesign-20261116060141139"
    const manifest = path.join(root, "backend.json")
    await fs.writeFile(manifest, JSON.stringify({ version }))
    expect(preparedVersion(manifest)).toBe(version)
    expect(numericBundleVersion(version)).toBe("0.0.0")
    expect(numericBundleVersion("1.18.4")).toBe("1.18.4")
    const app = path.join(root, "Synthetic.app")
    const info = path.join(app, "Contents/Info.plist")
    await fs.mkdir(path.dirname(info), { recursive: true })
    await fs.writeFile(info, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>1.18.4</string></dict></plist>')
    writeBundleMetadata(app, version)
    for (const key of ["CFBundleVersion", "CFBundleShortVersionString"])
      expect(execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", info], { encoding: "utf8" }).trim()).toBe("0.0.0")
    expect(execFileSync("/usr/bin/plutil", ["-lint", info], { encoding: "utf8" })).toContain("OK")
    for (const value of ["bad", "01.2.3", "1.2.3+build", "1.2.3-invalid+build", "1.2.3-01"])
      expect(() => numericBundleVersion(value)).toThrow("semantic version")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("Electrobun metadata hooks address the displayed bundle name rather than the sanitized artifact name", async () => {
  const root = await fs.mkdtemp(path.join(os.homedir(), ".local/share/ycoding/tasks/desktop-bundle-hook-"))
  try {
    const app = path.join(root, `${applicationName}.app`)
    const info = path.join(app, "Contents/Info.plist")
    await fs.mkdir(path.dirname(info), { recursive: true })
    for (const wrapped of [false, true]) {
      await fs.writeFile(info, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>1.18.4</string></dict></plist>')
      const result = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../script/app-bundle.ts")], {
        env: { ...process.env, ELECTROBUN_OS: "macos", ELECTROBUN_BUILD_DIR: root, ELECTROBUN_APP_NAME: "YCodingDesktop", ELECTROBUN_APP_VERSION: "0.0.0-desktop-preview", ...(wrapped ? { ELECTROBUN_WRAPPER_BUNDLE_PATH: app } : {}) },
        stdout: "pipe", stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      for (const key of ["CFBundleVersion", "CFBundleShortVersionString"])
        expect(execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", info], { encoding: "utf8" }).trim()).toBe("0.0.0")
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
