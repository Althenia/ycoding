import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261025113826_mcp-event-attention",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`mcp_event_outbox\` ADD \`attention\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
