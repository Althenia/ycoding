import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import semver from "semver"
import type { UpdateProgress } from "./progress"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"

const repository = "Althenia/ycoding"
const maxArchiveBytes = 512 * 1024 * 1024
const maxChecksumsBytes = 1024 * 1024
const maxArchiveEntries = 1024
const pairedMacOSRelease = "0.2.0"
const appMacOSRelease = "0.7.1"
// Releases after 0.7.1, including their prereleases, ship YCoding Computer Use.app without a bare helper on macOS
// (the app filename is its privacy-settings display name) and include the Chrome extension on every platform.
const currentLayoutRelease = "0.7.2-0"
const legacyComputerHelper = "ycoding-computer-helper"
const legacyComputerApp = `${legacyComputerHelper}.app`

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>
type Rename = (source: string, destination: string) => Promise<void>
type InstallTransaction = {
  executableBackedUp: boolean
  helperBackedUp: boolean
  bundlesBackedUp: string[]
  supersededBackedUp: string[]
  executableInstalled: boolean
  helperInstalled: boolean
  bundlesInstalled: string[]
}
type Bundle = { readonly label: string; readonly target: string; readonly candidate: string; readonly exists: boolean }

export type InstallReleaseInput = {
  readonly version: string
  readonly executable: string
  readonly platform: string
  readonly arch: string
  readonly fetch?: Fetch
  readonly filesystem?: {
    readonly rename: Rename
    readonly verifyApplication?: (application: string) => Promise<void>
  }
  readonly onProgress?: (event: UpdateProgress.Event) => void
}

export function validVersion(version: string) {
  return semver.valid(version) === version
}

export function releaseTarget(platform: string, arch: string) {
  const target = `${platform}-${arch}`
  if (["darwin-arm64", "darwin-x64", "linux-x64"].includes(target)) return target
  throw new Error(
    `Unsupported platform for self-update: ${target}; install manually from https://github.com/${repository}/releases`,
  )
}

export async function latestRelease(fetcher: Fetch = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ycoding" },
    signal: AbortSignal.timeout(10_000),
  })
  requireHttps(response)
  if (!response.ok) throw new Error(`Failed to resolve the latest release: HTTP ${response.status}`)
  const data: unknown = JSON.parse(
    new TextDecoder().decode(await readLimited(response, maxChecksumsBytes, "latest release response")),
  )
  if (typeof data !== "object" || data === null || !("tag_name" in data) || typeof data.tag_name !== "string") {
    throw new Error("Latest release response did not contain a tag")
  }
  const version = data.tag_name.startsWith("v") ? data.tag_name.slice(1) : ""
  if (!validVersion(version)) throw new Error(`Latest release returned an invalid version: ${data.tag_name}`)
  return version
}

