import { Effect, Option } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import type { DecisionItem } from "@ycoding-ai/client"
import { DecisionCommand, shellCommand } from "../../decision"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(DecisionCommand.commands.list, Effect.fn("cli.decision.list")(function* (input) {
  const connection = yield* ServerConnection.resolve({ server: Option.getOrUndefined(input.server), standalone: input.standalone, mismatch: "ignore" })
  const response = yield* Effect.tryPromise(() => fetch(new URL("/api/decision", connection.endpoint.url), { headers: Service.headers(connection.endpoint) }))
  if (!response.ok) return yield* Effect.fail(new Error(`Decision list failed (HTTP ${response.status})`))
  const result = yield* Effect.tryPromise(() => response.json() as Promise<{ data: DecisionItem[] }>)
  if (input.json) return yield* Effect.sync(() => { process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`) })
  const rows = result.data.map((item) => [item.kind, `${item.sessionTitle} (${item.sessionID})`, item.directory, item.id, item.summary])
  const headings = ["KIND", "SESSION", "DIRECTORY", "ID", "SUMMARY"]
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index]!.length)))
  const line = (row: string[]) => row.map((value, index) => value.replaceAll(/[\r\n\t\x1b]/g, " ").padEnd(widths[index]!)).join("  ").trimEnd()
  process.stdout.write(`${line(headings)}\n`)
  for (const [index, item] of result.data.entries()) {
    process.stdout.write(`${line(rows[index]!)}\n`)
    for (const choice of item.decide) {
      process.stdout.write(`  ${choice.label}${choice.template ? " [template]" : ""}: ${shellCommand(choice.argv)}\n`)
      if (choice.hint) process.stdout.write(`    ${choice.hint}\n`)
    }
  }
  if (result.data.length === 0) process.stdout.write("No pending decisions.\n")
}, Effect.catch((error) => Effect.sync(() => {
  process.stderr.write(`ycoding: ${error.message}\n`)
  process.exitCode = 1
}))))
