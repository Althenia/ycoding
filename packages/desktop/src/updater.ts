import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access as fsAccess, lstat, mkdtemp, open, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { DesktopError, type UpdateCheckResult, type UpdateInstallResult } from "./contract"

export const DESKTOP_GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/Althenia/ycoding/releases/latest"
export const DESKTOP_BUNDLE_IDENTIFIER = "app.ycoding.desktop"
export const DESKTOP_SIGNING_CERT_SHA1 = "9dd524184b0db949ffac7f0ada0ae860ac7f5f85"

const releaseDownloadBase = "https://github.com/Althenia/ycoding/releases/download"
const releaseTagBase = "https://github.com/Althenia/ycoding/releases/tag"
const userAgent = "ycoding-desktop"
const maxMetadataBytes = 1024 * 1024
const maxChecksumsBytes = 1024 * 1024
const maxArchiveBytes = 512 * 1024 * 1024
const metadataTimeoutMs = 10_000
const checksumsTimeoutMs = 60_000
const archiveTimeoutMs = 10 * 60_000
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

export type UpdateFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type UpdateAccess = (target: string, mode?: number) => Promise<void>
export type UpdateCommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type UpdateRunCommand = (command: readonly string[]) => Promise<UpdateCommandResult>

export type CheckForUpdatesOptions = {
  readonly currentVersion: string
  readonly appBundlePath: string | null
  readonly platform?: string
  readonly arch?: string
  readonly fetch?: UpdateFetch
  readonly access?: UpdateAccess
}

export type InstallUpdateOptions = {
  readonly currentVersion: string
  readonly targetVersion?: string
  readonly appBundlePath: string | null
  readonly platform?: string
  readonly arch?: string
  readonly fetch?: UpdateFetch
  readonly access?: UpdateAccess
  readonly runCommand?: UpdateRunCommand
  readonly relaunch?: (appBundlePath: string) => Promise<void> | void
}

type Version = { readonly core: readonly string[]; readonly prerelease: readonly string[] }

type Release = {
  readonly version: string
  readonly releaseUrl: string
  readonly publishedAt: string
  readonly releaseNotes: string
  readonly assets: ReadonlyArray<{ readonly name: string; readonly url: string }>
}

export function resolveAppBundlePath(targetPath: string): string | null {
  const segments = targetPath.split("/")
  const index = segments.findIndex(
    (segment, position) =>
      segment.length > ".app".length &&
      segment.endsWith(".app") &&
      (position === segments.length - 1 || segments[position + 1] === "Contents"),
  )
  if (index <= 0) return null
  return segments.slice(0, index + 1).join("/")
}

export async function checkForUpdates(options: CheckForUpdatesOptions): Promise<UpdateCheckResult> {
  const current = requireVersion(options.currentVersion, "current version")
  const release = await fetchLatestRelease(options.fetch ?? fetch)
  const updateAvailable = compareVersions(requireVersion(release.version, "latest version"), current) > 0
  const cannotInstallReason = updateAvailable ? await installBlocker(options, release) : undefined
  return {
    currentVersion: options.currentVersion,
    latestVersion: release.version,
    updateAvailable,
    releaseUrl: release.releaseUrl,
    publishedAt: release.publishedAt,
    releaseNotes: release.releaseNotes,
    canInstall: updateAvailable && cannotInstallReason === undefined,
    ...(cannotInstallReason === undefined ? {} : { cannotInstallReason }),
  }
}

