export * as SessionTodo from "./session-todo.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { SessionID } from "./session-id.js"

export const Status = Schema.Literals(["pending", "in_progress", "completed", "cancelled"])
export type Status = typeof Status.Type

export const Priority = Schema.Literals(["high", "medium", "low"])
export type Priority = typeof Priority.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Status.annotate({ description: "Current task status" }),
  priority: Priority.annotate({ description: "Task priority" }),
}).annotate({ identifier: "SessionTodo.Info" })

const Updated = ephemeral({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})

export const Event = { Updated, Definitions: inventory(Updated) }
