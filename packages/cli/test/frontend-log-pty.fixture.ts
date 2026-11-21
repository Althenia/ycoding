import { Effect } from "effect"
import { main } from "../src/main"

main(
  Effect.logInfo("event stream connected", { component: "client" }).pipe(
    Effect.andThen(Effect.sync(() => process.stdout.write("FIXTURE-DONE\n"))),
  ),
)
