import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

const NodeResult = Schema.Struct({
  runtime: Schema.Struct({
    bun: Schema.String,
    node: Schema.String,
    registerHooks: Schema.String,
  }),
  calls: Schema.Array(
    Schema.Struct({
      specification: Schema.Unknown,
      add: Schema.Unknown,
      save: Schema.Unknown,
      saveType: Schema.Unknown,
      options: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  callsAfterNodes: Schema.Number,
  resolved: Schema.Record(Schema.String, Schema.String),
  errors: Schema.Record(Schema.String, Schema.String),
})

const entry = `
import { PluginLoader } from __LOADER__
import { Arborist } from "@npmcli/arborist"
import module from "node:module"

const config = JSON.parse(process.env.PLUGIN_NODE_FIXTURE)
const results = {
  runtime: { bun: typeof Bun, node: process.version, registerHooks: typeof module.registerHooks },
  calls: [],
  callsAfterNodes: 0,
  resolved: {},
  errors: {},
}
Arborist.prototype.reify = async function (request) {
  const specification = Array.isArray(request.add) ? request.add[0] : undefined
  results.calls.push({
    specification,
    add: request.add,
    save: request.save,
    saveType: request.saveType,
    options: {
      cache: this.options.cache,
      binLinks: this.options.binLinks,
      progress: this.options.progress,
      savePrefix: this.options.savePrefix,
      ignoreScripts: this.options.ignoreScripts,
      audit: this.options.audit,
      fund: this.options.fund,
    },
  })
  const node = config.nodes.find((candidate) => candidate.specification === specification)
  if (!node && specification !== config.empty) throw new Error("Unexpected fixture install")
  const tree = { edgesOut: new Map(node ? [[node.name, { to: { name: node.name, path: node.path } }]] : []) }
  return Object.assign(tree, { target: tree })
}
for (const node of config.nodes.slice(0, 3)) {
  results.resolved[node.name + ":server"] = await PluginLoader.install(node.specification, config.cache)
  results.resolved[node.name + ":root"] = await PluginLoader.install(node.specification, config.cache, false)
}
results.callsAfterNodes = results.calls.length
results.resolved["fixture-cached:server"] = await PluginLoader.install("fixture-cached", config.cache)
results.resolved["fixture-cached:root"] = await PluginLoader.install("fixture-cached", config.cache, false)
for (const specification of config.failures) {
  try {
    const resolved = await PluginLoader.install(specification, config.cache)
    results.errors[specification] = "resolved: " + resolved
  } catch (error) {
    results.errors[specification] = error instanceof Error ? error.message : String(error)
  }
}
process.stdout.write(JSON.stringify(results) + "\\n")
`

test("Node resolves installed plugin entrypoints with export preference and cache", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plugin-install-node-")))
  const cache = path.join(root, "cache")
  const nodes = [
    { specification: "file:fixture-archive.tgz", name: "fixture-plugin", manifest: "fixture-plugin" },
    {
      specification: "fixture-alias@npm:fixture-origin@1.0.0",
      name: "fixture-alias",
      manifest: "fixture-origin",
    },
    { specification: "file:fixture-scoped.tgz", name: "@fixture/plugin", manifest: "@fixture/plugin" },
    { specification: "file:fixture-blocked.tgz", name: "fixture-blocked", manifest: "fixture-blocked" },
  ].map((node, index) => ({ ...node, path: path.join(root, "installed", String(index), "node_modules", node.name) }))
  const failures = ["file:fixture-blocked.tgz", "file:fixture-empty-tree.tgz"]

  async function packageAt(directory: string, name: string, blocked = false) {
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name,
        type: "module",
        exports: blocked ? { ".": null, "./server": null } : { ".": "./root.mjs", "./server": "./server.mjs" },
      }),
    )
    await Promise.all(
      ["root.mjs", "server.mjs"].map((file) =>
        writeFile(path.join(directory, file), 'throw new Error("Entrypoint resolution must not execute modules")'),
      ),
    )
  }

  try {
    await Promise.all(nodes.map((node) => packageAt(node.path, node.manifest, node.name === "fixture-blocked")))
    const cached = path.join(cache, "packages", "fixture-cached", "node_modules", "fixture-cached")
    await packageAt(cached, "fixture-cached")

    const loader = fileURLToPath(new URL("../src/plugin-host/loader.ts", import.meta.url))
    const source = path.join(root, "entry.mjs")
    await writeFile(source, entry.replaceAll("__LOADER__", JSON.stringify(loader)))
    const arborist = Bun.resolveSync("@npmcli/arborist", path.join(import.meta.dir, ".."))
    const build = await Bun.build({
      entrypoints: [source],
      outdir: path.join(root, "bundle"),
      target: "node",
      format: "esm",
      plugins: [
        {
          name: "fixture-arborist",
          setup(builder) {
            builder.onResolve({ filter: /^@npmcli\/arborist$/ }, () => ({ path: arborist }))
          },
        },
      ],
    })
    if (!build.success)
      throw new Error(`Node harness bundle failed:\n${build.logs.map(String).join("\n").slice(0, 4000)}`)

    const child = Bun.spawn(["node", build.outputs[0].path], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        PLUGIN_NODE_FIXTURE: JSON.stringify({ cache, nodes, empty: failures[1], failures }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_048_576,
    })
    try {
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      await child.stdin.end()
      const code = await child.exited
      const [stdoutText, stderrText] = await Promise.all([stdout, stderr])
      if (child.signalCode !== null || code !== 0)
        throw new Error(`Node child failed (exit ${code}, signal ${child.signalCode}): ${stderrText.slice(0, 4000)}`)
      let result: Schema.Schema.Type<typeof NodeResult>
      try {
        result = Schema.decodeUnknownSync(Schema.fromJsonString(NodeResult))(stdoutText.trim())
      } catch {
        throw new Error(
          `Node child did not emit exactly one JSON result (stderr: ${stderrText.slice(0, 2000)}; stdout: ${stdoutText.slice(0, 2000)})`,
        )
      }

      expect(result.runtime.bun).toBe("undefined")
      if (!/^v\d+\.\d+\.\d+/.test(result.runtime.node))
        throw new Error(`Unexpected Node version: ${result.runtime.node}`)
      expect(result.runtime.registerHooks).toBe("function")
      for (const node of nodes.slice(0, 3)) {
        expect(result.resolved[`${node.name}:server`]).toBe(path.join(node.path, "server.mjs"))
        expect(result.resolved[`${node.name}:root`]).toBe(path.join(node.path, "root.mjs"))
      }
      expect(result.callsAfterNodes).toBe(6)
      expect(result.resolved["fixture-cached:server"]).toBe(path.join(cached, "server.mjs"))
      expect(result.resolved["fixture-cached:root"]).toBe(path.join(cached, "root.mjs"))
      for (const specification of failures)
        expect({ specification, outcome: result.errors[specification] }).toEqual({
          specification,
          outcome: expect.stringContaining("has no import entrypoint"),
        })
      expect(result.calls).toHaveLength(8)
      for (const call of result.calls) {
        expect(call.add).toEqual([call.specification])
        expect(call.save).toBe(true)
        expect(call.saveType).toBe("prod")
        expect(call.options).toMatchObject({
          cache: path.join(cache, "npm"),
          binLinks: false,
          progress: false,
          savePrefix: "",
          ignoreScripts: true,
          audit: false,
          fund: false,
        })
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await child.exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
