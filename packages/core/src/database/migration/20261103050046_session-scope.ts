import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261103050046_session-scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`session\` ADD \`scope\` text DEFAULT 'bound' NOT NULL CONSTRAINT \`session_scope_check\` CHECK ("scope" IN ('bound', 'standalone'));`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
