import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("native builds enable bytecode while retaining minified code-split ESM", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-build-options-"))
  try {
    const preload = path.join(directory, "capture.js")
    await Bun.write(
      preload,
      `Bun.build = async (options) => {
        console.log("BUILD_OPTIONS=" + JSON.stringify({
          bytecode: options.bytecode,
          format: options.format,
          minify: options.minify,
          splitting: options.splitting,
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
