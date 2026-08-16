import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725062914_drop-application-cache",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE IF EXISTS \`cache_artifact_fts\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_artifact_chunk_artifact_ordinal_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_artifact_exact_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_artifact_lifecycle_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_edge_target_relation_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_metric_scope_domain_time_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_observation_artifact_time_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`cache_validation_artifact_time_idx\`;`)
      yield* tx.run(`DROP TABLE \`cache_artifact_chunk\`;`)
      yield* tx.run(`DROP TABLE \`cache_artifact\`;`)
      yield* tx.run(`DROP TABLE \`cache_edge\`;`)
      yield* tx.run(`DROP TABLE \`cache_evidence\`;`)
      yield* tx.run(`DROP TABLE \`cache_metric\`;`)
      yield* tx.run(`DROP TABLE \`cache_observation\`;`)
      yield* tx.run(`DROP TABLE \`cache_tombstone\`;`)
      yield* tx.run(`DROP TABLE \`cache_validation\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
