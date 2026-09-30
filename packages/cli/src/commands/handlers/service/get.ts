import { EOL } from "os"
import { Effect, Option } from "effect"
import { ServiceCommand } from "../../service"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  ServiceCommand.commands.get,
  Effect.fn("cli.service.get")(function* (input) {
    process.stdout.write((yield* ServiceConfig.get(Option.getOrUndefined(input.key))) + EOL)
  }),
)
