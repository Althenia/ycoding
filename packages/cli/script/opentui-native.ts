import { spawnSync } from "node:child_process"
import path from "node:path"

// vendor/opentui is checked out ahead of the published @opentui/core-<platform>-<arch> prebuilds, so the FFI symbols
// its TypeScript binds (createNativeRenderable, bufferDrawImage, ...) exist only in a library built from
// vendor/opentui/packages/core/src/zig. The vendored build writes the native packages into the vendored core's
// node_modules, which is where both the Bun compile and the Node SEA asset collection resolve them from.
const core = path.resolve(import.meta.dirname, "../../../vendor/opentui/packages/core")

export function buildOpentuiNative(all: boolean) {
  const result = spawnSync(process.execPath, ["run", "scripts/build.ts", "--native", ...(all ? ["--all"] : [])], {
    cwd: core,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Building the vendored OpenTUI native library failed (exit ${result.status}). It requires the Zig toolchain on PATH.`,
    )
  }
}
