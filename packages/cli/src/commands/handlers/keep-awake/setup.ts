import os from "node:os"
import { Effect } from "effect"
import { Runtime } from "../../../framework/runtime"
import { KeepAwakeCommand } from "../../keep-awake"
import { setupKeepAwake } from "../../keep-awake-setup"

export default Runtime.handler(
  KeepAwakeCommand.commands.setup,
  Effect.fn("cli.keep-awake.setup")(function* () {
    const result = yield* Effect.promise(() =>
      setupKeepAwake({
        platform: process.platform,
        user: os.userInfo().username,
        run: async (argv) => (await Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited),
      }),
    )
    process.exitCode = result.code
    ;(result.code === 0 ? process.stdout : process.stderr).write(result.message + "\n")
  }),
)
