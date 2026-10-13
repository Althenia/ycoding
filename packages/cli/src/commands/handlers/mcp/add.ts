import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"
import { frontendClient } from "../../../services/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.mcp.commands.add,
  Effect.fn("cli.mcp.add")(function* (input) {
    const url = Option.getOrUndefined(input.url)
    const headers = Option.getOrUndefined(input.header)
    const environment = Option.getOrUndefined(input.env)
    // The CLI framework strands `--` operands on the root command, so read the local server command
    // straight from argv after `--`. This also lets the command carry its own flags (e.g. `npx -y`).
    const dash = process.argv.indexOf("--")
    const command = dash === -1 ? [...input.command] : process.argv.slice(dash + 1)

    const hasCommand = command.length > 0
    if (url && hasCommand)
      return yield* Effect.fail(new Error("Provide either --url <url> or a command after --, not both"))
    if (!url && !hasCommand) return yield* Effect.fail(new Error("Provide either --url <url> or a command after --"))
    if (url && !URL.canParse(url)) return yield* Effect.fail(new Error(`Invalid URL: ${url}`))
    if (url && environment) return yield* Effect.fail(new Error("--env is only valid for local MCP servers"))
    if (hasCommand && headers) return yield* Effect.fail(new Error("--header is only valid for remote MCP servers"))

    const server = url
      ? { type: "remote" as const, url, ...(headers ? { headers } : {}) }
      : { type: "local" as const, command, ...(environment ? { environment } : {}) }

    const options = yield* ServiceConfig.options()
    const found = yield* Service.discover(options)
    const endpoint = found ?? (yield* Service.ensure(options))
    const client = yield* frontendClient(endpoint)
    const result = yield* Effect.tryPromise(() =>
      client.mcp.configure({
        location: { directory: process.cwd() },
        name: input.name,
        scope: input.global ? "global" : "project",
        config: server,
      }),
    )
    process.stdout.write(`MCP server "${result.name}" added to ${result.target.path}` + EOL)
  }),
)
