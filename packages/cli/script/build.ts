#!/usr/bin/env bun

import { rm } from "fs/promises"
import path from "path"
import { Script } from "@ycoding-ai/script"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { modelsData } from "./generate"
import { buildOpentuiNative } from "./opentui-native"
import { BUN_BINARY } from "../src/binary"

const dir = path.resolve(import.meta.dirname, "..")
const binary = BUN_BINARY
const tuiOnly = process.argv.includes("--tui-only")
const entrypoint = tuiOnly ? "./src/tui.ts" : "./src/index.ts"
const artifact = tuiOnly ? "tui" : "cli"
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist",
)
if (outdir === dir) throw new Error("--outdir must not be the package directory")
process.chdir(dir)

await rm(outdir, { recursive: true, force: true })

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const plugin = createSolidTransformPlugin()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) return false
      if (item.avx2 === false) return baselineFlag
      return item.abi === undefined
    })
  : allTargets

buildOpentuiNative(targets.some((item) => item.os !== process.platform || item.arch !== process.arch))

for (const item of targets) {
  const target = [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
  const name = target.replace(binary, artifact)
  console.log(`building ${name}`)
  const result = await Bun.build({
    entrypoints: [entrypoint],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: "inline",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
      outfile: path.join(outdir, name, "bin", binary),
      execArgv: [`--user-agent=${binary}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    define: {
      YCODING_VERSION: `'${Script.version}'`,
      YCODING_CLI_NAME: `'${binary}'`,
      YCODING_MODELS_DEV: modelsData,
      YCODING_CHANNEL: `'${Script.channel}'`,
      YCODING_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      // FFF_LIBC selects the fff native lib variant: "musl" or "gnu".
      FFF_LIBC: item.os === "linux" ? `'${item.abi ?? "gnu"}'` : "undefined",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  await Bun.write(
    path.join(outdir, name, "package.json"),
    JSON.stringify(
      {
        name: `@ycoding-ai/${name}`,
        version: Script.version,
        license: "MIT",
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
}
