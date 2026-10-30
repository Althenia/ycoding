import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import type { FSWatcher } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createCcaExecutor, type CcaAuthorizationInput } from "@ycoding-ai/core/cca/executor"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import type { CcaCapabilityFileSystem } from "../src/remote-control/cca-capability-discovery"
import {
  ccaActivePluginVersion,
  createCcaCapabilityDiscoveryV2,
  createNodeCcaCapabilityWatcher,
  nodeCcaCapabilityWatcher,
  parseCcaSkillFrontmatter,
  parseCcaSkillMetadata,
  type CcaCapabilityDiscoveryV2Options,
  type CcaCapabilityWatchPath,
  type CcaCapabilityWatcher,
} from "../src/remote-control/cca-capability-discovery-v2"
import { CcaRpcError, type CcaRpcHandlerContext } from "../src/remote-control/cca-executor-rpc"
import { ensureYcodingOperatorSkill } from "../src/remote-control/ycoding-operator-skill"
import golden from "./fixture/cca-capability-discovery-v2.golden.json"
import { fixedScopeFor } from "./fixture/cca-scope"
import {
  ABSENT_PARAMS,
  PARAM_CASES,
  normalizer,
  restrictedSandbox,
  unlockCacheTree,
  write,
  writeInventoryTree,
  writeLimitTree,
  writeLockedCacheTree,
  type DiscoveryV2Tree,
} from "./fixture/cca-capability-discovery-v2"

const ctx: CcaRpcHandlerContext = { signal: new AbortController().signal, sessionId: "synthetic-session" }
const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {})
})

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cca-v2-test-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function capabilityFileSystem(root: string, deny: (input: CcaAuthorizationInput) => boolean = () => false): CcaCapabilityFileSystem {
  const executor = createCcaExecutor({
    scopeFor: fixedScopeFor([root], async (input) => {
      if (deny(input)) throw new Error("denied")
      return { release: async () => {} }
    }),
  })
  cleanups.push(() => executor.close())
  const reportMissing =
    <P extends { readonly path: string }, R>(operation: (params: P) => Promise<R>) =>
    async (params: P): Promise<R> => {
      try {
        return await operation(params)
      } catch (error) {
        const missing = await stat(CcaPolicy.parsePathUri(params.path)).then(
          () => false,
          (failed: { readonly code?: string }) => failed.code === "ENOENT",
        )
        if (missing) throw new CcaRpcError(-32004, "No such file or directory (os error 2)")
        throw error
      }
    }
  return {
    openReadTree: async (params, context) => {
      const tree = await reportMissing((p: typeof params) => executor.openReadTree(p, context))(params)
      return {
        getMetadata: reportMissing(tree.getMetadata),
        readDirectory: reportMissing(tree.readDirectory),
        readFile: reportMissing(tree.readFile),
        release: tree.release,
      }
    },
  }
}

async function bareTree(root: string): Promise<DiscoveryV2Tree> {
  const tree = { root, home: path.join(root, "home"), codexHome: path.join(root, "codex"), project: path.join(root, "project") }
  await mkdir(tree.project, { recursive: true })
  return tree
}

type Fixture = { readonly tree: DiscoveryV2Tree; readonly fs: CcaCapabilityFileSystem }

function discovery(fixture: Fixture, options: Partial<CcaCapabilityDiscoveryV2Options> = {}) {
  const instance = createCcaCapabilityDiscoveryV2({
    fs: fixture.fs,
    environment: {
      homeDirectory: fixture.tree.home,
      dataDirectory: path.join(fixture.tree.root, "data"),
      codexHomeEnv: fixture.tree.codexHome,
      systemConfigPath: path.join(fixture.tree.root, "etc", "codex", "config.toml"),
    },
    watcher: null,
    ...options,
  })
  cleanups.push(() => instance.close())
  return instance
}

async function fixture(build: (root: string) => Promise<DiscoveryV2Tree>, deny?: (input: CcaAuthorizationInput) => boolean): Promise<Fixture> {
  const root = await tempRoot()
  const tree = await build(root)
  return { tree, fs: capabilityFileSystem(root, deny) }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof CcaRpcError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error("expected the discovery to fail")
}

