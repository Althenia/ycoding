import { sql } from "drizzle-orm"
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core"

export const TelemetryConsentTable = sqliteTable(
  "telemetry_consent",
  {
    id: integer().primaryKey(),
    enabled: integer({ mode: "boolean" }).notNull(),
    notice_version: integer().notNull(),
    decided_at: integer().notNull(),
  },
  (table) => [check("telemetry_consent_single_row", sql`${table.id} = 1`)],
)
