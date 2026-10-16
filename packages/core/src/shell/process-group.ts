export * as ProcessGroup from "./process-group"

import { execFile } from "node:child_process"
import { Context, Effect, Exit } from "effect"

export type Identity = { readonly pid: number; readonly pgid: number; readonly started: string }

export interface Interface {
  readonly read: Effect.Effect<readonly Identity[], Error>
  readonly signal: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void, Error>
}
export const native: Interface = {
  read: Effect.tryPromise({
    try: (signal) =>
      new Promise<readonly Identity[]>((resolve, reject) => {
        execFile(
          "ps",
          ["-axo", "pid=,pgid=,lstart="],
          {
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
            timeout: 1_000,
            maxBuffer: 4 * 1024 * 1024,
            signal,
          },
          (error, stdout) => {
            if (error) return reject(error)
            resolve(
              stdout.split("\n").flatMap((line) => {
                const fields = line.trim().split(/\s+/)
                const pid = Number(fields[0])
                const pgid = Number(fields[1])
                return fields.length < 3 || !Number.isInteger(pid) || !Number.isInteger(pgid)
                  ? []
                  : [{ pid, pgid, started: fields.slice(2).join(" ") }]
              }),
            )
          },
        )
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }),
  signal: (pid, signal) =>
    Effect.try({
      try: () => {
        process.kill(pid, signal)
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
}
export const System = Context.Reference<Interface>("@ycoding/ProcessGroup.System", { defaultValue: () => native })

export const make = Effect.fnUntraced(function* (pid: number, grouped: boolean, system: Interface) {
  const initial = yield* Effect.exit(system.read)
  const original = Exit.isSuccess(initial) ? initial.value.find((item) => item.pid === pid) : undefined
  const state = { closed: false }
  const members = Effect.gen(function* () {
    if (state.closed) return [] as readonly Identity[]
    const snapshot = yield* system.read
    const current = snapshot.filter((item) => (grouped ? item.pgid === pid : item.pid === pid))
    const leader = snapshot.find((item) => item.pid === pid)
    if (current.length === 0) {
      state.closed = true
      return [] as readonly Identity[]
    }
    if (Exit.isFailure(initial)) return yield* initial
    if (leader && leader.started !== original?.started) {
      state.closed = true
      return [] as readonly Identity[]
    }
    return current
  })
  const signal = (name: NodeJS.Signals) =>
    Effect.gen(function* () {
      const current = yield* members
      if (current.length === 0) return
      yield* system
        .signal(grouped ? -pid : pid, name)
        .pipe(Effect.catch((error) => ("code" in error && error.code === "ESRCH" ? Effect.void : Effect.fail(error))))
    })
  return { members, signal }
})