function manualWatcher(registered = true) {
  const registrations: { paths: readonly CcaCapabilityWatchPath[]; emit: (paths: readonly string[]) => void; closed: boolean }[] = []
  const watcher: CcaCapabilityWatcher = (paths, onChange) => {
    const registration = { paths, emit: onChange, closed: false }
    registrations.push(registration)
    return {
      registered,
      close: () => {
        registration.closed = true
      },
    }
  }
  const emit = (paths: readonly string[]) => {
    for (const registration of registrations) if (!registration.closed) registration.emit(paths)
  }
  return { watcher, registrations, emit }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("capabilities/discoverV2 matches the official exec-server", () => {
  test("discovers the isolated Dots operator skill with its advertised root id", async () => {
    const f = await fixture(bareTree)
    await mkdir(f.tree.codexHome, { recursive: true })
    const root = path.join(f.tree.root, "data", "dots", "skills")
    await ensureYcodingOperatorSkill(path.join(f.tree.root, "data"))
    const result = await discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    expect(result.skills).toEqual([expect.objectContaining({
      name: "ycoding-operator",
      path: CcaPolicy.toPathUri(path.join(root, "ycoding-operator", "SKILL.md")),
      discoveryRoot: { id: "ycoding-dots-skills", path: CcaPolicy.toPathUri(root) },
    })])
    expect(result.warnings).toEqual([])
    const instructions = await readFile(path.join(root, "ycoding-operator", "SKILL.md"), "utf8")
    expect(instructions).toContain('{"env":{"CODEX_APPS_MCP_URL":"ycoding-library://process"}}')
    expect(instructions).toContain("python3 <helper-path> < /approved/library-upload.json")
  })

  test("Dots skill discovery watches its root and preserves sandbox denials", async () => {
    const f = await fixture(bareTree)
    await mkdir(f.tree.codexHome, { recursive: true })
    await ensureYcodingOperatorSkill(path.join(f.tree.root, "data"))
    const watched = manualWatcher()
    const discover = discovery(f, { watcher: watched.watcher })
    const cwd = CcaPolicy.toPathUri(f.tree.project)
    const result = await discover.discover({ cwd, sandbox: restrictedSandbox([], f.tree.project) }, ctx)
    expect(result.skills).toEqual([])
    expect(result.warnings).toContain("some capability metadata could not be loaded; discovery may be incomplete")
    expect(watched.registrations[0]!.paths).toContainEqual({ path: path.join(f.tree.root, "data", "dots", "skills"), recursive: true })
  })

  test("unsandboxed inventory equals the recorded answer", async () => {
    const f = await fixture(writeInventoryTree)
    const normalize = await normalizer(f.tree.root)
    const cwd = CcaPolicy.toPathUri(f.tree.project)
    const discover = discovery(f)
    expect(normalize(await discover.discover({ cwd }, ctx))).toEqual(golden.inventory.result)
    expect(normalize(await discover.discover({ cwd, sandbox: null }, ctx))).toEqual(golden.inventoryNullSandbox.result)
  })

  test("restricted sandboxes equal the recorded answers, including the denial warning", async () => {
    const f = await fixture(writeInventoryTree)
    const normalize = await normalizer(f.tree.root)
    const cwd = CcaPolicy.toPathUri(f.tree.project)
    const discover = discovery(f)
    const run = (readable: string[]) => discover.discover({ cwd, sandbox: restrictedSandbox(readable, f.tree.project) }, ctx).then(normalize)
    expect(await run([path.join(f.tree.codexHome, "skills")])).toEqual(golden.restrictedSkills.result)
    expect(await run([f.tree.codexHome])).toEqual(golden.restrictedCodexHome.result)
    expect(await run([])).toEqual(golden.restrictedNothing.result)
    expect(golden.restrictedNothing.result.warnings.slice(1)).toEqual(Array(9).fill("some capability metadata could not be loaded; discovery may be incomplete"))
  })

  test("an unreadable plugin cache fails discovery with the recorded error, carrying the executor's read error text", async () => {
    const f = await fixture(writeLockedCacheTree)
    cleanups.push(() => unlockCacheTree(f.tree.root))
    const normalize = await normalizer(f.tree.root)
    const recorded = golden.lockedCache.error
    expect(recorded.message.endsWith(": Permission denied (os error 13)")).toBe(true)
    expect(normalize(await failure(discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)))).toEqual({
      code: recorded.code,
      message: recorded.message,
    })
  })

  test("a missing CODEX_HOME fails discovery with the recorded error", async () => {
    const f = await fixture(writeInventoryTree)
    const normalize = await normalizer(f.tree.root)
    const discover = createCcaCapabilityDiscoveryV2({
      fs: f.fs,
      environment: { homeDirectory: f.tree.home, dataDirectory: path.join(f.tree.root, "data"), codexHomeEnv: path.join(f.tree.root, "missing-codex-home") },
      watcher: null,
    })
    cleanups.push(() => discover.close())
    expect(normalize(await failure(discover.discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)))).toEqual(golden.missingCodexHome.error)
  })

  test("location, capability, and response limits equal the recorded answer", async () => {
    const f = await fixture(writeLimitTree)
    const normalize = await normalizer(f.tree.root)
    const result = await discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    const last = result.plugins.at(-1)!
    expect({
      plugins: result.plugins.length,
      pluginSkills: result.plugins.reduce((total, plugin) => total + plugin.skills.length, 0),
      lastPlugin: { id: last.id, skills: last.skills.map((skill) => skill.name) },
      skills: result.skills.map((skill) => skill.name),
      warnings: result.warnings,
      bytes: JSON.stringify(normalize(result)).length,
    }).toEqual(golden.limits)
  })

  test("parameter decoding matches the recorded -32602 answers", async () => {
    const f = await fixture(writeInventoryTree)
    const discover = discovery(f)
    const recorded = golden.params as Record<string, { code: number; message: string } | null>
    expect(Object.keys(recorded)).toEqual(Object.keys(PARAM_CASES))
    for (const [name, params] of Object.entries(PARAM_CASES)) {
      const call = discover.discover(params === ABSENT_PARAMS ? undefined : params, ctx)
      const expected = recorded[name]
      if (expected === null) expect({ name, result: Object.keys(await call) }).toEqual({ name, result: ["plugins", "skills", "warnings"] })
      else expect({ name, error: await failure(call) }).toEqual({ name, error: expected })
    }
  })
})

