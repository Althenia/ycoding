import { createInterface } from "node:readline/promises"
import { Effect, Option, Schema } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand, dotsAttachConfirmed, dotsAttachWarning, dotsComputerLine } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

const Envelope = Schema.Struct({ data: Dots.NativeStatus })
const decode = Schema.decodeUnknownPromise(Envelope)

async function ask() {
  if (!process.stdin.isTTY) return undefined
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await prompt.question("Attach this computer? [y/N] ")
  } finally {
    prompt.close()
  }
}

export default Runtime.handler(DotsCommand.commands.attach, Effect.fn("cli.dots.attach")(function* (input) {
  const connection = yield* ServerConnection.resolve({ server: Option.getOrUndefined(input.server), mismatch: "ignore" })
  const request = (method: "GET" | "POST", expectedTarget?: Dots.ComputerTarget) => Effect.tryPromise(async () => {
    const headers = new Headers(Service.headers(connection.endpoint))
    if (method === "POST") headers.set("content-type", "application/json")
    const response = await fetch(new URL(method === "GET" ? "/api/dots" : "/api/dots/computer", connection.endpoint.url), {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify({ replaceOthers: true, ...(expectedTarget === undefined ? {} : { expectedTarget }) }) } : {}),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Dots request failed (${response.status}): ${text}`)
    return (await decode(JSON.parse(text))).data
  })
  const current = yield* request("GET")
  process.stdout.write(`${dotsComputerLine(current)}\n`)
  if (current.computer?.state === "attached") return
  if (current.computer?.state !== "detached") return yield* Effect.fail(new Error("This computer cannot be attached right now"))
  process.stdout.write(`${dotsAttachWarning}\n`)
  if (!input.yes) {
    const answer = yield* Effect.promise(ask)
    if (answer === undefined) return yield* Effect.fail(new Error("Confirmation requires an interactive terminal; rerun with --yes"))
    if (!dotsAttachConfirmed(answer)) return yield* Effect.fail(new Error("Attach cancelled"))
  }
  const after = yield* request("POST", current.computer.target)
  process.stdout.write(`${dotsComputerLine(after)}\n`)
  if (after.computer?.state !== "attached") return yield* Effect.fail(new Error("This computer is not attached to your Dot"))
}, Effect.catch((error) => Effect.sync(() => {
  process.stderr.write(`ycoding: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}))))
