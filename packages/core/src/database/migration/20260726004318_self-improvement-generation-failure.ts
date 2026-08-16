import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726004318_self-improvement-generation-failure",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`self_improvement_generation_lease\` ADD \`proposal_failure_code\` text;`)
      yield* tx.run(`ALTER TABLE \`self_improvement_generation_lease\` ADD \`proposal_failure_pointer\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
