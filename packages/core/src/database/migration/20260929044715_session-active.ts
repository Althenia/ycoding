import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260929044715_session-active",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_active\` integer;`)
      yield* tx.run(`
        UPDATE \`session\`
        SET \`time_active\` = (
          SELECT MAX(\`created\`) FROM \`event\`
          WHERE \`aggregate_id\` = \`session\`.\`id\`
            AND \`type\` IN (
              'session.step.ended.1', 'session.step.failed.1',
              'session.execution.succeeded.1', 'session.execution.failed.1', 'session.execution.interrupted.1'
            )
        )
        WHERE EXISTS (
          SELECT 1 FROM \`event\`
          WHERE \`aggregate_id\` = \`session\`.\`id\`
            AND \`type\` IN (
              'session.step.ended.1', 'session.step.failed.1',
              'session.execution.succeeded.1', 'session.execution.failed.1', 'session.execution.interrupted.1'
            )
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
