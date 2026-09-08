import { Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { runTui } from "./tui-shared"
import { runRoot } from "./run-shared"

export default Runtime.handler(Commands, (input) => {
  const model = Option.getOrUndefined(input.model)
  if (!model) return runTui(input)
  return runRoot({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
    prompt: Option.getOrUndefined(input.directory),
    model,
    continue: input.continue,
    session: Option.getOrUndefined(input.session),
  })
})
