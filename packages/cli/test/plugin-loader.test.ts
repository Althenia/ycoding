import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Arborist } from "@npmcli/arborist"
import { PluginLoader } from "../src/plugin-host/loader"

test("installed package nodes select their own entrypoints and preserve cache and export policy", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plugin-install-tree-")))
  const cache = path.join(root, "cache")
  const nodes = [
    { specification: "file:fixture-archive.tgz", name: "fixture-plugin", manifest: "fixture-plugin" },
    {
      specification: "fixture-alias@npm:fixture-origin@1.0.0",
      name: "fixture-alias",
      manifest: "fixture-origin",
    },
    { specification: "file:fixture-scoped.tgz", name: "@fixture/plugin", manifest: "@fixture/plugin" },
    { specification: "file:fixture-broken.tgz", name: "fixture-broken", manifest: "fixture-broken" },
  ].map((node, index) => ({ ...node, path: path.join(root, "installed", String(index), "node_modules", node.name) }))

  async function packageAt(directory: string, name: string, available = true) {
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name,
        type: "module",
        exports: { ".": "./root.mjs", "./server": "./server.mjs" },
      }),
    )
    if (!available) return
    await Promise.all(
      ["root.mjs", "server.mjs"].map((file) =>
        writeFile(path.join(directory, file), 'throw new Error("Entrypoint resolution must not execute modules")'),
      ),
    )
  }

  const reify = spyOn(Arborist.prototype, "reify").mockImplementation(async function (this: Arborist, request) {
    expect(this.options).toMatchObject({
      cache: path.join(cache, "npm"),
      binLinks: false,
      progress: false,
      savePrefix: "",
      ignoreScripts: true,
      audit: false,
      fund: false,
    })
    const specification = Array.isArray(request.add) ? request.add[0] : undefined
    expect(request).toMatchObject({ add: [specification], save: true, saveType: "prod" })
    const node = nodes.find((node) => node.specification === specification)
    if (!node && specification !== "file:fixture-empty-tree.tgz") throw new Error("Unexpected fixture install")
    const tree = { edgesOut: new Map(node ? [[node.name, { to: node }]] : []) }
    return Object.assign(tree, { target: tree })
  })
  try {
    await Promise.all(nodes.map((node) => packageAt(node.path, node.manifest, node.name !== "fixture-broken")))
    for (const node of nodes.slice(0, 3)) {
      expect(await PluginLoader.install(node.specification, cache)).toBe(path.join(node.path, "server.mjs"))
      expect(await PluginLoader.install(node.specification, cache, false)).toBe(path.join(node.path, "root.mjs"))
    }
    expect(reify).toHaveBeenCalledTimes(6)

    const cached = path.join(cache, "packages", "fixture-cached", "node_modules", "fixture-cached")
    await packageAt(cached, "fixture-cached")
    expect(await PluginLoader.install("fixture-cached", cache)).toBe(path.join(cached, "server.mjs"))
    expect(await PluginLoader.install("fixture-cached", cache, false)).toBe(path.join(cached, "root.mjs"))
    expect(reify).toHaveBeenCalledTimes(6)

    for (const specification of ["file:fixture-broken.tgz", "file:fixture-empty-tree.tgz"]) {
      await PluginLoader.install(specification, cache).then(
        () => {
          throw new Error("Unresolvable fixture unexpectedly resolved")
        },
        (error: unknown) => {
          expect(error instanceof Error ? error.message : undefined).toContain("has no import entrypoint")
        },
      )
    }
    expect(reify).toHaveBeenCalledTimes(8)
  } finally {
    reify.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test("a local directory specification installs through a linked cache and resolves its root export without lifecycle scripts", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plugin-install-local-")))
  try {
    const source = path.join(root, "source")
    const marker = path.join(root, "postinstall-marker")
    const cache = path.join(root, "cache")
    await mkdir(source)
    await mkdir(path.join(root, "cache-target"))
    await symlink(path.join(root, "cache-target"), cache, "dir")
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "fixture-local",
        version: "1.0.0",
        type: "module",
        exports: "./root.mjs",
        scripts: { postinstall: `touch '${marker}'` },
      }),
    )
    await writeFile(path.join(source, "root.mjs"), "export const createFixture = () => ({})\n")

    const entrypoint = await PluginLoader.install(`file:${source}`, cache, false)

    expect(await realpath(entrypoint)).toBe(path.join(source, "root.mjs"))
    const installs = await readdir(path.join(cache, "packages"))
    expect(installs).toHaveLength(1)
    const manifest = path.join(cache, "packages", installs[0], "node_modules", "fixture-local", "package.json")
    expect(await Bun.file(manifest).exists()).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("installs honor the npm user configuration registry without re-enabling scripts or leaving the plugin cache", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plugin-install-registry-")))
  const environment = ["npm_config_userconfig", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const
  const saved = Object.fromEntries(environment.map((name) => [name, process.env[name]]))
  try {
    const userconfig = path.join(root, ".npmrc")
    await writeFile(
      userconfig,
      [
        "registry=http://127.0.0.1:9/",
        "fetch-retries=0",
        "ignore-scripts=false",
        "bin-links=true",
        "audit=true",
        "fund=true",
        "//127.0.0.1:9/:_authToken=synthetic-token-value",
        "",
      ].join("\n"),
    )
    process.env.npm_config_userconfig = userconfig
    for (const name of environment.slice(1)) process.env[name] = "http://127.0.0.1:1"
    const cache = path.join(root, "cache")
    const options: Record<string, unknown>[] = []
    const reify = spyOn(Arborist.prototype, "reify").mockImplementation(async function (this: Arborist, request) {
      options.push({ arborist: this.options, request })
      throw new Error("stop")
    })
    try {
      await PluginLoader.install("fixture-registry-config@1.0.0", cache).catch(() => undefined)
    } finally {
      reify.mockRestore()
    }
    expect(options).toHaveLength(1)
    for (const applied of [options[0].arborist, options[0].request]) {
      expect(applied).toMatchObject({ registry: "http://127.0.0.1:9/", ignoreScripts: true, binLinks: false })
      expect(applied).toMatchObject({ audit: false, fund: false })
    }
    expect(options[0].arborist).toMatchObject({ cache: path.join(cache, "npm") })

    const error = await PluginLoader.install("fixture-registry-config@1.0.0", cache).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(error).toContain("127.0.0.1:9")
    expect(error).not.toContain("registry.npmjs.org")
    expect(error).not.toContain("synthetic-token-value")
  } finally {
    for (const name of environment) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent cold installs of one specification into one directory run one at a time", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plugin-install-lock-")))
  try {
    const source = path.join(root, "source")
    await mkdir(source)
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ name: "fixture-locked", version: "1.0.0", type: "module", exports: "./root.mjs" }),
    )
    await writeFile(path.join(source, "root.mjs"), "export const createFixture = () => ({})\n")
    const log = path.join(root, "reify.log")
    await writeFile(log, "")
    const run = () =>
      Bun.spawn([process.execPath, path.join(import.meta.dirname, "plugin-loader-install.fixture.ts")], {
        env: {
          ...process.env,
          PLUGIN_INSTALL_LOG: log,
          PLUGIN_INSTALL_SPEC: `file:${source}`,
          PLUGIN_INSTALL_CACHE: path.join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    const children = [run(), run()]
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        out: (await new Response(child.stdout).text()).trim(),
        err: await new Response(child.stderr).text(),
      })),
    )
    expect(results.map((result) => result.err)).toEqual(["", ""])
    expect(results.map((result) => result.code)).toEqual([0, 0])
    expect(new Set(await Promise.all(results.map((result) => realpath(result.out))))).toEqual(
      new Set([path.join(source, "root.mjs")]),
    )
    const events = (await Bun.file(log).text()).trim().split("\n")
    expect(events.map((event) => event.split(" ")[0])).toEqual(["start", "end", "start", "end"])
    expect(new Set(events.map((event) => event.split(" ")[1])).size).toBe(2)
    expect(events[0].split(" ")[1]).toBe(events[1].split(" ")[1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
