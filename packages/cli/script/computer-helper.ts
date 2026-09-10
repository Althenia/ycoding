import { chmod, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"

export const COMPUTER_HELPER_BINARY = MacOSComputer.helperBinary

export interface ComputerHelperTarget {
  readonly platform: NodeJS.Platform
  readonly arch: "arm64" | "x64"
}

interface ComputerHelperBuild {
  readonly source: string
  readonly output: string
  readonly target: string
}

export function computerHelperBuild(target: ComputerHelperTarget, binDirectory: string) {
  if (target.platform !== "darwin") return undefined
  return {
    source: path.resolve(import.meta.dir, "../../core/computer-helper/main.swift"),
    output: path.join(binDirectory, COMPUTER_HELPER_BINARY),
    target: `${target.arch === "x64" ? "x86_64" : target.arch}-apple-macosx13.0`,
  }
}

export const computerHelperBuildAvailable = (
  target: ComputerHelperTarget,
  hostPlatform: NodeJS.Platform = process.platform,
) => target.platform !== "darwin" || hostPlatform === "darwin"

export function developmentComputerHelperBuild(
  arch: ComputerHelperTarget["arch"] = computerHelperHostArchitecture(),
): ComputerHelperBuild {
  const plan = computerHelperBuild({ platform: "darwin", arch }, path.dirname(MacOSComputer.developmentHelperPath()))
  if (!plan) throw new Error("Failed to plan the macOS computer helper development build")
  return plan
}

export async function buildComputerHelper(target: ComputerHelperTarget, binDirectory: string) {
  const plan = computerHelperBuild(target, binDirectory)
  if (!plan) return
  if (process.platform !== "darwin") throw new Error("macOS computer helper builds require a macOS host")
  await compileComputerHelper(plan)
}

export async function buildDevelopmentComputerHelper() {
  if (process.platform !== "darwin") throw new Error("macOS computer helper development builds require a macOS host")
  const plan = developmentComputerHelperBuild()
  await compileComputerHelper(plan)
  return plan.output
}

async function compileComputerHelper(plan: ComputerHelperBuild) {
  await stat(plan.source)
  await mkdir(path.dirname(plan.output), { recursive: true })
  run(["/usr/bin/xcrun", "swiftc", "-O", "-target", plan.target, plan.source, "-o", plan.output])
  await chmod(plan.output, 0o755)
  run(["/usr/bin/codesign", "--force", "--sign", "-", plan.output])
  run(["/usr/bin/codesign", "--verify", plan.output])
}

export async function verifyPackagedComputerHelper(binDirectory: string, platform: NodeJS.Platform = process.platform) {
  const helper = path.join(binDirectory, COMPUTER_HELPER_BINARY)
  if (platform !== "darwin") {
    if (await Bun.file(helper).exists()) throw new Error(`Unexpected macOS computer helper: ${helper}`)
    return
  }
  const info = await stat(helper)
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error(`Computer helper is not executable: ${helper}`)
  const result = Bun.spawnSync([helper], { stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0)
    throw new Error(`Computer helper smoke failed (${result.exitCode}): ${result.stderr.toString()}`)
  const response: unknown = JSON.parse(result.stdout.toString())
  if (
    typeof response !== "object" ||
    response === null ||
    Reflect.get(response, "status") !== "error" ||
    Reflect.get(response, "code") !== "invalid_request" ||
    Reflect.get(response, "outcome") !== "not_started"
  )
    throw new Error(`Computer helper returned an invalid smoke response: ${result.stdout.toString()}`)
}

function run(command: readonly string[]) {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return
  throw new Error(`${command[0]} exited with ${result.exitCode}: ${result.stderr.toString()}`)
}

function computerHelperHostArchitecture() {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch
  throw new Error(`Unsupported macOS computer helper development architecture: ${process.arch}`)
}

if (import.meta.main) console.log(await buildDevelopmentComputerHelper())
