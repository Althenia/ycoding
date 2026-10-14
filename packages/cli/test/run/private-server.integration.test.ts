import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { providerConfig, startProviderStandIn } from "../remote-harness"

const cli = path.resolve(import.meta.dir, "../../src/tui.ts")
const marker = "PROJECT-RULE-MARKER"

test("run --isolated uses a temporary data directory and --config outranks project configuration", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-run-private-")))
  const standIn = await startProviderStandIn({ text: "Isolated run finished." })
  const user = path.join(root, "user")
  const project = path.join(root, "project")
  const tmp = path.join(root, "tmp")
  const userDatabase = path.join(user, "data", "ycoding", "user.db")
  try {
    await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(tmp, { recursive: true })])
    await fs.writeFile(path.join(project, "AGENTS.md"), marker)
    await fs.writeFile(
      path.join(project, "ycoding.json"),
      JSON.stringify({
        ...JSON.parse(providerConfig(standIn)),
        capabilities: { instructions: { project: true }, builtin_instructions: { enabled: true } },
      }),
    )
    const runConfig = path.join(root, "run.jsonc")
    await fs.writeFile(
      runConfig,
      `{
        // Per-run evaluation toggles.
        "capabilities": { "instructions": { "project": false }, "builtin_instructions": { "enabled": false } },
      }`,
    )
    const run = (...flags: string[]) =>
      spawn(["run", ...flags, "--model", `${standIn.providerID}/${standIn.modelID}`, "--format", "json", "hello"], {
        env: {
          HOME: user,
          YCODING_TEST_HOME: user,
          XDG_CONFIG_HOME: path.join(user, "config"),
          XDG_DATA_HOME: path.join(user, "data"),
          XDG_CACHE_HOME: path.join(user, "cache"),
          XDG_STATE_HOME: path.join(user, "state"),
          TMPDIR: tmp,
          YCODING_DB: userDatabase,
          YCODING_DISABLE_MODELS_FETCH: "1",
          YCODING_DISABLE_AUTOUPDATE: "1",
          PWD: project,
        },
      })

    const plain = await run("--isolated")
    expect(plain.exitCode, plain.stderr).toBe(0)
    const configured = await run("--isolated", "--config", runConfig)
    expect(configured.exitCode, configured.stderr).toBe(0)

    const [first, second] = standIn.requests().map((request) => JSON.stringify(request))
    expect(first).toContain(marker)
    expect(first).toContain("<env>")
    expect(second).toBeDefined()
    expect(second).toContain("hello")
    expect(second).not.toContain(marker)
    expect(second).not.toContain("<env>")

    expect(await Bun.file(userDatabase).exists()).toBe(false)
    expect((await fs.readdir(path.join(user, "data", "ycoding"))).filter((name) => name.endsWith(".db"))).toEqual([])
    expect((await fs.readdir(tmp)).filter((name) => name.startsWith("ycoding-isolated-"))).toEqual([])
  } finally {
    await standIn.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 120_000)

// Bun resolves the CLI's JSX runtime from the package directory; the run Location comes from PWD.
async function spawn(args: string[], options: { env: Record<string, string> }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["YCODING_CONFIG", "YCODING_CONFIG_CONTENT", "YCODING_CONFIG_DIR", "YCODING_PASSWORD"].includes(key),
    ),
  )
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...env, ...options.env },
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
