import { spawnSync } from "node:child_process"
import path from "node:path"
import { modelsSource } from "./generate"

export async function buildRuntime(target: { os: string; arch: string; abi?: string }) {
  if (target.os !== process.platform || target.arch !== process.arch || target.abi === "musl")
    throw new Error("Rust payload builds require a matching native host")
  const root = path.resolve(import.meta.dirname, "../../..")
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
    { cwd: root, stdio: "inherit", env: { ...process.env, YCODING_BUNDLED_MODELS_PATH: path.resolve(modelsSource) } },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Rust payload build failed (${result.status ?? result.signal})`)
  return Buffer.from(
    await Bun.file(
      path.join(
        process.env.CARGO_TARGET_DIR ?? path.join(root, "rust/target"),
        "release",
        target.os === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime",
      ),
    ).arrayBuffer(),
  ).toString("base64")
}
