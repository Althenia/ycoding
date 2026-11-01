import { expect, test } from "bun:test"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import { CliOutput, Command, type HelpDoc } from "effect/unstable/cli"
import { ApiCommand } from "../src/commands/api"
import { Commands } from "../src/commands/commands"
import { TuiCommand } from "../src/commands/tui"

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
    { name: "operation | method path", description: "OpenAPI operation ID, or an HTTP method followed by a path", variadic: true },
  ])
  expect(doc?.flags.map((flag) => ({ name: flag.name, aliases: [...flag.aliases], description: Option.getOrUndefined(flag.description) }))
    .sort((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: "data", aliases: ["-d"], description: "Request body" },
    { name: "header", aliases: ["-H"], description: "Request header in name:value form" },
    { name: "param", aliases: [], description: "OpenAPI path or query parameter" },
    { name: "server", aliases: [], description: "Connect to a server URL instead of the background service" },
    { name: "standalone", aliases: [], description: "Run with a private server instead of the background service" },
  ])
})

test("CLI api command exits 0 on 2xx response from synthetic server", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/health") return Response.json({ version: "local" })
      if (url.pathname === "/test-ok") return Response.json({ status: "ok" })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "api", "--server", `http://localhost:${server.port}`, "GET", "/test-ok"], {
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

test("CLI api command exits 1 on non-2xx response from synthetic server", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/health") return Response.json({ version: "local" })
      if (url.pathname === "/test-error") return new Response(JSON.stringify({ error: "InvalidRequestError" }), { status: 400, headers: { "content-type": "application/json" } })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "api", "--server", `http://localhost:${server.port}`, "GET", "/test-error"], {
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
