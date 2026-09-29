#!/usr/bin/env bun

import { cp, mkdir, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { BUN_BINARY } from "../src/binary"
import { COMPUTER_HELPER_APPLICATION } from "./computer-use"

export async function installLocalBuild(input: { source: string; destination: string; platform: NodeJS.Platform }) {
  if (input.platform === "win32") throw new Error("install:local supports macOS and Linux")
  const items = [BUN_BINARY, ...(input.platform === "darwin" ? [COMPUTER_HELPER_APPLICATION] : []), BrowserExtension.directory]
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
    if (input.platform === "darwin") verifySignature(path.join(input.destination, `.${COMPUTER_HELPER_APPLICATION}${suffix}`))
    for (const item of staged) {
      if (await exists(item.target)) await rename(item.target, item.backup)
      committed.push(item)
      await rename(item.candidate, item.target)
    }
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

function verifySignature(application: string) {
  const result = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", application])
  if (result.exitCode !== 0) throw new Error(`Computer helper app signature verification failed: ${result.stderr.toString().trim()}`)
}

export function computerHelperSigningNotice(application: string) {
  const result = Bun.spawnSync(["/usr/bin/codesign", "-dvv", application])
  if (result.exitCode !== 0) throw new Error(`Failed to read the signature of ${application}: ${result.stderr.toString().trim()}`)
  return signingNotice(result.stderr.toString())
}

export function signingNotice(details: string) {
  if (/^Signature=adhoc$/m.test(details))
    return "The computer helper app is ad-hoc signed and each build has a different code requirement: remove old YCoding Computer Use entries in Privacy & Security and allow the new one when prompted."
  const authority = /^Authority=(.+)$/m.exec(details)?.[1] ?? "a code-signing certificate"
  return `The computer helper app is signed by ${authority}; macOS decides whether existing YCoding Computer Use grants in Privacy & Security apply to this build.`
}

if (import.meta.main) {
  const source = path.resolve(
    import.meta.dir,
    "../../../dist/tui",
    `tui-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    "bin",
  )
  const destination = path.join(os.homedir(), ".local", "bin")
  const installed = await installLocalBuild({ source, destination, platform: process.platform })
  for (const file of installed) console.log(`installed ${file}`)
  if (process.platform === "darwin") console.log(computerHelperSigningNotice(path.join(destination, COMPUTER_HELPER_APPLICATION)))
}