describe("plugin cache layout and active version", () => {
  test("active version prefers local, then the highest semver, then plain string order", () => {
    expect(ccaActivePluginVersion([])).toBeUndefined()
    expect(ccaActivePluginVersion(["1.9.0", "local", "9.0.0"])).toBe("local")
    expect(ccaActivePluginVersion(["1.9.0", "1.10.0", "1.10.0-beta.1"])).toBe("1.10.0")
    expect(ccaActivePluginVersion(["1.0.0-alpha.10", "1.0.0-alpha.9", "1.0.0-alpha"])).toBe("1.0.0-alpha.10")
    expect(ccaActivePluginVersion(["1.0.0+build.2", "1.0.0+build.10", "1.0.0"])).toBe("1.0.0+build.10")
    expect(ccaActivePluginVersion(["abc", "1.0.0", "2.0.0"])).toBe("abc")
    expect(ccaActivePluginVersion(["01.0.0", "1.0.0"])).toBe("1.0.0")
    expect(ccaActivePluginVersion(["v2", "v10"])).toBe("v2")
    expect(ccaActivePluginVersion([".", "..", "bad version", "bad/version", ""])).toBeUndefined()
    expect(ccaActivePluginVersion(["bad version", "0.1.0"])).toBe("0.1.0")
  })

  test("symlinked packages are followed, symlinked version directories are ignored, and remote ids are validated", async () => {
    const f = await fixture(async (root) => {
      const t = await bareTree(root)
      const cache = "codex/plugins/cache/market"
      await write(root, "elsewhere/linked/2.0.0/.codex-plugin/plugin.json", '{"name":"linked"}')
      await mkdir(path.join(root, cache), { recursive: true })
      await symlink(path.join(root, "elsewhere/linked"), path.join(root, cache, "linked"))
      await write(root, "elsewhere/version/9.9.9/.codex-plugin/plugin.json", '{"name":"versioned"}')
      await write(root, `${cache}/versioned/1.0.0/.codex-plugin/plugin.json`, '{"name":"versioned"}')
      await symlink(path.join(root, "elsewhere/version/9.9.9"), path.join(root, cache, "versioned", "9.9.9"))
      const remote = (name: string, metadata: string) =>
        Promise.all([write(root, `${cache}/${name}/1.0.0/.codex-plugin/plugin.json`, `{"name":"${name}"}`), write(root, `${cache}/${name}/.codex-remote-plugin-install.json`, metadata)])
      await remote("good", '{"schema_version":1,"remote_plugin_id":" plugins~good ","extra":true}')
      await remote("blank", '{"schema_version":1,"remote_plugin_id":"   "}')
      await remote("json", "not json")
      await remote("oversized", `{"schema_version":1,"remote_plugin_id":"x","pad":"${"x".repeat(16 * 1024)}"}`)
      await remote("longid", `{"schema_version":1,"remote_plugin_id":"${"x".repeat(1025)}"}`)
      await write(root, `${cache}/dironly/1.0.0/.codex-plugin/plugin.json`, '{"name":"dironly"}')
      await mkdir(path.join(root, cache, "dironly", ".codex-remote-plugin-install.json"))
      return t
    })
    const result = await discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    expect(result.plugins.map((plugin) => [plugin.id, plugin.version, plugin.remotePluginId])).toEqual([
      ["blank@market", "1.0.0", null],
      ["dironly@market", "1.0.0", null],
      ["good@market", "1.0.0", "plugins~good"],
      ["json@market", "1.0.0", null],
      ["linked@market", "2.0.0", null],
      ["longid@market", "1.0.0", null],
      ["oversized@market", "1.0.0", null],
      ["versioned@market", "1.0.0", null],
    ])
    expect(result.plugins.find((plugin) => plugin.id === "linked@market")!.root).toBe(
      CcaPolicy.toPathUri(path.join(await realpath(f.tree.codexHome), "plugins/cache/market/linked/2.0.0")),
    )
    expect(result.warnings).toEqual(["some capability locations could not be resolved; discovery may be incomplete"])
  })

  test("a YCoding Permission denial for one plugin root drops it silently", async () => {
    const f = await fixture(writeInventoryTree, (input) => input.resources.some((resource) => resource.includes(`${path.sep}mail${path.sep}1.10.0`)))
    const result = await discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["badremote@market", "cal@market", "odd@market", "remote@market"])
    expect(result.warnings).toEqual(golden.inventory.result.warnings)
  })
})

