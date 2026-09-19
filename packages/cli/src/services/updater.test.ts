import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { action, decodePolicy, updateCheckSkipReason, Updater } from "./updater"

describe("updater", () => {
  test("reads autoupdate from JSONC", () => {
    expect(decodePolicy('{ // preference\n "autoupdate": "notify",\n}')).toBe("notify")
    expect(decodePolicy('{ "autoupdate": false }')).toBe(false)
    expect(decodePolicy('{ "autoupdate": "invalid" }')).toBeUndefined()
  })

  test("skips local, disabled, and preview update checks", () => {
    expect(updateCheckSkipReason({ local: true, disabled: false, version: "1.2.3" })).toBe("local-install")
    expect(updateCheckSkipReason({ local: false, disabled: true, version: "1.2.3" })).toBe("disabled")
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "0.0.0-main-20260722034528845" })).toBe(
      "preview-build",
    )
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "0.0.0-feature-123" })).toBe(
      "preview-build",
    )
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "1.2.3" })).toBeUndefined()
    expect(updateCheckSkipReason({ local: false, disabled: false, version: "1.2.3-beta.1" })).toBeUndefined()
  })

  test("automatically updates patches and minors", () => {
    expect(action("1.2.3", "1.2.4", true)).toBe("upgrade")
    expect(action("1.2.3", "1.3.0", true)).toBe("upgrade")
    expect(action("1.2.3", "1.2.4", "notify")).toBe("upgrade")
    expect(action("1.2.3", "1.3.0", "notify")).toBe("upgrade")
  })

  test("skips when autoupdate is disabled", () => {
    expect(action("1.2.3", "1.2.4", false)).toBe("none")
  })

  test("never automatically updates majors", () => {
    expect(action("1.2.3", "2.0.0", true)).toBe("none")
  })

  test("reports up-to-date only when versions match", () => {
    expect(action("1.2.3", "1.2.3", true)).toBe("none")
  })

  test("upgrades when latest is lower (rollback)", () => {
    expect(action("1.2.4", "1.2.3", true)).toBe("upgrade")
  })
})

describe("updater release source", () => {
  test("resolves and installs from GitHub Releases instead of the npm registry", async () => {
    const fixture = await releaseFixture()
    const urls: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        const updater = yield* Updater.Service
        yield* updater.check()
      }).pipe(
        Effect.provide(
          Updater.layerWith({
            local: false,
            version: "1.2.3",
            executable: fixture.executable,
            platform: "darwin",
            arch: "arm64",
            fetch: async (url) => {
              urls.push(url)
              if (url.includes("/releases/latest")) return Response.json({ tag_name: "v1.2.4" })
              if (url.endsWith("checksums.txt")) return new Response(fixture.checksums)
              if (url.endsWith(fixture.asset)) return new Response(fixture.archive)
              return new Response("not found", { status: 404 })
            },
          }),
        ),
        Effect.provide(Global.layerWith({ config: fixture.config })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    expect(urls).toEqual([
      "https://api.github.com/repos/Althenia/ycoding/releases/latest",
      `https://github.com/Althenia/ycoding/releases/download/v1.2.4/ycoding-1.2.4-checksums.txt`,
      `https://github.com/Althenia/ycoding/releases/download/v1.2.4/${fixture.asset}`,
    ])
    expect(await Bun.file(fixture.executable).text()).toBe("new executable\n")
  })

  test("leaves an installation untouched when the policy disables updates", async () => {
    const fixture = await releaseFixture('{ "autoupdate": false }')
    const urls: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        const updater = yield* Updater.Service
        yield* updater.check()
      }).pipe(
        Effect.provide(
          Updater.layerWith({
            local: false,
            version: "1.2.3",
            executable: fixture.executable,
            platform: "darwin",
            arch: "arm64",
            fetch: async (url) => {
              urls.push(url)
              return Response.json({ tag_name: "v1.2.4" })
            },
          }),
        ),
        Effect.provide(Global.layerWith({ config: fixture.config })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    expect(urls).toEqual([])
    expect(await Bun.file(fixture.executable).text()).toBe("old executable\n")
  })
})

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function releaseFixture(policy = '{ "autoupdate": true }') {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-updater-test-"))
  temporary.push(root)
  const config = path.join(root, "config")
  await mkdir(config, { recursive: true })
  await writeFile(path.join(config, "config.json"), policy)
  const source = path.join(root, "source")
  await mkdir(source, { recursive: true })
  const version = "1.2.4"
  const asset = `ycoding-${version}-darwin-arm64.tar.gz`
  const names = ["ycoding", "ycoding-computer-helper"]
  await Promise.all(
    names.map(async (name) => {
      await writeFile(path.join(source, name), `new ${name === "ycoding" ? "executable" : "helper"}\n`, { mode: 0o755 })
    }),
  )
  const archiveFile = path.join(root, asset)
  const tar = Bun.spawnSync(["tar", "-C", source, "-czf", archiveFile, ...names], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  expect(tar.exitCode).toBe(0)
  const archive = new Uint8Array(await Bun.file(archiveFile).arrayBuffer())
  const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
  const executable = path.join(root, "ycoding")
  await writeFile(executable, "old executable\n", { mode: 0o755 })
  await writeFile(path.join(root, "ycoding-computer-helper"), "old helper\n", { mode: 0o755 })
  return { config, executable, archive, asset, checksums: `${digest}  ${asset}\n` }
}
