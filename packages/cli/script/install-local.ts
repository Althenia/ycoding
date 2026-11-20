#!/usr/bin/env bun

import { cp, mkdir, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { BUN_BINARY } from "../src/binary"
import { interactionApplication } from "../src/update/interaction-layout"
import { verifyMacOSInteractionSignature } from "./package-macos-interaction"

export async function installLocalBuild(input: {
  source: string
  destination: string
  platform: NodeJS.Platform
  preserveComputerHelper?: boolean
}, verify = verifyMacOSInteractionSignature) {
  if (input.platform === "win32") throw new Error("install:local supports macOS and Linux")
  if (input.preserveComputerHelper && input.platform !== "darwin") throw new Error("Preserving the Interaction helper requires macOS")
  if (input.preserveComputerHelper) verify(path.join(input.destination, interactionApplication.name), "helper")
  const items = [BUN_BINARY, ...(input.platform === "darwin" && !input.preserveComputerHelper ? [interactionApplication.name] : []), BrowserExtension.directory]
  await Promise.all(items.map((item) => requireBuilt(path.join(input.source, item))))
  const suffix = `.install-${process.pid}-${Date.now()}`
  const staged = items.map((item) => ({
    target: path.join(input.destination, item),
    candidate: path.join(input.destination, `.${item}${suffix}`),
    backup: path.join(input.destination, `.${item}${suffix}.previous`),
    source: path.join(input.source, item),
  }))
  const committed: typeof staged = []
  await mkdir(input.destination, { recursive: true })
  try {
    for (const item of staged) await cp(item.source, item.candidate, { recursive: true, verbatimSymlinks: true })
    if (input.platform === "darwin") {
      verify(path.join(input.destination, `.${BUN_BINARY}${suffix}`), "cli")
      if (!input.preserveComputerHelper) verify(path.join(input.destination, `.${interactionApplication.name}${suffix}`), "helper")
    }
    for (const item of staged) {
      if (await exists(item.target)) await rename(item.target, item.backup)
      committed.push(item)
      await rename(item.candidate, item.target)
    }
    await rm(path.join(input.destination, "ycoding-chrome-extension.crx"), { force: true })
  } catch (error) {
    for (const item of committed.toReversed()) {
      await rm(item.target, { recursive: true, force: true })
      if (await exists(item.backup)) await rename(item.backup, item.target)
    }
    await Promise.all(staged.map((item) => rm(item.candidate, { recursive: true, force: true })))
    throw error
  }
  await Promise.all(staged.map((item) => rm(item.backup, { recursive: true, force: true })))
  return staged.map((item) => item.target)
}

async function requireBuilt(file: string) {
  if (!(await exists(file))) throw new Error(`Missing ${file}; run \`bun run build:tui\` first`)
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

if (import.meta.main) {
  const source = path.resolve(
    import.meta.dir,
    "../../../dist/tui",
    `tui-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    "bin",
  )
  const destination = path.join(os.homedir(), ".local", "bin")
  const preserveComputerHelper = process.argv.includes("--preserve-computer-helper")
  const installed = await installLocalBuild({ source, destination, platform: process.platform, preserveComputerHelper })
  for (const file of installed) console.log(`installed ${file}`)
  if (preserveComputerHelper) console.log(`retained ${path.join(destination, interactionApplication.name)}; release signature verified`)
}
