import { lstat, mkdir, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = process.argv[2]
if (
  !root ||
  process.argv.length !== 3 ||
  path.dirname(root) !== (await realpath(tmpdir())) ||
  !/^ycoding-rust-baseline-[A-Za-z0-9]+$/.test(path.basename(root))
)
  throw new Error("Refusing non-temp baseline root")
const stat = await lstat(root)
if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root || (await readdir(root)).length)
  throw new Error("Refusing non-fresh baseline root")
for (const name of [
  "home",
  "data",
  "config",
  "state",
  "cache",
  "tmp",
  "locations/first",
  "locations/second",
  "meeting",
])
  await mkdir(path.join(root, name), { recursive: true, mode: 0o700 })
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.TMPDIR = path.join(root, "tmp")
process.env.YCODING_TEST_HOME = path.join(root, "home")
process.env.YCODING_TEST_XDG_ROOT = root
process.env.YCODING_CONFIG_DIR = path.join(root, "config/ycoding")
process.env.YCODING_DB = path.join(root, "data/core.sqlite")
await Bun.write(
  path.join(root, "config/ycoding/ycoding.json"),
  JSON.stringify({
    snapshots: false,
    prediction: { enabled: false },
    compaction: { advisory: false },
    mcp: {},
  }),
)
const { buildScenario } = await import("./scenario")
await buildScenario(root)
const { freezeBaseline } = await import("../../../../script/rust-parity/export")
await freezeBaseline(root)
