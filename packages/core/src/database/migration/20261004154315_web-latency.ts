import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004154315_web-latency",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`web_latency\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`received_at\` integer NOT NULL,
          \`sample\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`web_latency_received_at_idx\` ON \`web_latency\` (\`received_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
