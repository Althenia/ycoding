import { mkdir } from "node:fs/promises"
import path from "node:path"
import { macOSInteractionApplication, macOSInteractionBundleID, macOSInteractionExecutable } from "@ycoding-ai/core/interaction/macos"
import { interactionSigningSHA1 } from "../src/update/interaction-layout"

const sources = path.resolve(import.meta.dir, "../../core/interaction-macos")
const icon = path.resolve(import.meta.dir, "../../../assets/brand/ycoding-icon-512.png")

function run(command: string[]) {
  const result = Bun.spawnSync(command, {
    env: Object.fromEntries(Object.entries({ HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: "C" })
      .flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  if (result.success) return
  const diagnostics = result.stderr.toString().split("\n").filter((line) => /\/interaction-macos\/[^/:]+\.swift:\d+:\d+: (?:warning|error):/.test(line))
  for (const diagnostic of diagnostics.slice(0, 15)) console.error(diagnostic)
  throw new Error(`${path.basename(command[0])} exited ${result.exitCode}`)
}

export async function buildInteractionMacOS(application: string, identity: string, arch = process.arch) {
  if (process.platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) throw new Error("A supported macOS host is required")
  if (!path.isAbsolute(application) || path.basename(application) !== macOSInteractionApplication || !identity || identity === "-") {
    throw new Error(`Supply a new absolute ${macOSInteractionApplication} path and an existing stable signing identity`)
  }
  await mkdir(application, { mode: 0o700 })
  const contents = path.join(application, "Contents")
  const macOS = path.join(contents, "MacOS")
  const resources = path.join(contents, "Resources")
  await mkdir(macOS, { recursive: true })
  await mkdir(resources)
  run(["/usr/bin/xcrun", "swiftc", "-O", "-target", `${arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
    ...["Fence.swift", "WindowHost.swift", "ControlPanel.swift", "Service.swift"].map((name) => path.join(sources, name)),
    "-o", path.join(macOS, macOSInteractionExecutable)])
  run(["/usr/bin/sips", "-s", "format", "icns", icon, "--out", path.join(resources, "YCoding.icns")])
  await Bun.write(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${macOSInteractionBundleID}</string>
<key>CFBundleExecutable</key><string>${macOSInteractionExecutable}</string>
<key>CFBundleName</key><string>YCoding Interaction</string>
<key>CFBundleDisplayName</key><string>YCoding Interaction</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>YCoding.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`)
  run(["/usr/bin/codesign", "--sign", identity, "--options", "runtime", "--timestamp=none", application])
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", application])
  if (identity.toLowerCase() === interactionSigningSHA1) run(["/usr/bin/codesign", "--verify", "--strict", "-R",
    `=identifier "${macOSInteractionBundleID}" and certificate leaf = H"${interactionSigningSHA1}"`, application])
  return application
}

if (import.meta.main) {
  const application = process.argv[2]
  const identity = process.argv[3] ?? interactionSigningSHA1
  if (!application || !identity || process.argv.length > 4) throw new Error("Usage: build-interaction-macos.ts <absolute app path> [development signing identity]")
  console.log(await buildInteractionMacOS(application, identity))
}
