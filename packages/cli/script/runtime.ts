import { spawnSync } from "node:child_process"
import path from "node:path"
import { modelsSource } from "./generate"

export async function buildRuntime(target: { os: string; arch: string; abi?: string }) {
  if (target.os !== process.platform || target.arch !== process.arch || target.abi === "musl")
    throw new Error("Rust payload builds require a matching native host")
  const root = path.resolve(import.meta.dirname, "../../..")
  const args = ["--manifest-path", path.join(root, "rust/Cargo.toml"), "--no-deps", "--format-version", "1"]
  const env = { ...process.env, YCODING_BUNDLED_MODELS_PATH: path.resolve(modelsSource) }
  const metadata = spawnSync("cargo", ["metadata", "--locked", ...args], { cwd: root, encoding: "utf8", env })
  if (metadata.error) throw metadata.error
  if (metadata.status !== 0) throw new Error(`Rust payload metadata failed (${metadata.status ?? metadata.signal})`)
  const targetDirectory = (JSON.parse(metadata.stdout) as { target_directory: string }).target_directory
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      path.join(root, "rust/Cargo.toml"),
      "--release",
      "-p",
      "ycoding-runtime",
      "--bin",
      "ycoding-runtime",
    ],
    { cwd: root, stdio: "inherit", env },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Rust payload build failed (${result.status ?? result.signal})`)
  return Buffer.from(
    await Bun.file(
      path.join(targetDirectory, "release", target.os === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime"),
    ).arrayBuffer(),
  ).toString("base64")
}
