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
delete process.env.CLAUDE_CODE_ENTRYPOINT

const { mock } = await import("bun:test")
const { Layer } = await import("effect")
const { ClamshellSleep } = await import("../src/util/clamshell-sleep")
const lidLayer = Layer.succeed(ClamshellSleep.Service, ClamshellSleep.Service.of({ set: (enabled) => enabled ? "on" : "off" }))
const lidNode = { ...ClamshellSleep.node, implementation: lidLayer }
const lidModule = { Service: ClamshellSleep.Service, make: ClamshellSleep.make, layer: lidLayer, node: lidNode }
await mock.module("../src/util/clamshell-sleep", () => ({ ...lidModule, ClamshellSleep: lidModule }))
