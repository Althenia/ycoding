import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

export type Kind = "file" | "dir" | "symlink" | "other"
export type Info = { readonly kind: Kind; readonly mode: number; readonly size: number }
export type Files = {
  info(target: string): Promise<Info | undefined>
  list(target: string): Promise<string[]>
  link(target: string): Promise<string>
  digest(target: string): Promise<string>
  real(target: string): Promise<string>
  text(target: string): Promise<string>
}
export type Entry = {
  readonly path: string
  readonly type: "dir" | "file" | "symlink"
  readonly mode: number
  readonly size?: number
  readonly sha256?: string
  readonly target?: string
}
export type Tree = { readonly status: "absent" | "present"; readonly entries: readonly Entry[]; readonly digest: string }
export type Artifact = { readonly label: string; readonly source: string }
export type Preserved = {
  readonly label: string
  readonly source: string
  readonly backup: string
  readonly status: "absent" | "verified"
  readonly count: number
  readonly digest: string
  readonly entries: readonly Entry[]
}
export type Manifest = { readonly verification: string; readonly artifacts: readonly Preserved[] }
export type Metadata = { readonly target: string; readonly workspace: string }
export type Options = { readonly outdir: string; readonly isolatedSmoke: boolean }
export type Boundary = {
  readonly files: Files
  readonly assertSigning: () => Promise<void>
  readonly metadata: () => Promise<Metadata>
  readonly lock: (file: string, token: string) => Promise<void>
  readonly unlock: (file: string, token: string) => Promise<void>
  readonly mkdir: (target: string) => Promise<void>
  readonly mkdirs: (target: string) => Promise<void>
  readonly copy: (from: string, to: string) => Promise<void>
  readonly write: (target: string, text: string) => Promise<void>
  readonly prepare: (output: string) => Promise<{ readonly version: string }>
  readonly tauri: (command: readonly string[]) => Promise<number>
}

export const metadataCommand = ["cargo", "metadata", "--offline", "--locked", "--format-version", "1", "--no-deps"] as const

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const bytewise = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right))
const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"

export function parseArguments(argv: readonly string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv
  let outdir: string | undefined
  let isolatedSmoke = false
  for (const arg of args) {
    if (arg.startsWith("--outdir=")) {
      const value = arg.slice("--outdir=".length)
      if (outdir !== undefined) throw new Error("Supply --outdir exactly once.")
      if (!value || value.includes("\0")) throw new Error("Supply a non-empty fresh path after --outdir=.")
      outdir = value
    } else if (arg === "--smoke") {
      if (isolatedSmoke) throw new Error("Supply --smoke at most once.")
      isolatedSmoke = true
    } else {
      throw new Error(`Unsupported desktop build argument: ${arg.split("=")[0]}. Only --outdir=<fresh-output-directory> and --smoke are accepted.`)
    }
  }
  if (outdir === undefined) throw new Error("Supply --outdir=<fresh-output-directory> for the desktop build receipt and app copy.")
  return { outdir, isolatedSmoke }
}

export function tauriCommand(execPath: string, isolatedSmoke: boolean, config?: string) {
  if (isolatedSmoke ? config === undefined || !path.isAbsolute(config) : config !== undefined) throw new Error("An isolated-smoke build needs an absolute overlay config; a default build takes none.")
  return [execPath, "run", "tauri", "build", "--bundles", "app", "--no-sign", ...(isolatedSmoke && config !== undefined ? ["--features", "isolated-smoke", "--config", config] : []), "--", "--offline", "--locked"] as const
}

const smokeIdentifierPattern = /^app\.ycoding\.desktop\.smoke\.t[0-9a-f]{1,63}$/
const identifierKey = "<key>CFBundleIdentifier</key>"
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined

export const validSmokeIdentifier = (value: unknown) => typeof value === "string" && smokeIdentifierPattern.test(value)

export function smokeIdentifier(token: string) {
  const identifier = `app.ycoding.desktop.smoke.t${token.toLowerCase().replaceAll("-", "")}`
  if (!validSmokeIdentifier(identifier)) throw new Error("The isolated-smoke token must be 1 to 63 hexadecimal characters once hyphens are removed.")
  return identifier
}

export function bundleIdentifier(plist: string) {
  const parts = plist.split(identifierKey)
  if (parts.length !== 2) return undefined
  return /^\s*<string>([^<]*)<\/string>/.exec(parts[1] ?? "")?.[1]
}

