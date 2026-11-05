import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bundledBackend } from "../src/resources"

const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex")

async function bundle(root: string, files: Record<string, string>) {
  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), bytes, { mode: file === "backend/ycoding" ? 0o700 : 0o600 })
  }
  const listed = Object.entries(files).map(([file, bytes]) => ({ path: file, sha256: digest(bytes) }))
  await fs.writeFile(path.join(root, "backend.json"), JSON.stringify({ executable: "backend/ycoding", version: "synthetic", files: listed }))
}

const synthetic = {
  "backend/ycoding": "synthetic executable bytes",
  "backend/Helper.app/Contents/MacOS/helper": "synthetic helper bytes",
  "backend/extension/manifest.json": "{\"synthetic\":true}",
}

test("refuses missing, escaped, non-executable and mismatched bundled backend executables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-resources-"))
  try {
    await expect(bundledBackend(root)).rejects.toThrow("bundle")
    await fs.writeFile(path.join(root, "backend.json"), JSON.stringify({ executable: "../elsewhere", version: "synthetic", files: [] }))
    await expect(bundledBackend(root)).rejects.toThrow("bundle")
    await bundle(root, synthetic)
    const binary = path.join(root, "backend", "ycoding")
    expect(await bundledBackend(root)).toEqual({ executable: await fs.realpath(binary), version: "synthetic" })
    await fs.chmod(binary, 0o600)
    await expect(bundledBackend(root)).rejects.toThrow("bundle")
    await fs.chmod(binary, 0o700)
    await fs.writeFile(binary, "different bytes")
    await expect(bundledBackend(root)).rejects.toThrow("bundle")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each([
  ["a tampered non-main file", (root: string) => fs.writeFile(path.join(root, "backend/extension/manifest.json"), "{\"tampered\":true}")],
  ["an unlisted extra file", (root: string) => fs.writeFile(path.join(root, "backend/extension/injected.js"), "synthetic")],
  ["a missing listed file", (root: string) => fs.rm(path.join(root, "backend/Helper.app/Contents/MacOS/helper"))],
  ["a symbolic link", (root: string) => fs.symlink("/bin/sh", path.join(root, "backend/extension/link"))],
] as const)("refuses a bundled backend tree with %s", async (_, change) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-resources-"))
  try {
    await bundle(root, synthetic)
    expect((await bundledBackend(root)).version).toBe("synthetic")
    await change(root)
    await expect(bundledBackend(root)).rejects.toThrow("bundle")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
