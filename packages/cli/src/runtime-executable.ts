import { createHash, randomUUID } from "node:crypto"
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { InstallationChannel, InstallationVersion } from "./version"
import { platformBinary } from "./binary"
import { FrontendPaths } from "./paths"
import { sourceRuntimeExecutable } from "../../../script/ycoding-runtime-source"

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
  return sourceRuntimeExecutable(path.resolve(import.meta.dirname, "../../.."))
}

export function runtimeEnvironment() {
  return { ...process.env, YCODING_VERSION: InstallationVersion, YCODING_CHANNEL: InstallationChannel }
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
