import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@ycoding-ai/core/cross-spawn-spawner"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { escapedProcess, fileReady } from "./shell-process"

const directory = process.argv[process.argv.length - 1]
const command = escapedProcess(directory)
await Effect.runPromise(
  Effect.gen(function* () {
    if (process.argv[2] === "drain") {
      const script =
        'const fs=require("node:fs"); const data=Buffer.alloc(256*1024,97); for(let offset=0;offset<data.length;) offset+=fs.writeSync(1,data,offset,data.length-offset)'
      const handle = yield* ChildProcess.make("node", ["-e", script])
      yield* Effect.promise(() => writeFile(join(directory, "leader"), String(handle.pid)))
      const pull = yield* Stream.toPull(handle.stdout)
      const first = yield* pull
      const code = yield* handle.exitCode
      yield* handle.kill()
      const rest = yield* Stream.runCollect(Stream.fromPull(Effect.succeed(pull)))
      yield* Effect.promise(() => writeFile(join(directory, "output"), Buffer.concat([...first, ...rest])))
      if (code !== 0) return yield* Effect.die(new Error(`Unexpected child exit ${code}`))
      return
    }
    const handle = yield* ChildProcess.make("/bin/sh", ["-c", command.command], { forceKillAfter: 100 })
    yield* Effect.promise(() => writeFile(join(directory, "leader"), String(handle.pid)))
    yield* fileReady(command.ready)
    yield* handle.kill()
  }).pipe(
    Effect.scoped,
    Effect.andThen(Effect.promise(() => writeFile(join(directory, "settled"), "settled"))),
    Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
  ),
)