export async function installRelease(input: InstallReleaseInput) {
  if (!validVersion(input.version)) throw new Error(`Invalid YCoding version: ${input.version}`)
  const existing = await lstat(input.executable)
  if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.())
    throw new Error("Installed ycoding executable must be an owned regular file")
  const target = releaseTarget(input.platform, input.arch)
  const asset = `ycoding-${input.version}-${target}.tar.gz`
  const checksums = `ycoding-${input.version}-checksums.txt`
  const release = `https://github.com/${repository}/releases/download/v${input.version}`
  const fetcher = input.fetch ?? fetch
  const checksumText = new TextDecoder().decode(await download(fetcher, `${release}/${checksums}`, maxChecksumsBytes))
  const archive = await download(fetcher, `${release}/${asset}`, maxArchiveBytes, (received, total) =>
    input.onProgress?.({ phase: "download", received, total }),
  )
  input.onProgress?.({ phase: "verify" })
  const expected = checksum(checksumText, asset)
  const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
  if (actual !== expected) throw new Error(`Checksum verification failed for ${asset}`)
  input.onProgress?.({ phase: "install" })
  const temporary = await mkdtemp(path.join(path.dirname(input.executable), ".ycoding-update-"))
  let rollback: string | undefined
  let retainRollback = false
  try {
    const currentLayout = semver.gte(input.version, currentLayoutRelease)
    const appExecutable = currentLayout ? "ycoding-computer-use" : legacyComputerHelper
    const computerApp = currentLayout ? "YCoding Computer Use.app" : legacyComputerApp
    const bareHelper = input.platform === "darwin" && semver.gte(input.version, pairedMacOSRelease) && !currentLayout
    const installedNames = bareHelper ? ["ycoding", legacyComputerHelper] : ["ycoding"]
    const appRequired = input.platform === "darwin" && semver.gte(input.version, appMacOSRelease)
    const appFiles = [
      `${computerApp}/Contents/Info.plist`,
      `${computerApp}/Contents/MacOS/${appExecutable}`,
      `${computerApp}/Contents/_CodeSignature/CodeResources`,
      `${computerApp}/Contents/Resources/YCoding.icns`,
    ]
    const extension = BrowserExtension.directory
    const required = [
      ...installedNames,
      ...(appRequired ? appFiles : []),
      ...(currentLayout ? BrowserExtension.files.map((file) => `${extension}/${file}`) : []),
    ]
    const files = readArchive(await expandArchive(archive), required)
    await Promise.all(
      required.map(async (name) => {
        const candidate = path.join(temporary, name)
        await mkdir(path.dirname(candidate), { recursive: true })
        await Bun.write(candidate, files.get(name)!)
        if (name === "ycoding" || name === legacyComputerHelper || name === appFiles[1]) await chmod(candidate, 0o755)
      }),
    )
    if (appRequired) {
      const metadata = await Bun.file(path.join(temporary, appFiles[0])).text()
      if (
        !metadata.includes(`<key>CFBundleIdentifier</key><string>app.ycoding.${currentLayout ? "computer-use" : "computer-helper"}</string>`) ||
        !metadata.includes("<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>") ||
        !metadata.includes("<key>CFBundleIconFile</key><string>YCoding.icns</string>")
      )
        throw new Error("Computer helper app has invalid bundle metadata")
      const application = path.join(temporary, computerApp)
      if (input.filesystem?.verifyApplication) await input.filesystem.verifyApplication(application)
      else {
        const verification = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", application], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (verification.exitCode !== 0) throw new Error("Computer helper app signature verification failed")
      }
    }
    const move = input.filesystem?.rename ?? rename
    if (!bareHelper && !appRequired && !currentLayout) {
      await move(path.join(temporary, "ycoding"), input.executable)
      return { version: input.version, asset }
    }
    const installDirectory = path.dirname(input.executable)
    const helper = bareHelper ? path.join(installDirectory, legacyComputerHelper) : undefined
    const installedHelper = helper ? await statIfExists(helper) : undefined
    if (installedHelper && (!installedHelper.isFile() || installedHelper.isSymbolicLink() || installedHelper.uid !== process.getuid?.())) {
      throw new Error("Installed computer helper must be a regular file owned by the current user")
    }
    const bundles: ReadonlyArray<Bundle> = await Promise.all(
      [
        ...(appRequired ? [{ label: "Computer helper app", name: computerApp }] : []),
        ...(currentLayout ? [{ label: "Chrome extension", name: extension }] : []),
      ].map(async (bundle) => {
        const target = path.join(installDirectory, bundle.name)
        const installed = await statIfExists(target)
        if (installed && (!installed.isDirectory() || installed.isSymbolicLink() || installed.uid !== process.getuid?.())) {
          throw new Error(`Installed ${bundle.label} must be an owned directory`)
        }
        return { label: bundle.label, target, candidate: path.join(temporary, bundle.name), exists: installed !== undefined }
      }),
    )
    const superseded = currentLayout && input.platform === "darwin" ? await installedSuperseded(installDirectory) : []
    rollback = await mkdtemp(path.join(installDirectory, ".ycoding-update-backup-"))
    const transaction: InstallTransaction = {
      executableBackedUp: false,
      helperBackedUp: false,
      bundlesBackedUp: [],
      supersededBackedUp: [],
      executableInstalled: false,
      helperInstalled: false,
      bundlesInstalled: [],
    }
    try {
      await replaceRelease({
        executable: input.executable,
        helper,
        helperExists: installedHelper !== undefined,
        bundles,
        superseded,
        candidate: path.join(temporary, "ycoding"),
        helperCandidate: path.join(temporary, legacyComputerHelper),
        rollback,
        rename: move,
        transaction,
      })
    } catch (error) {
      const recovery = await restoreRelease({
        executable: input.executable,
        helper,
        bundles,
        rollback,
        rename: move,
        transaction,
      })
      retainRollback = recovery.length > 0
      if (recovery.length > 0) throw new Error(`${errorMessage(error)}\n${recovery.join("\n")}`, { cause: error })
      throw error
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (rollback && !retainRollback) await rm(rollback, { recursive: true, force: true })
  }
  return { version: input.version, asset }
}

