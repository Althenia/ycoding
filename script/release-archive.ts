import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { BrowserExtension } from "../packages/core/src/browser/extension"
import { interactionApplication, interactionExtensionDirectory, interactionExtensionFiles, usesAppleSiliconRelease, usesInteractionLayout, usesNativeReleaseLayout } from "../packages/cli/src/update/interaction-layout"

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"] as const
type Target = typeof targets[number]
const computerUseApplication = {
  name: "YCoding Computer Use.app",
  executable: "ycoding-computer-use",
  identifier: "app.ycoding.computer-use",
  displayName: "YCoding Computer Use",
}
const desktopApplication = "YCoding Desktop.app"

function payload(binary: string, withApplication: boolean, version: string) {
  const interaction = usesInteractionLayout(version)
  const app = interaction ? interactionApplication : computerUseApplication
  const extension = interaction ? interactionExtensionFiles : BrowserExtension.files
  return [
    binary,
    `${interactionExtensionDirectory}/`,
    ...extension.map((file) => `${interactionExtensionDirectory}/${file}`),
    ...new Set(extension.filter((file) => file.includes("/")).map((file) => `${interactionExtensionDirectory}/${file.slice(0, file.lastIndexOf("/"))}/`)),
    ...(withApplication ? [
      `${app.name}/`, `${app.name}/Contents/`, `${app.name}/Contents/Info.plist`,
      `${app.name}/Contents/MacOS/`, `${app.name}/Contents/MacOS/${app.executable}`,
      `${app.name}/Contents/Resources/`, `${app.name}/Contents/Resources/YCoding.icns`,
      `${app.name}/Contents/_CodeSignature/`, `${app.name}/Contents/_CodeSignature/CodeResources`,
    ] : []),
  ].sort()
}

function includesApplication(target: Target, version: string) {
  if (!target.startsWith("darwin")) return false
  const core = version.split("+")[0]!
  const numbers = core.split("-")[0]!.split(".").map(Number)
  return numbers[0]! > 0 || numbers[1]! > 7 || (numbers[1] === 7 && (numbers[2]! > 1 || (numbers[2] === 1 && !core.includes("-"))))
}

function filename(target: Target, version: string) {
  return `ycoding-${version}-${target}.${target === "windows-x64" ? "zip" : "tar.gz"}`
}

function executable(target: Target) {
  return target === "windows-x64" ? "ycoding.exe" : "ycoding"
}

function archiveExecutable(target: Target, version: string) {
  return target !== "windows-x64" && usesNativeReleaseLayout(version) ? "ycoding-native" : executable(target)
}

function desktopFilename(version: string) {
  return `YCoding-Desktop-v${version}-darwin-arm64.zip`
}

function releaseTargets(version: string): readonly Target[] {
  return usesAppleSiliconRelease(version) ? ["darwin-arm64"] : targets
}

export function releaseArchives(version: string) {
  return [...releaseTargets(version).map((target) => filename(target, version)), desktopFilename(version)]
}

function desktopPayload(hash: string) {
  return ["", "Contents/", "Contents/Frameworks/", "Contents/Info.plist", "Contents/MacOS/", "Contents/MacOS/launcher", "Contents/Resources/", "Contents/Resources/AppIcon.icns", "Contents/Resources/metadata.json", `Contents/Resources/${hash}.tar.zst`, "Contents/_CodeSignature/", "Contents/_CodeSignature/CodeResources"]
    .map((entry) => `${desktopApplication}/${entry}`)
    .sort()
}

function desktopHash(metadata: string, plist: string) {
  const parsed: unknown = (() => { try { return JSON.parse(metadata) } catch { return undefined } })()
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid desktop release payload: metadata")
  const fields = parsed as Record<string, unknown>
  if (fields.identifier !== "app.ycoding.desktop" || fields.name !== "YCoding Desktop" || fields.channel !== "stable" || typeof fields.hash !== "string" || !/^[0-9a-z]+$/.test(fields.hash))
    throw new Error("Invalid desktop release payload: metadata")
  for (const [key, value] of [["CFBundleIdentifier", "app.ycoding.desktop"], ["CFBundleExecutable", "launcher"], ["CFBundleIconFile", "AppIcon"]] as const)
    if (!new RegExp(`<key>${key}</key>\\s*<string>${value.replaceAll(".", "\\.")}</string>`).test(plist)) throw new Error(`Invalid desktop release payload: ${key}`)
  return fields.hash
}

