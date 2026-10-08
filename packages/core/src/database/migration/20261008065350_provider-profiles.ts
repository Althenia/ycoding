import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008065350_provider-profiles",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`account_generation\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_provider_request\` ADD \`assistant_message_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_provider_request\` ADD \`connection_identity_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`profile_binding\` text;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`generation\` integer DEFAULT 0 NOT NULL,
          \`account_generation\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT "credential_generation_check" CHECK(typeof("generation") = 'integer' AND "generation" >= 0),
          CONSTRAINT "credential_account_generation_check" CHECK(typeof("account_generation") = 'integer' AND "account_generation" >= 0)
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_credential\`(\`id\`, \`integration_id\`, \`label\`, \`value\`, \`connector_id\`, \`method_id\`, \`active\`, \`generation\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`integration_id\`, \`label\`, \`value\`, \`connector_id\`, \`method_id\`, \`active\`, \`generation\`, \`time_created\`, \`time_updated\` FROM \`credential\`;`,
      )
      yield* tx.run(`DROP TABLE \`credential\`;`)
      yield* tx.run(`ALTER TABLE \`__new_credential\` RENAME TO \`credential\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
} satisfies DatabaseMigration.Migration
