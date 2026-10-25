import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"

test("test preload isolates static Core imports and the Global service before test modules load", async () => {
  const root = process.env.YCODING_TEST_XDG_ROOT
  expect(root).toBeDefined()
  const expected = {
    home: path.join(root!, "home"),
    data: path.join(root!, "data", "ycoding"),
    cache: path.join(root!, "cache", "ycoding"),
    config: path.join(root!, "config", "ycoding"),
    state: path.join(root!, "state", "ycoding"),
    tmp: path.join(root!, "tmp", "ycoding"),
    bin: path.join(root!, "cache", "ycoding", "bin"),
    log: path.join(root!, "data", "ycoding", "log"),
    repos: path.join(root!, "data", "ycoding", "repos"),
  }
  expect(Global.Path).toEqual(expected)
  expect(await Effect.runPromise(Global.Service.pipe(Effect.provide(AppNodeBuilder.build(Global.node))))).toEqual(expected)
  expect(process.env.HOME).toBe(expected.home)
  expect(process.env.YCODING_CONFIG_DIR).toBe(expected.config)
  expect(process.env.YCODING_DB).toBeUndefined()
  for (const directory of Object.values(expected)) expect(fs.statSync(directory).isDirectory()).toBe(true)
})

test("test preload replaces inherited paths and cleans only its own root on process exit", async () => {
  const parent = process.env.YCODING_TEST_XDG_ROOT!
  const inherited = path.join(parent, "inherited")
  fs.mkdirSync(inherited)
  const marker = path.join(inherited, "retain.txt")
  fs.writeFileSync(marker, "retain inherited data")
  const database = path.join(inherited, "user.db")
  fs.writeFileSync(database, "retain inherited database")
  const child = Bun.spawn([
    process.execPath,
    "--preload", "./test/preload.ts",
    "-e",
    'import { Global } from "@ycoding-ai/core/global"; console.log(JSON.stringify({ root: process.env.YCODING_TEST_XDG_ROOT, paths: Global.Path, config: process.env.YCODING_CONFIG_DIR, db: process.env.YCODING_DB, content: process.env.YCODING_CONFIG_CONTENT, file: process.env.YCODING_CONFIG }))',
  ], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: inherited,
      USERPROFILE: inherited,
      TMPDIR: inherited,
      TMP: inherited,
      TEMP: inherited,
      XDG_DATA_HOME: inherited,
      XDG_CACHE_HOME: inherited,
      XDG_CONFIG_HOME: inherited,
      XDG_STATE_HOME: inherited,
      XDG_RUNTIME_DIR: inherited,
      YCODING_TEST_HOME: inherited,
      YCODING_TEST_XDG_ROOT: inherited,
      YCODING_CONFIG_DIR: inherited,
      YCODING_CONFIG: marker,
      YCODING_CONFIG_CONTENT: '{"theme":{"name":"inherited"}}',
      YCODING_DB: database,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(error).toBe("")
  expect(code).toBe(0)
  const result: { root: string; paths: Global.Interface; config: string; db?: string; content?: string; file?: string } = JSON.parse(output)
  expect(result.root).not.toBe(inherited)
  for (const directory of Object.values(result.paths)) expect(String(directory).startsWith(result.root + path.sep)).toBe(true)
  expect(result.config).toBe(result.paths.config)
  expect(result.paths.data).toBe(path.join(result.root, "data", "ycoding"))
  expect(result.db).toBeUndefined()
  expect(result.content).toBeUndefined()
  expect(result.file).toBeUndefined()
  expect(fs.existsSync(result.root)).toBe(false)
  expect(fs.readFileSync(marker, "utf8")).toBe("retain inherited data")
  expect(fs.readFileSync(database, "utf8")).toBe("retain inherited database")
})
