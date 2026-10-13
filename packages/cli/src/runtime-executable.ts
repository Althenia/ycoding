import { createHash, randomUUID } from "node:crypto"
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { InstallationChannel, InstallationVersion } from "./version"
import { platformBinary } from "./binary"

declare const YCODING_RUNTIME_PAYLOAD: string

export async function extractRuntime(payload: Uint8Array, bin: string, version: string) {
  const digest = createHash("sha256").update(payload).digest("hex")
  const directory = path.join(bin, "runtime", encodeURIComponent(version), digest)
  const executable = path.join(directory, platformBinary("ycoding-runtime"))
  const existing = await lstat(executable).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) {
    if (
      !existing.isFile() ||
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex") !== digest
    )
      throw new Error("Extracted runtime does not match the embedded payload")
    await access(executable, constants.X_OK)
    return executable
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = executable + "." + randomUUID()
  try {
    await writeFile(temporary, payload, { flag: "wx", mode: 0o700 })
    await chmod(temporary, 0o700)
    await rename(temporary, executable)
  } finally {
    await rm(temporary, { force: true })
  }
  return executable
}

export async function runtimeExecutable() {
  if (typeof YCODING_RUNTIME_PAYLOAD === "string") {
    const namespace = InstallationChannel === "beta" ? "ycoding-beta" : "ycoding"
    return extractRuntime(
      Buffer.from(YCODING_RUNTIME_PAYLOAD, "base64"),
      path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), namespace, "bin"),
      InstallationVersion,
    )
  }
  const executable =
    process.env.YCODING_RUNTIME_EXECUTABLE ??
    path.resolve(import.meta.dirname, "../../../rust/target/debug", platformBinary("ycoding-runtime"))
  await access(executable, constants.X_OK)
  return executable
}

export function runtimeEnvironment() {
  return { ...process.env, YCODING_VERSION: InstallationVersion, YCODING_CHANNEL: InstallationChannel }
}
