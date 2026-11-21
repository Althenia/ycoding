#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, cp, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { build, mergeConfig } from "vite"
import { Script } from "@ycoding-ai/script"
import pkg from "../package.json"
import { modelsData } from "./generate"
import { collectNodeAssets, copyNodeAssets, hashNodeAssets, seaAssetMap } from "./node-assets"
import { mainConfig } from "../vite.node.config"
import { nodeExecArgv, nodeTarget, type NodeTarget } from "../src/node/target"
import { NODE_BINARY, platformBinary } from "../src/binary"
import { computerHelperBuildAvailable } from "./computer-use"
import { packageMacOSInteraction, verifyMacOSInteractionPackage } from "./package-macos-interaction"
import { copyChromeExtension } from "./chrome-extension"
import { buildRuntime } from "./runtime"
import { nativeBuildTarget } from "./native-target"
import { pluginSDKAssetConfig, pluginSDKAssetKey, runtimeAssetKey } from "./runtime-asset"
import { buildUserAppLibrary, buildUserAppPackage, userAppPackageMetadata } from "./user-app-package"
import { interactionApplication } from "../src/update/interaction-layout"

const NODE_VERSION = "26.4.0"
const dir = path.resolve(import.meta.dirname, "..")
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist",
)
if (outdir === dir) throw new Error("--outdir must not be the package directory")
if (outdir === path.join(dir, "dist-node")) {
  throw new Error("--outdir must not be dist-node because it contains temporary files")
}
const bundleOnly = process.argv.includes("--bundle-only")
const skipInstall = process.argv.includes("--skip-install")
const targetArgs = process.argv.filter((arg) => arg.startsWith("--target="))
if (targetArgs.length > 1) throw new Error("Target must be specified once")
const requested = targetArgs[0]?.slice("--target=".length)
const selected = nativeBuildTarget({ os: process.platform, arch: process.arch, target: requested })
const target = nodeTarget(selected.os, selected.arch)
if (!bundleOnly && target.platform === "darwin" && target.arch === "x64") {
  throw new Error("Node 26.4 SEA does not support macOS x64")
}
if (!bundleOnly && !computerHelperBuildAvailable(target, process.platform))
  throw new Error("A complete artifact requires a matching native host")
const targets = [target]
const { PluginSDKAsset } = await import("./plugin-sdk")

process.chdir(dir)
if (!skipInstall) run(process.execPath, ["install", "--os=*", "--cpu=*"])
if (!bundleOnly) await rm(outdir, { recursive: true, force: true })
const builder =
  !bundleOnly || targets.some((target) => target.platform === process.platform && target.arch === process.arch)
    ? await resolveHostNode()
    : undefined

const pluginSDKAsset = await PluginSDKAsset.build(path.resolve(dir, "../.."), outdir)
try {
  for (const target of targets) {
    console.log(`building cli-node-${targetName(target)}`)
    const runtimeAsset = await buildRuntime({ os: target.platform, arch: target.arch })
    try {
      const assets = [
        ...(await collectNodeAssets(target)),
        { key: runtimeAssetKey, source: runtimeAsset.path },
        { key: pluginSDKAssetKey, source: pluginSDKAsset.path },
      ]
      await rm("dist-node", { recursive: true, force: true })
      const assetHash = await hashNodeAssets(assets)
      const input = {
        version: Script.version,
        channel: Script.channel,
        models: modelsData,
        assetHash,
        target,
        runtimeAsset,
      }
      await build(mergeConfig(mainConfig(input), pluginSDKAssetConfig(pluginSDKAsset)))
      await copyNodeAssets(assets)
      if (bundleOnly)
        await buildUserAppLibrary({
          directory: path.resolve(dir, "dist-node/lib"),
          version: Script.version,
          channel: Script.channel,
          runtimeAsset,
          pluginSDKAsset,
        })

      const host = target.platform === process.platform && target.arch === process.arch
      if (host) {
        if (!builder) throw new Error("Node SEA builder is unavailable")
        run(builder, [...nodeExecArgv, "dist-node/ycoding.mjs", "--version"])
        run(builder, [...nodeExecArgv, "dist-node/ycoding.mjs", "--help"])
      }
      if (bundleOnly) continue

      const name = `cli-node-${targetName(target)}`
      const binary = platformBinary(NODE_BINARY, target.platform)
      const output = path.join(outdir, name, "bin", binary)
      if (!builder) throw new Error("Node SEA builder is unavailable")
      await mkdir(path.dirname(output), { recursive: true })
      const config = {
        main: "dist-node/ycoding.mjs",
        mainFormat: "module",
        executable: await resolveTargetNode(target, builder),
        output: path.relative(dir, output),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgv: nodeExecArgv,
        execArgvExtension: "none",
        assets: await seaAssetMap(),
      }
      await writeFile("dist-node/sea.json", `${JSON.stringify(config, null, 2)}\n`)
      run(builder, ["--build-sea", "dist-node/sea.json"])
      if (target.platform !== "win32") await chmod(output, 0o755)
      if (target.platform === "darwin") await packageMacOSInteraction(output, target.arch)
      await copyChromeExtension(path.dirname(output))
      await buildUserAppPackage({
        directory: path.join(outdir, name, "lib"),
        packageDirectory: dir,
        selection: { requested, targets: targets.map((target) => ({ os: target.platform, arch: target.arch })) },
        frontend: output,
        os: target.platform,
        arch: target.arch,
        version: Script.version,
        channel: Script.channel,
        runtimeAsset,
        pluginSDKAsset,
      })
      await writeFile(
        path.join(outdir, name, "package.json"),
        `${JSON.stringify(
          {
            name: `@ycoding-ai/${name}`,
            version: Script.version,
            license: pkg.license,
            os: [target.platform],
            cpu: [target.arch],
            ...userAppPackageMetadata(true),
          },
          null,
          2,
        )}\n`,
      )
      if (host) await smoke(output, target)
    } finally {
      await runtimeAsset.dispose()
    }
  }
} finally {
  await rm(path.dirname(pluginSDKAsset.path), { recursive: true, force: true })
}

