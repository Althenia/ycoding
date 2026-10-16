import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Agent } from "@ycoding-ai/schema/agent"
import type { Model } from "@ycoding-ai/schema/model"
import type { ModelIncident } from "@ycoding-ai/schema/model-incident"
import type { Provider } from "@ycoding-ai/schema/provider"

export const ModelIncidentTable = sqliteTable(
  "model_incident",
  {
    id: text().$type<ModelIncident.ID>().primaryKey(),
    time_created: integer().notNull(),
    kind: text().$type<ModelIncident.Kind>().notNull(),
    provider_id: text().$type<Provider.ID>().notNull(),
    model_id: text().$type<Model.ID>().notNull(),
    variant: text().$type<Model.VariantID>(),
    profile: text().$type<Model.ProfileName>(),
    agent: text().$type<Agent.ID>().notNull(),
    project_id: text().notNull(),
    session_id: text().notNull(),
    request_id: text(),
    category: text().notNull(),
    rule_ids: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    target: text({ mode: "json" }).$type<Model.Ref>(),
    decided_by: text().$type<ModelIncident.DecidedBy>(),
  },
  (table) => [
    index("model_incident_time_created_id_idx").on(table.time_created, table.id),
    index("model_incident_model_time_idx").on(table.provider_id, table.model_id, table.time_created),
    index("model_incident_request_id_idx").on(table.request_id),
  ],
)

export const ModelGuidanceClearTable = sqliteTable(
  "model_guidance_clear",
  {
    provider_id: text().$type<Provider.ID>().notNull(),
    model_id: text().$type<Model.ID>().notNull(),
    cleared_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider_id, table.model_id] })],
)
