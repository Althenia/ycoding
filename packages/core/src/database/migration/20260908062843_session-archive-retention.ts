import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908062843_session-archive-retention",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_archived\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
