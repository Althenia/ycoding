import { access, constants, mkdir, rm } from "node:fs/promises"
import path from "node:path"

export const pinnedVersion = "155.0.8059.39"
export const metadataURL = `https://googlechromelabs.github.io/chrome-for-testing/${pinnedVersion}.json`
export const minimumMajor = 152
const platform = "mac-arm64"
const executable = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const maxMetadataBytes = 1024 * 1024
const maxArchiveBytes = 512 * 1024 * 1024

export async function provision(input: { readonly destination: string; readonly metadataURL?: string }) {
  const metadata = await download(input.metadataURL ?? metadataURL, maxMetadataBytes)
  const pinned = readPinned(metadata)
  const archive = await download(pinned.url, maxArchiveBytes)

  await rm(input.destination, { recursive: true, force: true })
  await mkdir(input.destination, { recursive: true })
  const archivePath = path.join(input.destination, "chrome.zip")
  await Bun.write(archivePath, archive)
  const extraction = Bun.spawnSync(["unzip", "-q", "-o", archivePath, "-d", input.destination], { stdout: "pipe", stderr: "pipe" })
  if (extraction.exitCode !== 0) throw new Error(`Failed to extract Chrome for Testing: ${extraction.stderr.toString().trim()}`)
  await rm(archivePath)

  const binary = path.join(input.destination, executable)
  await access(binary, constants.X_OK).catch(() => {
    throw new Error("The Chrome for Testing archive did not contain an executable browser")
  })
  const reported = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  const version = /(\d+\.\d+\.\d+\.\d+)/.exec(reported.stdout.toString())?.[1]
  if (reported.exitCode !== 0 || version !== pinned.version)
    throw new Error(`Chrome for Testing reported ${version ?? "no version"} instead of ${pinned.version}`)
  return binary
}

async function download(url: string, limit: number) {
  const target = new URL(url)
  if (target.protocol !== "https:" && !(target.protocol === "http:" && target.hostname === "127.0.0.1"))
    throw new Error(`Refusing to download from a non-HTTPS address: ${target.origin}`)
  const response = await fetch(target, { redirect: "error" })
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${target.origin}${target.pathname}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error(`Download exceeds ${limit} bytes: ${target.origin}${target.pathname}`)
  return bytes
}

function readPinned(bytes: Uint8Array) {
  const root = record(JSON.parse(new TextDecoder().decode(bytes)))
  if (root.version !== pinnedVersion)
    throw new Error(`Chrome for Testing metadata is for ${typeof root.version === "string" ? root.version : "no version"} instead of the pinned ${pinnedVersion}`)
  if (Number(pinnedVersion.split(".")[0]) < minimumMajor)
    throw new Error(`Chrome for Testing ${pinnedVersion} is older than the required major ${minimumMajor}`)
  const downloads = record(root.downloads).chrome
  const entry = Array.isArray(downloads) ? downloads.map(record).find((item) => item.platform === platform) : undefined
  if (typeof entry?.url !== "string") throw new Error(`Chrome for Testing metadata has no ${platform} download`)
  return { version: pinnedVersion, url: entry.url }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chrome for Testing metadata has an unexpected shape")
  return Object.fromEntries(Object.entries(value))
}

if (import.meta.main) {
  const destination = process.argv[2]
  if (!destination) {
    console.error("usage: bun script/chrome-for-testing.ts <destination-directory>")
    process.exit(2)
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error(`Chrome for Testing provisioning supports darwin/arm64, got ${process.platform}/${process.arch}`)
    process.exit(1)
  }
  await provision({ destination: path.resolve(destination) }).then(
    (binary) => console.log(binary),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