describe("metadata parsing", () => {
  test("frontmatter keeps raw scalar text, repairs colon prose, and validates fields", () => {
    const parse = (contents: string) => parseCcaSkillFrontmatter(contents, () => "fallback")
    expect(parse("---\nname: 0x10\ndescription: 1e3\n---\n")).toEqual({ name: "0x10", description: "1e3", shortDescription: null })
    expect(parse("---\ndescription: {a: b}\n---\n")).toEqual({ name: "fallback", description: "{a: b}", shortDescription: null })
    expect(parse("---\ndescription: 'quoted: ok' # note\nname: ~\n---\n")).toEqual({ name: "fallback", description: "quoted: ok", shortDescription: null })
    expect(parse("\r\n---\ndescription: x\n---\n")).toBeInstanceOf(Error)
    expect(parse("---\ndescription: x\n")).toBeInstanceOf(Error)
    expect(parse("---\n---\n")).toBeInstanceOf(Error)
    expect(parse("---\nname: x\n---\n")).toBeInstanceOf(Error)
    expect(parse(`---\nname: ${"n".repeat(65)}\ndescription: x\n---\n`)).toBeInstanceOf(Error)
    expect(parse(`---\nname: ${"n".repeat(64)}\ndescription: x\n---\n`)).toEqual({ name: "n".repeat(64), description: "x", shortDescription: null })
    expect(parse("---\ndescription: x\nmetadata: [1]\n---\n")).toBeInstanceOf(Error)
    expect(parse("---\ndescription: x\ndescription: y\n---\n")).toBeInstanceOf(Error)
    expect(parse("---\ndescription: [unclosed\n---\n")).toEqual({ name: "fallback", description: "[unclosed", shortDescription: null })
  })

  test("skill metadata drops invalid dependencies and rejects invalid files as a whole", () => {
    expect(parseCcaSkillMetadata("dependencies:\n  tools: [{type: mcp}]\n")).toEqual({ dependencies: null, policy: null })
    expect(parseCcaSkillMetadata("dependencies: {tools: []}\npolicy: {}\n")).toEqual({ dependencies: null, policy: { allowImplicitInvocation: null, products: [] } })
    expect(parseCcaSkillMetadata("dependencies:\n  tools:\n    - {type: mcp, value: v, oauth: {callbackPort: 70000}}\n")).toBeInstanceOf(Error)
    expect(parseCcaSkillMetadata("dependencies:\n  tools:\n    - {type: mcp, value: v, oauth: {callbackPort: 1, callback_port: 2}}\n")).toBeInstanceOf(Error)
    expect(parseCcaSkillMetadata("dependencies:\n  tools:\n    - {type: mcp, value: v, oauth: {callback_port: '1'}}\n")).toBeInstanceOf(Error)
    expect(parseCcaSkillMetadata("dependencies:\n  tools:\n    - {type: mcp, value: v, oauth: {callback_port: 0x10}}\n")).toEqual({
      dependencies: { tools: [{ type: "mcp", value: "v", description: null, transport: null, command: null, url: null, oauthCallbackPort: 16 }] },
      policy: null,
    })
    expect(parseCcaSkillMetadata("policy:\n  allow_implicit_invocation: 'true'\n")).toBeInstanceOf(Error)
    expect(parseCcaSkillMetadata("policy:\n  allow_implicit_invocation: True\n  products: [ATLAS]\n")).toEqual({ dependencies: null, policy: { allowImplicitInvocation: true, products: ["atlas"] } })
    expect(parseCcaSkillMetadata(`dependencies:\n  tools:\n    - {type: "${"t".repeat(65)}", value: v}\n`)).toEqual({ dependencies: null, policy: null })
    expect(parseCcaSkillMetadata("interface:\n  icon_small: 5\n  display_name: ~\n")).toEqual({ dependencies: null, policy: null })
    expect(parseCcaSkillMetadata("a: 1\n---\nb: 2\n")).toBeInstanceOf(Error)
  })
})

