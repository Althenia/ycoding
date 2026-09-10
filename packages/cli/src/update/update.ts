import { chmod, lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import semver from "semver"

const repository = "Althenia/ycoding"
const maxArchiveBytes = 512 * 1024 * 1024
const maxChecksumsBytes = 1024 * 1024
const pairedMacOSRelease = "0.2.0"
const computerHelper = "ycoding-computer-helper"

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
type Rename = (source: string, destination: string) => Promise<void>
type InstallTransaction = {
  executableBackedUp: boolean
  helperBackedUp: boolean
  executableInstalled: boolean
  helperInstalled: boolean
}

export type InstallReleaseInput = {
  readonly version: string
  readonly executable: string
  readonly platform: string
  readonly arch: string
  readonly fetch?: Fetch
  readonly filesystem?: {
    readonly rename: Rename
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
  if (!existing.isFile() || existing.isSymbolicLink())
    throw new Error("Installed ycoding executable must be a regular file")
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
    const names =
      input.platform === "darwin" && semver.gte(input.version, pairedMacOSRelease)
        ? ["ycoding", computerHelper]
        : ["ycoding"]
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
    const extracted = await releaseArchive.extract(temporary)
    const entries = (await readdir(temporary)).sort()
    if (
      extracted !== names.length ||
      entries.length !== names.length ||
      entries.some((entry, index) => entry !== names[index])
    ) {
      throw new Error(`Release archive did not contain the exact direct entries: ${names.join(", ")}`)
    }
    await Promise.all(
      names.map(async (name) => {
        const candidate = path.join(temporary, name)
        const file = await lstat(candidate)
        if (!file.isFile() || file.isSymbolicLink() || file.size === 0 || file.size > maxArchiveBytes) {
          throw new Error(`Release archive entry ${name} must be a bounded regular nonempty direct file`)
        }
        await chmod(candidate, 0o755)
      }),
    )
    const move = input.filesystem?.rename ?? rename
    if (names.length === 1) {
      await move(path.join(temporary, "ycoding"), input.executable)
      return { version: input.version, asset }
    }
    const helper = path.join(path.dirname(input.executable), computerHelper)
    const installedHelper = await statIfExists(helper)
    if (installedHelper && (!installedHelper.isFile() || installedHelper.isSymbolicLink())) {
      throw new Error("Installed computer helper must be a regular file")
    }
    rollback = await mkdtemp(path.join(path.dirname(input.executable), ".ycoding-update-backup-"))
    const transaction = {
      executableBackedUp: false,
      helperBackedUp: false,
      executableInstalled: false,
      helperInstalled: false,
    }
    try {
      await replaceRelease({
        executable: input.executable,
        helper,
        helperExists: installedHelper !== undefined,
        candidate: path.join(temporary, "ycoding"),
        helperCandidate: path.join(temporary, computerHelper),
        rollback,
        rename: move,
        transaction,
      })
    } catch (error) {
      const recovery = await restoreRelease({
        executable: input.executable,
        helper,
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
  readonly helperExists: boolean
  readonly candidate: string
  readonly helperCandidate: string
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
  await input.rename(input.helperCandidate, input.helper)
  input.transaction.helperInstalled = true
  await input.rename(input.candidate, input.executable)
  input.transaction.executableInstalled = true
}

async function restoreRelease(input: {
  readonly executable: string
  readonly helper: string
  readonly rollback: string
  readonly rename: Rename
  readonly transaction: InstallTransaction
}) {
  const executableBackup = path.join(input.rollback, "ycoding")
  const helperBackup = path.join(input.rollback, computerHelper)
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
