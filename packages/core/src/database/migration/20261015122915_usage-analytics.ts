import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015122915_usage-analytics",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`usage_analytics_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`session_updated\` integer NOT NULL,
          \`agent\` text NOT NULL,
          \`source\` text NOT NULL,
          \`model\` text NOT NULL,
          \`usage_anchor\` text,
          \`task_path\` text NOT NULL,
          \`request\` integer NOT NULL,
          \`attempts\` integer NOT NULL,
          \`continuation\` text NOT NULL,
          \`invalidation\` text NOT NULL,
          \`prompt_cache_key\` text NOT NULL,
          \`cache_read_reported\` integer,
          \`tokens\` text NOT NULL,
          \`cost\` real,
          \`timing\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_compaction_job\` ADD \`usage_anchor\` text;`)
      yield* tx.run(`ALTER TABLE \`session_provider_request\` ADD \`usage_anchor\` text;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`usage_anchor\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`usage_pruned_through\` integer;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_provider_request_time_created_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_provider_request_unpriced_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_provider_request_session_unpriced_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_request_time_created_id_idx\` ON \`usage_analytics_request\` (\`time_created\`,\`id\`);`,
      )
      const { UsageAnalytics } = yield* Effect.promise(() => import("../../usage-analytics"))
      yield* UsageAnalytics.backfill(tx)
    })
  },
} satisfies DatabaseMigration.Migration
