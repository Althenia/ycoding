import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installRelease, latestRelease, releaseTarget, validVersion } from "../src/update/update"

const temporary: string[] = []
const fixtureVersion = process.env.YCODING_TEST_VERSION ?? "9.9.9"
const legacyVersion = "0.1.2"

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("release updater", () => {
  test("validates release versions and supported platforms", () => {
    expect(validVersion(fixtureVersion)).toBe(true)
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

  test("verifies and installs the complete macOS executable pair", async () => {
    const fixture = await setup()
    const urls: string[] = []

    const result = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture, urls),
    })

    expect(result).toEqual({ version: fixture.version, asset: fixture.asset })
    expect(urls).toEqual([
      `https://github.com/Althenia/ycoding/releases/download/v${fixture.version}/ycoding-${fixture.version}-checksums.txt`,
      `https://github.com/Althenia/ycoding/releases/download/v${fixture.version}/${fixture.asset}`,
    ])
    expect(await readFile(fixture.executable, "utf8")).toBe("new executable\n")
    expect(await readFile(fixture.helper, "utf8")).toBe("new helper\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("adds the helper when upgrading a single-file macOS installation", async () => {
    const fixture = await setup({ existingHelper: false })

    await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
    })

    expect(await readFile(fixture.executable, "utf8")).toBe("new executable\n")
    expect(await readFile(fixture.helper, "utf8")).toBe("new helper\n")
  })

  test("rejects an existing helper directory without changing its contents", async () => {
    const fixture = await setup({ existingHelper: false })
    await mkdir(fixture.helper)
    const retained = path.join(fixture.helper, "keep.txt")
    await writeFile(retained, "keep\n")

    const error = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
    }).then(
      () => "",
      (cause) => (cause instanceof Error ? cause.message : String(cause)),
    )

    expect(error).toContain("Installed computer helper must be a regular file")
    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect(await readFile(retained, "utf8")).toBe("keep\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("rejects an existing helper symlink without changing its target", async () => {
    const fixture = await setup({ existingHelper: false })
    const target = path.join(fixture.root, "helper-target")
    await writeFile(target, "target\n")
    await symlink(target, fixture.helper)

    const error = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
    }).then(
      () => "",
      (cause) => (cause instanceof Error ? cause.message : String(cause)),
    )

    expect(error).toContain("Installed computer helper must be a regular file")
    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect((await lstat(fixture.helper)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, "utf8")).toBe("target\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("keeps Linux self-update single-file", async () => {
    const fixture = await setup({ target: "linux-x64", entries: ["ycoding"] })

    await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "linux",
      arch: "x64",
      fetch: fixtureFetch(fixture),
    })

    expect(await readFile(fixture.executable, "utf8")).toBe("new executable\n")
    expect(await readFile(fixture.helper, "utf8")).toBe("old helper\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("rejects a helper added to the Linux single-file archive", async () => {
    const fixture = await setup({ target: "linux-x64" })

    const error = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "linux",
      arch: "x64",
      fetch: fixtureFetch(fixture),
    }).then(
      () => "",
      (cause) => (cause instanceof Error ? cause.message : String(cause)),
    )

    expect(error).toContain("exact direct entries: ycoding")
    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect(await readFile(fixture.helper, "utf8")).toBe("old helper\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("accepts the published pre-0.2.0 single-file macOS archive contract", async () => {
    const fixture = await setup({ version: legacyVersion, entries: ["ycoding"] })

    await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
    })

    expect(await readFile(fixture.executable, "utf8")).toBe("new executable\n")
    expect(await readFile(fixture.helper, "utf8")).toBe("old helper\n")
  })

  test("atomically replaces single-file Linux and pre-0.2.0 macOS installations directly", async () => {
    const fixtures = [
      {
        fixture: await setup({ target: "linux-x64", entries: ["ycoding"] }),
        platform: "linux",
        arch: "x64",
      },
      {
        fixture: await setup({ version: legacyVersion, entries: ["ycoding"] }),
        platform: "darwin",
        arch: "arm64",
      },
    ]

    for (const item of fixtures) {
      const moves: Array<{ source: string; destination: string }> = []
      await installRelease({
        version: item.fixture.version,
        executable: item.fixture.executable,
        platform: item.platform,
        arch: item.arch,
        fetch: fixtureFetch(item.fixture),
        filesystem: {
          rename: async (source, destination) => {
            moves.push({ source, destination })
            await rename(source, destination)
          },
        },
      })

      expect(moves).toHaveLength(1)
      expect(moves[0]?.source).toContain("/.ycoding-update-")
      expect(path.basename(moves[0]?.source ?? "")).toBe("ycoding")
      expect(moves[0]?.destination).toBe(item.fixture.executable)
      expect(await readFile(item.fixture.helper, "utf8")).toBe("old helper\n")
      expect(await updatePaths(item.fixture.root)).toEqual([])
    }
  })

  test("rejects missing, extra, nested, symlink, and empty macOS helper entries", async () => {
    const invalid = [
      {
        fixture: await setup({ entries: ["ycoding"] }),
        expected: "exact direct entries",
      },
      {
        fixture: await setup({ entries: ["ycoding", "ycoding-computer-helper", "extra"] }),
        expected: "exact direct entries",
      },
      {
        fixture: await setup({ entries: ["ycoding", "ycoding-computer-helper", "nested/file"] }),
        expected: "exact direct entries",
      },
      {
        fixture: await setup({ helperSymlink: true }),
        expected: "exact direct entries",
      },
      {
        fixture: await setup({ emptyHelper: true }),
        expected: "regular nonempty direct file",
      },
    ]

    for (const item of invalid) {
      expect(
        await installRelease({
          version: item.fixture.version,
          executable: item.fixture.executable,
          platform: "darwin",
          arch: "arm64",
          fetch: fixtureFetch(item.fixture),
        }).then(
          () => "",
          (error) => (error instanceof Error ? error.message : String(error)),
        ),
      ).toContain(item.expected)
      expect(await readFile(item.fixture.executable, "utf8")).toBe("old executable\n")
      expect(await readFile(item.fixture.helper, "utf8")).toBe("old helper\n")
      expect(await updatePaths(item.fixture.root)).toEqual([])
    }
  })

  test("restores the installed macOS pair when the second replacement fails", async () => {
    const fixture = await setup()
    let failed = false

    const error = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
      filesystem: {
        rename: async (source, destination) => {
          if (destination === fixture.executable && !source.includes(".ycoding-update-backup-") && !failed) {
            failed = true
            throw new Error("injected second replacement failure")
          }
          await rename(source, destination)
        },
      },
    }).then(
      () => "",
      (cause) => (cause instanceof Error ? cause.message : String(cause)),
    )

    expect(error).toContain("injected second replacement failure")
    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect(await readFile(fixture.helper, "utf8")).toBe("old helper\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("removes a newly added helper when the main executable replacement fails", async () => {
    const fixture = await setup({ existingHelper: false })

    const error = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
      filesystem: {
        rename: async (source, destination) => {
          if (destination === fixture.executable && !source.includes(".ycoding-update-backup-")) {
            throw new Error("injected second replacement failure")
          }
          await rename(source, destination)
        },
      },
    }).then(
      () => "",
      (cause) => (cause instanceof Error ? cause.message : String(cause)),
    )

    expect(error).toContain("injected second replacement failure")
    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect(await Bun.file(fixture.helper).exists()).toBe(false)
    expect(await updatePaths(fixture.root)).toEqual([])
  })

  test("retains an old helper backup with recovery guidance when restore fails", async () => {
    const fixture = await setup()
    let replacementFailed = false

    const error = await installRelease({
      version: fixture.version,
      executable: fixture.executable,
      platform: "darwin",
      arch: "arm64",
      fetch: fixtureFetch(fixture),
      filesystem: {
        rename: async (source, destination) => {
          if (destination === fixture.executable && !source.includes(".ycoding-update-backup-") && !replacementFailed) {
            replacementFailed = true
            throw new Error("injected second replacement failure")
          }
          if (source.includes(".ycoding-update-backup-") && destination === fixture.helper) {
            throw new Error("injected helper restore failure")
          }
          await rename(source, destination)
        },
      },
    }).then(
      () => "",
      (cause) => (cause instanceof Error ? cause.message : String(cause)),
    )

    expect(await readFile(fixture.executable, "utf8")).toBe("old executable\n")
    expect(await Bun.file(fixture.helper).exists()).toBe(false)
    const backups = await Array.fromAsync(
      new Bun.Glob(".ycoding-update-backup-*/ycoding-computer-helper").scan(fixture.root),
    )
    expect(backups).toHaveLength(1)
    expect(await readFile(path.join(fixture.root, backups[0]), "utf8")).toBe("old helper\n")
    expect(error).toContain(`Computer helper backup retained at ${path.join(fixture.root, backups[0])}`)
    expect(error).toContain(`Move that backup to ${fixture.helper}`)
  })

  test("preserves the installed pair and cleans temporary files on checksum failure", async () => {
    const fixture = await setup()

    expect(
      await installRelease({
        version: fixture.version,
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
    expect(await readFile(fixture.helper, "utf8")).toBe("old helper\n")
    expect(await updatePaths(fixture.root)).toEqual([])
  })
})

async function setup(
  options: {
    version?: string
    target?: "darwin-arm64" | "linux-x64"
    entries?: string[]
    helperSymlink?: boolean
    emptyHelper?: boolean
    existingHelper?: boolean
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-update-test-"))
  temporary.push(root)
  const source = path.join(root, "source")
  await mkdir(path.join(source, "nested"), { recursive: true })
  await writeFile(path.join(source, "ycoding"), "new executable\n")
  await writeFile(path.join(source, "extra"), "extra\n")
  await writeFile(path.join(source, "nested/file"), "nested\n")
  if (options.helperSymlink) await symlink("ycoding", path.join(source, "ycoding-computer-helper"))
  else await writeFile(path.join(source, "ycoding-computer-helper"), options.emptyHelper ? "" : "new helper\n")
  await chmod(path.join(source, "ycoding"), 0o755)
  if (!options.helperSymlink) await chmod(path.join(source, "ycoding-computer-helper"), 0o755)
  const version = options.version ?? fixtureVersion
  const target = options.target ?? "darwin-arm64"
  const asset = `ycoding-${version}-${target}.tar.gz`
  const archiveFile = path.join(root, asset)
  const tar = Bun.spawnSync(
    ["tar", "-C", source, "-czf", archiveFile, ...(options.entries ?? ["ycoding", "ycoding-computer-helper"])],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  )
  expect(tar.exitCode).toBe(0)
  const archive = new Uint8Array(await Bun.file(archiveFile).arrayBuffer())
  const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
  const executable = path.join(root, "ycoding")
  const helper = path.join(root, "ycoding-computer-helper")
  await writeFile(executable, "old executable\n")
  if (options.existingHelper !== false) await writeFile(helper, "old helper\n")
  return {
    root,
    executable,
    helper,
    archive,
    asset,
    version,
    checksums: `${digest}  ${asset}\n`,
  }
}

function fixtureFetch(fixture: Awaited<ReturnType<typeof setup>>, urls?: string[]) {
  return async (url: string) => {
    urls?.push(url)
    if (url.endsWith("checksums.txt")) return new Response(fixture.checksums)
    if (url.endsWith(fixture.asset)) return new Response(fixture.archive)
    return new Response("not found", { status: 404 })
  }
}

const updatePaths = (root: string) => Array.fromAsync(new Bun.Glob(".ycoding-update-*").scan(root))
