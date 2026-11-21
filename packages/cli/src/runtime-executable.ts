import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { InstallationChannel, InstallationVersion } from "./version"
import { platformBinary } from "./binary"
import { FrontendPaths } from "./paths"

declare const YCODING_RUNTIME_ASSET: string
declare const YCODING_RUNTIME_SHA256: string
declare const YCODING_RUNTIME_PAYLOAD_SHA256: string

export async function extractRuntime(payload: Uint8Array, sha256: string, bin: string, version: string) {
  const directory = path.join(bin, "runtime", encodeURIComponent(version), sha256)
  const executable = path.join(directory, platformBinary("ycoding-runtime"))
  const existing = await lstat(executable).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) {
    if (!existing.isFile() || digest(await readFile(executable)) !== sha256)
      throw new Error("Extracted runtime does not match the embedded payload")
    await access(executable, constants.X_OK)
    return executable
  }
  const runtime = brotliDecompressSync(payload)
  if (digest(runtime) !== sha256) throw new Error("Packaged runtime does not match its embedded digest")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = executable + "." + randomUUID()
  try {
    await writeFile(temporary, runtime, { flag: "wx", mode: 0o700 })
    await chmod(temporary, 0o700)
    await rename(temporary, executable)
  } finally {
    await rm(temporary, { force: true })
  }
  return executable
}

export async function runtimeExecutable() {
  if (typeof YCODING_RUNTIME_ASSET === "string") {
    const asset = await import(YCODING_RUNTIME_ASSET, { with: { type: "file" } })
    const payload = await readFile(asset.default)
    if (
      typeof YCODING_RUNTIME_SHA256 !== "string" ||
      typeof YCODING_RUNTIME_PAYLOAD_SHA256 !== "string" ||
      digest(payload) !== YCODING_RUNTIME_PAYLOAD_SHA256
    )
      throw new Error("Packaged runtime does not match its embedded digest")
    return extractRuntime(payload, YCODING_RUNTIME_SHA256, FrontendPaths.Path.bin, InstallationVersion)
  }
  const executable = process.env.YCODING_RUNTIME_EXECUTABLE ?? sourceExecutable()
  await access(executable, constants.X_OK)
  return executable
}

function sourceExecutable() {
  const root = path.resolve(import.meta.dirname, "../../..")
  const metadata = spawnSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version", "1", "--manifest-path", path.join(root, "rust/Cargo.toml")],
    { cwd: root, encoding: "utf8" },
  )
  if (metadata.error) throw new Error("Failed to read the configured Cargo target directory", { cause: metadata.error })
  if (metadata.status !== 0)
    throw new Error(`Cargo metadata failed (${metadata.status ?? metadata.signal})`)
  const value: unknown = JSON.parse(metadata.stdout)
  if (typeof value !== "object" || value === null || !("target_directory" in value) ||
      typeof value.target_directory !== "string" || !path.isAbsolute(value.target_directory))
    throw new Error("Cargo metadata did not provide an absolute target directory")
  return path.join(value.target_directory, "debug", platformBinary("ycoding-runtime"))
}

export function runtimeEnvironment() {
  return { ...process.env, YCODING_VERSION: InstallationVersion, YCODING_CHANNEL: InstallationChannel }
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
