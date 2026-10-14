import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014011041_task-owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`owner_pid\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_task\` ADD \`owner_started\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
