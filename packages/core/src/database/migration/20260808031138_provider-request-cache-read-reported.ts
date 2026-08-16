import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808031138_provider-request-cache-read-reported",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_provider_request\` ADD \`cache_read_reported\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
