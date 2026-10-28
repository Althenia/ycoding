import { sql } from "drizzle-orm"
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import type { Model } from "@ycoding-ai/schema/model"
import type { Agent } from "@ycoding-ai/schema/agent"

export const UsageAnalyticsRequestTable = sqliteTable(
  "usage_analytics_request",
  {
    id: text().$type<ProviderRequest.ID>().primaryKey(),
    session_id: text().notNull(),
    project_id: text().notNull(),
    directory: text().notNull(),
    workspace_id: text(),
    session_updated: integer().notNull(),
    agent: text().$type<Agent.ID>().notNull(),
    source: text().$type<ProviderRequest.Source>().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    usage_anchor: text({ mode: "json" }).$type<UsageAnchor.Ref>(),
    task_path: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    request: integer().notNull(),
    attempts: integer().notNull(),
    continuation: text().$type<ProviderRequest.Continuation>().notNull(),
    invalidation: text().$type<ProviderRequest.Invalidation>().notNull(),
    prompt_cache_key: text().notNull(),
    cache_read_reported: integer({ mode: "boolean" }),
    tokens: text({ mode: "json" }).$type<TokenUsage.Info>().notNull(),
    cost: real(),
    timing: text({ mode: "json" }).$type<ProviderRequest.Timing>(),
    outcome: text().$type<ProviderRequest.Outcome>(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("usage_analytics_request_time_created_id_idx").on(table.time_created, table.id),
    index("usage_analytics_request_unpriced_time_created_id_idx")
      .on(table.time_created, table.id)
      .where(sql`cost IS NULL AND source <> 'decision'`),
    index("usage_analytics_request_metrics_idx").on(
      table.time_created,
      table.id,
      table.session_id,
      table.project_id,
      table.directory,
      table.workspace_id,
      table.session_updated,
      table.agent,
      table.source,
      table.model,
      table.usage_anchor,
      table.task_path,
      table.request,
      table.attempts,
      table.continuation,
      table.cache_read_reported,
      table.cost,
      sql`json_extract(tokens, '$.input')`,
      sql`json_extract(tokens, '$.output')`,
      sql`json_extract(tokens, '$.reasoning')`,
      sql`json_extract(tokens, '$.cache.read')`,
      sql`json_extract(tokens, '$.cache.write')`,
      sql`json_extract(timing, '$.firstOutputMs')`,
      sql`json_extract(timing, '$.totalMs')`,
      sql`json_extract(timing, '$.generatedTokens')`,
      sql`json_extract(timing, '$.generationDurationNs')`,
      sql`json_extract(timing, '$.observedGenerationDurationNs')`,
      sql`json_type(timing, '$.generationDurationNs')`,
    ),
  ],
)
