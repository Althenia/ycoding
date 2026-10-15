import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { deltaChunk, finishChunk } from "../../../ai/test/lib/openai-chunks"
import { providerConfig, startProviderStandIn } from "../remote-harness"
import { platformBinary } from "../../src/binary"

const cli = path.resolve(import.meta.dir, "../../src/tui.ts")
const runtime = path.resolve(import.meta.dir, "../../../../rust/target/debug", platformBinary("ycoding-runtime"))
const marker = "PROJECT-RULE-MARKER"

test("run --isolated uses a temporary data directory and --config outranks project configuration", async () => {
  const fixture = await privateRun()
  try {
    const runConfig = path.join(fixture.root, "run.jsonc")
    await fs.writeFile(
      runConfig,
      `{
        // Per-run evaluation toggles.
        "capabilities": { "instructions": { "project": false }, "builtin_instructions": { "enabled": false } },
      }`,
    )
    const plain = await fixture.run("--isolated")
    expect(plain.exitCode, plain.stderr + plain.stdout).toBe(0)
    const configured = await fixture.run("--isolated", "--config", runConfig)
    expect(configured.exitCode, configured.stderr + configured.stdout).toBe(0)
    const [first, second] = fixture.standIn.requests().map((request) => JSON.stringify(request))
    expect(first).toContain(marker)
    expect(first).toContain("<env>")
    expect(second).toBeDefined()
    expect(second).toContain("hello")
    expect(second).not.toContain(marker)
    expect(second).not.toContain("<env>")
    expect(await Bun.file(fixture.userDatabase).exists()).toBe(false)
    expect(
      (await fs.readdir(path.join(fixture.user, "data", "ycoding"))).filter((name) => name.endsWith(".redb")),
    ).toEqual([])
    expect(fixture.stores).toHaveLength(2)
    expect(fixture.stores.every((file) => file.endsWith(path.join("ycoding", "ycoding.redb")))).toBe(true)
    expect((await fs.readdir(fixture.tmp)).filter((name) => name.startsWith("ycoding-isolated-"))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 120_000)

test("isolated beta run leaves a real existing beta marker, stores and user roots unchanged", async () => {
  const fixture = await privateRun("beta")
  try {
    const child = Bun.spawn([runtime, "--stdio", "--port", "0"], {
      cwd: fixture.project,
      env: { ...fixture.env, YCODING_CHANNEL: "beta", YCODING_CONFIG_PROJECT_DISABLE: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toContain('"url":"http://127.0.0.1:')
      reader.releaseLock()
      await child.stdin.end()
      expect(await child.exited, await stderr).toBe(0)
    } finally {
      child.kill()
      await child.exited
    }
    const selection = await Bun.file(path.join(fixture.user, "state/ycoding-beta/stable-import-v1.json")).json()
    expect(selection).toMatchObject({ version: 2, kind: "core", sealed: true })
    expect(await Bun.file(path.join(fixture.user, "data/ycoding-beta/ycoding.redb")).exists()).toBe(true)
    await fs.writeFile(path.join(fixture.user, "data/ycoding/ycoding.db"), "stable-source-must-not-be-imported")
    const before = await inventory(fixture.user)
    const result = await fixture.run("--isolated")
    expect(result.exitCode, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain("Isolated run finished.")
    expect(fixture.standIn.requests().length).toBeGreaterThan(0)
    expect(fixture.stores).toHaveLength(1)
    expect(fixture.stores[0]).toEndWith(path.join("ycoding-beta", "ycoding.redb"))
    expect(await inventory(fixture.user)).toEqual(before)
    expect((await fs.readdir(fixture.tmp)).filter((name) => name.startsWith("ycoding-isolated-"))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 30_000)

test("isolated provider uses environment credentials without a stored credential", async () => {
  const fixture = await privateRun()
  try {
    const document = JSON.parse(providerConfig(fixture.standIn))
    delete document.providers[fixture.standIn.providerID].settings.apiKey
    document.providers[fixture.standIn.providerID].env = ["YCODING_PRIVATE_TEST_KEY"]
    await fs.writeFile(path.join(fixture.project, "ycoding.json"), JSON.stringify(document))
    const result = await fixture.runWith({ YCODING_PRIVATE_TEST_KEY: "private-env-key" }, "--isolated")
    expect(result.exitCode, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain("Isolated run finished.")
    expect(fixture.standIn.authorizations()).toEqual(["Bearer private-env-key"])
    expect(await Bun.file(fixture.userDatabase).exists()).toBe(false)
  } finally {
    await fixture.close()
  }
}, 30_000)

test("private config alone starts a server and resolves config and file references from the run directory", async () => {
  const fixture = await privateRun()
  try {
    const config = path.join(fixture.root, "config")
    await fs.mkdir(config)
    await fs.writeFile(path.join(fixture.project, "prompt.txt"), "RUN-DIRECTORY-PROMPT")
    await fs.writeFile(
      path.join(config, "eval.jsonc"),
      '{ // JSONC\n "agents": { "build": { "system": "{file:prompt.txt}" } }, }',
    )
    const result = await fixture.run("--config", "../config/eval.jsonc", "--agent", "build")
    expect(result.exitCode, result.stderr + result.stdout).toBe(0)
    expect(
      fixture.standIn
        .requests()
        .map((request) => JSON.stringify(request))
        .join("\n"),
    ).toContain("RUN-DIRECTORY-PROMPT")
    expect(await Bun.file(fixture.userDatabase).exists()).toBe(true)
    expect(
      (await fs.readdir(path.join(fixture.user, "state", "ycoding"))).filter((name) => name.startsWith("service")),
    ).toEqual([])
  } finally {
    await fixture.close()
  }
}, 30_000)

test("isolated data is removed after a runtime error without changing user roots", async () => {
  const fixture = await privateRun()
  try {
    const before = await inventory(fixture.user)
    const result = await fixture.run("--isolated", "--session", "ses_missing_private_eval")
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Session not found")
    expect(fixture.standIn.requests()).toEqual([])
    expect(await inventory(fixture.user)).toEqual(before)
    expect((await fs.readdir(fixture.tmp)).filter((name) => name.startsWith("ycoding-isolated-"))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 30_000)

test("isolated data is removed after a Rust bootstrap error without changing user roots", async () => {
  const fixture = await privateRun()
  try {
    const config = path.join(fixture.root, "bootstrap-error.jsonc")
    await fs.writeFile(config, '{ "agents": { "build": { "system": "{file:absent-prompt.txt}" } } }')
    const before = await inventory(fixture.user)
    const result = await fixture.run("--isolated", "--config", config)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("production composition failed")
    expect(fixture.standIn.requests()).toEqual([])
    expect(await inventory(fixture.user)).toEqual(before)
    expect((await fs.readdir(fixture.tmp)).filter((name) => name.startsWith("ycoding-isolated-"))).toEqual([])
  } finally {
    await fixture.close()
  }
}, 30_000)

async function privateRun(channel = "local") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-run-private-")))
  const user = path.join(root, "user")
  const project = path.join(root, "project")
  const tmp = path.join(root, "tmp")
  const stores: string[] = []
  await Promise.all([
    fs.mkdir(project),
    fs.mkdir(tmp),
    ...["data", "config", "cache", "state"].flatMap((base) =>
      ["ycoding", "ycoding-beta"].map(async (namespace) => {
        const directory = path.join(user, base, namespace)
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(path.join(directory, "unrelated"), `${base}/${namespace}`)
      }),
    ),
  ])
  const standIn = await startProviderStandIn({
    text: "Isolated run finished.",
    reply: () => {
      stores.push(
        ...readdirSync(tmp, { recursive: true })
          .map(String)
          .filter((name) => path.basename(name) === "ycoding.redb")
          .map((name) => path.join(tmp, name)),
      )
      return [deltaChunk({ role: "assistant" }), deltaChunk({ content: "Isolated run finished." }), finishChunk("stop")]
    },
  })
  await fs.writeFile(path.join(project, "AGENTS.md"), marker)
  await fs.writeFile(
    path.join(project, "ycoding.json"),
    JSON.stringify({
      ...JSON.parse(providerConfig(standIn)),
      capabilities: { instructions: { project: true }, builtin_instructions: { enabled: true } },
    }),
  )
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: user,
    YCODING_TEST_HOME: user,
    XDG_CONFIG_HOME: path.join(user, "config"),
    XDG_DATA_HOME: path.join(user, "data"),
    XDG_CACHE_HOME: path.join(user, "cache"),
    XDG_STATE_HOME: path.join(user, "state"),
    TMPDIR: tmp,
    TEMP: tmp,
    YCODING_DB: path.join(user, "data", channel === "beta" ? "ycoding-beta" : "ycoding", "ycoding.redb"),
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_DISABLE_AUTOUPDATE: "1",
    PWD: project,
    YCODING_RUNTIME_EXECUTABLE: runtime,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "bun-cache"),
  }
  const runWith = (overrides: NodeJS.ProcessEnv, ...flags: string[]) =>
    spawn(
      ["run", ...flags, "--model", `${standIn.providerID}/${standIn.modelID}`, "--format", "json", "hello"],
      { ...env, ...overrides },
      channel,
    )
  return {
    root,
    user,
    project,
    tmp,
    stores,
    standIn,
    env,
    userDatabase: env.YCODING_DB!,
    runWith,
    run: (...flags: string[]) => runWith({}, ...flags),
    close: async () => {
      await standIn.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function spawn(args: string[], env: NodeJS.ProcessEnv, channel: string) {
  const child = Bun.spawn([process.execPath, "--define", `YCODING_CHANNEL=${JSON.stringify(channel)}`, cli, ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function inventory(root: string) {
  return Promise.all(
    (await fs.readdir(root, { recursive: true })).sort().map(async (file) => {
      const target = path.join(root, file)
      const stat = await fs.stat(target)
      return {
        file,
        mode: stat.mode,
        mtime: stat.mtimeMs,
        ...(stat.isFile()
          ? {
              digest: createHash("sha256")
                .update(await fs.readFile(target))
                .digest("hex"),
            }
          : {}),
      }
    }),
  )
}
