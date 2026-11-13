import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

export const smokeUnavailable = "electrobun@1.18.1 BrowserWindow unconditionally creates a persist:default BrowserView without partition or incognito support; isolated smoke is unavailable."
export type Entry = { path: string; type: "file" | "dir" | "symlink"; mode: number; size?: number; sha256?: string; target?: string }
export type Tree = { status: "present" | "absent"; entries: Entry[]; digest: string }

export function parseArguments(argv: readonly string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv
  if (args.includes("--smoke")) throw new Error(smokeUnavailable)
  if (args.length !== 1 || !args[0]?.startsWith("--outdir=") || !args[0].slice(9) || args[0].includes("\0"))
    throw new Error("Supply exactly --outdir=<fresh-output-directory>.")
  return { outdir: args[0].slice(9) }
}

export const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
const innerApp = "YCoding Desktop.app"
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

export async function fileDigest(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

export async function fingerprint(root: string): Promise<Tree> {
  const entries: Entry[] = []
  const walk = async (target: string, relative: string) => {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) { entries.push({ path: relative, type: "symlink", mode: 0, target: await fs.readlink(target) }); return }
    if (stat.isFile()) { entries.push({ path: relative, type: "file", mode: stat.mode & 0o7777, size: stat.size, sha256: await fileDigest(target) }); return }
    if (!stat.isDirectory()) throw new Error(`Unsupported special file in artifact: ${relative}`)
    entries.push({ path: relative, type: "dir", mode: stat.mode & 0o7777 })
    for (const name of (await fs.readdir(target)).sort(compare)) await walk(path.join(target, name), relative === "." ? name : path.join(relative, name))
  }
  const top = await fs.lstat(root).catch((error: unknown) => { if (missing(error)) return undefined; throw error })
  if (!top) return { status: "absent", entries, digest: sha("[]") }
  if (top.isSymbolicLink() || (!top.isFile() && !top.isDirectory())) throw new Error(`Artifact root must be a regular file or directory: ${root}`)
  await walk(root, ".")
  entries.sort((a, b) => compare(a.path, b.path))
  return { status: "present", entries, digest: sha(JSON.stringify(entries)) }
}

export async function freshOutput(requested: string, protectedPaths: readonly string[]) {
  const resolved = path.resolve(requested)
  const parent = await fs.realpath(path.dirname(resolved)).catch(() => { throw new Error("The output directory's parent must already exist.") })
  const canonical = path.join(parent, path.basename(resolved))
  for (const target of new Set([resolved, canonical])) {
    try { await fs.lstat(target); throw new Error("The output directory already exists or is a link. Use a fresh path.") }
    catch (error) { if (!missing(error)) throw error }
  }
  for (const target of protectedPaths) {
    const real = await fs.realpath(target).catch(() => path.resolve(target))
    if (overlaps(canonical, real) || overlaps(resolved, path.resolve(target))) throw new Error("The output directory must not overlap the repository or build outputs.")
  }
  return canonical
}

const execute = (file: string, args: readonly string[]) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
})

async function validatePayload(contents: string, validation: string) {
  const resources = path.join(contents, "Resources")
  const metadata = await fs.readFile(path.join(resources, "metadata.json"), "utf8").then((text): { channel?: unknown; hash?: unknown } | undefined => {
    try { return JSON.parse(text) } catch { return undefined }
  }, () => undefined)
  if (!metadata) throw new Error("The stable bundle metadata is missing or invalid.")
  if (metadata.channel !== "stable" || typeof metadata.hash !== "string" || !/^[A-Za-z0-9]+$/.test(metadata.hash)) throw new Error("The stable bundle metadata is missing or invalid.")
  const archive = path.join(resources, `${metadata.hash}.tar.zst`)
  const listing = await execute("/usr/bin/tar", ["-tf", archive]).catch(() => { throw new Error("The stable bundle payload is missing or unreadable.") })
  for (const entry of listing.split("\n").filter(Boolean)) {
    if (path.isAbsolute(entry) || entry.split("/").includes("..") || (entry !== `${innerApp}/` && !entry.startsWith(`${innerApp}/`)))
      throw new Error(`The stable bundle payload contains an unsafe path: ${entry}`)
  }
  await fs.mkdir(validation)
  await execute("/usr/bin/tar", ["-xf", archive, "-C", validation]).catch(() => { throw new Error("The stable bundle payload could not be extracted.") })
  return path.join(validation, innerApp, "Contents/Resources/app/runtime/backend.json")
}

