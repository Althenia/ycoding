export * as SessionRunnerStall from "./stall"

import { Form } from "@ycoding-ai/schema/form"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Permission } from "@ycoding-ai/schema/permission"
import { Question } from "@ycoding-ai/schema/question"
import { Clock, Duration, Effect } from "effect"
import type { EventRuntime } from "../../event"

const opened: ReadonlySet<string> = new Set([Permission.Event.Asked.type, Question.Event.Asked.type, Guardrail.Event.Asked.type])
const closed: ReadonlySet<string> = new Set([
  Permission.Event.Replied.type,
  Permission.Event.Deferred.type,
  Permission.Event.Cancelled.type,
  Question.Event.Replied.type,
  Question.Event.Rejected.type,
  Question.Event.TimedOut.type,
  Question.Event.Deferred.type,
  Guardrail.Event.Replied.type,
  Guardrail.Event.Deferred.type,
  Guardrail.Event.Cancelled.type,
  Form.Event.Replied.type,
  Form.Event.Cancelled.type,
  Form.Event.TimedOut.type,
  Form.Event.Deferred.type,
])

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

export function requests(sessionID: string) {
  const open = new Set<string>()
  return {
    pending: () => open.size > 0,
    observe: (event: EventRuntime.Payload) =>
      Effect.sync(() => {
        if (event.type === Form.Event.Created.type) {
          const form = field(event.data, "form")
          const id = field(form, "id")
          if (field(form, "sessionID") === sessionID && typeof id === "string") open.add(id)
          return
        }
        if (field(event.data, "sessionID") !== sessionID) return
        if (opened.has(event.type)) {
          const id = field(event.data, "id")
          if (typeof id === "string") open.add(id)
          return
        }
        if (!closed.has(event.type)) return
        const id = field(event.data, "requestID") ?? field(event.data, "id")
        if (typeof id === "string") open.delete(id)
      }),
  }
}

export const watch = <A, E, R>(
  unit: (touch: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  options: { readonly millis: number; readonly waiting: Effect.Effect<boolean>; readonly stalled: Effect.Effect<A, E> },
) =>
  Effect.gen(function* () {
    const activity = { last: yield* Clock.currentTimeMillis }
    const touch = Clock.currentTimeMillis.pipe(Effect.map((now) => { activity.last = now }))
    const watchdog = Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis
        const idle = now - activity.last
        if (idle < options.millis) {
          yield* Effect.sleep(Duration.millis(options.millis - idle))
          continue
        }
        if (!(yield* options.waiting)) return yield* options.stalled
        activity.last = now
      }
    })
    return yield* Effect.raceFirst(unit(touch), watchdog)
  })