async function replaceRelease(input: {
  readonly executable: string
  readonly helper?: string
  readonly helperExists: boolean
  readonly bundles: ReadonlyArray<Bundle>
  readonly superseded: ReadonlyArray<string>
  readonly candidate: string
  readonly helperCandidate: string
  readonly rollback: string
  readonly rename: Rename
  readonly transaction: InstallTransaction
}) {
  await input.rename(input.executable, path.join(input.rollback, "ycoding"))
  input.transaction.executableBackedUp = true
  if (input.helper && input.helperExists) {
    await input.rename(input.helper, path.join(input.rollback, path.basename(input.helper)))
    input.transaction.helperBackedUp = true
  }
  for (const bundle of input.bundles.filter((bundle) => bundle.exists)) {
    await input.rename(bundle.target, path.join(input.rollback, path.basename(bundle.target)))
    input.transaction.bundlesBackedUp.push(bundle.target)
  }
  for (const file of input.superseded) {
    await input.rename(file, path.join(input.rollback, path.basename(file)))
    input.transaction.supersededBackedUp.push(file)
  }
  if (input.helper) {
    await input.rename(input.helperCandidate, input.helper)
    input.transaction.helperInstalled = true
  }
  for (const bundle of input.bundles) {
    await input.rename(bundle.candidate, bundle.target)
    input.transaction.bundlesInstalled.push(bundle.target)
  }
  await input.rename(input.candidate, input.executable)
  input.transaction.executableInstalled = true
}

async function restoreRelease(input: {
  readonly executable: string
  readonly helper?: string
  readonly bundles: ReadonlyArray<Bundle>
  readonly rollback: string
  readonly rename: Rename
  readonly transaction: InstallTransaction
}) {
  const executableBackup = path.join(input.rollback, "ycoding")
  const helperBackup = input.helper ? path.join(input.rollback, path.basename(input.helper)) : undefined
  const recovery: string[] = []
  if (input.transaction.executableInstalled || input.transaction.executableBackedUp) {
    await rm(input.executable, { force: true }).catch(() => {})
  }
  if (input.transaction.executableBackedUp && (await exists(executableBackup))) {
    await input.rename(executableBackup, input.executable).catch(() => {
      recovery.push(`YCoding executable backup retained at ${executableBackup}`)
      recovery.push(`Move that backup to ${input.executable} before retrying`)
    })
  }
  if (input.helper && (input.transaction.helperInstalled || input.transaction.helperBackedUp)) {
    await rm(input.helper, { force: true }).catch(() => {})
  }
  if (input.helper && helperBackup && input.transaction.helperBackedUp && (await exists(helperBackup))) {
    await input.rename(helperBackup, input.helper).catch(() => {
      recovery.push(`Computer helper backup retained at ${helperBackup}`)
      recovery.push(`Move that backup to ${input.helper} before retrying`)
    })
  } else if (input.helper && input.transaction.helperInstalled) {
    await rm(input.helper, { force: true }).catch(() => {
      recovery.push(`Failed to remove the newly installed computer helper at ${input.helper}`)
    })
  }
  for (const bundle of input.bundles) {
    const backup = path.join(input.rollback, path.basename(bundle.target))
    const backedUp = input.transaction.bundlesBackedUp.includes(bundle.target)
    if (backedUp || input.transaction.bundlesInstalled.includes(bundle.target)) {
      await rm(bundle.target, { recursive: true, force: true }).catch(() => {
        recovery.push(`Failed to remove the newly installed ${bundle.label} at ${bundle.target}`)
      })
    }
    if (backedUp && (await exists(backup))) {
      await input.rename(backup, bundle.target).catch(() => {
        recovery.push(`${bundle.label} backup retained at ${backup}`)
        recovery.push(`Move that backup to ${bundle.target} before retrying`)
      })
    }
  }
  for (const file of input.transaction.supersededBackedUp) {
    const backup = path.join(input.rollback, path.basename(file))
    await input.rename(backup, file).catch(() => {
      recovery.push(`Computer helper backup retained at ${backup}`)
      recovery.push(`Move that backup to ${file} before retrying`)
    })
  }
  return recovery
}

async function installedSuperseded(directory: string) {
  const helper = path.join(directory, legacyComputerHelper)
  const app = path.join(directory, legacyComputerApp)
  const [installedHelper, installedApp] = await Promise.all([statIfExists(helper), statIfExists(app)])
  if (installedHelper && (!installedHelper.isFile() || installedHelper.isSymbolicLink() || installedHelper.uid !== process.getuid?.()))
    throw new Error("Installed computer helper must be a regular file owned by the current user")
  if (installedApp && (!installedApp.isDirectory() || installedApp.isSymbolicLink() || installedApp.uid !== process.getuid?.()))
    throw new Error("Installed computer helper app must be an owned directory")
  return [...(installedHelper ? [helper] : []), ...(installedApp ? [app] : [])]
}