function run(command: string[], cwd?: string) {
  const result = Bun.spawnSync(command, { cwd, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`Release archive command failed (${command[0]}): ${result.stderr.toString().slice(0, 2000)}`)
  return result.stdout.toString().replaceAll("\r\n", "\n")
}

async function tree(directory: string, prefix = ""): Promise<string[]> {
  return (await Promise.all((await fs.readdir(directory)).map(async (name) => {
    const relative = `${prefix}${name}`
    const info = await fs.lstat(path.join(directory, name))
    if (info.isDirectory()) return [`${relative}/`, ...await tree(path.join(directory, name), `${relative}/`)]
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Invalid release payload: ${relative}`)
    return [relative]
  }))).flat().sort()
}

async function validatePayload(directory: string, target: Target, version: string) {
  const withApplication = target.startsWith("darwin")
  const app = usesInteractionLayout(version) ? interactionApplication : computerUseApplication
  if (JSON.stringify(await tree(directory)) !== JSON.stringify(payload(executable(target), withApplication, version)))
    throw new Error("Invalid release payload: unexpected or missing entries")
  for (const file of [target === "windows-x64" ? undefined : "ycoding", withApplication ? `${app.name}/Contents/MacOS/${app.executable}` : undefined].filter((file) => file !== undefined))
    if (((await fs.stat(path.join(directory, file))).mode & 0o111) === 0) throw new Error(`Invalid release payload: ${file} is not executable`)
  if (!withApplication) return
  const plist = await Bun.file(path.join(directory, app.name, "Contents/Info.plist")).text()
  for (const [key, value] of [["CFBundleIdentifier", app.identifier], ["CFBundleDisplayName", app.displayName], ["CFBundleIconFile", "YCoding.icns"]])
    if (!plist.includes(`<key>${key}</key><string>${value}</string>`)) throw new Error(`Invalid release payload: ${key}`)
}

async function validateArchive(file: string, target: Target, version: string) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error("Invalid release archive file")
  const binary = archiveExecutable(target, version)
  const expected = payload(binary, includesApplication(target, version), version)
  const zip = target === "windows-x64"
  if (zip && process.platform === "win32") {
    const [header, listing] = run(["7z", "l", "-slt", file]).split(/\n-{10,}\n/)
    if (!listing || !/^Type = zip$/m.test(header!)) throw new Error("Invalid release archive listing")
    const entries = listing.trim().split(/\n\n+/).map((entry) => {
      const name = /^Path = (.+)$/m.exec(entry)?.[1]
      const folder = /^Folder = \+$/m.test(entry) || /^Attributes = D/m.test(entry)
      if (!name || /^Symbolic Link =|^Hard Link =|^Attributes = .*\blrwx/m.test(entry) ||
        !folder && !/^Size = [1-9]\d*$/m.test(entry)) throw new Error("Invalid release archive entry")
      return `${name.replaceAll("\\", "/").replace(/\/$/, "")}${folder ? "/" : ""}`
    })
    if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) throw new Error("Invalid release archive entries")
    run(["7z", "t", file])
    return
  }
  const names = run(zip ? ["unzip", "-Z1", file] : ["tar", "-tzf", file]).trimEnd().split("\n")
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) throw new Error("Invalid release archive entries")
  const modes = run(zip ? ["unzip", "-Z", "-l", file] : ["tar", "-tzvf", file]).split("\n").filter((line) => /^[bcdhlps-][rwx-]/.test(line))
  if (modes.length !== names.length) throw new Error("Invalid release archive modes")
  for (const [index, name] of names.entries()) {
    const mode = modes[index]!.split(/\s/)[0]!
    if (mode[0] !== (name.endsWith("/") ? "d" : "-")) throw new Error("Invalid release archive entry type")
    if (!zip && (name === binary || name.includes("/Contents/MacOS/") && !name.endsWith("/")) && !mode.includes("x")) throw new Error("Invalid release archive executable mode")
    if (zip && !name.endsWith("/") && !(Number(modes[index]!.trim().split(/\s+/)[3]) > 0)) throw new Error("Invalid release archive empty entry")
  }
  if (zip) run(["unzip", "-t", file])
}

async function validateDesktopPayload(app: string) {
  if (path.basename(app) !== desktopApplication) throw new Error("Invalid desktop release payload: application name")
  const contents = path.join(app, "Contents")
  const hash = desktopHash(await Bun.file(path.join(contents, "Resources/metadata.json")).text().catch(() => ""), await Bun.file(path.join(contents, "Info.plist")).text().catch(() => ""))
  const entries = [`${desktopApplication}/`, ...(await tree(app)).map((entry) => `${desktopApplication}/${entry}`)].sort()
  if (JSON.stringify(entries) !== JSON.stringify(desktopPayload(hash))) throw new Error("Invalid desktop release payload: unexpected or missing entries")
  if (((await fs.stat(path.join(contents, "MacOS/launcher"))).mode & 0o111) === 0) throw new Error("Invalid desktop release payload: launcher is not executable")
}

async function validateDesktopArchive(file: string) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error("Invalid desktop release archive file")
  const names = run(["unzip", "-Z1", file]).trimEnd().split("\n")
  const hash = desktopHash(run(["unzip", "-p", file, `${desktopApplication}/Contents/Resources/metadata.json`]), run(["unzip", "-p", file, `${desktopApplication}/Contents/Info.plist`]))
  if (JSON.stringify([...names].sort()) !== JSON.stringify(desktopPayload(hash))) throw new Error("Invalid desktop release archive entries")
  const modes = run(["unzip", "-Z", "-l", file]).split("\n").filter((line) => /^[bcdhlps-][rwx-]/.test(line))
  if (modes.length !== names.length) throw new Error("Invalid desktop release archive modes")
  for (const [index, name] of names.entries()) {
    const mode = modes[index]!.split(/\s/)[0]!
    if (mode[0] !== (name.endsWith("/") ? "d" : "-")) throw new Error("Invalid desktop release archive entry type")
    if (name.endsWith("/MacOS/launcher") && !mode.includes("x")) throw new Error("Invalid desktop release archive executable mode")
  }
  run(["unzip", "-t", file])
}

async function createDesktop(version: string, app: string, output: string) {
  await validateDesktopPayload(app)
  await fs.mkdir(output, { recursive: true })
  const file = path.join(output, desktopFilename(version))
  if (await Bun.file(file).exists()) throw new Error("Release archive already exists")
  run(["ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--keepParent", app, file])
  await validateDesktopArchive(file)
  console.log(`Prepared ${desktopFilename(version)}`)
}

async function create(target: Target, version: string, directory: string, output: string) {
  await validatePayload(directory, target, version)
  await fs.mkdir(output, { recursive: true })
  const file = path.join(output, filename(target, version))
  if (await Bun.file(file).exists()) throw new Error("Release archive already exists")
  const app = usesInteractionLayout(version) ? interactionApplication : computerUseApplication
  const binary = archiveExecutable(target, version)
  const entries = [interactionExtensionDirectory, ...(includesApplication(target, version) ? [app.name] : [])]
  if (binary !== executable(target)) {
    const staging = await fs.mkdtemp(path.join(output, ".native-release-"))
    try {
      await fs.copyFile(path.join(directory, executable(target)), path.join(staging, binary))
      run(["tar", "-czf", file, "-C", staging, binary, "-C", directory, ...entries])
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  } else {
    run(target !== "windows-x64" ? ["tar", "-czf", file, binary, ...entries]
      : process.platform === "win32" ? ["7z", "a", "-tzip", "-mm=Deflate", file, binary, ...entries]
      : ["zip", "-qr", file, binary, ...entries], directory)
  }
  await validateArchive(file, target, version)
  console.log(`Prepared ${filename(target, version)}`)
}

async function finalize(version: string, directory: string, output: string) {
  const expected = releaseArchives(version)
  if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`Expected exactly ${expected.length} release archives for ${version}`)
  await fs.mkdir(output, { recursive: true })
  if ((await fs.readdir(output)).length !== 0) throw new Error("Release output must be empty")
  for (const target of releaseTargets(version)) await validateArchive(path.join(directory, filename(target, version)), target, version)
  await validateDesktopArchive(path.join(directory, desktopFilename(version)))
  for (const name of expected) await fs.copyFile(path.join(directory, name), path.join(output, name))
  for (const name of ["LICENSE", "NOTICE"]) await fs.copyFile(path.join(import.meta.dir, "..", name), path.join(output, name))
  const checksums = await Promise.all([...expected, "LICENSE", "NOTICE"].map(async (name) => `${createHash("sha256").update(new Uint8Array(await Bun.file(path.join(output, name)).arrayBuffer())).digest("hex")}  ${name}\n`))
  await Bun.write(path.join(output, `ycoding-${version}-checksums.txt`), checksums.join(""))
  console.log(`Validated ${expected.length} release archives and all ${checksums.length} asset checksums`)
}

if (import.meta.main) await main()

async function main() {
  const args = process.argv.slice(2)
  const version = args[args[0] === "create" || args[0] === "executable" ? 2 : 1]
  if (!version || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error("Invalid release version")
  if ((args[0] === "create" && args.length === 5) || (args[0] === "executable" && args.length === 3)) {
    const target = targets.find((target) => target === args[1])
    if (!target) throw new Error("Invalid release target")
    if (!releaseTargets(version).includes(target)) throw new Error(`YCoding ${version} release archives are Apple Silicon only`)
    if (args[0] === "executable") console.log(archiveExecutable(target, version))
    else await create(target, version, path.resolve(args[3]!), path.resolve(args[4]!))
    return
  }
  if (args[0] === "create-desktop" && args.length === 4) {
    await createDesktop(version, path.resolve(args[2]!), path.resolve(args[3]!))
    return
  }
  if (args[0] === "finalize" && args.length === 4) {
    await finalize(version, path.resolve(args[2]!), path.resolve(args[3]!))
    return
  }
  throw new Error("Use executable <target> <version>, create <target> <version> <source> <output>, create-desktop <version> <application> <output> or finalize <version> <source> <output>")
}
