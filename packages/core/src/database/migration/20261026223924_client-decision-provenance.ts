import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261026223924_client-decision-provenance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("UPDATE model_incident SET decided_by = 'client' WHERE decided_by = 'human'")
      yield* tx.run("UPDATE session_message SET data = json_set(data, '$.metadata.inputOrigin', 'direct') WHERE type = 'user' AND json_valid(data) AND json_extract(data, '$.metadata.inputOrigin') = 'human'")
      yield* tx.run("UPDATE session_pending SET data = json_set(data, '$.metadata.inputOrigin', 'direct') WHERE type = 'user' AND json_valid(data) AND json_extract(data, '$.metadata.inputOrigin') = 'human'")
      yield* tx.run("UPDATE event SET data = json_set(data, '$.input.data.metadata.inputOrigin', 'direct') WHERE type = 'session.input.admitted.1' AND json_valid(data) AND json_extract(data, '$.input.type') = 'user' AND json_extract(data, '$.input.data.metadata.inputOrigin') = 'human'")
      yield* tx.run("UPDATE event SET data = json_set(data, '$.payload.fingerprintVersion', 1) WHERE type = 'session.review.deferred.1' AND json_valid(data) AND json_extract(data, '$.kind') = 'permission' AND json_extract(data, '$.payload.type') = 'permission' AND json_type(data, '$.payload.fingerprintVersion') IS NULL")
    })
  },
} satisfies DatabaseMigration.Migration
