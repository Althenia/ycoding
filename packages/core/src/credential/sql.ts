import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Credential } from "../credential"

export const CredentialTable = sqliteTable(
  "credential",
  {
    id: text().$type<Credential.ID>().primaryKey(),
    integration_id: text().$type<Credential.Info["integrationID"]>(),
    label: text().notNull(),
    value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
    connector_id: text(),
    method_id: text(),
    active: integer({ mode: "boolean" }),
    generation: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    check("credential_generation_check", sql`typeof(${table.generation}) = 'integer' AND ${table.generation} >= 0`),
  ],
)
