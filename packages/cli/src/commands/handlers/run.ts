import { Effect, Option } from "effect"
import { RunCommand } from "../run"
import { Runtime } from "../../framework/runtime"
import { runCommand } from "./run-shared"

export default Runtime.handler(RunCommand, (input) => {
  const separator = process.argv.indexOf("--", 2)
  const missingMode = (
    [
      ["--permissions", input.permissions],
      ["--guardrails", input.guardrails],
      ["--answers", input.answers],
    ] as const
  ).find(
    ([flag, value]) =>
      process.argv.slice(2, separator === -1 ? undefined : separator).includes(flag) && Option.isNone(value),
  )
  if (missingMode)
    return Effect.sync(() => {
      process.exitCode = 1
      process.stderr.write(`ycoding: ${missingMode[0]} requires manual, yolo, or auto\n`)
    })
  return runCommand({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
    config: Option.getOrUndefined(input.config),
    isolated: input.isolated,
    message: [...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))],
    continue: input.continue,
    session: Option.getOrUndefined(input.session),
    fork: input.fork,
    model: Option.getOrUndefined(input.model),
    agent: Option.getOrUndefined(input.agent),
    format: input.format,
    file: [...input.file],
    title: Option.getOrUndefined(input.title),
    thinking: input.thinking,
    permissions: Option.getOrUndefined(input.permissions),
    guardrails: Option.getOrUndefined(input.guardrails),
    answers: Option.getOrUndefined(input.answers),
  })
})
