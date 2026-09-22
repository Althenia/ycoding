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

  test("notifies for available patch, minor, and major versions", () => {
    expect(action("1.2.3", "1.2.4", true)).toBe("notify")
    expect(action("1.2.3", "1.3.0", true)).toBe("notify")
    expect(action("1.2.3", "2.0.0", true)).toBe("notify")
    expect(action("1.2.3", "1.2.4", "notify")).toBe("notify")
    expect(action("1.2.3", "1.3.0", "notify")).toBe("notify")
    expect(action("1.2.3", "2.0.0", "notify")).toBe("notify")
  })

  test("skips when autoupdate is disabled", () => {
    expect(action("1.2.3", "1.2.4", false)).toBe("none")
  })

  test("reports up-to-date only when versions match", () => {
    expect(action("1.2.3", "1.2.3", true)).toBe("none")
  })

  test("does not notify when the latest release is older", () => {
    expect(action("1.2.4", "1.2.3", true)).toBe("none")
  })
})

describe("updater release source", () => {
  test.each(
    ([undefined, true, "notify"] as const).flatMap((policy) =>
      ["1.2.4", "1.3.0", "2.0.0"].map((latest) => [policy, latest] as const),
    ),
  )("announces an available release without mutating the installation", async (policy, latest) => {
    const fixture = await releaseFixture(policy === undefined ? undefined : `{ "autoupdate": ${JSON.stringify(policy)} }`)
    const urls: string[] = []
    const notices: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        const updater = yield* Updater.Service
        yield* updater.check((message) => Effect.sync(() => notices.push(message)))
      }).pipe(
        Effect.provide(
          Updater.layerWith({
            local: false,
            version: "1.2.3",
            fetch: async (url) => {
              urls.push(url)
              return Response.json({ tag_name: `v${latest}` })
            },
          }),
        ),
        Effect.provide(Global.layerWith({ config: fixture.config })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    expect(urls).toEqual(["https://api.github.com/repos/Althenia/ycoding/releases/latest"])
    expect(notices).toEqual([`YCoding ${latest} available. Run \`ycoding update\`.`])
  })

  test("leaves an installation untouched when the policy disables updates", async () => {
    const fixture = await releaseFixture('{ "autoupdate": false }')
    const urls: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        const updater = yield* Updater.Service
        yield* updater.check(() => Effect.void)
      }).pipe(
        Effect.provide(
          Updater.layerWith({
            local: false,
            version: "1.2.3",
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
  })
})

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function releaseFixture(policy?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-updater-test-"))
  temporary.push(root)
  const config = path.join(root, "config")
  await mkdir(config, { recursive: true })
  if (policy !== undefined) await writeFile(path.join(config, "config.json"), policy)
  return { config }
}
