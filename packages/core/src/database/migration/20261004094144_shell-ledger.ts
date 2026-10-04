import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004094144_shell-ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`shell\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`pid\` integer NOT NULL,
          \`process_started\` text,
          \`owner_pid\` integer NOT NULL,
          \`owner_started\` text NOT NULL,
          \`notice_pending\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_lost\` integer,
          \`start_seq\` integer DEFAULT -1 NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
