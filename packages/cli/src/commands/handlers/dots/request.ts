import { createInterface } from "node:readline/promises"
import { Effect, Option } from "effect"
import { ServerConnection } from "../../../services/server-connection"
import { frontendClient } from "../../../services/client"
import { dotsFailureText } from "./rejection"

export async function ask(question: string) {
  if (!process.stdin.isTTY) return undefined
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await prompt.question(question)
  } finally {
    prompt.close()
  }
}

export const connectDots = Effect.fn("cli.dots.connect")(function* (server: Option.Option<string>) {
  const connection = yield* ServerConnection.resolve({ server: Option.getOrUndefined(server), mismatch: "ignore" })
  return (yield* frontendClient(connection.endpoint)).dots
})

export const dotsRequest = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: (error) => new Error(dotsFailureText(error) ?? (error instanceof Error ? error.message : String(error))),
})

export const failCommand = (error: unknown) => Effect.sync(() => {
  process.stderr.write(`ycoding: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