export async function finalizeBuild(input: { desktop: string; output: string; arch: string; prepared: string; version: string; lockfile: string; lockDigest: string; frontend: readonly string[]; command: readonly string[] }) {
  const { desktop, output, prepared } = input
  if (await fileDigest(input.lockfile) !== input.lockDigest) throw new Error("bun.lock changed during the build; it was not restored.")
  if (await fileDigest(path.join(desktop, "runtime/backend.json")) !== prepared) throw new Error("The prepared backend manifest changed during the build.")
  const built = path.join(desktop, "build", `stable-macos-${input.arch}`, "YCoding Desktop.app")
  const validation = path.join(output, "validation")
  const innerManifest = await validatePayload(path.join(built, "Contents"), validation)
  if (await fileDigest(innerManifest).catch(() => "") !== prepared) throw new Error("The built application's backend manifest differs from the prepared manifest.")
  for (const icon of [path.join(built, "Contents/Resources/AppIcon.icns"), path.join(validation, innerApp, "Contents/Resources/AppIcon.icns")]) {
    const stat = await fs.lstat(icon).catch(() => undefined)
    if (!stat?.isFile() || stat.size === 0) throw new Error("The built application is missing its AppIcon.icns. Check the icon.iconset and Electrobun icon conversion.")
  }
  const original = await fingerprint(built)
  const application = path.join(output, "YCoding Desktop.app")
  await fs.cp(built, application, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
  if ((await fingerprint(application)).digest !== original.digest || (await fingerprint(built)).digest !== original.digest) throw new Error("The built application changed or its copy differs.")
  const executable = path.join(application, "Contents/MacOS/launcher")
  const stat = await fs.lstat(executable)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("The built application launcher must be a regular executable.")
  return { application, validation, version: input.version, executable: { path: executable, sha256: await fileDigest(executable) }, manifest: { sha256: prepared }, build: { argv: input.command, status: 0 }, frontend: { argv: input.frontend, status: 0 }, bundle: { sha256: original.digest }, lock: { sha256: input.lockDigest } }
}

export type BuildBoundary = {
  assertSigning(): Promise<void>
  assertToolchain(): Promise<void>
  prepare(): Promise<{ version: string }>
  run(command: readonly string[]): Promise<number>
}

export async function buildDesktop(boundary: BuildBoundary, input: { argv: readonly string[]; desktop: string; bun: string; arch: string }) {
  const { outdir } = parseArguments(input.argv)
  await boundary.assertSigning()
  await boundary.assertToolchain()
  const desktop = path.resolve(input.desktop)
  const repo = path.resolve(desktop, "../..")
  const lockfile = path.join(repo, "bun.lock")
  const lockDigest = await fileDigest(lockfile)
  const targets = ["runtime", "dist", "build", "artifacts"].map((name) => path.join(desktop, name))
  const output = await freshOutput(outdir, [repo, ...targets])
  for (const target of targets) {
    const present = await fs.lstat(target).then(() => true, (error: unknown) => { if (missing(error)) return false; throw error })
    if (present) throw new Error(`Desktop build output already exists: ${target}. Preserve it before building.`)
  }
  const lock = path.join(desktop, ".ycoding-desktop-build.lock")
  const token = crypto.randomUUID()
  await fs.writeFile(lock, token, { flag: "wx" })
  const build = async () => {
    await fs.mkdir(output)
    const version = (await boundary.prepare()).version
    const prepared = await fileDigest(path.join(desktop, "runtime/backend.json"))
    const frontend = [input.bun, "run", "build:frontend"]
    const command = [input.bun, "run", "electrobun", "build", "--env=stable"]
    if (await boundary.run(frontend) !== 0) throw new Error("The frontend build failed.")
    if (await boundary.run(command) !== 0) throw new Error("The Electrobun build failed.")
    return finalizeBuild({ desktop, output, arch: input.arch, prepared, version, lockfile, lockDigest, frontend, command })
  }
  let receipt: Awaited<ReturnType<typeof build>> | undefined
  let failure: unknown
  let failed = false
  try { receipt = await build() } catch (error) { failed = true; failure = error }
  const issues: unknown[] = []
  try {
    if (await fileDigest(lockfile) !== lockDigest) throw new Error("bun.lock changed during the build; it was not restored.")
  } catch (error) { issues.push(error) }
  try {
    if (await fs.readFile(lock, "utf8") !== token) throw new Error("The desktop build lock is not owned by this invocation; it was left in place.")
    await fs.unlink(lock)
  } catch (error) { issues.push(error) }
  if (issues.length) throw new AggregateError(failed ? [failure, ...issues] : issues, issues.map((error) => error instanceof Error ? error.message : "Build verification failed.").join(" "))
  if (failed) throw failure
  if (!receipt) throw new Error("The desktop build produced no receipt.")
  await fs.writeFile(path.join(output, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}
