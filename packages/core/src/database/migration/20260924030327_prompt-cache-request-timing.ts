import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924030327_prompt-cache-request-timing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_provider_request\` ADD \`timing\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
