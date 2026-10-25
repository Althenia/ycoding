import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261024192410_coordination-member-owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`__new_coordination_member\` (
                  \`group_id\` text NOT NULL,
                  \`session_id\` text NOT NULL,
                  \`owner_session_id\` text,
                  CONSTRAINT \`coordination_member_pk\` PRIMARY KEY(\`group_id\`, \`session_id\`),
                  CONSTRAINT \`fk_coordination_member_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
                  CONSTRAINT \`fk_coordination_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
                  CONSTRAINT \`fk_coordination_member_owner_session_id_session_id_fk\` FOREIGN KEY (\`owner_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
                );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_coordination_member\` (\`group_id\`, \`session_id\`) SELECT \`group_id\`, \`session_id\` FROM \`coordination_member\`;`,
      )
      yield* tx.run(`DROP TABLE \`coordination_member\`;`)
      yield* tx.run(`ALTER TABLE \`__new_coordination_member\` RENAME TO \`coordination_member\`;`)
      yield* tx.run(`CREATE INDEX \`coordination_member_owner_idx\` ON \`coordination_member\` (\`owner_session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`coordination_member_session_idx\` ON \`coordination_member\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
