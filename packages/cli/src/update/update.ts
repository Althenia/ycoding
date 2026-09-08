import { chmod, lstat, mkdtemp, rename, rm } from "node:fs/promises"
import path from "node:path"
import semver from "semver"

const repository = "Althenia/ycoding"
const maxArchiveBytes = 512 * 1024 * 1024
const maxChecksumsBytes = 1024 * 1024

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type InstallReleaseInput = {
  readonly version: string
  readonly executable: string
  readonly platform: string
  readonly arch: string
  readonly fetch?: Fetch
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
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Installed ycoding executable must be a regular file")
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
  try {
    const candidate = path.join(temporary, "ycoding")
    const extracted = await new Bun.Archive(archive).extract(temporary, { glob: "ycoding" })
    const file = await lstat(candidate)
    if (extracted !== 1 || !file.isFile() || file.isSymbolicLink() || file.size === 0 || file.size > maxArchiveBytes) {
      throw new Error("Release archive did not contain one regular direct ycoding executable")
    }
    await chmod(candidate, 0o755)
    await rename(candidate, input.executable)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return { version: input.version, asset }
}

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
