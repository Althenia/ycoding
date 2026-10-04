import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Shell } from "@ycoding-ai/schema/shell"
import type { SessionSchema } from "../session/schema"

export const ShellTable = sqliteTable("shell", {
  id: text().$type<Shell.ID>().primaryKey(),
  session_id: text().$type<SessionSchema.ID>(),
  pid: integer().notNull(),
  process_started: text(),
  owner_pid: integer().notNull(),
  owner_started: text().notNull(),
  notice_pending: integer({ mode: "boolean" }).notNull().default(false),
  time_created: integer().notNull(),
  time_lost: integer(),
  start_seq: integer().notNull().default(-1),
})
