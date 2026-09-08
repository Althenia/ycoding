import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installRelease, latestRelease, releaseTarget, validVersion } from "../src/update/update"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("release updater", () => {
  test("validates release versions and supported platforms", () => {
    expect(validVersion("0.1.0")).toBe(true)
    expect(validVersion("1.2.3-beta.1")).toBe(true)
    expect(validVersion("01.2.3")).toBe(false)
    expect(validVersion("../../1.2.3")).toBe(false)
    expect(releaseTarget("darwin", "arm64")).toBe("darwin-arm64")
    expect(releaseTarget("linux", "x64")).toBe("linux-x64")
    expect(() => releaseTarget("linux", "arm64")).toThrow("Unsupported platform")
  })

  test("validates the latest version returned by the fixed GitHub API", async () => {
    const urls: string[] = []
    const version = await latestRelease(async (url) => {
      urls.push(url)
      return Response.json({ tag_name: "v1.2.3-beta.1" })
    })

    expect(version).toBe("1.2.3-beta.1")
    expect(urls).toEqual(["https://api.github.com/repos/Althenia/ycoding/releases/latest"])
    expect(
      await latestRelease(async () => Response.json({ tag_name: "../../bad" })).then(
        () => "",
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
    ).toContain("invalid version")
  })

  test("downloads from the fixed repository, verifies SHA256, and atomically replaces the executable", async () => {
    const fixture = await setup()
    const urls: string[] = []

    const result = await installRelease({
      version: "0.1.0",
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: async (url) => {
        urls.push(url)
        if (url.endsWith("checksums.txt")) return new Response(fixture.checksums)
        if (url.endsWith("darwin-arm64.tar.gz")) return new Response(fixture.archive)
        return new Response("not found", { status: 404 })
      },
    })

    expect(result).toEqual({ version: "0.1.0", asset: "ycoding-0.1.0-darwin-arm64.tar.gz" })
    expect(urls).toEqual([
      "https://github.com/Althenia/ycoding/releases/download/v0.1.0/ycoding-0.1.0-checksums.txt",
      "https://github.com/Althenia/ycoding/releases/download/v0.1.0/ycoding-0.1.0-darwin-arm64.tar.gz",
    ])
    expect(await readFile(fixture.executable, "utf8")).toBe("new executable\n")
    expect(await Array.fromAsync(new Bun.Glob(".ycoding-update-*").scan(fixture.root))).toEqual([])
  })

  test("preserves the installed executable and cleans temporary files on checksum failure", async () => {
    const fixture = await setup()

    expect(
      await installRelease({
        version: "0.1.0",
        executable: fixture.executable,
        platform: "darwin",
        arch: "arm64",
        fetch: async (url) =>
          new Response(url.endsWith("checksums.txt") ? `${"0".repeat(64)}  ${fixture.asset}\n` : fixture.archive),
      }).then(
        () => "",
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
    ).toContain("Checksum verification failed")
    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect(await Array.fromAsync(new Bun.Glob(".ycoding-update-*").scan(fixture.root))).toEqual([])
  })
})

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-update-test-"))
  temporary.push(root)
  const source = path.join(root, "source")
  await mkdir(source)
  await writeFile(path.join(source, "ycoding"), "new executable\n")
  await chmod(path.join(source, "ycoding"), 0o755)
  const asset = "ycoding-0.1.0-darwin-arm64.tar.gz"
  const archiveFile = path.join(root, asset)
  const tar = Bun.spawnSync(["tar", "-C", source, "-czf", archiveFile, "ycoding"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  expect(tar.exitCode).toBe(0)
  const archive = new Uint8Array(await Bun.file(archiveFile).arrayBuffer())
  const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
  const executable = path.join(root, "ycoding")
  await writeFile(executable, "old executable\n")
  return { root, executable, archive, asset, checksums: `${digest}  ${asset}\n` }
}
