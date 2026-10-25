import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-tui-test-"))

process.env.YCODING_TEST_XDG_ROOT = testRoot
process.env.HOME = path.join(testRoot, "home")
process.env.USERPROFILE = process.env.HOME
process.env.YCODING_TEST_HOME = process.env.HOME
process.env.TMPDIR = path.join(testRoot, "tmp")
process.env.TMP = process.env.TMPDIR
process.env.TEMP = process.env.TMPDIR
process.env.XDG_CACHE_HOME = path.join(testRoot, "cache")
process.env.XDG_CONFIG_HOME = path.join(testRoot, "config")
process.env.XDG_DATA_HOME = path.join(testRoot, "data")
process.env.XDG_STATE_HOME = path.join(testRoot, "state")
process.env.XDG_RUNTIME_DIR = path.join(testRoot, "runtime")
process.env.YCODING_CONFIG_DIR = path.join(testRoot, "config", "ycoding")
delete process.env.YCODING_DB
delete process.env.YCODING_CONFIG
delete process.env.YCODING_CONFIG_CONTENT

for (const directory of ["home", "tmp", "cache", "config", "data", "state", "runtime"]) {
  fs.mkdirSync(path.join(testRoot, directory))
}

process.once("exit", () => fs.rmSync(testRoot, { recursive: true, force: true }))

export function assertTestPaths(paths: object) {
  for (const [name, value] of Object.entries(paths)) {
    if (typeof value !== "string" || !value.startsWith(testRoot + path.sep)) {
      throw new Error(`Global path ${name} is outside the TUI test root`)
    }
  }
}
