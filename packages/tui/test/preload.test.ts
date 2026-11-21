import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { FrontendPaths } from "../src/frontend-paths"

test("test preload isolates static frontend imports and the FrontendPaths service before test modules load", async () => {
  const root = process.env.YCODING_TEST_XDG_ROOT
  expect(root).toBeDefined()
  const expected = {
    home: path.join(root!, "home"),
    cache: path.join(root!, "cache", "ycoding"),
    config: path.join(root!, "config", "ycoding"),
    state: path.join(root!, "state", "ycoding"),
  }
  expect(FrontendPaths.Path).toEqual(expected)
  expect(await Effect.runPromise(FrontendPaths.Service.pipe(Effect.provide(FrontendPaths.layer)))).toEqual(expected)
  expect(process.env.HOME).toBe(expected.home)
  expect(process.env.YCODING_CONFIG_DIR).toBe(expected.config)
  expect(process.env.YCODING_DB).toBeUndefined()
  expect(fs.statSync(expected.home).isDirectory()).toBe(true)
})

test("test preload replaces inherited paths and cleans only its own root on process exit", async () => {
  const parent = process.env.YCODING_TEST_XDG_ROOT!
  const inherited = path.join(parent, "inherited")
  fs.mkdirSync(inherited)
  const marker = path.join(inherited, "retain.txt")
  fs.writeFileSync(marker, "retain inherited data")
  const database = path.join(inherited, "user.db")
  fs.writeFileSync(database, "retain inherited database")
  const frontendPaths = path.resolve(import.meta.dir, "../src/frontend-paths.ts")
  const child = Bun.spawn([
    process.execPath,
    "--preload", "./test/preload.ts",
    "-e",
    `import { FrontendPaths } from ${JSON.stringify(frontendPaths)}; console.log(JSON.stringify({ root: process.env.YCODING_TEST_XDG_ROOT, paths: FrontendPaths.Path, config: process.env.YCODING_CONFIG_DIR, db: process.env.YCODING_DB, content: process.env.YCODING_CONFIG_CONTENT, file: process.env.YCODING_CONFIG }))`,
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
  const result: { root: string; paths: FrontendPaths.Interface; config: string; db?: string; content?: string; file?: string } = JSON.parse(output)
  expect(result.root).not.toBe(inherited)
  for (const directory of Object.values(result.paths)) expect(String(directory).startsWith(result.root + path.sep)).toBe(true)
  expect(result.config).toBe(result.paths.config)
  expect(result.paths.state).toBe(path.join(result.root, "state", "ycoding"))
  expect(result.db).toBeUndefined()
  expect(result.content).toBeUndefined()
  expect(result.file).toBeUndefined()
  expect(fs.existsSync(result.root)).toBe(false)
  expect(fs.readFileSync(marker, "utf8")).toBe("retain inherited data")
  expect(fs.readFileSync(database, "utf8")).toBe("retain inherited database")
})
