import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028131454_usage-telemetry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`usage_analytics_request\` ADD \`outcome\` text;`)
      yield* tx.run(`ALTER TABLE \`session_usage_cell\` ADD \`generation_rate\` real DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_usage_cell\` ADD \`busy_ms\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_usage_cell\` ADD \`failed\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_usage_cell\` ADD \`cancelled\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_usage_cell\` ADD \`outcomes\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_analytics_cell\` ADD \`generation_rate\` real DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_analytics_cell\` ADD \`busy_ms\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_analytics_cell\` ADD \`failed\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_analytics_cell\` ADD \`cancelled\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_analytics_cell\` ADD \`outcomes\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_view_row\` ADD \`generation_rate\` real DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_view_row\` ADD \`busy_ms\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_view_row\` ADD \`failed\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_view_row\` ADD \`cancelled\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`usage_view_row\` ADD \`outcomes\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_provider_request\` ADD \`outcome\` text;`)
      const { UsageStage } = yield* Effect.promise(() => import("../../usage-stage"))
      yield* UsageStage.backfill(tx)
      yield* tx.run(`UPDATE usage_view_state SET status = 'pending' WHERE status IN ('ready', 'building', 'error')`)
    })
  },
} satisfies DatabaseMigration.Migration
