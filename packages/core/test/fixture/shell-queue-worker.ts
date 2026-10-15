import { appendFile, writeFile } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { ConfigShell } from "@ycoding-ai/core/config/shell"
import { Global } from "@ycoding-ai/core/global"
import { ShellQueue } from "@ycoding-ai/core/shell/queue"
import { Shell } from "@ycoding-ai/schema/shell"
import { Effect, Schema } from "effect"

const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.String,
      log: Schema.String,
      backstopMs: Schema.Number,
      maxRunning: Schema.Number,
      maxRunningPerSession: Schema.Number,
      maxQueuedPerSession: Schema.Number,
      entries: Schema.Array(Schema.Struct({ id: Schema.String, sessionID: Schema.String, holdMs: Schema.Number })),
      // Stops this process with SIGSTOP at the first occurrence of this queue trace event.
      stopAt: Schema.String.pipe(Schema.optional),
      enqueueGate: Schema.String.pipe(Schema.optional),
      evaluated: Schema.String.pipe(Schema.optional),
      availableMb: Schema.Number.pipe(Schema.optional),
      memoryReserveMb: Schema.Number.pipe(Schema.optional),
      parallelism: Schema.Number.pipe(Schema.optional),
      clockFile: Schema.String.pipe(Schema.optional),
    }),
  ),
)(process.argv[2])

const stop = { pending: input.stopAt }
const evaluation = { passed: false }
const clockFile = input.clockFile

const layer = AppNodeBuilder.build(
  ShellQueue.configured({
    sample: Effect.succeed({ availableMb: input.availableMb ?? 1_000_000, load: 0 }),
    parallelism: input.parallelism,
    now: clockFile ? () => Number(readFileSync(clockFile, "utf8")) : undefined,
    backstopMs: input.backstopMs,
    heartbeatMs: 50,
    trace: (event) => {
      if (event === "pass") evaluation.passed = true
      if (evaluation.passed && input.evaluated && (event === "wait-backstop" || event === "wait-idle")) {
        evaluation.passed = false
        writeFileSync(input.evaluated, "evaluated")
      }
      if (event !== stop.pending) return
      stop.pending = undefined
      process.kill(process.pid, "SIGSTOP")
    },
  }),
  [[Global.node, Global.layerWith({ state: input.state })]],
)

await Effect.runPromise(
  Effect.forEach(
    input.entries,
    (entry) =>
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* ShellQueue.Service
          const gate = input.enqueueGate
          if (gate) {
            yield* Effect.promise(() => writeFile(`${input.log}.${entry.id}.ready`, "ready"))
            yield* Effect.promise(async () => {
              for (let attempt = 0; attempt < 250; attempt++) {
                if (await Bun.file(gate).exists()) return
                await Bun.sleep(20)
              }
              throw new Error("enqueue gate was not released")
            })
          }
          const ticket = yield* queue
            .enqueue({
              id: Shell.ID.make(entry.id),
              sessionID: entry.sessionID,
              command: entry.id,
              cwd: input.state,
              limits: ConfigShell.queueLimits({
                max_running: input.maxRunning,
                max_running_per_session: input.maxRunningPerSession,
                max_queued_per_session: input.maxQueuedPerSession,
                memory_reserve_mb: input.memoryReserveMb ?? 2_048,
              }),
            })
            .pipe(
              Effect.catchTag("ShellQueue.FullError", () =>
                Effect.promise(() => writeFile(`${input.log}.${entry.id}.rejected`, "full")).pipe(Effect.as(undefined)),
              ),
            )
          if (!ticket) return
          yield* Effect.promise(() => writeFile(`${input.log}.${entry.id}.queued`, String(ticket.position)))
          yield* ticket.admitted(() => Effect.void)
          yield* Effect.promise(() => appendFile(input.log, `start ${entry.id} ${Date.now()} ${entry.sessionID}\n`))
          if (entry.holdMs < 0) return yield* Effect.never
          yield* Effect.sleep(entry.holdMs)
          yield* Effect.promise(() => appendFile(input.log, `end ${entry.id} ${Date.now()} ${entry.sessionID}\n`))
        }),
      ),
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.provide(layer)),
)
