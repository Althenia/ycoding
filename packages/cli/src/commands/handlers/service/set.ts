import { Effect } from "effect"
import { ServiceCommand } from "../../service"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  ServiceCommand.commands.set,
  Effect.fn("cli.service.set")(function* (input) {
    yield* ServiceConfig.set(input.key, input.value)
  }),
)
