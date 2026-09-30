import { Effect } from "effect"
import { ServiceCommand } from "../../service"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  ServiceCommand.commands.unset,
  Effect.fn("cli.service.unset")(function* (input) {
    yield* ServiceConfig.unset(input.key)
  }),
)
