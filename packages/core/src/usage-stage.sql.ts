import { sql } from "drizzle-orm"
import { type AnySQLiteColumn, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Agent } from "@ycoding-ai/schema/agent"
import type { Model } from "@ycoding-ai/schema/model"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import { SessionTable } from "./session/sql"

const measures = () => ({
  logical: integer().notNull(),
  physical: integer().notNull(),
  helpers: integer().notNull(),
  continued: integer().notNull(),
  fallback: integer().notNull(),
  input: integer().notNull(),
  output: integer().notNull(),
  reasoning: integer().notNull(),
  cache_read: integer().notNull(),
  cache_write: integer().notNull(),
  cache_read_reported: integer().notNull(),
  cost: real().notNull(),
  priced: integer().notNull(),
  spend: real().notNull(),
  spend_priced: integer().notNull(),
  unpriced: integer().notNull(),
  first_output: integer().notNull(),
  total_output: integer().notNull(),
  generation_samples: integer().notNull(),
  provider_timed: integer().notNull(),
  observed: integer().notNull(),
  generation_tokens: real().notNull(),
  generation_duration: real().notNull(),
  generation_rate: real().notNull().default(0),
  busy_ms: integer().notNull().default(0),
  failed: integer().notNull().default(0),
  cancelled: integer().notNull().default(0),
  outcomes: integer().notNull().default(0),
  first_updated: integer(),
  first_request: integer(),
  last_updated: integer(),
  last_request: integer(),
  last_invalidation: text().$type<ProviderRequest.Invalidation>(),
  last_namespace: text(),
  last_timing: text(),
})

const sample = (name: string, cell: () => AnySQLiteColumn) =>
  sqliteTable(
    name,
    {
      cell: integer()
        .notNull()
        .references(cell, { onDelete: "cascade" }),
      metric: integer().notNull(),
      value: real().notNull(),
      count: integer().notNull(),
    },
    (table) => [primaryKey({ columns: [table.cell, table.metric, table.value] })],
  )

const unpriced = (name: string, cell: () => AnySQLiteColumn) =>
  sqliteTable(
    name,
    {
      cell: integer()
        .notNull()
        .references(cell, { onDelete: "cascade" }),
      context: integer().notNull(),
      requests: integer().notNull(),
      input: integer().notNull(),
      output: integer().notNull(),
      reasoning: integer().notNull(),
      cache_read: integer().notNull(),
      cache_write: integer().notNull(),
    },
    (table) => [primaryKey({ columns: [table.cell, table.context] })],
  )

const leaf = (name: string, cell: () => AnySQLiteColumn) =>
  sqliteTable(
    name,
    {
      cell: integer()
        .notNull()
        .references(cell, { onDelete: "cascade" }),
      updated: integer().notNull(),
      request: integer().notNull(),
      source: text().notNull(),
    },
    (table) => [primaryKey({ columns: [table.cell, table.updated, table.request, table.source] })],
  )

export const UsageAnalyticsCellTable = sqliteTable(
  "usage_analytics_cell",
  {
    id: integer().primaryKey(),
    span: integer().notNull(),
    bucket: integer().notNull(),
    key: text().notNull(),
    session_id: text().notNull(),
    project_id: text().notNull(),
    directory: text().notNull(),
    workspace_id: text(),
    agent: text().$type<Agent.ID>().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    usage_anchor: text({ mode: "json" }).$type<UsageAnchor.Ref>(),
    task_path: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    ...measures(),
  },
  (table) => [
    uniqueIndex("usage_analytics_cell_span_bucket_key_idx").on(table.span, table.bucket, table.key),
    index("usage_analytics_cell_unpriced_idx")
      .on(table.span, table.bucket, table.key)
      .where(sql`unpriced > 0`),
  ],
)

export const UsageAnalyticsCellSampleTable = sample("usage_analytics_cell_sample", () => UsageAnalyticsCellTable.id)

export const UsageAnalyticsCellUnpricedTable = unpriced(
  "usage_analytics_cell_unpriced",
  () => UsageAnalyticsCellTable.id,
)

export const UsageAnalyticsCellLeafTable = leaf("usage_analytics_cell_leaf", () => UsageAnalyticsCellTable.id)

export const SessionUsageCellTable = sqliteTable(
  "session_usage_cell",
  {
    id: integer().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    span: integer().notNull(),
    bucket: integer().notNull(),
    key: text().notNull(),
    agent: text().$type<Agent.ID>().notNull(),
    source: text().$type<ProviderRequest.Source>().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    usage_anchor: text({ mode: "json" }).$type<UsageAnchor.Ref>(),
    input_id: text(),
    ...measures(),
  },
  (table) => [
    uniqueIndex("session_usage_cell_session_span_bucket_key_idx").on(
      table.session_id,
      table.span,
      table.bucket,
      table.key,
    ),
    index("session_usage_cell_unpriced_idx")
      .on(table.session_id, table.span, table.bucket, table.key)
      .where(sql`unpriced > 0`),
  ],
)

export const SessionUsageCellSampleTable = sample("session_usage_cell_sample", () => SessionUsageCellTable.id)

export const SessionUsageCellUnpricedTable = unpriced("session_usage_cell_unpriced", () => SessionUsageCellTable.id)

export const SessionUsageCellLeafTable = leaf("session_usage_cell_leaf", () => SessionUsageCellTable.id)
