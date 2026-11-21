import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each([
  { module: "/fixture/packages/client/src/v5/client.ts", rejected: false },
  { module: "/fixture/packages/core/src/index.ts", rejected: true },
  { module: "/fixture/packages/meeting/src/index.ts", rejected: true },
])("audits the compiled frontend graph before publishing: $module", async ({ module, rejected }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-native-graph-"))
  try {
    const preload = path.join(root, "preload.ts")
    await mkdir(path.join(root, "sdk"))
    await writeFile(path.join(root, "runtime"), "runtime")
    await writeFile(path.join(root, "sdk", "sdk.mjs"), "sdk")
    await writeFile(preload, `
      import { mock } from "bun:test"
      import path from "node:path"
      import { createHash } from "node:crypto"
      mock.module(path.join(process.cwd(), "script/runtime.ts"), () => ({
        buildRuntime: async () => ({ path: path.join(process.env.TEST_ROOT, "runtime"), sha256: "runtime", payloadSha256: createHash("sha256").update("runtime").digest("hex"), dispose: async () => {} }),
      }))
      mock.module(path.join(process.cwd(), "script/plugin-sdk.ts"), () => ({
        PluginSDKAsset: { build: async () => ({ path: path.join(process.env.TEST_ROOT, "sdk", "sdk.mjs"), digest: "sdk" }) },
      }))
      mock.module(path.join(process.cwd(), "script/computer-use.ts"), () => ({
        computerHelperBuildAvailable: () => true,
      }))
      mock.module(path.join(process.cwd(), "script/package-macos-interaction.ts"), () => ({ packageMacOSInteraction: async () => {} }))
      mock.module(path.join(process.cwd(), "script/user-app-package.ts"), () => ({
        userAppPackageMetadata: () => ({}), buildUserAppPackage: async () => {},
      }))
      mock.module(path.join(process.cwd(), "script/chrome-extension.ts"), () => ({ copyChromeExtension: async () => {} }))
      Bun.build = async (options) => {
        await Bun.write(options.compile.outfile, "frontend")
        return {
        success: true, logs: [], outputs: [],
        metafile: { inputs: { [process.env.TEST_MODULE]: {} }, outputs: { "frontend.js": { imports: [] } } },
        }
      }
    `)
    const child = Bun.spawn([process.execPath, "--preload", preload, "script/build.ts", "--single", `--outdir=${root}/output`], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, TEST_ROOT: root, TEST_MODULE: module, YCODING_CHANNEL: "test", YCODING_VERSION: "0.0.0-test-1" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (rejected) {
      expect(code).not.toBe(0)
      expect(stderr).toContain("forbidden runtime modules")
      expect(stdout).not.toContain("phase=computer-helper")
    } else expect(code, stderr).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
