import { ProcessLock } from "@ycoding-ai/core/util/process-lock"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"

const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ file: Schema.String, ready: Schema.String, claim: Schema.Boolean.pipe(Schema.optional) }),
  ),
)(process.argv[2])

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* input.claim ? ProcessLock.claim(input.file) : ProcessLock.acquire(input.file)
      yield* Effect.promise(() => fs.writeFile(input.ready, String(process.pid)))
      return yield* Effect.never
    }),
  ),
)
