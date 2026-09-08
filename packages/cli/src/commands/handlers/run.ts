import { Option } from "effect"
import { RunCommand } from "../run"
import { Runtime } from "../../framework/runtime"
import { runCommand } from "./run-shared"

export default Runtime.handler(RunCommand, (input) => {
  const separator = process.argv.indexOf("--", 2)
  return runCommand({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
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
    auto: input.auto || input.yolo,
  })
})