export async function installUpdate(options: InstallUpdateOptions): Promise<UpdateInstallResult> {
  const appBundlePath = options.appBundlePath
  if (appBundlePath === null) throw new DesktopError(unbundledReason)
  if (!supportedTarget(options.platform, options.arch)) throw new DesktopError(unsupportedTargetReason)
  const current = requireVersion(options.currentVersion, "current version")
  if (options.targetVersion !== undefined) requireNewer(options.targetVersion, current)
  const bundle = await lstat(appBundlePath)
  if (!bundle.isDirectory() || bundle.isSymbolicLink()) throw new DesktopError("The installed application must be a bundle directory")
  await assertWritable(appBundlePath, options.access ?? fsAccess)

  const fetcher = options.fetch ?? fetch
  const version = options.targetVersion ?? (await fetchLatestRelease(fetcher)).version
  requireNewer(version, current)
  const zipName = archiveName(version)
  const releaseBase = `${releaseDownloadBase}/v${version}`
  const checksumsText = new TextDecoder().decode(
    await download(fetcher, `${releaseBase}/${checksumsName(version)}`, maxChecksumsBytes, checksumsTimeoutMs),
  )
  const expectedDigest = checksumEntry(checksumsText, zipName)
  const runCommand = options.runCommand ?? runProcess

  const workDir = await mkdtemp(path.join(path.dirname(appBundlePath), ".ycoding-desktop-update-"))
  let retainWorkDir = false
  try {
    const zipPath = path.join(workDir, zipName)
    const digest = await downloadToFile(fetcher, `${releaseBase}/${zipName}`, zipPath)
    if (digest !== expectedDigest) throw new DesktopError(`Checksum verification failed for ${zipName}`)
    await runChecked(runCommand, ["/usr/bin/ditto", "-x", "-k", zipPath, workDir], "Extracting the update")
    await rm(zipPath, { force: true })
    const extractedApp = await locateExtractedApp(workDir)
    await verifyBundleIdentifier(runCommand, extractedApp)
    await verifySignature(runCommand, extractedApp)
    const backupPath = path.join(workDir, "previous.app")
    await rename(appBundlePath, backupPath)
    try {
      await rename(extractedApp, appBundlePath)
    } catch (error) {
      await rename(backupPath, appBundlePath).catch((rollbackError: unknown) => {
        retainWorkDir = true
        throw new DesktopError(`Restoring the previous application failed; it remains at ${backupPath}`, {
          cause: rollbackError,
        })
      })
      throw error
    }
  } finally {
    if (!retainWorkDir) await rm(workDir, { recursive: true, force: true })
  }
  await options.relaunch?.(appBundlePath)
  return { installedVersion: version, relaunching: true }
}

const unbundledReason = "YCoding Desktop is not running from an installed application bundle"
const unsupportedTargetReason = "Desktop self-update supports macOS on Apple silicon only"

function supportedTarget(platform: string = process.platform, arch: string = process.arch) {
  return platform === "darwin" && arch === "arm64"
}

function archiveName(version: string) {
  return `YCoding-Desktop-v${version}-darwin-arm64.zip`
}

function checksumsName(version: string) {
  return `ycoding-${version}-checksums.txt`
}

async function installBlocker(options: CheckForUpdatesOptions, release: Release) {
  if (options.appBundlePath === null) return unbundledReason
  if (!supportedTarget(options.platform, options.arch)) return unsupportedTargetReason
  for (const name of [archiveName(release.version), checksumsName(release.version)]) {
    const asset = release.assets.find((item) => item.name === name)
    if (!asset || !isHttpsUrl(asset.url)) return `The release does not publish ${name} over HTTPS`
  }
  return assertWritable(options.appBundlePath, options.access ?? fsAccess).then(
    () => undefined,
    (error: unknown) => `The application location is not writable: ${errorMessage(error)}`,
  )
}

async function assertWritable(appBundlePath: string, access: UpdateAccess) {
  await access(path.dirname(appBundlePath), constants.W_OK)
  await access(appBundlePath, constants.W_OK)
}

async function fetchLatestRelease(fetcher: UpdateFetch): Promise<Release> {
  const response = await fetcher(DESKTOP_GITHUB_LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": userAgent },
    signal: AbortSignal.timeout(metadataTimeoutMs),
  })
  const bytes = await readLimited(response, maxMetadataBytes, "latest release metadata")
  const data = parseJson(new TextDecoder().decode(bytes))
  if (!isRecord(data) || typeof data.tag_name !== "string") throw new DesktopError("Latest release metadata did not contain a tag")
  const version = data.tag_name.startsWith("v") ? data.tag_name.slice(1) : ""
  requireVersion(version, `latest release tag ${JSON.stringify(data.tag_name)}`)
  const assets = Array.isArray(data.assets)
    ? data.assets.flatMap((asset) =>
        isRecord(asset) && typeof asset.name === "string" && typeof asset.browser_download_url === "string"
          ? [{ name: asset.name, url: asset.browser_download_url }]
          : [],
      )
    : []
  return {
    version,
    releaseUrl:
      typeof data.html_url === "string" && isHttpsUrl(data.html_url) ? data.html_url : `${releaseTagBase}/${data.tag_name}`,
    publishedAt: typeof data.published_at === "string" ? data.published_at : "",
    releaseNotes: typeof data.body === "string" ? data.body : "",
    assets,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new DesktopError("Latest release metadata is not valid JSON", { cause: error })
  }
}

