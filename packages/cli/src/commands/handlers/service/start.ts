import { EOL } from "os"
import { Effect } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { ServiceCommand } from "../../service"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  ServiceCommand.commands.start,
  Effect.fn("cli.service.start")(function* () {
    const transport = yield* Service.ensure(yield* ServiceConfig.options())
    process.stdout.write(transport.url + EOL)
  }),
)
