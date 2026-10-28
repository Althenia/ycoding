import { sql } from "drizzle-orm"
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"

export const UsageViewChangeTable = sqliteTable("usage_view_change", {
  seq: integer().primaryKey({ autoIncrement: true }),
  kind: text().$type<"append" | "remove">().notNull(),
  source: text().$type<ProviderRequest.ID>(),
  through: integer(),
})

export const UsageViewJournalTable = sqliteTable("usage_view_journal", {
  id: integer().primaryKey(),
  pruned: integer().notNull(),
})

export const UsageViewStateTable = sqliteTable(
  "usage_view_state",
  {
    id: text().primaryKey(),
    recipe: text().notNull(),
    generation: integer().notNull(),
    status: text().$type<"pending" | "building" | "ready" | "error" | "evicted">().notNull(),
    applied_seq: integer().notNull(),
    rows: integer().notNull(),
    latest: text(),
    error: text(),
    version: integer().notNull(),
    epoch: text(),
    refs: integer().notNull(),
    owner: text(),
    time_used: integer().notNull(),
  },
  (table) => [
    index("usage_view_state_status_idx").on(table.status),
    index("usage_view_state_time_used_idx").on(table.time_used),
  ],
)

export const UsageViewPresentationTable = sqliteTable(
  "usage_view_presentation",
  {
    id: text().primaryKey(),
    state: text()
      .notNull()
      .references(() => UsageViewStateTable.id, { onDelete: "cascade" }),
    recipe: text().notNull(),
    payload: text(),
    version: integer(),
    labels: text(),
    time_published: integer(),
    time_used: integer().notNull(),
  },
  (table) => [
    index("usage_view_presentation_state_idx").on(table.state),
    index("usage_view_presentation_time_used_idx").on(table.time_used),
  ],
)

export const UsageViewRowTable = sqliteTable(
  "usage_view_row",
  {
    state: text().notNull(),
    generation: integer().notNull(),
    key: text().notNull(),
    session_id: text().notNull(),
    title: text().notNull(),
    project_id: text().notNull(),
    model: text().notNull(),
    agent: text().notNull(),
    time: integer().notNull(),
    rep_updated: integer(),
    rep_session: text(),
    rep_request: integer(),
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
    reported: integer().notNull(),
    cost: real().notNull(),
    priced: integer().notNull(),
    catalog_cost: real().notNull(),
    catalog_requests: integer().notNull(),
    total_cost: real().notNull(),
    total_tokens: integer().notNull(),
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
  },
  (table) => [
    primaryKey({ columns: [table.state, table.generation, table.key] }),
    index("usage_view_row_cost_idx").on(table.state, table.generation, table.total_cost, table.key),
    index("usage_view_row_tokens_idx").on(table.state, table.generation, table.total_tokens, table.key),
    index("usage_view_row_steps_idx").on(table.state, table.generation, table.logical, table.key),
    index("usage_view_row_input_idx").on(table.state, table.generation, table.input, table.key),
    index("usage_view_row_output_idx").on(table.state, table.generation, table.output, table.key),
    index("usage_view_row_reasoning_idx").on(table.state, table.generation, table.reasoning, table.key),
    index("usage_view_row_cache_read_idx").on(table.state, table.generation, table.cache_read, table.key),
    index("usage_view_row_cache_write_idx").on(table.state, table.generation, table.cache_write, table.key),
    index("usage_view_row_hour_idx").on(table.state, table.generation, sql`strftime('%s', ${table.key})`, table.key),
  ],
)

export const UsageViewSampleTable = sqliteTable(
  "usage_view_sample",
  {
    state: text().notNull(),
    generation: integer().notNull(),
    key: text().notNull(),
    metric: integer().notNull(),
    value: real().notNull(),
    count: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.state, table.generation, table.key, table.metric, table.value] })],
)

export const UsageViewRankTable = sqliteTable(
  "usage_view_rank",
  {
    state: text().notNull(),
    generation: integer().notNull(),
    key: text().notNull(),
    quantile: integer().notNull(),
    value: real().notNull(),
    below: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.state, table.generation, table.key, table.quantile] })],
)

export const UsageViewRefTable = sqliteTable(
  "usage_view_ref",
  {
    state: text().notNull(),
    generation: integer().notNull(),
    location: text().notNull(),
    ref: text().notNull(),
    price: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.state, table.generation, table.location, table.ref] }),
    index("usage_view_ref_location_idx").on(table.location),
  ],
)
