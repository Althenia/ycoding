import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const turbo = path.join(root, "node_modules/.bin/turbo")
const tsgo = path.join(root, "node_modules/.bin/tsgo")
const cli = "@ycoding-ai/cli#typecheck"
const web = "@ycoding-ai/web#typecheck"

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  })
  if (result.exitedDueToTimeout) throw new Error("Subprocess exceeded its timeout")
  if (result.signalCode) throw new Error(`Subprocess terminated by ${result.signalCode}`)
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

function task(plan: unknown, id: string) {
  if (typeof plan !== "object" || plan === null) throw new Error("Turbo did not return a run plan")
  const tasks: unknown = Reflect.get(plan, "tasks")
  if (!Array.isArray(tasks)) throw new Error("Turbo did not return tasks")
  const found: unknown = tasks.find(
    (value: unknown) => typeof value === "object" && value !== null && Reflect.get(value, "taskId") === id,
  )
  if (typeof found !== "object" || found === null) throw new Error(`Turbo did not include ${id}`)
  const hash: unknown = Reflect.get(found, "hash")
  const inputs: unknown = Reflect.get(found, "inputs")
  const dependencies: unknown = Reflect.get(found, "dependencies")
  if (typeof hash !== "string" || typeof inputs !== "object" || inputs === null || !Array.isArray(dependencies))
    throw new Error(`Invalid Turbo task ${id}`)
  return {
    hash,
    inputs: Object.keys(inputs),
    dependencies: dependencies.map((value: unknown) => {
      if (typeof value !== "string") throw new Error(`Invalid dependency in ${id}`)
      return value
    }),
  }
}

