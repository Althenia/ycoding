import { expect, test } from "bun:test"
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