export function smokeOverlay(base: unknown, identifier: string) {
  if (!validSmokeIdentifier(identifier)) throw new Error("The isolated-smoke identifier is invalid.")
  const windows = record(record(base)?.app)?.windows
  const main = Array.isArray(windows) && windows.length === 1 ? record(windows[0]) : undefined
  if (!main || main.label !== "main" || ["incognito", "dataDirectory", "dataStoreIdentifier"].some((key) => Object.hasOwn(main, key)))
    throw new Error("The base Tauri config must define exactly one main window without incognito or data store settings.")
  return { identifier, app: { windows: [{ ...main, incognito: true }] } }
}

async function planSmoke(boundary: Boundary, desktop: string, output: string, token: string) {
  const identifier = smokeIdentifier(token)
  const overlay = smokeOverlay(JSON.parse(await boundary.files.text(path.join(desktop, "src-tauri/tauri.conf.json"))), identifier)
  return { identifier, config: path.join(output, "smoke-config.json"), text: JSON.stringify(overlay, null, 2) + "\n" }
}

export function plannedFeatures(argv: readonly string[]) {
  const end = argv.indexOf("--")
  const head = end < 0 ? argv : argv.slice(0, end)
  const features: string[] = []
  head.forEach((arg, index) => {
    if (arg === "--features") features.push(...(head[index + 1] ?? "").split(",").filter(Boolean))
  })
  return features
}

export function parseMetadata(text: string): Metadata {
  const value: unknown = JSON.parse(text)
  const field = (name: string) => {
    const found = typeof value === "object" && value !== null ? Object.entries(value).find(([key]) => key === name)?.[1] : undefined
    if (typeof found !== "string" || !path.isAbsolute(found) || path.normalize(found) !== found || found.includes("\0")) throw new Error(`Cargo metadata did not report a normalized absolute ${name}.`)
    return found
  }
  return { target: field("target_directory"), workspace: field("workspace_root") }
}

export function overlaps(left: string, right: string) {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)
}

