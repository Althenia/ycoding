import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { BrowserExtension } from "../packages/core/src/browser/extension"

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"] as const
type Target = typeof targets[number]
const application = "YCoding Computer Use.app"

function payload(target: Target, withApplication: boolean) {
  return [
    target === "windows-x64" ? "ycoding.exe" : "ycoding",
    "ycoding-chrome-extension/",
    "ycoding-chrome-extension/icons/",
    ...BrowserExtension.files.map((file) => `ycoding-chrome-extension/${file}`),
    ...(withApplication ? [
      `${application}/`, `${application}/Contents/`, `${application}/Contents/Info.plist`,
      `${application}/Contents/MacOS/`, `${application}/Contents/MacOS/ycoding-computer-use`,
      `${application}/Contents/Resources/`, `${application}/Contents/Resources/YCoding.icns`,
      `${application}/Contents/_CodeSignature/`, `${application}/Contents/_CodeSignature/CodeResources`,
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

async function validatePayload(directory: string, target: Target) {
  const withApplication = target.startsWith("darwin")
  if (JSON.stringify(await tree(directory)) !== JSON.stringify(payload(target, withApplication)))
    throw new Error("Invalid release payload: unexpected or missing entries")
  for (const file of [target === "windows-x64" ? undefined : "ycoding", withApplication ? `${application}/Contents/MacOS/ycoding-computer-use` : undefined].filter((file) => file !== undefined))
    if (((await fs.stat(path.join(directory, file))).mode & 0o111) === 0) throw new Error(`Invalid release payload: ${file} is not executable`)
  if (!withApplication) return
  const plist = await Bun.file(path.join(directory, application, "Contents/Info.plist")).text()
  for (const [key, value] of [["CFBundleIdentifier", "app.ycoding.computer-use"], ["CFBundleDisplayName", "YCoding Computer Use"], ["CFBundleIconFile", "YCoding.icns"]])
    if (!plist.includes(`<key>${key}</key><string>${value}</string>`)) throw new Error(`Invalid release payload: ${key}`)
}

async function validateArchive(file: string, target: Target, version: string) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error("Invalid release archive file")
  const expected = payload(target, includesApplication(target, version))
  if (process.platform === "win32") {
    const listing = run(["7z", "l", "-slt", file]).split(/\n-{10,}\n/)[1]
    if (!listing) throw new Error("Invalid release archive listing")
    const entries = listing.trim().split(/\n\n+/).map((entry) => {
      const name = /^Path = (.+)$/m.exec(entry)?.[1]?.replaceAll("\\", "/")
      if (!name || /^Symbolic Link =|^Hard Link =/m.test(entry)) throw new Error("Invalid release archive entry")
      return `${name}${/^Folder = \+$/m.test(entry) || /^Attributes = D/m.test(entry) ? "/" : ""}`
    })
    if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) throw new Error("Invalid release archive entries")
    run(["7z", "t", file])
    return
  }
  const zip = target === "windows-x64"
  const names = run(zip ? ["unzip", "-Z1", file] : ["tar", "-tzf", file]).trimEnd().split("\n")
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) throw new Error("Invalid release archive entries")
  const modes = run(zip ? ["unzip", "-Z", "-l", file] : ["tar", "-tzvf", file]).split("\n").filter((line) => /^[bcdhlps-][rwx-]/.test(line))
  if (modes.length !== names.length) throw new Error("Invalid release archive modes")
  for (const [index, name] of names.entries()) {
    const mode = modes[index]!.split(/\s/)[0]!
    if (mode[0] !== (name.endsWith("/") ? "d" : "-")) throw new Error("Invalid release archive entry type")
    if (!zip && (name === "ycoding" || name.endsWith("/ycoding-computer-use")) && !mode.includes("x")) throw new Error("Invalid release archive executable mode")
  }
  if (zip) run(["unzip", "-t", file])
}

async function create(target: Target, version: string, directory: string, output: string) {
  await validatePayload(directory, target)
  await fs.mkdir(output, { recursive: true })
  const file = path.join(output, filename(target, version))
  if (await Bun.file(file).exists()) throw new Error("Release archive already exists")
  const entries = [target === "windows-x64" ? "ycoding.exe" : "ycoding", "ycoding-chrome-extension", ...(includesApplication(target, version) ? [application] : [])]
  run(target === "windows-x64" ? ["7z", "a", "-tzip", "-mm=Deflate", file, ...entries] : ["tar", "-czf", file, ...entries], directory)
  await validateArchive(file, target, version)
  console.log(`Prepared ${filename(target, version)}`)
}

async function finalize(version: string, directory: string, output: string) {
  const expected = targets.map((target) => filename(target, version))
  if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify([...expected].sort())) throw new Error("Expected exactly four release archives")
  await fs.mkdir(output, { recursive: true })
  if ((await fs.readdir(output)).length !== 0) throw new Error("Release output must be empty")
  for (const target of targets) await validateArchive(path.join(directory, filename(target, version)), target, version)
  for (const name of expected) await fs.copyFile(path.join(directory, name), path.join(output, name))
  for (const name of ["LICENSE", "NOTICE"]) await fs.copyFile(path.join(import.meta.dir, "..", name), path.join(output, name))
  const checksums = await Promise.all([...expected, "LICENSE", "NOTICE"].map(async (name) => `${createHash("sha256").update(new Uint8Array(await Bun.file(path.join(output, name)).arrayBuffer())).digest("hex")}  ${name}\n`))
  await Bun.write(path.join(output, `ycoding-${version}-checksums.txt`), checksums.join(""))
  console.log("Validated four release archives and all six asset checksums")
}

await main()

async function main() {
  const args = process.argv.slice(2)
  const version = args[args[0] === "create" ? 2 : 1]
  if (!version || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error("Invalid release version")
  if (args[0] === "create" && args.length === 5) {
    const target = targets.find((target) => target === args[1])
    if (!target) throw new Error("Invalid release target")
    await create(target, version, path.resolve(args[3]!), path.resolve(args[4]!))
    return
  }
  if (args[0] === "finalize" && args.length === 4) {
    await finalize(version, path.resolve(args[2]!), path.resolve(args[3]!))
    return
  }
  throw new Error("Use create <target> <version> <source> <output> or finalize <version> <source> <output>")
}
