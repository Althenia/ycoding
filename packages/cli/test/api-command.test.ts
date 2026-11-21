import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli"
import { ApiCommand } from "../src/commands/api"
import { Commands } from "../src/commands/commands"
import { TuiCommand } from "../src/commands/tui"
import { v5Server } from "./fixture/v5-server"

const native = process.env.YCODING_RUNTIME_EXECUTABLE
const cli = path.resolve(import.meta.dirname, "../src/index.ts")

async function runApi(args: string[], cwd: string, env: Record<string, string>, entry = cli) {
  const child = Bun.spawn([process.execPath, entry, "api", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

test.skipIf(!native)("named API reads an isolated native runtime without OpenAPI", async () => {
  if (!native || !path.isAbsolute(native)) throw new Error("Bind YCODING_RUNTIME_EXECUTABLE to the absolute native binary path")
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ycoding-api-native-")))
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    YCODING_TEST_HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    YCODING_CONFIG_DIR: path.join(root, "config/ycoding"),
    YCODING_CONFIG_PROJECT_DISABLE: "1",
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_PASSWORD: "synthetic-api-test",
    YCODING_VERSION: "local",
    YCODING_RUNTIME_EXECUTABLE: native,
  }
  await mkdir(env.YCODING_CONFIG_DIR, { recursive: true })
  const project = path.join(root, "Location with spaces")
  await mkdir(project)
  const backend = Bun.spawn(
    [native, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0", "--frontend-executable", process.execPath,
      "--frontend-arguments", JSON.stringify([cli])],
    { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const output = backend.stdout.getReader()
  const stderr = new Response(backend.stderr).text()
  let checkedServer = false
  try {
    const decoder = new TextDecoder()
    let readiness = ""
    while (!readiness.includes("\n")) {
      const chunk = await output.read()
      if (chunk.done) throw new Error(`Native runtime exited before readiness: ${await stderr}`)
      readiness += decoder.decode(chunk.value, { stream: true })
    }
    const ready: unknown = JSON.parse(readiness.split("\n", 1)[0])
    if (typeof ready !== "object" || ready === null || !("url" in ready) || typeof ready.url !== "string")
      throw new Error("Native runtime did not return a readiness URL")
    const { url } = ready
    expect(new URL(url).hostname).toBe("127.0.0.1")
    const remote = (...args: string[]) => runApi(["--server", url, ...args], root, env)
    const read = async (...args: string[]) => {
      const result = await remote(...args)
      expect(result.exit, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    const location = ["-H", `x-ycoding-directory:${encodeURIComponent(project)}`]
    expect(await read("session.list", "--param", "limit=1")).toEqual({ data: [], cursor: {} })
    const sessionID = "ses_named_api_fixture"
    const selector = ["--param", `sessionID=${sessionID}`]
    const created = await read("session.create", ...location, "-d", JSON.stringify({ id: sessionID, title: "Named API fixture" }))
    expect(created).toMatchObject({ data: { id: sessionID, title: "Named API fixture", location: { directory: project } } })
    expect(await read("session.list", "--param", "limit=1", "--param", "parentID=null")).toMatchObject({ data: [created.data] })
    expect(await read("session.get", ...selector)).toEqual(created)
    const snapshot = await read("session.snapshot", ...selector, "--param", "limit=1")
    expect(snapshot).toMatchObject({ session: created.data, messages: [], watermark: { aggregateID: sessionID } })
    expect(await read("session.autonomy.get", ...selector)).toMatchObject({ data: { mode: "normal" } })
    expect(await read("session.snapshot", ...selector, "--param", "limit=1")).toEqual(snapshot)
    const catalog = { location: { directory: project } }
    expect(await read("config.diagnostics", ...location)).toMatchObject({ ...catalog, data: [] })
    expect(await read("provider.list", ...location)).toMatchObject({ ...catalog, data: expect.any(Array) })
    expect(await read("model.default", ...location)).toMatchObject(catalog)
    const log = await remote("session.log", ...selector, "--param", "follow=false")
    expect(log.exit, log.stderr).toBe(0)
    const events = log.stdout.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    expect(events).toMatchObject([
      { type: "session.created", durable: { aggregateID: sessionID, version: 2 } },
      { type: "log.synced", aggregateID: sessionID },
    ])
    const missing = await remote("session.get", "--param", "sessionID=ses_missing")
    expect(missing.exit).toBe(1)
    expect(missing.stderr).toContain("SessionNotFoundError")
    expect(JSON.parse(missing.stdout)).toMatchObject({ _tag: "SessionNotFoundError", sessionID: "ses_missing" })
    const unauthenticated = await runApi(["--server", url, "session.get", ...selector], root, { ...env, YCODING_PASSWORD: "" })
    expect(unauthenticated.exit).toBe(1)
    expect(unauthenticated.stdout).toBe("")
    checkedServer = true
  } finally {
    await backend.stdin.end()
    await output.cancel()
    const timer = setTimeout(() => backend.kill(), 3000)
    try {
      await backend.exited
    } finally {
      clearTimeout(timer)
      if (!checkedServer) await rm(root, { recursive: true, force: true })
    }
  }
  try {
    const result = await runApi(
      ["--standalone", "session.autonomy.get", "--param", "sessionID=ses_named_api_fixture"],
      root,
      env,
      path.resolve(import.meta.dirname, "../src/tui.ts"),
    )
    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { mode: "normal" } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("the full CLI and the installed TUI share one api command definition", () => {
  expect(Commands.commands.api).toBe(ApiCommand)
  expect(TuiCommand.commands.api).toBe(ApiCommand)
  expect(ApiCommand.name).toBe("api")
  expect(ApiCommand.commands).toEqual({})
})

test("the api command keeps its description, argument and flags", async () => {
  let doc: HelpDoc.HelpDoc | undefined
  const formatter = CliOutput.defaultFormatter()
  await Command.runWith(Command.withHandler(ApiCommand.spec, () => Effect.void), { version: "test" })(["--help"]).pipe(
    Effect.provide(CliOutput.layer({ ...formatter, formatHelpDoc: (value) => { doc = value; return "" } })),
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  )
  expect(doc?.description).toBe("Make a request to the running server")
  expect(doc?.args?.map((arg) => ({ name: arg.name, description: Option.getOrUndefined(arg.description), variadic: arg.variadic }))).toEqual([
    { name: "operation | method path", description: "V5 operation name, or an HTTP method followed by a path", variadic: true },
  ])
  expect(doc?.flags.map((flag) => ({ name: flag.name, aliases: [...flag.aliases], description: Option.getOrUndefined(flag.description) }))
    .sort((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: "data", aliases: ["-d"], description: "Request body" },
    { name: "header", aliases: ["-H"], description: "Request header in name:value form" },
    { name: "param", aliases: [], description: "Named operation path or query parameter" },
    { name: "server", aliases: [], description: "Connect to a server URL instead of the background service" },
    { name: "standalone", aliases: [], description: "Run with a private server instead of the background service" },
  ])
})

test("CLI named operations send typed v5 selectors and bodies without HTTP discovery", async () => {
  const requests: { name: string; data: unknown }[] = []
  const httpRequests: string[] = []
  const server = v5Server((name, data) => {
    if (name === "health.get") return { data: { version: "local" } }
    requests.push({ name, data })
    if (name === "session.list") return { data: { data: [], cursor: {} } }
    if (name === "session.autonomy.set")
      return { _tag: "InvalidRequestError", message: "No retained goal to resume." }
    return new Error("Unexpected named API operation")
  }, { httpRequests })
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-api-wire-"))
  const env = { PATH: process.env.PATH ?? "", HOME: root, YCODING_TEST_HOME: root }
  try {
    const run = (...args: string[]) => runApi(["--server", server.url, ...args], path.resolve(import.meta.dirname, ".."), env)
    const list = await run("session.list", "--param", "limit=1", "--param", "parentID=null", "--param", "pinned=false")
    expect(list).toEqual({ exit: 0, stdout: JSON.stringify({ data: [], cursor: {} }) + "\n", stderr: "" })
    const resume = await run("session.autonomy.set", "--param", "sessionID=ses_fixture", "-d", '{"goal":true}')
    expect(resume.exit).toBe(1)
    expect(JSON.parse(resume.stdout)).toEqual({ _tag: "InvalidRequestError", message: "No retained goal to resume." })
    expect(resume.stderr).toContain("ycoding: API request failed: InvalidRequestError")
    expect(requests).toEqual([
      { name: "session.list", data: { query: { limit: 1, parentID: null, pinned: false } } },
      { name: "session.autonomy.set", data: { params: { sessionID: "ses_fixture" }, payload: { goal: true } } },
    ])
    expect(httpRequests).toEqual(["GET /api/health", "GET /api/health"])
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("CLI api command exits 0 on 2xx response from synthetic server", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/health") return Response.json({ version: "local" })
      if (url.pathname === "/test-ok") return Response.json({ status: "ok" })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "api", "--server", server.url.toString(), "GET", "/test-ok"], {
      cwd: path.resolve(__dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('"status":"ok"')
  } finally {
    server.stop(true)
  }
})

test("CLI api command writes a multi-megabyte response completely to a piped stdout", async () => {
  const body = JSON.stringify({ blob: "x".repeat(4 * 1024 * 1024) })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/health") return Response.json({ version: "local" })
      if (url.pathname === "/large") return new Response(body, { headers: { "content-type": "application/json" } })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "api", "--server", server.url.toString(), "GET", "/large"], {
      cwd: path.resolve(__dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(exitCode).toBe(0)
    expect(stdout.length).toBe(body.length + 1)
    expect(JSON.parse(stdout)).toEqual(JSON.parse(body))
  } finally {
    void server.stop(true)
  }
}, 30000)

test("CLI api command exits 1 on non-2xx response from synthetic server", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/health") return Response.json({ version: "local" })
      if (url.pathname === "/test-error") return new Response(JSON.stringify({ error: "InvalidRequestError" }), { status: 400, headers: { "content-type": "application/json" } })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "api", "--server", server.url.toString(), "GET", "/test-error"], {
      cwd: path.resolve(__dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(1)
    expect(stderr).toContain("ycoding: API request failed: HTTP 400")
    expect(stdout).toContain("InvalidRequestError")
  } finally {
    server.stop(true)
  }
})
