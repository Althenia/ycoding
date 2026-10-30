import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261030011808_session-origin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`origin\` text;`)
      yield* tx.run(`
        UPDATE \`session\`
        SET \`origin\` = 'dots-executor'
        WHERE \`origin\` IS NULL
          AND \`id\` IN (
            SELECT json_extract(\`value\`, '$.sessionID') FROM \`kv\`
            WHERE CASE WHEN json_valid(\`value\`) THEN json_type(\`value\`) = 'object' AND json_type(\`value\`, '$.sessionID') = 'text' ELSE 0 END
              AND (
                (
                  substr(\`key\`, 1, 16) = 'dots.cca.thread.'
                  AND instr(substr(\`key\`, 17), '.') > 1
                  AND substr(\`key\`, -1) <> '.'
                )
                OR (substr(\`key\`, 1, 22) = 'dots.cca.unattributed.' AND length(\`key\`) > 22)
              )
          );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
