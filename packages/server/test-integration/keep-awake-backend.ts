import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Scope } from "effect"

const [port, directory] = process.argv.slice(2)
const scope = await Effect.runPromise(Scope.make())
const startingRaw = ServerProcess.start<never, never>({
  hostname: "127.0.0.1",
  port: Number(port),
  password: "test-password",
  database: { path: ":memory:" },
  config: { directory, project: false, content: "{}" },
  fs: { filewatcher: false, fff: false },
}).pipe(Effect.provideService(Scope.Scope, scope))
await Effect.runPromise(startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>)
console.log("ready")
setInterval(() => {}, 1000)
