import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
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
  readonly application: string
  readonly target: string
}

export function computerHelperBuild(target: ComputerHelperTarget, binDirectory: string) {
  if (target.platform !== "darwin") return undefined
  return {
    source: path.resolve(import.meta.dir, "../../core/computer-helper/main.swift"),
    output: path.join(binDirectory, COMPUTER_HELPER_BINARY),
    application: path.join(binDirectory, `${COMPUTER_HELPER_BINARY}.app`),
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
  await mkdir(path.join(plan.application, "Contents", "MacOS"), { recursive: true })
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
<key>CFBundleIdentifier</key><string>app.ycoding.computer-helper</string>
<key>CFBundleName</key><string>YCoding Computer Use</string>
<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>
<key>CFBundleIconFile</key><string>YCoding.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  )
  await copyFile(plan.output, path.join(plan.application, "Contents", "MacOS", COMPUTER_HELPER_BINARY))
  run(["/usr/bin/codesign", "--force", "--sign", "-", plan.application])
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", plan.application])
}

export async function verifyPackagedComputerHelper(binDirectory: string, platform: NodeJS.Platform = process.platform) {
  const helper = path.join(binDirectory, COMPUTER_HELPER_BINARY)
  const application = path.join(binDirectory, `${COMPUTER_HELPER_BINARY}.app`)
  const entries = await readdir(binDirectory)
  if (platform !== "darwin") {
    if (entries.includes(COMPUTER_HELPER_BINARY) || entries.includes(path.basename(application)))
      throw new Error(`Unexpected macOS computer helper: ${helper}`)
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
  if (!entries.includes(path.basename(application))) throw new Error(`Computer helper application missing: ${application}`)
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
