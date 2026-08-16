import fs from "fs"
import os from "os"
import path from "path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-test-"))

process.env.YCODING_TEST_XDG_ROOT = root
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.YCODING_DB = ":memory:"
process.env.YCODING_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.YCODING_DISABLE_MODELS_FETCH = "true"
