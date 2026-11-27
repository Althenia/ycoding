import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261127053131_drop-project-artifacts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA defer_foreign_keys = ON;`)
      yield* tx.run(`DELETE FROM \`event\` WHERE \`type\` = 'session.project-artifacts-ended.1';`)
      yield* tx.run(
        `DELETE FROM \`session_message\` WHERE \`type\` = 'synthetic' AND json_type(\`data\`, '$.metadata.projectArtifactsEnded') IN ('object', 'array');`,
      )
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_activation_identity_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_activation_sessionless_identity_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_activation_session_open_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_feedback_version_created_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_global_scope_singleton_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_observation_version_terminal_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_observation_version_session_absent_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_observation_sessionless_absent_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_observation_version_eligible_observed_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_operation_request_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_operation_automatic_retry_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_operation_active_artifact_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_operation_recovery_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_project_scope_project_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_scope_storage_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_scope_stage_kind_updated_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_terminal_message_identity_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_terminal_boundary_identity_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_terminal_cohort_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_trash_scope_kind_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_trash_purge_after_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_version_scope_kind_id_digest_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_version_scope_kind_id_created_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_write_scope_created_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_write_session_created_idx\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_activation\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_feedback\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_observation\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_operation\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_terminal\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_trash\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_write\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_global_scope\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_project_scope\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_legacy_cleanup\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_version\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact\`;`)
      yield* tx.run(`DROP TABLE \`project_artifact_scope\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
