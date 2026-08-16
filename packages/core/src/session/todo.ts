export * as SessionTodo from "./todo"

import { Event, Info } from "@ycoding-ai/schema/session-todo"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { SessionTodoTable } from "./sql"

export { Event, Info }

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    return Service.of({
      update: Effect.fn("SessionTodo.update")(function* (input) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.delete(SessionTodoTable).where(eq(SessionTodoTable.session_id, input.sessionID)).run()
              if (input.todos.length === 0) return
              yield* tx
                .insert(SessionTodoTable)
                .values(
                  input.todos.map((todo, position) => ({
                    session_id: input.sessionID,
                    content: todo.content,
                    status: todo.status,
                    priority: todo.priority,
                    position,
                  })),
                )
                .run()
            }),
          )
          .pipe(Effect.orDie)
        yield* events.publish(Event.Updated, input)
      }),
      get: Effect.fn("SessionTodo.get")(function* (sessionID) {
        return yield* db
          .select()
          .from(SessionTodoTable)
          .where(eq(SessionTodoTable.session_id, sessionID))
          .orderBy(asc(SessionTodoTable.position))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.map((row) => ({
                content: row.content,
                status: row.status as Info["status"],
                priority: row.priority as Info["priority"],
              })),
            ),
          )
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
