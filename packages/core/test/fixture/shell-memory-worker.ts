import { Effect } from "effect"
import { ShellMemory } from "@ycoding-ai/core/shell/memory"

const directory = process.argv[2]
const index = Number(process.argv[3])
const memory = ShellMemory.make(directory)
await Effect.runPromise(
  Effect.gen(function* () {
    for (const peakMb of [100, 200, 300, 400]) {
      yield* memory.record({
        command: `check ${index}`,
        cwd: directory,
        peakMb: peakMb + index,
        canLower: true,
        reserveMb: 2_048,
      })
      yield* memory.record({
        command: "shared",
        cwd: directory,
        peakMb: peakMb + index,
        canLower: true,
        reserveMb: 2_048,
      })
    }
  }),
)
