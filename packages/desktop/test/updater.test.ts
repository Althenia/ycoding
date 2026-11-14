import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DESKTOP_BUNDLE_IDENTIFIER,
  DESKTOP_GITHUB_LATEST_RELEASE_URL,
  DESKTOP_SIGNING_CERT_SHA1,
  checkForUpdates,
  installUpdate,
  resolveAppBundlePath,
} from "../src/updater"

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true })
  return response
}

function jsonResponse(payload: unknown, url = DESKTOP_GITHUB_LATEST_RELEASE_URL, status = 200, headers?: HeadersInit): Response {
  return withUrl(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
    url,
  )
}

function chunkedStreamResponse(url: string, chunk: Uint8Array, repeat: number, headers?: HeadersInit): Response {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= repeat) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(chunk)
    },
  })
  return withUrl(new Response(stream, { status: 200, headers }), url)
}

function releasePayload(
  options: {
    tagName?: string
    version?: string
    includeZip?: boolean
    includeChecksums?: boolean
    zipProtocol?: "https" | "http"
    checksumsProtocol?: "https" | "http"
    body?: string
  } = {},
) {
  const version = options.version ?? "1.19.0"
  const tagName = options.tagName ?? `v${version}`
  const zipProtocol = options.zipProtocol ?? "https"
  const checksumsProtocol = options.checksumsProtocol ?? "https"
  const assets: Array<{ name: string; browser_download_url: string }> = []
  if (options.includeZip !== false) {
    assets.push({
      name: `YCoding-Desktop-v${version}-darwin-arm64.zip`,
      browser_download_url: `${zipProtocol}://github.com/Althenia/ycoding/releases/download/v${version}/YCoding-Desktop-v${version}-darwin-arm64.zip`,
    })
  }
  if (options.includeChecksums !== false) {
    assets.push({
      name: `ycoding-${version}-checksums.txt`,
      browser_download_url: `${checksumsProtocol}://github.com/Althenia/ycoding/releases/download/v${version}/ycoding-${version}-checksums.txt`,
    })
  }
  return {
    tag_name: tagName,
    html_url: `https://github.com/Althenia/ycoding/releases/tag/${tagName}`,
    published_at: "2026-11-14T10:00:00Z",
    body: options.body ?? `Release notes for ${version}`,
    assets,
  }
}

