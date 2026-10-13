import fs from "fs"
import os from "os"
import path from "path"

// Runs before any test module imports Global, whose XDG paths are fixed at import time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-tui-test-"))

process.env.YCODING_TEST_XDG_ROOT = root
process.env.YCODING_TEST_HOME = root
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_STATE_HOME = path.join(root, "state")
delete process.env.YCODING_CONFIG_DIR

process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))
