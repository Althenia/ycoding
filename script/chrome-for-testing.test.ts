import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { minimumMajor, provision } from "./chrome-for-testing"

const temporary: string[] = []
const servers: Array<{ stop: (force: boolean) => unknown }> = []
const executablePath = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directory() {
  const created = await mkdtemp(path.join(os.tmpdir(), "ycoding-cft-test-"))
  temporary.push(created)
  return created
}

async function archive(reported: string, options: { executable?: boolean } = {}) {
  const root = await directory()
  const binary = path.join(root, options.executable === false ? "chrome-mac-arm64/README" : executablePath)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, `#!/bin/sh\necho "Google Chrome for Testing ${reported}"\n`)
  await chmod(binary, 0o755)
  const zip = path.join(root, "chrome.zip")
  const result = Bun.spawnSync(["zip", "-q", "-r", zip, "chrome-mac-arm64"], { cwd: root })
  expect(result.exitCode).toBe(0)
  return Bun.file(zip).bytes()
}

function serve(options: { version?: string; archive?: Uint8Array; downloads?: unknown; metadata?: string; status?: number; redirect?: boolean }) {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      requests.push(pathname)
      if (pathname === "/metadata.json") {
        if (options.redirect) return Response.redirect(`http://127.0.0.1:${server.port}/other`, 302)
        if (options.status) return new Response("unavailable", { status: options.status })
        return new Response(
          options.metadata ??
            JSON.stringify({
              channels: {
                Stable: {
                  version: options.version ?? "153.0.1.2",
                  downloads: {
                    chrome: options.downloads ?? [
                      { platform: "linux64", url: `http://127.0.0.1:${server.port}/linux.zip` },
                      { platform: "mac-arm64", url: `http://127.0.0.1:${server.port}/chrome.zip` },
                    ],
                  },
                },
              },
            }),
        )
      }
      if (pathname === "/chrome.zip") return new Response(options.archive)
      return new Response("missing", { status: 404 })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}/metadata.json`, requests }
}

describe("Chrome for Testing provisioning", () => {
  test("downloads the Stable mac-arm64 archive and returns its verified executable", async () => {
    const destination = path.join(await directory(), "chrome")
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, "stale"), "old\n")
    const server = serve({ archive: await archive("153.0.1.2") })
    const binary = await provision({ destination, metadataURL: server.url })
    expect(binary).toBe(path.join(destination, executablePath))
    expect(Bun.spawnSync([binary, "--version"]).stdout.toString()).toContain("153.0.1.2")
    expect(await Bun.file(path.join(destination, "stale")).exists()).toBe(false)
    expect(await Bun.file(path.join(destination, "chrome.zip")).exists()).toBe(false)
    expect(server.requests).toEqual(["/metadata.json", "/chrome.zip"])
  })

  test("rejects a Stable version below the required major before downloading the archive", async () => {
    const server = serve({ version: `${minimumMajor - 1}.0.1.2` })
    const error = await provision({ destination: path.join(await directory(), "chrome"), metadataURL: server.url }).then(() => "", (cause) => String(cause))
    expect(error).toContain(`required major ${minimumMajor}`)
    expect(server.requests).toEqual(["/metadata.json"])
  })

  test.each([
    ["metadata without a mac-arm64 download", { downloads: [{ platform: "linux64", url: "http://127.0.0.1:1/x.zip" }] }, "no mac-arm64 download"],
    ["malformed metadata shape", { metadata: JSON.stringify({ channels: [] }) }, "unexpected shape"],
    ["a metadata version that is not a build number", { version: "stable" }, "no valid Stable version"],
    ["an unavailable metadata document", { status: 503 }, "HTTP 503"],
    ["a redirected metadata document", { redirect: true }, "redirect"],
  ] as const)("rejects %s", async (_name, options, message) => {
    const server = serve(options)
    const error = await provision({ destination: path.join(await directory(), "chrome"), metadataURL: server.url }).then(() => "", (cause) => String(cause))
    expect(error.toLowerCase()).toContain(message.toLowerCase())
  })

  test("rejects a corrupt archive, an archive without the browser, and a browser that reports another version", async () => {
    const corrupt = serve({ archive: new TextEncoder().encode("not a zip archive") })
    expect(await provision({ destination: path.join(await directory(), "chrome"), metadataURL: corrupt.url }).then(() => "", (cause) => String(cause)))
      .toContain("Failed to extract")
    const empty = serve({ archive: await archive("153.0.1.2", { executable: false }) })
    expect(await provision({ destination: path.join(await directory(), "chrome"), metadataURL: empty.url }).then(() => "", (cause) => String(cause)))
      .toContain("did not contain an executable browser")
    const mismatch = serve({ archive: await archive("153.0.9.9") })
    expect(await provision({ destination: path.join(await directory(), "chrome"), metadataURL: mismatch.url }).then(() => "", (cause) => String(cause)))
      .toContain("reported 153.0.9.9 instead of 153.0.1.2")
  })

  test("refuses to fetch metadata or archives over a non-HTTPS address", async () => {
    const insecure = await provision({ destination: path.join(await directory(), "chrome"), metadataURL: "http://example.test/metadata.json" }).then(() => "", (cause) => String(cause))
    expect(insecure).toContain("non-HTTPS")
    const server = serve({ downloads: [{ platform: "mac-arm64", url: "http://example.test/chrome.zip" }] })
    const archiveError = await provision({ destination: path.join(await directory(), "chrome"), metadataURL: server.url }).then(() => "", (cause) => String(cause))
    expect(archiveError).toContain("non-HTTPS")
  })

  test("the command requires a destination and exits nonzero without downloading", () => {
    const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "chrome-for-testing.ts")], { stderr: "pipe" })
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("usage:")
  })
})