function plan(cwd: string) {
  const result = run(
    [
      turbo,
      "run",
      "typecheck",
      "--filter=@ycoding-ai/cli",
      "--filter=@ycoding-ai/web",
      "--filter=@ycoding-ai/remote",
      "--cache=local:rw",
      "--dry-run=json",
    ],
    cwd,
  )
  if (result.code !== 0) throw new Error(`Turbo dry run failed: ${result.stderr}`)
  const value: unknown = JSON.parse(result.stdout)
  return value
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-typecheck-cache-"))
  const write = async (file: string, value: string) => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await Bun.write(path.join(directory, file), value)
  }
  try {
    await write(
      "package.json",
      JSON.stringify({
        name: "ycoding-cache-fixture",
        private: true,
        packageManager: (await Bun.file(path.join(root, "package.json")).json()).packageManager,
        workspaces: ["packages/*", "apps/*"],
      }),
    )
    await write(".gitignore", "node_modules\n.turbo\n")
    await write("turbo.json", await Bun.file(path.join(root, "turbo.json")).text())
    for (const [directory, name, dependencies] of [
      ["packages/cli", "@ycoding-ai/cli", { "@ycoding-ai/remote": "workspace:*", "@ycoding-ai/schema": "workspace:*" }],
      ["apps/web", "@ycoding-ai/web", { "@ycoding-ai/remote": "workspace:*" }],
      ["packages/remote", "@ycoding-ai/remote", {}],
      ["packages/schema", "@ycoding-ai/schema", {}],
    ] as const) {
      await write(
        `${directory}/package.json`,
        JSON.stringify({
          name,
          version: "0.0.0",
          private: true,
          type: "module",
          exports: "./src/index.ts",
          dependencies,
          scripts: { typecheck: `${tsgo} --noEmit -p tsconfig.json` },
        }),
      )
      await write(
        `${directory}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "ESNext",
            moduleResolution: "bundler",
            target: "ESNext",
            types: [],
          },
          include: ["src", "test"],
        }),
      )
    }
    await write("infra/cloudflare/worker-configuration.d.ts", "interface WorkerBinding { enabled: boolean }\n")
    await write(
      "infra/cloudflare/src/push/store.ts",
      '/// <reference path="../../worker-configuration.d.ts" />\nexport type PushStore = { upsert: () => void; binding?: WorkerBinding }\n',
    )
    await write("infra/cloudflare/test/notice-storage.ts", 'export type { PushStore } from "../src/push/store"\n')
    await write("infra/cloudflare/test/support/d1-sqlite.ts", "export const adapterVersion = 1\n")
    await write("packages/remote/src/index.ts", "export type Envelope = { id: string }\n")
    await write("packages/schema/src/index.ts", "export type Session = { id: string }\n")
    await write(
      "packages/cli/src/index.ts",
      'import type { Envelope } from "@ycoding-ai/remote"\nimport type { Session } from "@ycoding-ai/schema"\nexport const value: Envelope & Session = { id: "synthetic" }\n',
    )
    await write(
      "apps/web/src/index.ts",
      'import type { Envelope } from "@ycoding-ai/remote"\nexport const value: Envelope = { id: "synthetic" }\n',
    )
    for (const owner of ["packages/cli", "apps/web"]) {
      await write(
        `${owner}/test/worker.ts`,
        'import type { PushStore } from "../../../infra/cloudflare/test/notice-storage"\nimport { adapterVersion } from "../../../infra/cloudflare/test/support/d1-sqlite"\nexport const store: PushStore = { upsert: () => {} }\nexport const version = adapterVersion\n',
      )
    }
    await fs.mkdir(path.join(directory, "node_modules/@ycoding-ai"), { recursive: true })
    await Promise.all(
      ["remote", "schema"].map((name) =>
        fs.symlink(path.join(directory, `packages/${name}`), path.join(directory, `node_modules/@ycoding-ai/${name}`)),
      ),
    )
    const lock = run(["bun", "install", "--lockfile-only", "--offline", "--ignore-scripts"], directory)
    if (lock.code !== 0) throw new Error(`Fixture lock generation failed: ${lock.stderr}`)
    return { directory, write, close: () => fs.rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

test("typecheck cache includes Worker source, generated declarations and shared test adapters, then rechecks changed contracts", async () => {
  const f = await fixture()
  try {
    const before = plan(f.directory)
    for (const file of [
      "infra/cloudflare/src/push/store.ts",
      "infra/cloudflare/worker-configuration.d.ts",
      "infra/cloudflare/test/notice-storage.ts",
      "infra/cloudflare/test/support/d1-sqlite.ts",
    ]) {
      const content = await Bun.file(path.join(f.directory, file)).text()
      await f.write(file, `${content}\nexport type CacheRevision = 1\n`)
      const changed = plan(f.directory)
      expect(task(changed, cli).hash).not.toBe(task(before, cli).hash)
      expect(task(changed, web).hash).not.toBe(task(before, web).hash)
      expect(task(changed, "@ycoding-ai/remote#typecheck").hash).toBe(task(before, "@ycoding-ai/remote#typecheck").hash)
      await f.write(file, content)
    }
    const command = [
      turbo,
      "run",
      "typecheck",
      "--filter=@ycoding-ai/cli",
      "--filter=@ycoding-ai/web",
      "--cache=local:rw",
    ]
    const first = run(command, f.directory)
    expect(first.code, first.stdout + first.stderr).toBe(0)
    const cached = run(command, f.directory)
    expect(cached.code, cached.stdout + cached.stderr).toBe(0)
    expect(cached.stdout).toContain("cache hit")
    await f.write("infra/cloudflare/src/push/store.ts", "export type PushStore = { upsert: () => Promise<boolean> }\n")
    const broken = run(command, f.directory)
    expect(broken.code, broken.stdout + broken.stderr).toBeGreaterThan(0)
    expect(broken.stdout + broken.stderr).toContain("Promise<boolean>")
  } finally {
    await f.close()
  }
}, 90_000)

test("declared workspace source changes invalidate only consuming typechecks without ordering independent checks", async () => {
  const f = await fixture()
  try {
    const before = plan(f.directory)
    await f.write("packages/remote/src/index.ts", "export type Envelope = { id: string; revision?: number }\n")
    const shared = plan(f.directory)
    expect(task(shared, cli).hash).not.toBe(task(before, cli).hash)
    expect(task(shared, web).hash).not.toBe(task(before, web).hash)
    for (const owner of [cli, web])
      expect(task(shared, owner).dependencies.some((id) => id.endsWith("#typecheck"))).toBe(false)
    await f.write("packages/remote/src/index.ts", "export type Envelope = { id: string }\n")
    await f.write("packages/schema/src/index.ts", "export type Session = { id: string; revision?: number }\n")
    const schema = plan(f.directory)
    expect(task(schema, cli).hash).not.toBe(task(before, cli).hash)
    expect(task(schema, web).hash).toBe(task(before, web).hash)
  } finally {
    await f.close()
  }
}, 90_000)

test("live Worker-importing typechecks declare their external inputs without charging the comment-only remote package", () => {
  const live = plan(root)
  for (const owner of [cli, web]) {
    const inputs = task(live, owner).inputs
    for (const file of [
      "infra/cloudflare/src/push/store.ts",
      "infra/cloudflare/worker-configuration.d.ts",
      "infra/cloudflare/test/notice-storage.ts",
      "infra/cloudflare/test/support/d1-sqlite.ts",
    ])
      expect(inputs.some((input) => input.endsWith(file))).toBe(true)
  }
  expect(task(live, "@ycoding-ai/remote#typecheck").inputs.some((input) => input.includes("infra/cloudflare"))).toBe(
    false,
  )
  expect(task(live, "@ycoding-ai/tui#typecheck-inputs").inputs).toContain("src/image.d.ts")
  expect(task(live, "@ycoding-ai/ai#typecheck-inputs").inputs).toContain("test/lib/openai-chunks.ts")
})
