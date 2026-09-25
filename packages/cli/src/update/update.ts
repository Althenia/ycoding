import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import semver from "semver"

const repository = "Althenia/ycoding"
const maxArchiveBytes = 512 * 1024 * 1024
const maxChecksumsBytes = 1024 * 1024
const pairedMacOSRelease = "0.2.0"
const appMacOSRelease = "0.7.1"
const computerHelper = "ycoding-computer-helper"
const computerApp = `${computerHelper}.app`
const appFiles = [
  `${computerApp}/Contents/Info.plist`,
  `${computerApp}/Contents/MacOS/${computerHelper}`,
  `${computerApp}/Contents/_CodeSignature/CodeResources`,
  `${computerApp}/Contents/Resources/YCoding.icns`,
]

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>
type Rename = (source: string, destination: string) => Promise<void>
type InstallTransaction = {
  executableBackedUp: boolean
  helperBackedUp: boolean
  appBackedUp: boolean
  executableInstalled: boolean
  helperInstalled: boolean
  appInstalled: boolean
}

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
  const archive = await download(fetcher, `${release}/${asset}`, maxArchiveBytes)
  const expected = checksum(checksumText, asset)
  const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
  if (actual !== expected) throw new Error(`Checksum verification failed for ${asset}`)
  const temporary = await mkdtemp(path.join(path.dirname(input.executable), ".ycoding-update-"))
  let rollback: string | undefined
  let retainRollback = false
  try {
    const installedNames =
      input.platform === "darwin" && semver.gte(input.version, pairedMacOSRelease)
        ? ["ycoding", computerHelper]
        : ["ycoding"]
    const appRequired = input.platform === "darwin" && semver.gte(input.version, appMacOSRelease)
    const names = [...installedNames, ...(appRequired ? appFiles : [])].sort()
    await inspectArchive(archive, names, appRequired)
    const releaseArchive = new Bun.Archive(archive)
    const archiveFiles = await releaseArchive.files()
    const files = [...archiveFiles.keys()].sort()
    if (files.length !== names.length || files.some((entry, index) => entry !== names[index])) {
      throw new Error(`Release archive did not contain the exact direct entries: ${names.join(", ")}`)
    }
    const sizes = names.map((name) => archiveFiles.get(name)?.size ?? 0)
    if (
      sizes.some((size) => size === 0 || size > maxArchiveBytes) ||
      sizes.reduce((sum, size) => sum + size, 0) > maxArchiveBytes
    ) {
      throw new Error("Release archive entries must be bounded regular nonempty direct files")
    }
    if (appRequired) {
      await Promise.all(
        [
          computerApp,
          `${computerApp}/Contents`,
          `${computerApp}/Contents/MacOS`,
          `${computerApp}/Contents/Resources`,
          `${computerApp}/Contents/_CodeSignature`,
        ].map((directory) => mkdir(path.join(temporary, directory), { recursive: true })),
      )
    }
    await Promise.all(names.map((name) => Bun.write(path.join(temporary, name), archiveFiles.get(name)!)))
    const entries = (await readdir(temporary)).sort()
    if (
      entries.length !== installedNames.length + Number(appRequired) ||
      entries.some((entry, index) => entry !== [...installedNames, ...(appRequired ? [computerApp] : [])].sort()[index])
    ) {
      throw new Error(`Release archive did not contain the exact direct entries: ${names.join(", ")}`)
    }
    if (appRequired) {
      for (const [directory, expected] of [
        [computerApp, ["Contents"]],
        [`${computerApp}/Contents`, ["Info.plist", "MacOS", "Resources", "_CodeSignature"]],
        [`${computerApp}/Contents/MacOS`, [computerHelper]],
        [`${computerApp}/Contents/Resources`, ["YCoding.icns"]],
        [`${computerApp}/Contents/_CodeSignature`, ["CodeResources"]],
      ] as const) {
        const actual = (await readdir(path.join(temporary, directory))).sort()
        if (actual.length !== expected.length || actual.some((entry, index) => entry !== [...expected].sort()[index])) {
          throw new Error(`Release archive entry ${directory} contains unexpected files`)
        }
      }
      for (const directory of [
        computerApp,
        `${computerApp}/Contents`,
        `${computerApp}/Contents/MacOS`,
        `${computerApp}/Contents/Resources`,
        `${computerApp}/Contents/_CodeSignature`,
      ]) {
        const info = await lstat(path.join(temporary, directory))
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Release archive entry ${directory} must be a directory`)
      }
      const metadata = await Bun.file(path.join(temporary, appFiles[0])).text()
      if (
        !metadata.includes("<key>CFBundleIdentifier</key><string>app.ycoding.computer-helper</string>") ||
        !metadata.includes("<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>") ||
        !metadata.includes("<key>CFBundleIconFile</key><string>YCoding.icns</string>")
      )
        throw new Error("Computer helper app has invalid bundle metadata")
    }
    await Promise.all(
      names.map(async (name) => {
        const candidate = path.join(temporary, name)
        const file = await lstat(candidate)
        if (!file.isFile() || file.isSymbolicLink() || file.size === 0 || file.size > maxArchiveBytes) {
          throw new Error(`Release archive entry ${name} must be a bounded regular nonempty direct file`)
        }
        if (name === "ycoding" || name === computerHelper || name === appFiles[1]) await chmod(candidate, 0o755)
      }),
    )
    if (appRequired) {
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
    if (installedNames.length === 1) {
      await move(path.join(temporary, "ycoding"), input.executable)
      return { version: input.version, asset }
    }
    const helper = path.join(path.dirname(input.executable), computerHelper)
    const installedHelper = await statIfExists(helper)
    if (installedHelper && (!installedHelper.isFile() || installedHelper.isSymbolicLink() || installedHelper.uid !== process.getuid?.())) {
      throw new Error("Installed computer helper must be a regular file owned by the current user")
    }
    const app = path.join(path.dirname(input.executable), computerApp)
    const installedApp = appRequired ? await statIfExists(app) : undefined
    if (installedApp && (!installedApp.isDirectory() || installedApp.isSymbolicLink() || installedApp.uid !== process.getuid?.())) {
      throw new Error("Installed computer helper app must be an owned directory")
    }
    rollback = await mkdtemp(path.join(path.dirname(input.executable), ".ycoding-update-backup-"))
    const transaction = {
      executableBackedUp: false,
      helperBackedUp: false,
      appBackedUp: false,
      executableInstalled: false,
      helperInstalled: false,
      appInstalled: false,
    }
    try {
      await replaceRelease({
        executable: input.executable,
        helper,
        app: appRequired ? app : undefined,
        appExists: installedApp !== undefined,
        helperExists: installedHelper !== undefined,
        candidate: path.join(temporary, "ycoding"),
        helperCandidate: path.join(temporary, computerHelper),
        appCandidate: path.join(temporary, computerApp),
        rollback,
        rename: move,
        transaction,
      })
    } catch (error) {
      const recovery = await restoreRelease({
        executable: input.executable,
        helper,
        app: appRequired ? app : undefined,
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
  readonly helper: string
  readonly app?: string
  readonly appExists: boolean
  readonly helperExists: boolean
  readonly candidate: string
  readonly helperCandidate: string
  readonly appCandidate: string
  readonly rollback: string
  readonly rename: Rename
  readonly transaction: InstallTransaction
}) {
  await input.rename(input.executable, path.join(input.rollback, "ycoding"))
  input.transaction.executableBackedUp = true
  if (input.helperExists) {
    await input.rename(input.helper, path.join(input.rollback, computerHelper))
    input.transaction.helperBackedUp = true
  }
  if (input.app && input.appExists) {
    await input.rename(input.app, path.join(input.rollback, computerApp))
    input.transaction.appBackedUp = true
  }
  await input.rename(input.helperCandidate, input.helper)
  input.transaction.helperInstalled = true
  if (input.app) {
    await input.rename(input.appCandidate, input.app)
    input.transaction.appInstalled = true
  }
  await input.rename(input.candidate, input.executable)
  input.transaction.executableInstalled = true
}

async function restoreRelease(input: {
  readonly executable: string
  readonly helper: string
  readonly app?: string
  readonly rollback: string
  readonly rename: Rename
  readonly transaction: InstallTransaction
}) {
  const executableBackup = path.join(input.rollback, "ycoding")
  const helperBackup = path.join(input.rollback, computerHelper)
  const appBackup = path.join(input.rollback, computerApp)
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
  if (input.transaction.helperInstalled || input.transaction.helperBackedUp) {
    await rm(input.helper, { force: true }).catch(() => {})
  }
  if (input.transaction.helperBackedUp && (await exists(helperBackup))) {
    await input.rename(helperBackup, input.helper).catch(() => {
      recovery.push(`Computer helper backup retained at ${helperBackup}`)
      recovery.push(`Move that backup to ${input.helper} before retrying`)
    })
  } else if (input.transaction.helperInstalled) {
    await rm(input.helper, { force: true }).catch(() => {
      recovery.push(`Failed to remove the newly installed computer helper at ${input.helper}`)
    })
  }
  if (input.app && (input.transaction.appInstalled || input.transaction.appBackedUp)) {
    await rm(input.app, { recursive: true, force: true }).catch(() => {
      recovery.push(`Failed to remove the newly installed computer helper app at ${input.app}`)
    })
  }
  if (input.app && input.transaction.appBackedUp && (await exists(appBackup))) {
    await input.rename(appBackup, input.app).catch(() => {
      recovery.push(`Computer helper app backup retained at ${appBackup}`)
      recovery.push(`Move that backup to ${input.app} before retrying`)
    })
  }
  return recovery
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

async function download(fetcher: Fetch, url: string, maximum: number) {
  const response = await fetcher(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "ycoding" },
    signal: AbortSignal.timeout(60_000),
  })
  requireHttps(response)
  if (!response.ok) throw new Error(`Failed to download ${path.basename(url)}: HTTP ${response.status}`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`Download is too large: ${path.basename(url)}`)
  return readLimited(response, maximum, path.basename(url))
}

function requireHttps(response: Response) {
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error("Release download redirected to a non-HTTPS URL")
  }
}

async function readLimited(response: Response, maximum: number, name: string) {
  if (!response.body) throw new Error(`Download returned no body: ${name}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new Error(`Download is too large: ${name}`)
      chunks.push(next.value)
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

async function inspectArchive(archive: Uint8Array, files: string[], appRequired: boolean) {
  const directories = appRequired
    ? [
        computerApp,
        `${computerApp}/Contents`,
        `${computerApp}/Contents/MacOS`,
        `${computerApp}/Contents/Resources`,
        `${computerApp}/Contents/_CodeSignature`,
      ].map((directory) => `${directory}/`)
    : []
  const expected = [...files, ...directories].sort()
  const entries: string[] = []
  const header = new Uint8Array(512)
  let headerBytes = 0
  let skip = 0
  let expanded = 0
  let ended = false
  for await (const chunk of Readable.from([archive]).pipe(createGunzip())) {
    expanded += chunk.length
    if (expanded > maxArchiveBytes + 1024 * 1024) throw new Error("Release archive is too large when expanded")
    for (let offset = 0; offset < chunk.length; ) {
      if (skip > 0) {
        const consumed = Math.min(skip, chunk.length - offset)
        skip -= consumed
        offset += consumed
        continue
      }
      const consumed = Math.min(512 - headerBytes, chunk.length - offset)
      header.set(chunk.subarray(offset, offset + consumed), headerBytes)
      headerBytes += consumed
      offset += consumed
      if (headerBytes !== 512) continue
      headerBytes = 0
      if (header.every((byte) => byte === 0)) {
        ended = true
        continue
      }
      if (ended) throw new Error("Release archive has entries after its terminator")
      const name = Buffer.from(header.subarray(0, 100)).toString("utf8").split("\0", 1)[0]
      const prefix = Buffer.from(header.subarray(345, 500)).toString("utf8").split("\0", 1)[0]
      const sizeField = Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim()
      if (prefix || !/^[0-7]+$/.test(sizeField)) throw new Error("Release archive has invalid entry metadata")
      const size = Number.parseInt(sizeField, 8)
      const type = header[156]
      if (type === 120 && size <= 16 * 1024 && entries.length <= expected.length) {
        skip = Math.ceil(size / 512) * 512
        continue
      }
      if (
        (type === 53 && directories.includes(name) && size === 0) ||
        ((type === 48 || type === 0) && files.includes(name) && size > 0 && size <= maxArchiveBytes)
      ) {
        entries.push(name)
        if (entries.length > expected.length) throw new Error("Release archive has unexpected entries")
        skip = Math.ceil(size / 512) * 512
        continue
      }
      if ((type === 48 || type === 0) && files.includes(name)) {
        throw new Error("Release archive entries must be bounded regular nonempty direct files")
      }
      throw new Error(`Release archive did not contain the exact direct entries: ${expected.join(", ")}`)
    }
  }
  if (headerBytes !== 0 || skip !== 0 || !ended || entries.sort().some((entry, index) => entry !== expected[index]) || entries.length !== expected.length) {
    throw new Error(`Release archive did not contain the exact direct entries: ${expected.join(", ")}`)
  }
}
