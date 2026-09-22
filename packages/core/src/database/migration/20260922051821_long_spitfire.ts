import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922051821_long_spitfire",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`daybreak\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
