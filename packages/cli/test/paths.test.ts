import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FrontendPaths } from "../src/paths"
import { ServiceConfig } from "../src/services/service-config"

test.each(["local", "beta"])(
  "frontend paths match the Rust launch namespace without creating directories (%s)",
  async (channel) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-cli-paths-"))
    const env = {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      YCODING_CHANNEL: channel,
    }
    try {
      const paths = FrontendPaths.resolvePaths(env, channel)
      const runtime = Bun.spawnSync(
        [
          path.resolve(
            import.meta.dirname,
            "../../../rust/target/debug",
            process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime",
          ),
          "--paths",
        ],
        { env: { ...process.env, ...env, YCODING_CONFIG_DIR: undefined } },
      )
      expect(runtime.exitCode, runtime.stderr.toString()).toBe(0)
      expect(JSON.parse(runtime.stdout.toString())).toMatchObject({
        data: paths.data,
        cache: paths.cache,
        state: paths.state,
        config: paths.config,
        serviceFilename: ServiceConfig.filename(channel),
      })
      expect(await readdir(root)).toEqual([])
      expect(
        FrontendPaths.resolvePaths({ ...env, YCODING_CONFIG_DIR: path.join(root, "explicit") }, channel).config,
      ).toBe(path.join(root, "explicit"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
