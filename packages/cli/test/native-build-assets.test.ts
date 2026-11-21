import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { platformBinary } from "../src/binary"

test("the compiled frontend embeds the selected native runtime and isolated plugin SDK", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-native-build-"))
  try {
    const preload = path.join(directory, "preload.ts")
    await Bun.write(preload, `
      import { mock } from "bun:test"
      import path from "node:path"
      mock.module(path.join(process.cwd(), "script/runtime.ts"), () => ({
        buildRuntime: async () => ({ path: "/fixture/runtime.br", sha256: "runtime-hash", payloadSha256: "payload-hash", dispose: async () => {} }),
      }))
      mock.module(path.join(process.cwd(), "script/plugin-sdk.ts"), () => ({
        PluginSDKAsset: { build: async () => ({ path: "/fixture/sdk.mjs", digest: "sdk-hash" }) },
      }))
      Bun.build = async (options) => {
        const names = ["YCODING_RUNTIME_ASSET", "YCODING_RUNTIME_SHA256", "YCODING_RUNTIME_PAYLOAD_SHA256", "YCODING_PLUGIN_SDK_ASSET", "YCODING_PLUGIN_SDK_SHA256"]
        console.log("ASSETS=" + JSON.stringify(Object.fromEntries(names.map((name) => [name, options.define[name]]))))
        console.log("OUTFILE=" + options.compile.outfile)
        process.exit(0)
      }
    `)
    const child = Bun.spawn([process.execPath, "--preload", preload, "script/build.ts", "--single", `--outdir=${directory}/output`], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, YCODING_CHANNEL: "test", YCODING_VERSION: "0.0.0-test-1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    const line = stdout.split("\n").find((value) => value.startsWith("ASSETS="))
    expect(line).toBeDefined()
    expect(path.basename(stdout.split("\n").find((value) => value.startsWith("OUTFILE="))!.slice("OUTFILE=".length).trimEnd())).toBe(platformBinary("ycoding"))
    expect(JSON.parse(line!.slice("ASSETS=".length))).toMatchObject({
      YCODING_RUNTIME_ASSET: JSON.stringify("/fixture/runtime.br"),
      YCODING_RUNTIME_SHA256: JSON.stringify("runtime-hash"),
      YCODING_RUNTIME_PAYLOAD_SHA256: JSON.stringify("payload-hash"),
      YCODING_PLUGIN_SDK_ASSET: JSON.stringify("/fixture/sdk.mjs"),
      YCODING_PLUGIN_SDK_SHA256: JSON.stringify("sdk-hash"),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
