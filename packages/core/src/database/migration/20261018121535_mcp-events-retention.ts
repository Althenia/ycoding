import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261018121535_mcp-events-retention",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`mcp_event_subscription\` ADD \`pruned_through\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