const exists = (file: string) => statIfExists(file).then((value) => value !== undefined)

const statIfExists = (file: string) =>
  lstat(file).then(
    (value) => value,
    (error) => {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return undefined
      throw error
    },
  )

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function download(
  fetcher: Fetch,
  url: string,
  maximum: number,
  onBytes?: (received: number, total: number | undefined) => void,
) {
  const response = await fetcher(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "ycoding" },
    signal: AbortSignal.timeout(60_000),
  })
  requireHttps(response)
  if (!response.ok) throw new Error(`Failed to download ${path.basename(url)}: HTTP ${response.status}`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`Download is too large: ${path.basename(url)}`)
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
  return readLimited(response, maximum, path.basename(url), onBytes && ((received) => onBytes(received, total)))
}

function requireHttps(response: Response) {
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error("Release download redirected to a non-HTTPS URL")
  }
}

async function readLimited(response: Response, maximum: number, name: string, onBytes?: (received: number) => void) {
  if (!response.body) throw new Error(`Download returned no body: ${name}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  onBytes?.(0)
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new Error(`Download is too large: ${name}`)
      chunks.push(next.value)
      onBytes?.(size)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function checksum(text: string, asset: string) {
  const matches = text
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64})\s+\*?([^\s]+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match?.[2] === asset)
  if (matches.length !== 1) throw new Error(`Checksum file does not contain exactly one entry for ${asset}`)
  return matches[0][1]
}

async function expandArchive(archive: Uint8Array) {
  const chunks: Buffer[] = []
  let expanded = 0
  for await (const chunk of Readable.from([archive]).pipe(createGunzip())) {
    expanded += chunk.length
    if (expanded > maxArchiveBytes + 1024 * 1024) throw new Error("Release archive is too large when expanded")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function readArchive(tar: Uint8Array, required: ReadonlyArray<string>) {
  const files = new Map<string, Uint8Array>()
  const names = new Set<string>()
  let offset = 0
  let total = 0
  while (true) {
    if (offset + 512 > tar.length) throw new Error("Release archive is truncated")
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) break
    const sizeField = Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim()
    if (!/^[0-7]+$/.test(sizeField)) throw new Error("Release archive has invalid entry metadata")
    const size = Number.parseInt(sizeField, 8)
    const type = header[156]
    const name = entryName(header)
    if (type === 120 && size <= 16 * 1024) {
      offset += Math.ceil(size / 512) * 512
      continue
    }
    const directory = type === 53 && size === 0
    if (!directory && type !== 48 && type !== 0) throw new Error(`Release archive entry ${name} has an unsupported type`)
    const normalized = directory ? name.replace(/\/$/, "") : name
    if (!safeName(normalized)) throw new Error(`Release archive entry has an unsafe name: ${JSON.stringify(name)}`)
    if (names.has(normalized)) throw new Error(`Release archive has duplicate entry ${normalized}`)
    names.add(normalized)
    if (names.size > maxArchiveEntries) throw new Error("Release archive has too many entries")
    total += size
    if (size > maxArchiveBytes || total > maxArchiveBytes) {
      throw new Error(`Release archive entry ${normalized} exceeds the size limit`)
    }
    const next = offset + Math.ceil(size / 512) * 512
    if (next > tar.length) throw new Error("Release archive is truncated")
    if (!directory && required.includes(normalized)) files.set(normalized, tar.subarray(offset, offset + size))
    offset = next
  }
  if (!tar.subarray(offset).every((byte) => byte === 0)) throw new Error("Release archive has entries after its terminator")
  const missing = required.filter((name) => !files.has(name))
  if (missing.length > 0) throw new Error(`Release archive is missing required entries: ${missing.join(", ")}`)
  const empty = required.find((name) => files.get(name)!.length === 0)
  if (empty) throw new Error(`Release archive entry ${empty} must be nonempty`)
  return files
}

function entryName(header: Uint8Array) {
  const field = (start: number, end: number) => Buffer.from(header.subarray(start, end)).toString("utf8").split("\0", 1)[0]
  const prefix = field(345, 500)
  return prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)
}

const safeName = (name: string) =>
  !/[\\\x00-\x1f\x7f]/.test(name) && name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
