import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"

export const COMPUTER_HELPER_BINARY = MacOSComputer.helperBinary
export const COMPUTER_HELPER_APPLICATION = MacOSComputer.helperApplication

export interface ComputerHelperTarget {
  readonly platform: NodeJS.Platform
  readonly arch: "arm64" | "x64"
}

interface ComputerHelperBuild {
  readonly source: string
  readonly bridgingHeader: string
  readonly application: string
  readonly target: string
}

export function computerHelperBuild(target: ComputerHelperTarget, binDirectory: string) {
  if (target.platform !== "darwin") return undefined
  return {
    source: path.resolve(import.meta.dir, "../../core/computer-use/main.swift"),
    bridgingHeader: path.resolve(import.meta.dir, "../../core/computer-use/CGVirtualDisplay.h"),
    application: path.join(binDirectory, COMPUTER_HELPER_APPLICATION),
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
  const plan = computerHelperBuild({ platform: "darwin", arch }, path.dirname(MacOSComputer.applicationPath(process.execPath)))
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
  return plan.application
}

async function compileComputerHelper(plan: ComputerHelperBuild) {
  await stat(plan.source)
  await rm(plan.application, { recursive: true, force: true })
  await mkdir(path.join(plan.application, "Contents", "MacOS"), { recursive: true })
  run([
    "/usr/bin/xcrun",
    "swiftc",
    "-O",
    "-target",
    plan.target,
    "-import-objc-header",
    plan.bridgingHeader,
    plan.source,
    "-o",
    path.join(plan.application, "Contents", "MacOS", COMPUTER_HELPER_BINARY),
  ])
  await mkdir(path.join(plan.application, "Contents", "Resources"), { recursive: true })
  const iconsetDirectory = await mkdtemp(path.join(os.tmpdir(), "ycoding-icon-"))
  try {
    const iconset = path.join(iconsetDirectory, "YCoding.iconset")
    const source = path.resolve(import.meta.dir, "../../../assets/brand/ycoding-icon-512.png")
    await mkdir(iconset)
    for (const size of [16, 32, 64, 128, 256])
      run([
        "/usr/bin/sips",
        "-z",
        String(size),
        String(size),
        source,
        "--out",
        path.join(iconset, `icon_${size}x${size}.png`),
      ])
    await copyFile(source, path.join(iconset, "icon_512x512.png"))
    for (const size of [16, 32, 128, 256])
      await copyFile(
        path.join(iconset, `icon_${size * 2}x${size * 2}.png`),
        path.join(iconset, `icon_${size}x${size}@2x.png`),
      )
    run([
      "/usr/bin/iconutil",
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(plan.application, "Contents", "Resources", "YCoding.icns"),
    ])
  } finally {
    await rm(iconsetDirectory, { recursive: true, force: true })
  }
  await Bun.write(
    path.join(plan.application, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${COMPUTER_HELPER_BINARY}</string>
<key>CFBundleIdentifier</key><string>app.ycoding.computer-use</string>
<key>CFBundleName</key><string>YCoding Computer Use</string>
<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>
<key>CFBundleIconFile</key><string>YCoding.icns</string>
<key>NSAppleEventsUsageDescription</key><string>YCoding Computer Use controls the iTerm sessions, Finder items, and Safari or Chrome tabs you ask YCoding to operate.</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  )
  run(signingArguments(plan.application))
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", plan.application])
}

// A stable identity keeps macOS privacy grants across rebuilds; an ad-hoc signature changes with every build.
export function signingArguments(application: string, identity = process.env.YCODING_MACOS_SIGNING_IDENTITY) {
  if (!identity) return ["/usr/bin/codesign", "--force", "--sign", "-", application]
  return ["/usr/bin/codesign", "--force", "--sign", identity, "--timestamp", application]
}

export async function verifyPackagedComputerHelper(binDirectory: string, platform: NodeJS.Platform = process.platform) {
  const application = path.join(binDirectory, COMPUTER_HELPER_APPLICATION)
  const entries = await readdir(binDirectory)
  if (platform !== "darwin") {
    if (entries.includes(COMPUTER_HELPER_APPLICATION)) throw new Error(`Unexpected macOS computer helper: ${application}`)
    return
  }
  if (!entries.includes(COMPUTER_HELPER_APPLICATION)) throw new Error(`Computer helper application missing: ${application}`)
  const appInfo = await lstat(application)
  const executable = await lstat(path.join(application, "Contents", "MacOS", COMPUTER_HELPER_BINARY))
  const plist = await lstat(path.join(application, "Contents", "Info.plist"))
  const icon = await lstat(path.join(application, "Contents", "Resources", "YCoding.icns"))
  if (
    !appInfo.isDirectory() ||
    appInfo.isSymbolicLink() ||
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    (executable.mode & 0o111) === 0 ||
    !plist.isFile() ||
    plist.isSymbolicLink() ||
    !icon.isFile() ||
    icon.isSymbolicLink() ||
    icon.size === 0
  )
    throw new Error(`Computer helper application is invalid: ${application}`)
  const metadata = await Bun.file(path.join(application, "Contents", "Info.plist")).text()
  if (
    !metadata.includes("<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>") ||
    !metadata.includes("<key>CFBundleIconFile</key><string>YCoding.icns</string>")
  )
    throw new Error(`Computer helper application metadata is invalid: ${application}`)
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", application])
  await smokeApplication(path.join(application, "Contents", "MacOS", COMPUTER_HELPER_BINARY))
}

async function smokeApplication(executable: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-smoke-"))
  try {
    await writeFile(path.join(directory, "request.json"), "{}")
    const result = Bun.spawnSync(
      [executable, path.join(directory, "request.json"), path.join(directory, "response.json")],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode !== 0)
      throw new Error(`Computer helper smoke failed (${result.exitCode}): ${result.stderr.toString()}`)
    const response: unknown = await Bun.file(path.join(directory, "response.json")).json()
    if (
      typeof response !== "object" ||
      response === null ||
      Reflect.get(response, "status") !== "error" ||
      Reflect.get(response, "code") !== "invalid_request" ||
      Reflect.get(response, "outcome") !== "not_started"
    )
      throw new Error(`Computer helper returned an invalid smoke response: ${JSON.stringify(response)}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
