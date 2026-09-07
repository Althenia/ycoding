import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
import { Effect } from "effect"
import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../src/config"

function run<A, E>(directory: string, effect: Effect.Effect<A, E, Config.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ data: path.join(directory, "data"), config: directory, state: directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

test("ignores obsolete tui and kv configuration", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "tui.json"), JSON.stringify({ theme: "obsolete" }))
  await Bun.write(path.join(directory, "kv.json"), JSON.stringify({ animations_enabled: false }))

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.get()
      }),
    )

    expect(config).toEqual({})
    expect(await Bun.file(path.join(directory, "cli.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(directory, "tui.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(directory, "kv.json")).exists()).toBe(true)
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("updates current config without reading obsolete files", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "tui.json"), JSON.stringify({ theme: "obsolete" }))

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        yield* service.update((draft) => {
          draft.animations = false
          draft.mouse = false
        })
        return yield* service.get()
      }),
    )

    expect(config).toEqual({ animations: false, mouse: false })
    expect(await Bun.file(path.join(directory, "cli.json")).json()).toEqual({ animations: false, mouse: false })
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("updates a config draft while preserving JSONC comments", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "cli.json"), "{\n  // Keep this comment\n  \"animations\": true\n}\n")

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.update((draft) => {
          draft.prompt = { paste: "compact" }
        })
      }),
    )

    expect(config).toEqual({ animations: true, prompt: { paste: "compact" } })
    expect(await Bun.file(path.join(directory, "cli.json")).text()).toContain("// Keep this comment")
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})
