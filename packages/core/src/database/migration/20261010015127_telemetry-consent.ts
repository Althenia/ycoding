import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010015127_telemetry-consent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`telemetry_consent\` (
          \`id\` integer PRIMARY KEY,
          \`enabled\` integer NOT NULL,
          \`notice_version\` integer NOT NULL,
          \`decided_at\` integer NOT NULL,
          CONSTRAINT "telemetry_consent_single_row" CHECK("id" = 1)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