describe("response limits", () => {
  test("the response byte limit drops whole skills and leads with the limit warning", async () => {
    const f = await fixture(async (root) => {
      const t = await bareTree(root)
      const description = "d".repeat(900 * 1024)
      for (let index = 0; index < 5; index++) await write(root, `codex/skills/big${index}/SKILL.md`, `---\nname: big${index}\ndescription: ${description}\n---\n`)
      return t
    })
    const result = await discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    expect(result.skills.map((skill) => skill.name)).toEqual(["big0", "big1", "big2", "big3"])
    expect(result.warnings).toEqual(["capability discovery size limit reached"])
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  test("warnings stop at 64 and over-long qualified names are skipped", async () => {
    const f = await fixture(async (root) => {
      const t = await bareTree(root)
      for (let index = 0; index < 70; index++) await write(root, `codex/plugins/cache/market/n${String(index).padStart(2, "0")}/1.0.0/README.md`, "")
      await write(root, "codex/skills/ns/.codex-plugin/plugin.json", `{"name":"${"n".repeat(100)}"}`)
      await write(root, "codex/skills/ns/skills/long/SKILL.md", `---\nname: ${"s".repeat(29)}\ndescription: x\n---\n`)
      await write(root, "codex/skills/ns/skills/fits/SKILL.md", `---\nname: ${"s".repeat(28)}\ndescription: x\n---\n`)
      return t
    })
    const result = await discovery(f).discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    expect(result.warnings).toEqual(Array(64).fill("some capability metadata could not be loaded; discovery may be incomplete"))
    expect(result.skills.map((skill) => skill.name)).toEqual([`${"n".repeat(100)}:${"s".repeat(28)}`])
  })
})

describe("watched discovery state", () => {
  async function demoFixture() {
    return fixture(async (root) => {
      const t = await bareTree(root)
      await write(root, "codex/skills/demo/SKILL.md", "---\nname: demo\ndescription: original\n---\n")
      await write(root, "codex/plugins/cache/acme/gmail/1.0.0/.codex-plugin/plugin.json", '{"name":"gmail"}')
      return t
    })
  }
  const describeDemo = (result: { skills: readonly { name: string; description: string }[] }) => result.skills.map((skill) => `${skill.name}:${skill.description}`)

  test("native watcher failure and rearm health invalidate cached discoveries", async () => {
    for (const rearmFails of [true, false]) {
      const f = await demoFixture()
      const handles: Array<EventEmitter & { close: () => void }> = []
      let fail = false
      const watcher = createNodeCcaCapabilityWatcher(() => {
        if (fail) throw new Error("synthetic watcher unavailable")
        const handle = Object.assign(new EventEmitter(), { close: () => {} })
        handles.push(handle)
        return handle as FSWatcher
      })
      const registrations: ReturnType<CcaCapabilityWatcher>[] = []
      const discover = discovery(f, { watcher: (paths, onChange) => {
        const subscription = watcher(paths, onChange)
        registrations.push(subscription)
        return subscription
      }, throttleMs: 0 })
      const cwd = CcaPolicy.toPathUri(f.tree.project)
      const original = await discover.discover({ cwd }, ctx)
      expect(describeDemo(original)).toEqual(["demo:original"])
      expect(registrations[0].registered).toBe(true)
      await write(f.tree.root, "codex/skills/demo/SKILL.md", "---\nname: demo\ndescription: missed edit\n---\n")
      fail = rearmFails
      handles[0].emit("error", new Error("synthetic watch loss"))
      expect(registrations[0].registered).toBe(!rearmFails)
      expect(describeDemo(await discover.discover({ cwd }, ctx))).toEqual(["demo:missed edit"])
      await discover.close()
      await discover.close()
    }
  })

  test("responses are cached per sandbox context until a watch event invalidates them", async () => {
    const f = await demoFixture()
    const manual = manualWatcher()
    const changes: (readonly string[])[] = []
    const discover = discovery(f, { watcher: manual.watcher, throttleMs: 0 })
    discover.subscribe((change) => changes.push(change.paths))
    const cwd = CcaPolicy.toPathUri(f.tree.project)
    const first = await discover.discover({ cwd }, ctx)
    expect(await discover.discover({ cwd: CcaPolicy.toPathUri(f.tree.root) }, ctx)).toBe(first)
    expect(manual.registrations.at(-1)!.paths).toEqual([
      { path: path.join(await realpath(f.tree.codexHome), "plugins", "cache"), recursive: true },
      { path: path.join(await realpath(f.tree.codexHome), "skills"), recursive: true },
      { path: path.join(f.tree.home, ".agents", "skills"), recursive: true },
      { path: path.join(f.tree.root, "etc", "codex", "skills"), recursive: true },
      { path: path.join(f.tree.root, "data", "dots", "skills"), recursive: true },
    ])
    const sandboxed = { cwd, sandbox: restrictedSandbox([f.tree.root], f.tree.project) }
    const restricted = await discover.discover(sandboxed, ctx)
    expect(restricted).not.toBe(first)
    expect(await discover.discover(sandboxed, ctx)).toBe(restricted)

    await write(f.tree.root, "codex/skills/demo/SKILL.md", "---\nname: demo\ndescription: edited\n---\n")
    expect(await discover.discover({ cwd }, ctx)).toBe(first)
    manual.emit([path.join(f.tree.codexHome, "skills", "demo", "SKILL.md")])
    expect(changes).toEqual([[path.join(f.tree.codexHome, "skills", "demo", "SKILL.md")]])
    const after = await discover.discover({ cwd }, ctx)
    expect(describeDemo(after)).toEqual(["demo:edited"])
    expect(await discover.discover({ cwd }, ctx)).toBe(after)
    expect(manual.registrations.filter((registration) => !registration.closed)).toHaveLength(1)
  })

  test("the oldest of 16 sandbox contexts is evicted first", async () => {
    const f = await demoFixture()
    const discover = discovery(f, { watcher: manualWatcher().watcher })
    const cwd = CcaPolicy.toPathUri(f.tree.project)
    const first = await discover.discover({ cwd }, ctx)
    for (let index = 0; index < 16; index++) {
      await mkdir(path.join(f.tree.project, `context-${index}`))
      const params = { cwd, sandbox: restrictedSandbox([f.tree.root], path.join(f.tree.project, `context-${index}`)) }
      const response = await discover.discover(params, ctx)
      expect(response).toEqual(first)
      expect(await discover.discover(params, ctx)).toBe(response)
    }
    const reloaded = await discover.discover({ cwd }, ctx)
    expect(reloaded).toEqual(first)
    expect(reloaded).not.toBe(first)
  })

  test("events are throttled and coalesced", async () => {
    const f = await demoFixture()
    const manual = manualWatcher()
    const changes: (readonly string[])[] = []
    const discover = discovery(f, { watcher: manual.watcher, throttleMs: 80 })
    discover.subscribe((change) => changes.push(change.paths))
    await discover.discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    manual.emit(["/synthetic/b"])
    manual.emit(["/synthetic/c"])
    manual.emit(["/synthetic/a", "/synthetic/c"])
    expect(changes).toEqual([["/synthetic/b"]])
    await wait(200)
    expect(changes).toEqual([["/synthetic/b"], ["/synthetic/a", "/synthetic/c"]])
  })

  test("a failed refresh keeps the previous response and retries without another event", async () => {
    const f = await demoFixture()
    const manual = manualWatcher()
    const discover = discovery(f, { watcher: manual.watcher, throttleMs: 0 })
    const cwd = CcaPolicy.toPathUri(f.tree.project)
    const first = await discover.discover({ cwd }, ctx)
    const marketplace = path.join(f.tree.codexHome, "plugins", "cache", "acme")
    await chmod(marketplace, 0o000)
    cleanups.push(() => chmod(marketplace, 0o755))
    manual.emit([marketplace])
    expect(await discover.discover({ cwd }, ctx)).toBe(first)
    await chmod(marketplace, 0o755)
    await write(f.tree.root, "codex/skills/recovered/SKILL.md", "---\nname: recovered\ndescription: back\n---\n")
    const recovered = await discover.discover({ cwd }, ctx)
    expect(describeDemo(recovered)).toEqual(["demo:original", "recovered:back"])
    expect(await discover.discover({ cwd }, ctx)).toBe(recovered)
  })

  test("without a watcher or with a failed registration every request reloads", async () => {
    for (const watcher of [null, manualWatcher(false).watcher]) {
      const f = await demoFixture()
      const discover = discovery(f, { watcher })
      const cwd = CcaPolicy.toPathUri(f.tree.project)
      const before = await discover.discover({ cwd }, ctx)
      await write(f.tree.root, "codex/skills/demo/SKILL.md", "---\nname: demo\ndescription: uncached edit\n---\n")
      await write(f.tree.root, "codex/plugins/cache/acme/calendar/1.0.0/.codex-plugin/plugin.json", '{"name":"calendar"}')
      const after = await discover.discover({ cwd }, ctx)
      expect(before.plugins.map((plugin) => plugin.id)).toEqual(["gmail@acme"])
      expect(after.plugins.map((plugin) => plugin.id)).toEqual(["calendar@acme", "gmail@acme"])
      expect(describeDemo(after)).toEqual(["demo:uncached edit"])
    }
  })

  test("failed discoveries are not cached", async () => {
    const root = await tempRoot()
    const codexHome = path.join(root, "codex")
    const discover = createCcaCapabilityDiscoveryV2({
      fs: capabilityFileSystem(root),
      environment: { homeDirectory: path.join(root, "home"), dataDirectory: path.join(root, "data"), codexHomeEnv: codexHome },
      watcher: manualWatcher().watcher,
    })
    cleanups.push(() => discover.close())
    const cwd = CcaPolicy.toPathUri(root)
    expect((await failure(discover.discover({ cwd }, ctx))).code).toBe(-32603)
    await write(root, "codex/skills/demo/SKILL.md", "---\nname: demo\ndescription: later\n---\n")
    expect(describeDemo(await discover.discover({ cwd }, ctx))).toEqual(["demo:later"])
  })

  test("close releases the watch registration and rejects later requests", async () => {
    const f = await demoFixture()
    const manual = manualWatcher()
    const discover = discovery(f, { watcher: manual.watcher })
    await discover.discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx)
    await discover.close()
    expect(manual.registrations.every((registration) => registration.closed)).toBe(true)
    expect(await failure(discover.discover({ cwd: CcaPolicy.toPathUri(f.tree.project) }, ctx))).toEqual({ code: -32603, message: "capability discovery closed" })
  })

  test("the native watcher reports edits below existing roots and creation of missing roots", async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, "present"), { recursive: true })
    const seen: string[] = []
    const subscription = nodeCcaCapabilityWatcher(
      [
        { path: path.join(root, "present"), recursive: true },
        { path: path.join(root, "missing", "skills"), recursive: true },
      ],
      (paths) => seen.push(...paths),
    )
    cleanups.push(async () => subscription.close())
    expect(subscription.registered).toBe(true)
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await wait(50)
      return predicate()
    }
    await wait(100)
    await write(root, "present/demo/SKILL.md", "x")
    expect(await until(() => seen.some((changed) => changed.startsWith(path.join(root, "present"))))).toBe(true)
    seen.length = 0
    await mkdir(path.join(root, "missing", "skills"), { recursive: true })
    expect(await until(() => seen.some((changed) => changed.startsWith(path.join(root, "missing"))))).toBe(true)
    seen.length = 0
    await wait(100)
    await writeFile(path.join(root, "missing", "skills", "new.md"), "x")
    expect(await until(() => seen.some((changed) => changed.startsWith(path.join(root, "missing", "skills"))))).toBe(true)
  })
})