export const nodeFiles: Files = {
  info: async (target) => {
    try {
      const stat = await fs.lstat(target)
      return { kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other", mode: stat.mode & 0o7777, size: stat.size }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  },
  list: (target) => fs.readdir(target),
  link: (target) => fs.readlink(target),
  digest: (target) => new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(target)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  }),
  real: (target) => fs.realpath(target),
  text: (target) => fs.readFile(target, "utf8"),
}

async function walk(files: Files, absolute: string, relative: string, entries: Entry[]) {
  const info = await files.info(absolute)
  if (!info) throw new Error(`Artifact entry vanished: ${relative}`)
  if (info.kind === "other") throw new Error(`Unsupported special file in artifact: ${relative}`)
  if (info.kind === "symlink") {
    entries.push({ path: relative, type: "symlink", mode: 0, target: await files.link(absolute) })
    return
  }
  if (info.kind === "file") {
    entries.push({ path: relative, type: "file", mode: info.mode, size: info.size, sha256: await files.digest(absolute) })
    return
  }
  entries.push({ path: relative, type: "dir", mode: info.mode })
  for (const name of (await files.list(absolute)).sort(bytewise))
    await walk(files, path.join(absolute, name), relative === "." ? name : path.join(relative, name), entries)
}

export async function fingerprint(files: Files, root: string): Promise<Tree> {
  const top = await files.info(root)
  if (!top) return { status: "absent", entries: [], digest: sha("[]") }
  if (top.kind === "symlink" || top.kind === "other") throw new Error(`Artifact root must be a regular file or directory: ${root}`)
  const entries: Entry[] = []
  await walk(files, root, ".", entries)
  entries.sort((left, right) => bytewise(left.path, right.path))
  return { status: "present", entries, digest: sha(JSON.stringify(entries)) }
}

export function difference(expected: Tree, actual: Tree): string | undefined {
  if (expected.status !== actual.status) return `status ${expected.status} differs from ${actual.status}`
  const right = new Map(actual.entries.map((entry) => [entry.path, entry]))
  const left = new Map(expected.entries.map((entry) => [entry.path, entry]))
  for (const [relative, entry] of left) {
    const other = right.get(relative)
    if (!other) return `missing entry ${relative}`
    if (JSON.stringify(entry) !== JSON.stringify(other)) return `changed entry ${relative}`
  }
  for (const relative of right.keys()) if (!left.has(relative)) return `extra entry ${relative}`
  return undefined
}

export async function assertFreshOutput(files: Files, requested: string, protectedPaths: readonly string[]) {
  const resolved = path.resolve(requested)
  const name = path.basename(resolved)
  if (!name || name === "." || name === "..") throw new Error("The output directory needs its own fresh name.")
  const parent = await files.real(path.dirname(resolved)).catch(() => {
    throw new Error("The output directory's parent must already exist.")
  })
  const canonical = path.join(parent, name)
  for (const candidate of new Set([resolved, canonical]))
    if (await files.info(candidate)) throw new Error("The output directory already exists or is a link. Use a fresh path.")
  for (const protectedPath of protectedPaths) {
    const real = await files.real(protectedPath).catch(() => path.resolve(protectedPath))
    if (overlaps(canonical, real) || overlaps(resolved, path.resolve(protectedPath)))
      throw new Error("The output directory must not contain or sit inside the repository, build targets or artifacts being preserved.")
  }
  return canonical
}

export async function preserve(boundary: Pick<Boundary, "files" | "copy" | "write" | "mkdirs">, root: string, artifacts: readonly Artifact[]): Promise<Manifest> {
  await boundary.mkdirs(root)
  const records: Preserved[] = []
  try {
    for (const artifact of artifacts) {
      const backup = path.join(root, artifact.label)
      const before = await fingerprint(boundary.files, artifact.source)
      if (before.status === "absent") {
        records.push({ label: artifact.label, source: artifact.source, backup, status: "absent", count: 0, digest: before.digest, entries: [] })
        continue
      }
      await boundary.copy(artifact.source, backup)
      const copied = await fingerprint(boundary.files, backup)
      const after = await fingerprint(boundary.files, artifact.source)
      const copyDifference = difference(before, copied)
      if (copyDifference) throw new Error(`The ${artifact.label} backup differs from its source: ${copyDifference}.`)
      const sourceDifference = difference(before, after)
      if (sourceDifference) throw new Error(`The ${artifact.label} source changed while it was preserved: ${sourceDifference}.`)
      records.push({ label: artifact.label, source: artifact.source, backup, status: "verified", count: before.entries.length, digest: before.digest, entries: before.entries })
    }
  } catch (error) {
    await boundary.write(path.join(root, "manifest.partial.json"), JSON.stringify({ failure: error instanceof Error ? error.message : "unknown", artifacts: records }, null, 2) + "\n")
    throw error
  }
  const manifest: Manifest = { verification: "source before, backup and source after are identical for every present artifact", artifacts: records }
  await boundary.write(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return manifest
}

export function artifactsFor(desktop: string, metadata: Metadata): Artifact[] {
  return [
    { label: "runtime", source: path.join(desktop, "src-tauri/runtime") },
    { label: "dist", source: path.join(desktop, "dist") },
    { label: "gen-schemas", source: path.join(desktop, "src-tauri/gen/schemas") },
    { label: "permissions-autogenerated", source: path.join(desktop, "src-tauri/permissions/autogenerated") },
    { label: "cargo-app-bundle", source: path.join(metadata.target, "release/bundle/macos/YCoding Desktop.app") },
    { label: "Cargo.lock", source: path.join(metadata.workspace, "Cargo.lock") },
  ]
}

export const lockName = ".ycoding-desktop-build.lock"
export const lockPath = (target: string) => path.join(target, lockName)

export async function orchestrate(boundary: Boundary, config: { readonly argv: readonly string[]; readonly desktop: string; readonly execPath: string; readonly token?: string }) {
  const options = parseArguments(config.argv)
  await boundary.assertSigning()
  const metadata = await boundary.metadata()
  const artifacts = artifactsFor(config.desktop, metadata)
  const built = artifacts.find((artifact) => artifact.label === "cargo-app-bundle")
  const lock = artifacts.find((artifact) => artifact.label === "Cargo.lock")
  if (!built || !lock) throw new Error("The build artifact plan is incomplete.")
  const before = await fingerprint(boundary.files, lock.source)
  if (before.status !== "present") throw new Error("Cargo.lock is required for a locked build.")
  const repo = path.resolve(config.desktop, "../..")
  const output = await assertFreshOutput(boundary.files, options.outdir, [repo, config.desktop, metadata.target, metadata.workspace, ...artifacts.map((artifact) => artifact.source)])
  const token = config.token ?? crypto.randomUUID()
  const smoke = options.isolatedSmoke ? await planSmoke(boundary, config.desktop, output, token) : undefined
  const lockFile = lockPath(metadata.target)
  await boundary.lock(lockFile, token)
  const build = async () => {
  await boundary.mkdir(output)
  if (smoke) await boundary.write(smoke.config, smoke.text)
  const manifest = await preserve(boundary, path.join(output, "preserved"), artifacts)
  const preparedManifest = path.join(config.desktop, "src-tauri/runtime/backend.json")
  const command = tauriCommand(config.execPath, options.isolatedSmoke, smoke?.config)
  let version: string | undefined
  let status: number | undefined
  let prepared: string | undefined
  let failure: unknown
  try {
    version = (await boundary.prepare(path.join(output, "backend-build"))).version
    prepared = await boundary.files.digest(preparedManifest)
    status = await boundary.tauri(command)
    if (await boundary.files.digest(preparedManifest) !== prepared) throw new Error("The prepared backend manifest changed during the Tauri build.")
  } catch (error) {
    failure = error
  }
  const after = await fingerprint(boundary.files, lock.source)
  const drift = difference(before, after)
  if (drift) throw new Error(`Cargo.lock changed during the build (${drift}); it was not restored.`)
  if (failure) throw failure
  if (version === undefined || prepared === undefined || status !== 0) throw new Error("The owning Tauri app build failed.")
  const builtManifest = path.join(built.source, "Contents/Resources/backend.json")
  if (await boundary.files.digest(builtManifest) !== prepared) throw new Error("The built application's backend manifest is not the one just prepared.")
  const macos = path.join(built.source, "Contents/MacOS")
  const executables = await boundary.files.list(macos)
  const [name] = executables
  const mainInfo = name === undefined ? undefined : await boundary.files.info(path.join(macos, name))
  if (executables.length !== 1 || name === undefined || mainInfo?.kind !== "file") throw new Error("The built application must contain exactly one main executable.")
  const executableSha = await boundary.files.digest(path.join(macos, name))
  const builtBefore = await fingerprint(boundary.files, built.source)
  const application = path.join(output, "YCoding Desktop.app")
  await boundary.copy(built.source, application)
  const copied = await fingerprint(boundary.files, application)
  const copyDifference = difference(builtBefore, copied)
  if (copyDifference) throw new Error(`The copied application differs from the built bundle: ${copyDifference}.`)
  const sourceDifference = difference(builtBefore, await fingerprint(boundary.files, built.source))
  if (sourceDifference) throw new Error(`The built bundle changed while it was copied, so another build may share the target: ${sourceDifference}.`)
  if (await boundary.files.digest(path.join(application, "Contents/Resources/backend.json")) !== prepared) throw new Error("The copied application's backend manifest is not the one just prepared.")
  if (smoke && bundleIdentifier(await boundary.files.text(path.join(application, "Contents/Info.plist"))) !== smoke.identifier) throw new Error("The copied application's Info.plist does not hold exactly the planned isolated-smoke bundle identifier.")
  const preservation = path.join(output, "preserved/manifest.json")
  const receipt = {
    application: await boundary.files.real(application),
    version,
    features: plannedFeatures(command),
    executable: { path: await boundary.files.real(path.join(application, "Contents/MacOS", name)), sha256: executableSha },
    manifest: { sha256: prepared },
    build: { argv: [...command], status },
    preservation: { manifest: preservation, sha256: await boundary.files.digest(preservation) },
    preserved: manifest.artifacts.map((record) => ({ label: record.label, status: record.status, count: record.count, digest: record.digest })),
    lock: { before: before.digest, after: after.digest, sha256: before.entries[0]?.sha256 },
    buildLock: lockFile,
    ...(smoke ? { isolation: { identifier: smoke.identifier, incognito: true, config: { path: smoke.config, sha256: sha(smoke.text) } } } : {}),
  }
  return receipt
  }
  let failed = false
  let failure: unknown
  let receipt: Awaited<ReturnType<typeof build>> | undefined
  try {
    receipt = await build()
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await boundary.unlock(lockFile, token)
  } catch (error) {
    if (!failed) throw error
  }
  if (failed || receipt === undefined) throw failure
  await boundary.write(path.join(output, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  return receipt
}
