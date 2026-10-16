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
    time_created: integer().notNull(),
  },
  (table) => [index("usage_analytics_request_time_created_id_idx").on(table.time_created, table.id)],
)
