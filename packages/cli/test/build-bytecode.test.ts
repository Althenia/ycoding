import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("native builds enable bytecode while retaining minified code-split ESM", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-build-options-"))
  const runtimeAsset = { path: path.join(directory, "runtime.bin"), sha256: "a".repeat(64) }
  try {
    const preload = path.join(directory, "capture.js")
    await Bun.write(
      preload,
      `import { mock } from "bun:test"
      const runtimeCalls = []
      mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../script/runtime.ts"))}, () => ({
        buildRuntime: async (target) => {
          runtimeCalls.push(target)
          return ${JSON.stringify(runtimeAsset)}
        },
      }))
      Bun.build = async (options) => {
        console.log("BUILD_OPTIONS=" + JSON.stringify({
          bytecode: options.bytecode,
          format: options.format,
          minify: options.minify,
          splitting: options.splitting,
        }))
        console.log("RUNTIME_BUILD=" + JSON.stringify({
          calls: runtimeCalls,
          asset: options.define.YCODING_RUNTIME_ASSET,
          sha256: options.define.YCODING_RUNTIME_SHA256,
          hasBase64Payload: "YCODING_RUNTIME_PAYLOAD" in options.define,
        }))
        process.exit(0)
      }`,
    )
    const child = Bun.spawn(
      [process.execPath, "--preload", preload, "script/build.ts", "--single", `--outdir=${directory}/output`],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_STATE_HOME: path.join(directory, "state"),
          YCODING_CHANNEL: "test",
          YCODING_VERSION: "0.0.0-test-1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const line = stdout.split("\n").find((value) => value.startsWith("BUILD_OPTIONS="))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.slice("BUILD_OPTIONS=".length))).toEqual({
      bytecode: true,
      format: "esm",
      minify: true,
      splitting: true,
    })
    const runtime = stdout.split("\n").find((value) => value.startsWith("RUNTIME_BUILD="))
    expect(runtime).toBeDefined()
    expect(JSON.parse(runtime!.slice("RUNTIME_BUILD=".length))).toEqual({
      calls: [{ os: process.platform, arch: process.arch }],
      asset: JSON.stringify(runtimeAsset.path),
      sha256: JSON.stringify(runtimeAsset.sha256),
      hasBase64Payload: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
