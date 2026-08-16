import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Drops the session-level archive flag. The session archive feature is removed,
// so every stored session archive timestamp is permanently deleted and the
// column is never restored; this migration is irreversible (no down step).
export default {
  id: "20260801114207_drop-session-archived",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` DROP COLUMN \`time_archived\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
