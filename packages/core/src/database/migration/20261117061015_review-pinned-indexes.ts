import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261117061015_review-pinned-indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`event_review_type_aggregate_seq_idx\` ON \`event\` (\`type\`,\`aggregate_id\`,\`seq\`) WHERE "event"."type" IN ('session.review.deferred.1', 'session.review.decided.1', 'session.review.withdrawn.1', 'session.review.consumed.1');`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_pinned_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`) WHERE "session"."time_pinned" is not null;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
