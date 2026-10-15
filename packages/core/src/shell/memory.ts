export * as ShellMemory from "./memory"

import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schedule, Schema } from "effect"
import { Hash } from "../util/hash"
import { ProcessLock } from "../util/process-lock"

export interface Command {
  readonly command: string
  readonly cwd: string
}

export interface Requirement extends Command {
  readonly memoryLimitMb?: number
  readonly reserveMb: number
}

export interface Peak extends Requirement {
  readonly peakMb: number
  readonly canLower: boolean
}

const History = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    peaks: Schema.Array(Schema.Finite.check(Schema.isGreaterThan(0))).check(Schema.isMaxLength(5)),
  }),
).check(Schema.isMaxLength(256))
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(History))
const encode = Schema.encodeSync(Schema.fromJsonString(History))

export function make(directory: string) {
  const file = path.join(directory, "memory.json")
  const key = (input: Command) => Hash.sha256(JSON.stringify([input.command, path.resolve(input.cwd)]))
  const requirement = (history: typeof History.Type, input: Requirement) => {
    const peaks = history.find((entry) => entry.key === key(input))?.peaks
    return peaks?.length
      ? Math.min(Math.max(...peaks), input.memoryLimitMb ?? Infinity)
      : (input.memoryLimitMb ?? input.reserveMb)
  }
  const read = Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (error) => error }).pipe(
    Effect.map((text) => Option.getOrUndefined(decode(text)) ?? []),
    Effect.catch((error) =>
      typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT"
        ? Effect.succeed([] as typeof History.Type)
        : Effect.logWarning("Shell memory history is unavailable", { cause: error }).pipe(
            Effect.as([] as typeof History.Type),
          ),
    ),
  )
  return {
    requirement: (input: Requirement) => read.pipe(Effect.map((history) => requirement(history, input))),
    record: (input: Peak) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (!Number.isFinite(input.peakMb) || input.peakMb <= 0) return
          yield* ProcessLock.acquire(path.join(directory, "memory.lock")).pipe(
            Effect.retry({
              while: (error) => error._tag === "ProcessLockHeldError",
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("1 second"),
            Effect.orDie,
          )
          const abandoned = yield* Effect.promise(() => readdir(directory))
          yield* Effect.forEach(
            abandoned.filter((name) => /^memory\.json\.[a-f0-9-]{36}\.tmp$/.test(name)),
            (name) => Effect.promise(() => unlink(path.join(directory, name))),
            { concurrency: 8, discard: true },
          )
          const history = yield* read
          if (!input.canLower && input.peakMb <= requirement(history, input)) return
          const digest = key(input)
          const peaks = [...(history.find((entry) => entry.key === digest)?.peaks ?? []), input.peakMb].slice(-5)
          const next = [...history.filter((entry) => entry.key !== digest), { key: digest, peaks }].slice(-256)
          const temporary = `${file}.${randomUUID()}.tmp`
          yield* Effect.promise(() => writeFile(temporary, encode(next), { mode: 0o600 })).pipe(
            Effect.andThen(Effect.promise(() => rename(temporary, file))),
            Effect.ensuring(Effect.promise(() => unlink(temporary).catch(() => undefined))),
            Effect.uninterruptible,
          )
        }),
      ),
  }
}