async function download(fetcher: UpdateFetch, url: string, maximum: number, timeoutMs: number) {
  const response = await fetcher(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": userAgent },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return readLimited(response, maximum, path.basename(url))
}

async function downloadToFile(fetcher: UpdateFetch, url: string, destination: string) {
  const response = await fetcher(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": userAgent },
    signal: AbortSignal.timeout(archiveTimeoutMs),
  })
  const hash = createHash("sha256")
  const file = await open(destination, "wx", 0o600)
  try {
    await streamLimited(response, maxArchiveBytes, path.basename(url), async (chunk) => {
      hash.update(chunk)
      await file.write(chunk)
    })
  } finally {
    await file.close()
  }
  return hash.digest("hex")
}

async function readLimited(response: Response, maximum: number, label: string) {
  const chunks: Uint8Array[] = []
  const size = await streamLimited(response, maximum, label, (chunk) => {
    chunks.push(chunk)
  })
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function streamLimited(
  response: Response,
  maximum: number,
  label: string,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
) {
  if (!isHttpsUrl(response.url)) throw new DesktopError(`Request for ${label} did not resolve to an HTTPS URL`)
  if (!response.ok) throw new DesktopError(`Request for ${label} failed: HTTP ${response.status}`)
  const declared = Number(response.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maximum) throw new DesktopError(`Response for ${label} exceeds ${maximum} bytes`)
  if (!response.body) throw new DesktopError(`Response for ${label} has no body`)
  const reader = response.body.getReader()
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new DesktopError(`Response for ${label} exceeds ${maximum} bytes`)
      await onChunk(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return size
}

function checksumEntry(text: string, asset: string) {
  const matches = text
    .split(/\r?\n/)
    .map((line) => /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match?.[2] === asset)
  const digest = matches.length === 1 ? matches[0]?.[1] : undefined
  if (!digest) throw new DesktopError(`Checksum file does not contain exactly one entry for ${asset}`)
  return digest.toLowerCase()
}

async function locateExtractedApp(workDir: string) {
  const apps = (await readdir(workDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  )
  const app = apps.length === 1 ? apps[0] : undefined
  if (!app) throw new DesktopError("The update archive must contain exactly one application bundle")
  return path.join(workDir, app.name)
}

async function verifyBundleIdentifier(runCommand: UpdateRunCommand, app: string) {
  const result = await runChecked(
    runCommand,
    ["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(app, "Contents/Info.plist")],
    "Reading the update bundle identifier",
  )
  const identifier = result.stdout.trim()
  if (identifier !== DESKTOP_BUNDLE_IDENTIFIER)
    throw new DesktopError(`The update bundle identifier ${JSON.stringify(identifier)} is not ${DESKTOP_BUNDLE_IDENTIFIER}`)
}

async function verifySignature(runCommand: UpdateRunCommand, app: string) {
  await runChecked(runCommand, ["/usr/bin/codesign", "--verify", "--deep", "--strict", app], "Verifying the update signature")
  const result = await runChecked(runCommand, ["/usr/bin/codesign", "-d", "-r-", app], "Reading the update signing requirement")
  const expected = new RegExp(
    `^designated => identifier "${DESKTOP_BUNDLE_IDENTIFIER.replaceAll(".", "\\.")}" and certificate (?:leaf|root) = H"([0-9a-fA-F]{40})"$`,
  )
  const pinned = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .some((line) => expected.exec(line.trim())?.[1]?.toLowerCase() === DESKTOP_SIGNING_CERT_SHA1)
  if (!pinned) throw new DesktopError("The update is not signed by the pinned YCoding Desktop certificate")
}

async function runChecked(runCommand: UpdateRunCommand, command: readonly string[], label: string) {
  const result = await runCommand(command)
  if (result.exitCode !== 0) throw new DesktopError(`${label} failed: ${(result.stderr || result.stdout).trim()}`)
  return result
}

async function runProcess(command: readonly string[]): Promise<UpdateCommandResult> {
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function requireVersion(version: string, label: string) {
  const parsed = parseVersion(version)
  if (!parsed) throw new DesktopError(`Invalid ${label}: ${JSON.stringify(version)}`)
  return parsed
}

function requireNewer(version: string, current: Version) {
  if (compareVersions(requireVersion(version, "target version"), current) <= 0)
    throw new DesktopError(`Target version ${version} is not newer than the installed version`)
}

function parseVersion(version: string): Version | undefined {
  const match = semverPattern.exec(version)
  if (!match) return undefined
  const [, major = "", minor = "", patch = "", prerelease] = match
  return { core: [major, minor, patch], prerelease: prerelease === undefined ? [] : prerelease.split(".") }
}

function compareVersions(left: Version, right: Version) {
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumeric(left.core[index] ?? "0", right.core[index] ?? "0")
    if (order !== 0) return order
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return Math.sign(right.prerelease.length - left.prerelease.length)
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return compareNumeric(a, b)
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
