import { Effect } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { ServiceCommand } from "../../service"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  ServiceCommand.commands.stop,
  Effect.fn("cli.service.stop")(function* () {
    yield* Service.stop(yield* ServiceConfig.options())
  }),
)
