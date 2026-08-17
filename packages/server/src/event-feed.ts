export * as EventFeed from "./event-feed"

import { EventV2 } from "@ycoding-ai/core/event"
import { isYCodingEvent, YCodingEvent } from "@ycoding-ai/protocol/groups/event"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"
import { ProcessIdentity } from "./process-identity"

export const SubscriberCapacity = 4_096

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export class EncodingError extends Schema.TaggedErrorClass<EncodingError>()("EventFeed.EncodingError", {
  eventID: EventV2.ID,
  eventType: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Error = SubscriberOverflowError | EncodingError

export interface Interface {
  readonly subscribe: Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/server/EventFeed") {}

const encode = Schema.encodeUnknownSync(YCodingEvent)

export function frame(
  sourceEpoch: ServiceStatus.Epoch,
  event: { readonly id: EventV2.ID; readonly type: string; readonly data: unknown },
) {
  return `data: ${JSON.stringify(encode({ ...event, sourceEpoch }))}\n\n`
}

export const make = Effect.fn("EventFeed.make")(function* (
  sourceEpoch: ServiceStatus.Epoch,
  observe: (subscriber: EventV2.Subscriber) => Effect.Effect<EventV2.Unsubscribe>,
  options?: { readonly capacity?: number; readonly encode?: (event: YCodingEvent) => string },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const render = options?.encode ?? ((event) => frame(sourceEpoch, event))
  const subscribers = new Set<Queue.Queue<string, Error>>()

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers)
      subscribers.clear()
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
    })

  const publish = Effect.fnUntraced(function* (event: EventV2.Payload) {
    if (!isYCodingEvent(event)) return
    if (subscribers.size === 0) return
    const encoded = yield* Effect.try({
      try: () => render(event),
      catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to encode public event", {
          eventID: error.eventID,
          eventType: error.eventType,
          cause: error.cause,
        }).pipe(Effect.andThen(fail(error)), Effect.as(undefined)),
      ),
    )
    if (encoded === undefined) return
    for (const subscriber of subscribers) {
      if (Queue.offerUnsafe(subscriber, encoded)) continue
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  })

  const HEARTBEAT = ": keep-alive\n\n"
  const HEARTBEAT_INTERVAL_MS = 20000
  const heartbeatInterval = yield* Effect.sync(() => {
    const id = setInterval(() => {
      if (subscribers.size === 0) return
      for (const subscriber of Array.from(subscribers)) {
        if (Queue.offerUnsafe(subscriber, HEARTBEAT)) continue
        subscribers.delete(subscriber)
        Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
      }
    }, HEARTBEAT_INTERVAL_MS)
    const maybeUnref = (id as unknown as { unref?: () => void }).unref
    if (typeof maybeUnref === "function") maybeUnref.call(id)
    return id
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => clearInterval(heartbeatInterval)).pipe(Effect.andThen(unsubscribe)),
  )

  return Service.of({
    subscribe: Effect.acquireRelease(
      Queue.dropping<string, Error>(capacity).pipe(Effect.tap((queue) => Effect.sync(() => subscribers.add(queue)))),
      (queue) =>
        Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
    ).pipe(Effect.map(Stream.fromQueue)),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const identity = yield* ProcessIdentity
    return yield* make(identity.sourceEpoch, events.listen)
  }),
)
