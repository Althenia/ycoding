import { spawnSync } from "node:child_process"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"

export async function sourceRuntimeExecutable(root: string) {
  const executable = process.env.YCODING_RUNTIME_EXECUTABLE ?? sourceExecutable(root)
  await access(executable, constants.X_OK)
  return path.resolve(executable)
}

function sourceExecutable(root: string) {
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
  return path.join(value.target_directory, "debug", process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime")
}
