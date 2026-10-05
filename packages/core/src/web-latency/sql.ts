import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Telemetry } from "@ycoding-ai/schema/telemetry"

export const WebLatencyTable = sqliteTable(
  "web_latency",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    received_at: integer().notNull(),
    sample: text({ mode: "json" }).$type<Telemetry.Sample>().notNull(),
  },
  (table) => [index("web_latency_received_at_idx").on(table.received_at)],
)
