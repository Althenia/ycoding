#!/usr/bin/env bun

import { rm } from "fs/promises"
import path from "path"
import { Script } from "@ycoding-ai/script"
import pkg from "../package.json"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { modelsData } from "./generate"
import { BUN_BINARY, platformBinary } from "../src/binary"
import { computerHelperBuildAvailable } from "./computer-use"
import { packageMacOSInteraction } from "./package-macos-interaction"
import { copyChromeExtension } from "./chrome-extension"
import { buildRuntime } from "./runtime"
import { nativeBuildTarget } from "./native-target"
import { buildUserAppPackage, userAppPackageMetadata } from "./user-app-package"
import { checkBundleGraph } from "../../../script/ycoding-workspace"

const dir = path.resolve(import.meta.dirname, "..")
const binary = BUN_BINARY
const tuiOnly = process.argv.includes("--tui-only")
const entrypoint = tuiOnly ? "./src/tui.ts" : "./src/index.ts"
const artifact = tuiOnly ? "tui" : "cli"
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist",
)
const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const targetArgs = process.argv.filter((arg) => arg.startsWith("--target="))
if (targetArgs.length > 1) throw new Error("Target must be specified once")
const receiptArgs = process.argv.filter((arg) => arg.startsWith("--runtime-receipt="))
if (receiptArgs.length > 1) throw new Error("Runtime receipt directory must be specified once")
const receiptPath = receiptArgs[0]?.slice("--runtime-receipt=".length)
if (receiptPath === "" || receiptPath !== undefined && process.platform !== "win32")
  throw new Error("A runtime receipt requires a directory and a Windows build host")
const receiptDirectory = receiptPath === undefined ? undefined : path.resolve(receiptPath)
const requested = targetArgs[0]?.slice("--target=".length)
const item = nativeBuildTarget({
  os: process.platform,
  arch: process.arch,
  single: singleFlag,
  baseline: baselineFlag,
  target: requested,
})
if (outdir === dir) throw new Error("--outdir must not be the package directory")
if (!computerHelperBuildAvailable({ platform: item.os, arch: item.arch }, process.platform))
  throw new Error("A complete artifact requires a matching native host")
const { PluginSDKAsset } = await import("./plugin-sdk")
process.chdir(dir)
await rm(outdir, { recursive: true, force: true })
const plugin = createSolidTransformPlugin()

const pluginSDKAsset = await PluginSDKAsset.build(path.resolve(dir, "../.."), outdir)
try {
  const target = [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
  ]
    .filter(Boolean)
    .join("-")
  const name = target.replace(binary, artifact)
  const frontend = path.join(outdir, name, "bin", platformBinary(binary, item.os))
  console.log(`building ${name}`)
  const runtimeAsset = await buildRuntime(item, receiptDirectory)
  try {
    const compileStarted = performance.now()
    const result = await Bun.build({
      entrypoints: [entrypoint],
      tsconfig: "./tsconfig.json",
      plugins: [plugin],
      external: ["node-gyp"],
      format: "esm",
      minify: true,
      sourcemap: "inline",
      splitting: true,
      bytecode: true,
      metafile: true,
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
        target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
        outfile: frontend,
        execArgv: [`--user-agent=${binary}/${Script.version}`, "--use-system-ca", "--"],
        windows: {},
      },
      define: {
        YCODING_RUNTIME_ASSET: JSON.stringify(runtimeAsset.path),
        YCODING_RUNTIME_SHA256: JSON.stringify(runtimeAsset.sha256),
        YCODING_RUNTIME_PAYLOAD_SHA256: JSON.stringify(runtimeAsset.payloadSha256),
        YCODING_PLUGIN_SDK_ASSET: JSON.stringify(pluginSDKAsset.path),
        YCODING_PLUGIN_SDK_SHA256: JSON.stringify(pluginSDKAsset.digest),
        YCODING_VERSION: `'${Script.version}'`,
        YCODING_CLI_NAME: `'${binary}'`,
        YCODING_MODELS_DEV: modelsData,
        YCODING_CHANNEL: `'${Script.channel}'`,
        YCODING_LIBC: item.os === "linux" ? "'glibc'" : "undefined",
        // FFF_LIBC selects the fff native lib variant: "musl" or "gnu".
        FFF_LIBC: item.os === "linux" ? "'gnu'" : "undefined",
        ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify("glibc") } : {}),
      },
    }).catch(async (error) => {
      await rm(path.join(outdir, name), { recursive: true, force: true })
      throw error
    })

    console.log(
      `build ${name} phase=compile duration_ms=${Math.round(performance.now() - compileStarted)} success=${result.success}`,
    )
    if (!result.success) {
      for (const log of result.logs) console.error(log)
      await rm(path.join(outdir, name), { recursive: true, force: true })
      throw new Error(`Native frontend build failed for ${name}`)
    }
    if (!result.metafile) {
      await rm(path.join(outdir, name), { recursive: true, force: true })
      throw new Error("Native frontend build produced no audit graph")
    }
    const modules = Object.keys(result.metafile.inputs).map((file) => path.resolve(dir, file))
    const edges = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      (input.imports ?? []).map((entry) => ({
        file: path.resolve(dir, file),
        specifier: entry.external ? entry.path : path.resolve(dir, entry.path),
      })),
    )
    const violations = checkBundleGraph({
      frontend: artifact,
      outputs: Object.entries(result.metafile.outputs).map(([file, output]) => ({
        file,
        modules,
        imports: [...output.imports.map((entry) => entry.path), ...edges.map((edge) => edge.specifier)],
        edges,
      })),
    })
    if (violations.length) {
      await rm(path.join(outdir, name), { recursive: true, force: true })
      throw new Error(
        `Native frontend contains forbidden runtime modules: ${violations.map((entry) => entry.owner).join(", ")}`,
      )
    }

    const helperStarted = performance.now()
    if (item.os === "darwin") await packageMacOSInteraction(frontend, item.arch)
    console.log(`build ${name} phase=computer-helper duration_ms=${Math.round(performance.now() - helperStarted)}`)
    const extensionStarted = performance.now()
    await copyChromeExtension(path.join(outdir, name, "bin"))
    console.log(`build ${name} phase=chrome-extension duration_ms=${Math.round(performance.now() - extensionStarted)}`)

    await Bun.write(
      path.join(outdir, name, "package.json"),
      JSON.stringify(
        {
          name: `@ycoding-ai/${name}`,
          version: Script.version,
          license: pkg.license,
          os: [item.os],
          cpu: [item.arch],
          ...userAppPackageMetadata(!tuiOnly),
        },
        null,
        2,
      ),
    )
    await Promise.all(
      ["LICENSE", "NOTICE"].map((file) =>
        Bun.write(path.join(outdir, name, file), Bun.file(path.join(dir, "../..", file))),
      ),
    )
    if (!tuiOnly)
      await buildUserAppPackage({
        directory: path.join(outdir, name, "lib"),
        packageDirectory: dir,
        selection: { requested, targets: [item] },
        frontend,
        os: item.os,
        arch: item.arch,
        version: Script.version,
        channel: Script.channel,
        runtimeAsset,
        pluginSDKAsset,
      })
  } finally {
    await runtimeAsset.dispose()
  }
} finally {
  await rm(path.dirname(pluginSDKAsset.path), { recursive: true, force: true })
}