function infoPlist(bundleIdentifier: string, version: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleExecutable</key>",
    "  <string>launcher</string>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>${bundleIdentifier}</string>`,
    "  <key>CFBundleName</key>",
    "  <string>YCoding Desktop</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${version}</string>`,
    "  <key>CFBundleVersion</key>",
    `  <string>${version}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

function designatedRequirement(sha1: string, identifier = DESKTOP_BUNDLE_IDENTIFIER, anchor: "leaf" | "root" = "leaf"): string {
  return `designated => identifier "${identifier}" and certificate ${anchor} = H"${sha1}"\n`
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-updater-"))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createInstallFixture(
  root: string,
  options: {
    currentVersion?: string
    targetVersion?: string
    bundleIdentifier?: string
    omitInfoPlist?: boolean
  } = {},
) {
  const currentVersion = options.currentVersion ?? "1.18.4"
  const targetVersion = options.targetVersion ?? "2.0.0"
  const appsDir = path.join(root, "apps")
  const appBundlePath = path.join(appsDir, "YCoding Desktop.app")
  await mkdir(path.join(appBundlePath, "Contents/MacOS"), { recursive: true })
  await mkdir(path.join(appBundlePath, "Contents/Resources"), { recursive: true })
  await writeFile(path.join(appBundlePath, "Contents/Info.plist"), infoPlist(DESKTOP_BUNDLE_IDENTIFIER, currentVersion))
  await writeFile(path.join(appBundlePath, "Contents/MacOS/launcher"), `launcher-${currentVersion}\n`, { mode: 0o755 })
  await writeFile(path.join(appBundlePath, "Contents/Resources/installed-only.txt"), `installed-${currentVersion}\n`)

  const stageDir = path.join(root, "stage")
  const stagedApp = path.join(stageDir, "YCoding Desktop.app")
  await mkdir(path.join(stagedApp, "Contents/MacOS"), { recursive: true })
  await mkdir(path.join(stagedApp, "Contents/Resources"), { recursive: true })
  if (!options.omitInfoPlist) {
    await writeFile(
      path.join(stagedApp, "Contents/Info.plist"),
      infoPlist(options.bundleIdentifier ?? DESKTOP_BUNDLE_IDENTIFIER, targetVersion),
    )
  }
  await writeFile(path.join(stagedApp, "Contents/MacOS/launcher"), `launcher-${targetVersion}\n`, { mode: 0o755 })
  await writeFile(path.join(stagedApp, "Contents/Resources/AppIcon.icns"), `icns-${targetVersion}\n`)

  const zipName = `YCoding-Desktop-v${targetVersion}-darwin-arm64.zip`
  const checksumsName = `ycoding-${targetVersion}-checksums.txt`
  const zipPath = path.join(root, zipName)
  const packed = Bun.spawnSync(
    ["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--keepParent", stagedApp, zipPath],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(packed.exitCode, packed.stderr.toString()).toBe(0)

  const zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer())
  const zipSha256 = createHash("sha256").update(zipBytes).digest("hex")
  const unrelatedHash = "a".repeat(64)
  const checksumsText = [
    `${unrelatedHash}  ycoding-${targetVersion}-darwin-arm64.tar.gz`,
    `${zipSha256}  ${zipName}`,
    `${unrelatedHash}  ycoding-${targetVersion}-linux-x64.tar.gz`,
    "",
  ].join("\n")

  return {
    appsDir,
    appBundlePath,
    currentVersion,
    targetVersion,
    zipName,
    checksumsName,
    zipBytes,
    zipSha256,
    checksumsText,
  }
}

async function runRealCommand(command: readonly string[]): Promise<CommandResult> {
  const binary = command[0]
  if (!binary) throw new Error("Empty command")
  const child = Bun.spawn([binary, ...command.slice(1)], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function createCommandRunner(
  commands: string[][],
  options: {
    verifyResult?: CommandResult
    requirementResult?: CommandResult
    onAfterRequirement?: (extractedApp: string) => Promise<void>
  } = {},
) {
  return async (command: readonly string[]): Promise<CommandResult> => {
    commands.push([...command])
    if (command[0] === "/usr/bin/ditto" || command[0] === "/usr/libexec/PlistBuddy" || command[0] === "/usr/bin/plutil") {
      return runRealCommand(command)
    }
    if (command[0] === "/usr/bin/codesign") {
      if (command.includes("--verify")) {
        return options.verifyResult ?? { exitCode: 0, stdout: "", stderr: "" }
      }
      if (command.includes("-d")) {
        const extractedApp = command.at(-1) ?? ""
        const result = options.requirementResult ?? {
          exitCode: 0,
          stdout: designatedRequirement(DESKTOP_SIGNING_CERT_SHA1),
          stderr: `Executable=${extractedApp}/Contents/MacOS/launcher\n`,
        }
        if (options.onAfterRequirement) {
          await options.onAfterRequirement(extractedApp)
        }
        return result
      }
    }
    throw new Error(`Unexpected command: ${command.join(" ")}`)
  }
}

describe("desktop updater constants and bundle path resolution", () => {
  test("exports pinned GitHub release URL, bundle identifier, and signing certificate SHA-1", () => {
    expect(DESKTOP_GITHUB_LATEST_RELEASE_URL).toBe("https://api.github.com/repos/Althenia/ycoding/releases/latest")
    expect(DESKTOP_BUNDLE_IDENTIFIER).toBe("app.ycoding.desktop")
    expect(DESKTOP_SIGNING_CERT_SHA1).toBe("9dd524184b0db949ffac7f0ada0ae860ac7f5f85")
  })

  test("resolves the enclosing .app bundle from launcher and runtime paths", () => {
    expect(resolveAppBundlePath("/Users/synthetic/Apps/YCoding Desktop.app/Contents/MacOS/launcher")).toBe(
      "/Users/synthetic/Apps/YCoding Desktop.app",
    )
    expect(resolveAppBundlePath("/Users/synthetic/Apps/YCoding Desktop.app/Contents/Resources/app/runtime")).toBe(
      "/Users/synthetic/Apps/YCoding Desktop.app",
    )
    expect(
      resolveAppBundlePath("/Users/synthetic/Apps/YCoding Desktop.app/Contents/Resources/app/runtime/backend/ycoding"),
    ).toBe("/Users/synthetic/Apps/YCoding Desktop.app")
  })

  test("returns null when running unbundled from development or worktree paths", () => {
    expect(resolveAppBundlePath("/repo/packages/desktop/src/runtime")).toBeNull()
    expect(resolveAppBundlePath("/Users/synthetic/worktrees/desktop/packages/desktop/runtime/backend/ycoding")).toBeNull()
    expect(resolveAppBundlePath("/usr/local/bin/ycoding")).toBeNull()
  })
})

describe("checkForUpdates", () => {
  test("requests the latest GitHub release with Accept header and AbortSignal timeout and reports an installable update", async () => {
    await withTempDir(async (root) => {
      const appBundlePath = path.join(root, "YCoding Desktop.app")
      await mkdir(appBundlePath, { recursive: true })
      const requests: Array<{ url: string; accept: string | null; hasAbortSignal: boolean }> = []

      const result = await checkForUpdates({
        currentVersion: "1.18.4",
        appBundlePath,
        platform: "darwin",
        arch: "arm64",
        access: async () => {},
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            accept: new Headers(init?.headers).get("accept"),
            hasAbortSignal: init?.signal instanceof AbortSignal && !init.signal.aborted,
          })
          return jsonResponse(
            releasePayload({
              version: "1.19.0",
              body: "Signed desktop self-update support",
            }),
          )
        },
      })

      expect(requests).toEqual([
        {
          url: DESKTOP_GITHUB_LATEST_RELEASE_URL,
          accept: "application/vnd.github+json",
          hasAbortSignal: true,
        },
      ])
      expect(result).toMatchObject({
        currentVersion: "1.18.4",
        latestVersion: "1.19.0",
        updateAvailable: true,
        releaseUrl: "https://github.com/Althenia/ycoding/releases/tag/v1.19.0",
        publishedAt: "2026-11-14T10:00:00Z",
        releaseNotes: "Signed desktop self-update support",
        canInstall: true,
      })
    })
  })

  test("reports updateAvailable false and canInstall false when latestVersion is equal to or older than currentVersion", async () => {
    await withTempDir(async (root) => {
      const appBundlePath = path.join(root, "YCoding Desktop.app")
      await mkdir(appBundlePath, { recursive: true })

      for (const [currentVersion, latestVersion] of [
        ["1.19.0", "1.19.0"],
        ["1.20.0", "1.19.0"],
        ["1.19.0", "1.19.0-rc.1"],
      ] as const) {
        const result = await checkForUpdates({
          currentVersion,
          appBundlePath,
          platform: "darwin",
          arch: "arm64",
          access: async () => {},
          fetch: async () => jsonResponse(releasePayload({ version: latestVersion })),
        })

        expect(result.currentVersion).toBe(currentVersion)
        expect(result.latestVersion).toBe(latestVersion)
        expect(result.updateAvailable).toBe(false)
        expect(result.canInstall).toBe(false)
      }
    })
  })

  test("rejects non-HTTPS responses, HTTP error statuses, oversized payloads above 1 MiB, and invalid semver tags", async () => {
    await withTempDir(async (root) => {
      const appBundlePath = path.join(root, "YCoding Desktop.app")
      await mkdir(appBundlePath, { recursive: true })

      await expect(
        checkForUpdates({
          currentVersion: "1.18.4",
          appBundlePath,
          platform: "darwin",
          arch: "arm64",
          access: async () => {},
          fetch: async () =>
            jsonResponse(releasePayload(), "http://api.github.com/repos/Althenia/ycoding/releases/latest"),
        }),
      ).rejects.toThrow()

      for (const status of [403, 404, 500]) {
        await expect(
          checkForUpdates({
            currentVersion: "1.18.4",
            appBundlePath,
            platform: "darwin",
            arch: "arm64",
            access: async () => {},
            fetch: async () => jsonResponse({ message: "error" }, DESKTOP_GITHUB_LATEST_RELEASE_URL, status),
          }),
        ).rejects.toThrow()
      }

      await expect(
        checkForUpdates({
          currentVersion: "1.18.4",
          appBundlePath,
          platform: "darwin",
          arch: "arm64",
          access: async () => {},
          fetch: async () =>
            jsonResponse(releasePayload(), DESKTOP_GITHUB_LATEST_RELEASE_URL, 200, {
              "content-length": String(1024 * 1024 + 1),
            }),
        }),
      ).rejects.toThrow()

      const chunk = new TextEncoder().encode("x".repeat(64 * 1024))
      await expect(
        checkForUpdates({
          currentVersion: "1.18.4",
          appBundlePath,
          platform: "darwin",
          arch: "arm64",
          access: async () => {},
          fetch: async () => chunkedStreamResponse(DESKTOP_GITHUB_LATEST_RELEASE_URL, chunk, 17),
        }),
      ).rejects.toThrow()

      for (const badTag of ["", "latest", "v01.2.3", "../../1.2.3", "vnot-semver"]) {
        await expect(
          checkForUpdates({
            currentVersion: "1.18.4",
            appBundlePath,
            platform: "darwin",
            arch: "arm64",
            access: async () => {},
            fetch: async () => jsonResponse(releasePayload({ tagName: badTag })),
          }),
        ).rejects.toThrow()
      }
    })
  })

  test("returns gracefully with canInstall false and cannotInstallReason when unbundled, unsupported target, missing HTTPS assets, or read-only volume", async () => {
    await withTempDir(async (root) => {
      const appBundlePath = path.join(root, "YCoding Desktop.app")
      await mkdir(appBundlePath, { recursive: true })

      const unbundled = await checkForUpdates({
        currentVersion: "1.18.4",
        appBundlePath: null,
        platform: "darwin",
        arch: "arm64",
        access: async () => {},
        fetch: async () => jsonResponse(releasePayload({ version: "1.19.0" })),
      })
      expect(unbundled.updateAvailable).toBe(true)
      expect(unbundled.canInstall).toBe(false)
      expect(typeof unbundled.cannotInstallReason).toBe("string")
      expect(unbundled.cannotInstallReason?.trim().length).toBeGreaterThan(0)

      for (const [platform, arch] of [
        ["linux", "x64"],
        ["darwin", "x64"],
      ] as const) {
        const unsupported = await checkForUpdates({
          currentVersion: "1.18.4",
          appBundlePath,
          platform,
          arch,
          access: async () => {},
          fetch: async () => jsonResponse(releasePayload({ version: "1.19.0" })),
        })
        expect(unsupported.updateAvailable).toBe(true)
        expect(unsupported.canInstall).toBe(false)
        expect(unsupported.cannotInstallReason?.trim().length).toBeGreaterThan(0)
      }

      for (const assetOverride of [
        { includeZip: false },
        { includeChecksums: false },
        { zipProtocol: "http" as const },
        { checksumsProtocol: "http" as const },
      ]) {
        const missingAsset = await checkForUpdates({
          currentVersion: "1.18.4",
          appBundlePath,
          platform: "darwin",
          arch: "arm64",
          access: async () => {},
          fetch: async () => jsonResponse(releasePayload({ version: "1.19.0", ...assetOverride })),
        })
        expect(missingAsset.updateAvailable).toBe(true)
        expect(missingAsset.canInstall).toBe(false)
        expect(missingAsset.cannotInstallReason?.trim().length).toBeGreaterThan(0)
      }

      for (const code of ["EROFS", "EACCES"] as const) {
        const readOnly = await checkForUpdates({
          currentVersion: "1.18.4",
          appBundlePath,
          platform: "darwin",
          arch: "arm64",
          access: async () => {
            throw Object.assign(new Error(`${code}: bundle location is not writable`), { code })
          },
          fetch: async () => jsonResponse(releasePayload({ version: "1.19.0" })),
        })
        expect(readOnly.updateAvailable).toBe(true)
        expect(readOnly.canInstall).toBe(false)
        expect(readOnly.cannotInstallReason?.trim().length).toBeGreaterThan(0)
      }
    })
  })
})

describe("installUpdate", () => {
  test("refuses immediately when appBundlePath is null, non-writable, unsupported target, or targetVersion is invalid or not newer", async () => {
    await withTempDir(async (root) => {
      const fixture = await createInstallFixture(root)
      const urls: string[] = []
      const commands: string[][] = []
      const relaunched: string[] = []
      const trackingFetch = async (input: string | URL | Request) => {
        urls.push(String(input))
        return jsonResponse(releasePayload({ version: fixture.targetVersion }))
      }

      await expect(
        installUpdate({
          currentVersion: fixture.currentVersion,
          targetVersion: fixture.targetVersion,
          appBundlePath: null,
          platform: "darwin",
          arch: "arm64",
          fetch: trackingFetch,
          runCommand: createCommandRunner(commands),
          relaunch: async (bundle) => {
            relaunched.push(bundle)
          },
        }),
      ).rejects.toThrow()

      for (const [platform, arch] of [
        ["linux", "x64"],
        ["darwin", "x64"],
      ] as const) {
        await expect(
          installUpdate({
            currentVersion: fixture.currentVersion,
            targetVersion: fixture.targetVersion,
            appBundlePath: fixture.appBundlePath,
            platform,
            arch,
            fetch: trackingFetch,
            runCommand: createCommandRunner(commands),
            relaunch: async (bundle) => {
              relaunched.push(bundle)
            },
          }),
        ).rejects.toThrow()
      }

      for (const badTarget of ["", "01.2.3", "../../2.0.0", "not-semver", fixture.currentVersion, "1.0.0"]) {
        await expect(
          installUpdate({
            currentVersion: fixture.currentVersion,
            targetVersion: badTarget,
            appBundlePath: fixture.appBundlePath,
            platform: "darwin",
            arch: "arm64",
            fetch: trackingFetch,
            runCommand: createCommandRunner(commands),
            relaunch: async (bundle) => {
              relaunched.push(bundle)
            },
          }),
        ).rejects.toThrow()
      }

      const readOnlyDir = path.join(root, "readonly-volume")
      const readOnlyApp = path.join(readOnlyDir, "YCoding Desktop.app")
      await mkdir(path.join(readOnlyApp, "Contents/MacOS"), { recursive: true })
      await writeFile(path.join(readOnlyApp, "Contents/MacOS/launcher"), "original\n")
      await chmod(readOnlyApp, 0o555)
      await chmod(readOnlyDir, 0o555)
      try {
        await expect(
          installUpdate({
            currentVersion: fixture.currentVersion,
            targetVersion: fixture.targetVersion,
            appBundlePath: readOnlyApp,
            platform: "darwin",
            arch: "arm64",
            fetch: trackingFetch,
            runCommand: createCommandRunner(commands),
            relaunch: async (bundle) => {
              relaunched.push(bundle)
            },
          }),
        ).rejects.toThrow()
      } finally {
        await chmod(readOnlyDir, 0o755)
        await chmod(readOnlyApp, 0o755)
      }

      expect(urls).toEqual([])
      expect(commands).toEqual([])
      expect(relaunched).toEqual([])
    })
  })

  test("rejects HTTP download redirects, HTTP errors, and oversized checksums or zip streams before running ditto", async () => {
    await withTempDir(async (root) => {
      const fixture = await createInstallFixture(root)
      const commands: string[][] = []
      const relaunched: string[] = []

      const runWithFetch = (fetcher: (input: string | URL | Request) => Promise<Response>) =>
        installUpdate({
          currentVersion: fixture.currentVersion,
          targetVersion: fixture.targetVersion,
          appBundlePath: fixture.appBundlePath,
          platform: "darwin",
          arch: "arm64",
          fetch: fetcher,
          runCommand: createCommandRunner(commands),
          relaunch: async (bundle) => {
            relaunched.push(bundle)
          },
        })

      await expect(
        runWithFetch(async (input) => {
          const url = String(input)
          if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
          if (url.endsWith(fixture.checksumsName)) {
            return withUrl(new Response(fixture.checksumsText), `http://example.com/${fixture.checksumsName}`)
          }
          return withUrl(new Response(fixture.zipBytes), url)
        }),
      ).rejects.toThrow()

      await expect(
        runWithFetch(async (input) => {
          const url = String(input)
          if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
          if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
          return withUrl(new Response(fixture.zipBytes), `http://example.com/${fixture.zipName}`)
        }),
      ).rejects.toThrow()

      await expect(
        runWithFetch(async (input) => {
          const url = String(input)
          if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
          if (url.endsWith(fixture.checksumsName)) {
            return chunkedStreamResponse(url, new Uint8Array(64 * 1024), 17)
          }
          return withUrl(new Response(fixture.zipBytes), url)
        }),
      ).rejects.toThrow()

      await expect(
        runWithFetch(async (input) => {
          const url = String(input)
          if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
          if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
          return withUrl(
            new Response(fixture.zipBytes, {
              status: 200,
              headers: { "content-length": String(512 * 1024 * 1024 + 1) },
            }),
            url,
          )
        }),
      ).rejects.toThrow()

      const shared16MiBChunk = new Uint8Array(16 * 1024 * 1024)
      await expect(
        runWithFetch(async (input) => {
          const url = String(input)
          if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
          if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
          return chunkedStreamResponse(url, shared16MiBChunk, 33)
        }),
      ).rejects.toThrow()

      expect(commands).toEqual([])
      expect(relaunched).toEqual([])
      expect(await readFile(path.join(fixture.appBundlePath, "Contents/MacOS/launcher"), "utf8")).toBe(
        `launcher-${fixture.currentVersion}\n`,
      )
      expect(await readdir(fixture.appsDir)).toEqual(["YCoding Desktop.app"])
    })
  })

  test("verifies SHA-256 against the exact desktop zip entry in checksums.txt and aborts before ditto on mismatch or missing entry", async () => {
    await withTempDir(async (root) => {
      const fixture = await createInstallFixture(root)
      const commands: string[][] = []
      const relaunched: string[] = []

      const mismatchedChecksums = [
        `${fixture.zipSha256}  ycoding-${fixture.targetVersion}-darwin-arm64.tar.gz`,
        `${"0".repeat(64)}  ${fixture.zipName}`,
        "",
      ].join("\n")

      const missingEntryChecksums = `${fixture.zipSha256}  ycoding-${fixture.targetVersion}-darwin-arm64.tar.gz\n`

      for (const badChecksums of [mismatchedChecksums, missingEntryChecksums]) {
        await expect(
          installUpdate({
            currentVersion: fixture.currentVersion,
            targetVersion: fixture.targetVersion,
            appBundlePath: fixture.appBundlePath,
            platform: "darwin",
            arch: "arm64",
            fetch: async (input) => {
              const url = String(input)
              if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
              if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(badChecksums), url)
              if (url.endsWith(fixture.zipName)) return withUrl(new Response(fixture.zipBytes), url)
              return withUrl(new Response("not found", { status: 404 }), url)
            },
            runCommand: createCommandRunner(commands),
            relaunch: async (bundle) => {
              relaunched.push(bundle)
            },
          }),
        ).rejects.toThrow()
      }

      expect(commands).toEqual([])
      expect(relaunched).toEqual([])
      expect(await readFile(path.join(fixture.appBundlePath, "Contents/MacOS/launcher"), "utf8")).toBe(
        `launcher-${fixture.currentVersion}\n`,
      )
      expect(await readdir(fixture.appsDir)).toEqual(["YCoding Desktop.app"])
    })
  })

  test("rejects an extracted bundle with a mismatched CFBundleIdentifier or missing Info.plist without modifying the installed app", async () => {
    for (const variant of [{ bundleIdentifier: "app.example.impostor" }, { omitInfoPlist: true }] as const) {
      await withTempDir(async (root) => {
        const fixture = await createInstallFixture(root, variant)
        const commands: string[][] = []
        const relaunched: string[] = []

        await expect(
          installUpdate({
            currentVersion: fixture.currentVersion,
            targetVersion: fixture.targetVersion,
            appBundlePath: fixture.appBundlePath,
            platform: "darwin",
            arch: "arm64",
            fetch: async (input) => {
              const url = String(input)
              if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
              if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
              if (url.endsWith(fixture.zipName)) return withUrl(new Response(fixture.zipBytes), url)
              return withUrl(new Response("not found", { status: 404 }), url)
            },
            runCommand: createCommandRunner(commands),
            relaunch: async (bundle) => {
              relaunched.push(bundle)
            },
          }),
        ).rejects.toThrow()

        expect(commands.some((cmd) => cmd[0] === "/usr/bin/ditto")).toBe(true)
        expect(relaunched).toEqual([])
        expect(await readFile(path.join(fixture.appBundlePath, "Contents/MacOS/launcher"), "utf8")).toBe(
          `launcher-${fixture.currentVersion}\n`,
        )
        expect(await readFile(path.join(fixture.appBundlePath, "Contents/Info.plist"), "utf8")).toContain(
          `<string>${DESKTOP_BUNDLE_IDENTIFIER}</string>`,
        )
        expect(await readdir(fixture.appsDir)).toEqual(["YCoding Desktop.app"])
      })
    }
  })

  test("rejects failed codesign verification, wrong certificate SHA-1, wrong identifier, or missing requirement without modifying the installed app", async () => {
    const otherCert = "0".repeat(40)
    const badSignatureCases: Array<{
      name: string
      verifyResult?: CommandResult
      requirementResult?: CommandResult
    }> = [
      {
        name: "codesign --verify failure",
        verifyResult: { exitCode: 1, stdout: "", stderr: "invalid signature" },
      },
      {
        name: "codesign -d -r- non-zero exit",
        requirementResult: { exitCode: 1, stdout: designatedRequirement(DESKTOP_SIGNING_CERT_SHA1), stderr: "failed" },
      },
      {
        name: "unpinned certificate SHA-1",
        requirementResult: { exitCode: 0, stdout: designatedRequirement(otherCert), stderr: "" },
      },
      {
        name: "wrong designated bundle identifier",
        requirementResult: {
          exitCode: 0,
          stdout: designatedRequirement(DESKTOP_SIGNING_CERT_SHA1, "app.ycoding.other"),
          stderr: "",
        },
      },
      {
        name: "ad-hoc cdhash without pinned certificate",
        requirementResult: {
          exitCode: 0,
          stdout: 'designated => cdhash H"1593f00c9269224608bcfc16986b4c7b1b09a2d5"\n',
          stderr: "",
        },
      },
      {
        name: "missing requirement output",
        requirementResult: { exitCode: 0, stdout: "", stderr: "" },
      },
    ]

    for (const item of badSignatureCases) {
      await withTempDir(async (root) => {
        const fixture = await createInstallFixture(root)
        const commands: string[][] = []
        const relaunched: string[] = []

        await expect(
          installUpdate({
            currentVersion: fixture.currentVersion,
            targetVersion: fixture.targetVersion,
            appBundlePath: fixture.appBundlePath,
            platform: "darwin",
            arch: "arm64",
            fetch: async (input) => {
              const url = String(input)
              if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
              if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
              if (url.endsWith(fixture.zipName)) return withUrl(new Response(fixture.zipBytes), url)
              return withUrl(new Response("not found", { status: 404 }), url)
            },
            runCommand: createCommandRunner(commands, {
              verifyResult: item.verifyResult,
              requirementResult: item.requirementResult,
            }),
            relaunch: async (bundle) => {
              relaunched.push(bundle)
            },
          }),
          item.name,
        ).rejects.toThrow()

        expect(relaunched, item.name).toEqual([])
        expect(await readFile(path.join(fixture.appBundlePath, "Contents/MacOS/launcher"), "utf8"), item.name).toBe(
          `launcher-${fixture.currentVersion}\n`,
        )
        expect(await readdir(fixture.appsDir), item.name).toEqual(["YCoding Desktop.app"])
      })
    }
  })

  test("unpacks into a sibling temp directory with ditto, verifies Info.plist and case-insensitive pinned codesign SHA-1, swaps atomically, and relaunches", async () => {
    await withTempDir(async (root) => {
      const fixture = await createInstallFixture(root)
      const commands: string[][] = []
      const launcherDuringRelaunch: string[] = []
      const entriesDuringRelaunch: string[][] = []

      const result = await installUpdate({
        currentVersion: fixture.currentVersion,
        appBundlePath: fixture.appBundlePath,
        platform: "darwin",
        arch: "arm64",
        fetch: async (input) => {
          const url = String(input)
          if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
          if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
          if (url.endsWith(fixture.zipName)) return withUrl(new Response(fixture.zipBytes), url)
          return withUrl(new Response("not found", { status: 404 }), url)
        },
        runCommand: createCommandRunner(commands, {
          requirementResult: {
            exitCode: 0,
            stdout: "",
            stderr: designatedRequirement(DESKTOP_SIGNING_CERT_SHA1.toUpperCase(), DESKTOP_BUNDLE_IDENTIFIER, "root"),
          },
        }),
        relaunch: async (bundle) => {
          expect(bundle).toBe(fixture.appBundlePath)
          launcherDuringRelaunch.push(await readFile(path.join(bundle, "Contents/MacOS/launcher"), "utf8"))
          entriesDuringRelaunch.push(await readdir(fixture.appsDir))
        },
      })

      expect(result).toEqual({
        installedVersion: fixture.targetVersion,
        relaunching: true,
      })

      const dittoCommand = commands.find((cmd) => cmd[0] === "/usr/bin/ditto")
      expect(dittoCommand?.slice(0, 3)).toEqual(["/usr/bin/ditto", "-x", "-k"])
      const extractDir = dittoCommand?.[4] ?? ""
      expect(extractDir.length).toBeGreaterThan(0)
      expect(path.dirname(extractDir) === fixture.appsDir || path.dirname(extractDir) === (await realpath(fixture.appsDir))).toBe(
        true,
      )

      const verifyCommand = commands.find((cmd) => cmd[0] === "/usr/bin/codesign" && cmd.includes("--verify"))
      expect(verifyCommand?.slice(0, 4)).toEqual(["/usr/bin/codesign", "--verify", "--deep", "--strict"])
      expect(verifyCommand?.at(-1)).toBe(path.join(extractDir, "YCoding Desktop.app"))

      const requirementCommand = commands.find((cmd) => cmd[0] === "/usr/bin/codesign" && cmd.includes("-d"))
      expect(requirementCommand?.slice(0, 3)).toEqual(["/usr/bin/codesign", "-d", "-r-"])
      expect(requirementCommand?.at(-1)).toBe(path.join(extractDir, "YCoding Desktop.app"))

      expect(launcherDuringRelaunch).toEqual([`launcher-${fixture.targetVersion}\n`])
      expect(entriesDuringRelaunch).toEqual([["YCoding Desktop.app"]])
      expect(await Bun.file(path.join(fixture.appBundlePath, "Contents/Resources/installed-only.txt")).exists()).toBe(false)
      expect(await readFile(path.join(fixture.appBundlePath, "Contents/Resources/AppIcon.icns"), "utf8")).toBe(
        `icns-${fixture.targetVersion}\n`,
      )
      expect(await readdir(fixture.appsDir)).toEqual(["YCoding Desktop.app"])
    })
  })

  test("rolls back backup.app to the installed .app and cleans up temp directories if moving extracted.app into place fails", async () => {
    await withTempDir(async (root) => {
      const fixture = await createInstallFixture(root)
      const commands: string[][] = []
      const relaunched: string[] = []

      await expect(
        installUpdate({
          currentVersion: fixture.currentVersion,
          targetVersion: fixture.targetVersion,
          appBundlePath: fixture.appBundlePath,
          platform: "darwin",
          arch: "arm64",
          fetch: async (input) => {
            const url = String(input)
            if (url === DESKTOP_GITHUB_LATEST_RELEASE_URL) return jsonResponse(releasePayload({ version: fixture.targetVersion }))
            if (url.endsWith(fixture.checksumsName)) return withUrl(new Response(fixture.checksumsText), url)
            if (url.endsWith(fixture.zipName)) return withUrl(new Response(fixture.zipBytes), url)
            return withUrl(new Response("not found", { status: 404 }), url)
          },
          runCommand: createCommandRunner(commands, {
            onAfterRequirement: async (extractedApp) => {
              await rm(extractedApp, { recursive: true, force: true })
            },
          }),
          relaunch: async (bundle) => {
            relaunched.push(bundle)
          },
        }),
      ).rejects.toThrow()

      expect(relaunched).toEqual([])
      expect(await readFile(path.join(fixture.appBundlePath, "Contents/MacOS/launcher"), "utf8")).toBe(
        `launcher-${fixture.currentVersion}\n`,
      )
      expect(await readFile(path.join(fixture.appBundlePath, "Contents/Resources/installed-only.txt"), "utf8")).toBe(
        `installed-${fixture.currentVersion}\n`,
      )
      expect(await readdir(fixture.appsDir)).toEqual(["YCoding Desktop.app"])
    })
  })
})