async function resolveHostNode() {
  const candidates = [process.env.NODE_BIN, "node"].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-p", "JSON.stringify({version:process.versions.node,path:process.execPath})"],
      {
        encoding: "utf8",
      },
    )
    if (result.status !== 0) continue
    const info = JSON.parse(result.stdout) as { version: string; path: string }
    if (info.version === NODE_VERSION) return realpath(info.path)
  }
  return resolveTargetNode(nodeTarget(process.platform, process.arch))
}

async function resolveTargetNode(target: NodeTarget, host?: string) {
  if (host && target.platform === process.platform && target.arch === process.arch) return host
  const cache = path.resolve(dir, ".cache", "node")
  const platform = target.platform === "win32" ? "win" : target.platform
  const archiveName = `node-v${NODE_VERSION}-${platform}-${target.arch}`
  const targetDirectory = path.join(cache, archiveName)
  const executable = path.join(targetDirectory, target.platform === "win32" ? "node.exe" : "bin/node")
  if (
    (await stat(executable).then(
      () => true,
      () => false,
    )) &&
    (await stat(path.join(targetDirectory, ".verified")).then(
      () => true,
      () => false,
    ))
  )
    return realpath(executable)
  await mkdir(cache, { recursive: true })
  const extension = target.platform === "win32" ? "zip" : "tar.gz"
  const filename = `${archiveName}.${extension}`
  const archive = path.join(cache, filename)
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`
  const [response, sums] = await Promise.all([fetch(`${base}/${filename}`), fetch(`${base}/SHASUMS256.txt`)])
  if (!response.ok) throw new Error(`Failed to download Node ${NODE_VERSION}: ${response.status}`)
  if (!sums.ok) throw new Error(`Failed to download Node ${NODE_VERSION} checksums: ${sums.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Missing checksum for ${filename}`)
  if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error(`Checksum mismatch for ${filename}`)
  await writeFile(archive, data)
  const temporary = path.join(cache, `${archiveName}.${process.pid}.tmp`)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary)
  if (target.platform !== "win32") run("tar", ["-xzf", archive, "-C", temporary])
  if (target.platform === "win32" && process.platform === "win32") {
    run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", temporary])
  }
  if (target.platform === "win32" && process.platform !== "win32") run("unzip", ["-q", archive, "-d", temporary])
  await rm(targetDirectory, { recursive: true, force: true })
  await rename(path.join(temporary, archiveName), targetDirectory)
  await writeFile(path.join(targetDirectory, ".verified"), `${expected}\n`)
  await rm(temporary, { recursive: true, force: true })
  await rm(archive, { force: true })
  return realpath(executable)
}

async function smoke(output: string, target: NodeTarget) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-node-smoke-"))
  const executable = path.join(root, path.basename(output))
  try {
    await cp(output, executable)
    if (target.platform === "darwin") {
      const app = interactionApplication.name
      await cp(path.join(path.dirname(output), app), path.join(root, app), { recursive: true })
      verifyMacOSInteractionPackage(executable)
    }
    if (process.platform !== "win32") await chmod(executable, 0o755)
    run(executable, ["--version"], root)
    run(executable, ["--help"], root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function targetName(target: NodeTarget) {
  return `${target.platform === "win32" ? "windows" : target.platform}-${target.arch}`
}

function run(command: string, args: readonly string[], cwd = dir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`)
}
