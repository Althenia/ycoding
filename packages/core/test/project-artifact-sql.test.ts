import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

const digest = "a".repeat(64)
const packageRoot = path.resolve(import.meta.dir, "..")
let generatedSql: Promise<string> | undefined

describe("Project Artifact production SQLite schema", () => {
  test.each([
    { subtype: "project_artifact_project_scope", parentType: "global", values: "'pas_parent', 'project-a'" },
    { subtype: "project_artifact_global_scope", parentType: "project", values: "'pas_parent', 1" },
  ])("rejects a $subtype row whose parent has type $parentType", async ({ subtype, parentType, values }) => {
    const database = await makeDatabase()
    try {
      insertProject(database, "project-a")
      insertScope(database, "pas_parent", parentType)
      expect(() => database.run(`INSERT INTO ${subtype} VALUES (${values})`)).toThrow()
    } finally {
      database.close()
    }
  })

  test.each(["current_version_id", "fallback_version_id"])(
    "rejects a %s owned by another artifact tuple",
    async (column) => {
      const database = await makeDatabase()
      try {
        insertScope(database, "pas_scope", "project")
        insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
        insertArtifact(database, "pas_scope", "skill", "artifact-b", "pav_b", "b".repeat(64))
        expect(() =>
          database.run(
            `UPDATE project_artifact SET ${column} = 'pav_b' WHERE scope_id = 'pas_scope' AND kind = 'skill' AND artifact_id = 'artifact-a'`,
          ),
        ).toThrow()
      } finally {
        database.close()
      }
    },
  )

  test.each(["activation", "observation", "feedback"])(
    "rejects a mismatched %s scope/kind/artifact tuple for an existing version",
    async (table) => {
      const database = await makeDatabase()
      try {
        insertScope(database, "pas_scope", "project")
        insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
        const statement =
          table === "activation"
            ? "INSERT INTO project_artifact_activation (id, scope_id, kind, artifact_id, version_id, source, boundary_seq, activated_at) VALUES ('paa_bad', 'pas_scope', 'command', 'artifact-b', 'pav_a', 'manual', 0, 0)"
            : table === "observation"
              ? `INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, observed_at) VALUES ('pao_bad', 'pas_scope', 'command', 'artifact-b', 'pav_a', '${digest}', 1, 0, 1, 'succeeded', 'completed', 0, 0)`
              : "INSERT INTO project_artifact_feedback (id, scope_id, kind, artifact_id, version_id, action, actor, time_created) VALUES ('paf_bad', 'pas_scope', 'command', 'artifact-b', 'pav_a', 'disable', 'user', 0)"
        expect(() => database.run(statement)).toThrow()
      } finally {
        database.close()
      }
    },
  )

  test("rejects duplicate nullable activation and observation identities", async () => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      database.run(
        "INSERT INTO project_artifact_activation (id, scope_id, kind, artifact_id, version_id, source, boundary_seq, activated_at) VALUES ('paa_first', 'pas_scope', 'skill', 'artifact-a', 'pav_a', 'manual', 0, 0)",
      )
      database.run(
        "INSERT INTO project_artifact_activation (id, scope_id, kind, artifact_id, version_id, session_id, source, boundary_seq, activated_at) VALUES ('paa_session', 'pas_scope', 'skill', 'artifact-a', 'pav_a', 'ses_identity', 'manual', 0, 0)",
      )
      expect(() =>
        database.run(
          "INSERT INTO project_artifact_activation (id, scope_id, kind, artifact_id, version_id, source, boundary_seq, activated_at) VALUES ('paa_second', 'pas_scope', 'skill', 'artifact-a', 'pav_a', 'manual', 0, 1)",
        ),
      ).toThrow()

      database.run(
        `INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, observed_at) VALUES ('pao_first', 'pas_scope', 'skill', 'artifact-a', 'pav_a', '${digest}', 1, 0, 1, 'succeeded', 'completed', 0, 0)`,
      )
      database.run(
        `INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, terminal_message_id, observed_at) VALUES ('pao_message', 'pas_scope', 'skill', 'artifact-a', 'pav_a', '${digest}', 1, 0, 1, 'succeeded', 'completed', 0, 'terminal', 0)`,
      )
      expect(() =>
        database.run(
          `INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, observed_at) VALUES ('pao_second', 'pas_scope', 'skill', 'artifact-a', 'pav_a', '${digest}', 1, 0, 1, 'succeeded', 'completed', 0, 1)`,
        ),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  test("rejects parent and origin versions owned by another artifact tuple", async () => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      insertArtifact(database, "pas_scope", "skill", "artifact-b", "pav_b", "b".repeat(64))
      expect(() =>
        insertVersion(database, {
          id: "pav_parent-bad",
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "c".repeat(64),
          parentVersionID: "pav_b",
        }),
      ).toThrow()
      expect(() =>
        insertVersion(database, {
          id: "pav_origin-bad",
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "d".repeat(64),
          source: "promotion",
          originScopeID: "pas_scope",
          originVersionID: "pav_b",
          originEvidenceDigest: "e".repeat(64),
        }),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  test("rejects trash and write rows owned by another artifact or scope", async () => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertScope(database, "pas_other", "global")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      insertArtifact(database, "pas_other", "skill", "artifact-b", "pav_b", "b".repeat(64))
      expect(() =>
        database.run(
          "INSERT INTO project_artifact_trash (deletion_id, scope_id, kind, artifact_id, prior_stage, prior_version_id, deleted_at, purge_after) VALUES ('pad_bad', 'pas_scope', 'skill', 'artifact-a', 'trial', 'pav_b', 0, 2592000000)",
        ),
      ).toThrow()
      expect(() =>
        database.run(
          `INSERT INTO project_artifact_write (scope_id, session_id, insight_digest, operation, result, version_id, content_digest, time_created) VALUES ('pas_scope', 'ses_bad', '${"c".repeat(64)}', 'create', 'created', 'pav_b', '${"b".repeat(64)}', 0)`,
        ),
      ).toThrow()
      expect(() =>
        database.run(
          `INSERT INTO project_artifact_write (scope_id, session_id, insight_digest, operation, result, version_id, content_digest, time_created) VALUES ('pas_scope', 'ses_bad', '${"c".repeat(64)}', 'create', 'created', 'pav_a', '${"d".repeat(64)}', 0)`,
        ),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  test.each([
    {
      name: "scope ID",
      run: (database: Database) => insertScope(database, "pas_Bad", "project", "bad00000-0000-4000-8000-000000000000"),
    },
    {
      name: "artifact ID traversal",
      run: (database: Database) => insertArtifact(database, "pas_scope", "skill", "../bad", "pav_bad-artifact", digest),
    },
    {
      name: "overlong artifact ID",
      run: (database: Database) =>
        insertArtifact(database, "pas_scope", "skill", "a".repeat(65), "pav_overlong", digest),
    },
    {
      name: "version ID",
      run: (database: Database) => insertArtifact(database, "pas_scope", "skill", "artifact-b", "bad", digest),
    },
    {
      name: "deletion ID",
      run: (database: Database) =>
        database.run(
          "INSERT INTO project_artifact_trash (deletion_id, scope_id, kind, artifact_id, prior_stage, prior_version_id, deleted_at, purge_after) VALUES ('bad', 'pas_scope', 'skill', 'artifact-a', 'trial', 'pav_a', 0, 2592000000)",
        ),
    },
    {
      name: "activation ID",
      run: (database: Database) =>
        database.run(
          "INSERT INTO project_artifact_activation (id, scope_id, kind, artifact_id, version_id, source, boundary_seq, activated_at) VALUES ('bad', 'pas_scope', 'skill', 'artifact-a', 'pav_a', 'manual', 0, 0)",
        ),
    },
    {
      name: "observation ID",
      run: (database: Database) =>
        database.run(
          `INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, observed_at) VALUES ('bad', 'pas_scope', 'skill', 'artifact-a', 'pav_a', '${digest}', 1, 0, 1, 'succeeded', 'completed', 0, 0)`,
        ),
    },
  ])("rejects a malformed $name", async ({ run }) => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      expect(() => run(database)).toThrow()
    } finally {
      database.close()
    }
  })

  test.each([
    "con",
    "prn",
    "aux",
    "nul",
    "clock$",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
  ])("rejects reserved artifact ID %s", async (artifactID) => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      expect(() => insertArtifact(database, "pas_scope", "skill", artifactID, "pav_reserved", digest)).toThrow()
    } finally {
      database.close()
    }
  })

  test.each([
    {
      name: "version content digest",
      run: (database: Database) =>
        insertVersion(database, {
          id: "pav_bad-content-digest",
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "A".repeat(64),
        }),
    },
    {
      name: "version insight digest",
      run: (database: Database) =>
        insertVersion(database, {
          id: "pav_bad-insight-digest",
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "b".repeat(64),
          insightDigest: "bad",
        }),
    },
    {
      name: "version origin evidence digest",
      run: (database: Database) =>
        insertVersion(database, {
          id: "pav_bad-origin-digest",
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "c".repeat(64),
          source: "promotion",
          originScopeID: "pas_scope",
          originVersionID: "pav_a",
          originEvidenceDigest: "bad",
        }),
    },
    {
      name: "observation activation-set digest",
      run: (database: Database) =>
        database.run(
          "INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, observed_at) VALUES ('pao_bad-digest', 'pas_scope', 'skill', 'artifact-a', 'pav_a', 'BAD', 1, 0, 1, 'succeeded', 'completed', 0, 0)",
        ),
    },
    {
      name: "write insight digest",
      run: (database: Database) =>
        database.run(
          `INSERT INTO project_artifact_write (scope_id, session_id, insight_digest, operation, result, version_id, content_digest, time_created) VALUES ('pas_scope', 'ses_bad-digest', 'BAD', 'create', 'created', 'pav_a', '${digest}', 0)`,
        ),
    },
  ])("rejects a malformed $name", async ({ run }) => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      expect(() => run(database)).toThrow()
    } finally {
      database.close()
    }
  })

  test.each(["../escape", "/absolute", "a/../escape", "C:/escape", "a\\escape", "a//b", "a/./b", "a/", ""])(
    "rejects unsafe content_relpath %p",
    async (contentRelpath) => {
      const database = await makeDatabase()
      try {
        insertScope(database, "pas_scope", "project")
        insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
        expect(() =>
          insertVersion(database, {
            id: "pav_bad-path",
            scopeID: "pas_scope",
            kind: "skill",
            artifactID: "artifact-a",
            contentDigest: "b".repeat(64),
            contentRelpath,
          }),
        ).toThrow()
      } finally {
        database.close()
      }
    },
  )

  test.each([
    { source: "promotion", originScopeID: undefined, originVersionID: "pav_a", originEvidenceDigest: digest },
    { source: "promotion", originScopeID: "pas_scope", originVersionID: undefined, originEvidenceDigest: digest },
    { source: "promotion", originScopeID: "pas_scope", originVersionID: "pav_a", originEvidenceDigest: undefined },
    { source: "fork", originScopeID: undefined, originVersionID: "pav_a", originEvidenceDigest: digest },
    { source: "fork", originScopeID: "pas_scope", originVersionID: undefined, originEvidenceDigest: digest },
    { source: "fork", originScopeID: "pas_scope", originVersionID: "pav_a", originEvidenceDigest: undefined },
  ])("rejects incomplete $source provenance", async (provenance) => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      expect(() =>
        insertVersion(database, {
          id: `pav_${provenance.source}-${provenance.originScopeID ? "scope" : "none"}-${provenance.originVersionID ? "version" : "none"}-${provenance.originEvidenceDigest ? "evidence" : "none"}`,
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "b".repeat(64),
          ...provenance,
        }),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  test.each(["user", "agent", "restore"])("rejects origin provenance for %s source", async (source) => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      expect(() =>
        insertVersion(database, {
          id: `pav_${source}-origin`,
          scopeID: "pas_scope",
          kind: "skill",
          artifactID: "artifact-a",
          contentDigest: "b".repeat(64),
          source,
          originScopeID: "pas_scope",
          originVersionID: "pav_a",
          originEvidenceDigest: "c".repeat(64),
        }),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  test.each(["promotion", "fork"])("accepts complete %s provenance", async (source) => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_scope", "project")
      insertArtifact(database, "pas_scope", "skill", "artifact-a", "pav_a", digest)
      insertVersion(database, {
        id: `pav_${source}-complete`,
        scopeID: "pas_scope",
        kind: "skill",
        artifactID: "artifact-a",
        contentDigest: "b".repeat(64),
        source,
        originScopeID: "pas_scope",
        originVersionID: "pav_a",
        originEvidenceDigest: "c".repeat(64),
      })
    } finally {
      database.close()
    }
  })

  test("persists a preparing operation before its target version and finalizes it after restart", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-artifact-operation-restart-"))
    const filename = path.join(temporary, "schema.db")
    const database = await makeDatabase(filename)
    try {
      insertScope(database, "pas_operation", "project")
      insertOperation(database, {
        id: "pop_restart",
        scopeID: "pas_operation",
        artifactID: "journal",
        operation: "create",
        requestFingerprint: "1".repeat(64),
        targetVersionID: "pav_journal",
        targetDigest: "2".repeat(64),
      })
    } finally {
      database.close()
    }

    const reopened = openDatabase(filename)
    try {
      expect(
        reopened
          .query<
            { id: string; phase: string; target_version_id: string },
            []
          >("SELECT id, phase, target_version_id FROM project_artifact_operation WHERE phase = 'preparing'")
          .get(),
      ).toEqual({ id: "pop_restart", phase: "preparing", target_version_id: "pav_journal" })
      insertArtifact(reopened, "pas_operation", "skill", "journal", "pav_journal", "2".repeat(64))
      reopened.run(
        "UPDATE project_artifact_operation SET phase = 'available', time_updated = 1 WHERE id = 'pop_restart'",
      )
      reopened.run(
        "UPDATE project_artifact_operation SET phase = 'finalized', final_version_id = 'pav_journal', time_updated = 2 WHERE id = 'pop_restart'",
      )
      expect(
        reopened
          .query<
            { phase: string; final_version_id: string },
            []
          >("SELECT phase, final_version_id FROM project_artifact_operation WHERE id = 'pop_restart'")
          .get(),
      ).toEqual({ phase: "finalized", final_version_id: "pav_journal" })
    } finally {
      reopened.close()
      await fs.rm(temporary, { recursive: true, force: true })
    }
  })

  test("enforces active and exact operation retry identities and permits abort cleanup", async () => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_operation", "project")
      insertArtifact(database, "pas_operation", "skill", "journal", "pav_expected", "2".repeat(64))
      insertOperation(database, {
        id: "pop_first",
        scopeID: "pas_operation",
        artifactID: "journal",
        operation: "update",
        requestFingerprint: "1".repeat(64),
        expectedRevision: 1,
        expectedVersionID: "pav_expected",
        expectedDigest: "2".repeat(64),
        targetVersionID: "pav_target",
        targetDigest: "3".repeat(64),
        automaticSessionID: "ses_operation",
        automaticInsightDigest: "4".repeat(64),
      })
      expect(() =>
        insertOperation(database, {
          id: "pop_active-conflict",
          scopeID: "pas_operation",
          artifactID: "journal",
          operation: "disable",
          requestFingerprint: "5".repeat(64),
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_retry-conflict",
          scopeID: "pas_operation",
          artifactID: "other",
          operation: "create",
          requestFingerprint: "1".repeat(64),
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_automatic-conflict",
          scopeID: "pas_operation",
          artifactID: "other",
          operation: "create",
          requestFingerprint: "6".repeat(64),
          automaticSessionID: "ses_operation",
          automaticInsightDigest: "4".repeat(64),
        }),
      ).toThrow()

      database.run("UPDATE project_artifact_operation SET phase = 'aborted', time_updated = 1 WHERE id = 'pop_first'")
      insertOperation(database, {
        id: "pop_after-abort",
        scopeID: "pas_operation",
        artifactID: "journal",
        operation: "disable",
        requestFingerprint: "7".repeat(64),
      })
      database.run("DELETE FROM project_artifact_operation WHERE phase = 'aborted'")
      expect(
        database
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM project_artifact_operation WHERE id = 'pop_first'")
          .get()?.count,
      ).toBe(0)
    } finally {
      database.close()
    }
  })

  test("rejects malformed operation ownership, phases, expectations, and finalization links", async () => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_source", "project")
      insertScope(database, "pas_target", "global")
      insertArtifact(database, "pas_source", "skill", "journal", "pav_source", digest)
      expect(() =>
        insertOperation(database, {
          id: "pop_unknown-scope",
          scopeID: "pas_missing",
          artifactID: "journal",
          operation: "create",
          requestFingerprint: "1".repeat(64),
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_source-owner",
          scopeID: "pas_target",
          artifactID: "other",
          operation: "promotion",
          requestFingerprint: "2".repeat(64),
          sourceScopeID: "pas_source",
          sourceVersionID: "pav_source",
          sourceDigest: digest,
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_partial-expectation",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "update",
          requestFingerprint: "3".repeat(64),
          expectedRevision: 1,
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_partial-automatic",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "create",
          requestFingerprint: "4".repeat(64),
          automaticSessionID: "ses_operation",
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_partial-target",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "create",
          requestFingerprint: "4".repeat(64),
          targetVersionID: "pav_target",
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_bad-phase",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "create",
          requestFingerprint: "5".repeat(64),
          phase: "unknown",
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_bad-digest",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "create",
          requestFingerprint: "BAD",
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_missing-deletion",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "remove",
          requestFingerprint: "a".repeat(64),
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_bad-operation",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "reconcile",
          requestFingerprint: "6".repeat(64),
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_bad-time",
          scopeID: "pas_target",
          artifactID: "journal",
          operation: "create",
          requestFingerprint: "7".repeat(64),
          timeCreated: 2,
          timeUpdated: 1,
        }),
      ).toThrow()

      insertOperation(database, {
        id: "pop_finalize",
        scopeID: "pas_target",
        artifactID: "journal",
        operation: "create",
        requestFingerprint: "8".repeat(64),
        targetVersionID: "pav_target",
        targetDigest: "9".repeat(64),
      })
      expect(() =>
        database.run(
          "UPDATE project_artifact_operation SET phase = 'finalized', final_version_id = 'pav_missing', time_updated = 1 WHERE id = 'pop_finalize'",
        ),
      ).toThrow()
      insertOperation(database, {
        id: "pop_missing-final-target",
        scopeID: "pas_source",
        artifactID: "journal",
        operation: "disable",
        requestFingerprint: "b".repeat(64),
      })
      expect(() =>
        database.run(
          "UPDATE project_artifact_operation SET phase = 'finalized', final_version_id = 'pav_source', time_updated = 1 WHERE id = 'pop_missing-final-target'",
        ),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  test("binds operation expected, source, and finalized target digests to exact version owners", async () => {
    const database = await makeDatabase()
    try {
      insertScope(database, "pas_digest-source", "project")
      insertScope(database, "pas_digest-target", "global")
      insertArtifact(database, "pas_digest-source", "skill", "journal", "pav_digest-source", digest)

      expect(() =>
        insertOperation(database, {
          id: "pop_expected-digest",
          scopeID: "pas_digest-source",
          artifactID: "journal",
          operation: "update",
          requestFingerprint: "1".repeat(64),
          expectedRevision: 0,
          expectedVersionID: "pav_digest-source",
          expectedDigest: "c".repeat(64),
        }),
      ).toThrow()
      expect(() =>
        insertOperation(database, {
          id: "pop_source-digest",
          scopeID: "pas_digest-target",
          artifactID: "journal",
          operation: "promotion",
          requestFingerprint: "2".repeat(64),
          sourceScopeID: "pas_digest-source",
          sourceVersionID: "pav_digest-source",
          sourceDigest: "c".repeat(64),
          targetVersionID: "pav_digest-target",
          targetDigest: "d".repeat(64),
        }),
      ).toThrow()

      insertOperation(database, {
        id: "pop_final-digest",
        scopeID: "pas_digest-target",
        artifactID: "journal",
        operation: "create",
        requestFingerprint: "3".repeat(64),
        targetVersionID: "pav_digest-target",
        targetDigest: "d".repeat(64),
      })
      insertArtifact(database, "pas_digest-target", "skill", "journal", "pav_digest-target", "b".repeat(64))
      expect(() =>
        database.run(
          "UPDATE project_artifact_operation SET phase = 'finalized', final_version_id = 'pav_digest-target', time_updated = 1 WHERE id = 'pop_final-digest'",
        ),
      ).toThrow()
      database.run(
        `UPDATE project_artifact_operation SET target_digest = '${"b".repeat(64)}', phase = 'finalized', final_version_id = 'pav_digest-target', time_updated = 1 WHERE id = 'pop_final-digest'`,
      )
      expect(() =>
        database.run(
          "DELETE FROM project_artifact WHERE scope_id = 'pas_digest-target' AND kind = 'skill' AND artifact_id = 'journal'",
        ),
      ).toThrow()
      database.run("DELETE FROM project_artifact_operation WHERE id = 'pop_final-digest'")
      database.run(
        "DELETE FROM project_artifact WHERE scope_id = 'pas_digest-target' AND kind = 'skill' AND artifact_id = 'journal'",
      )
      expect(
        database
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM project_artifact_version WHERE id = 'pav_digest-target'")
          .get()?.count,
      ).toBe(0)
    } finally {
      database.close()
    }
  })

  test("rejects negative, fractional, boolean-range, and trash-expiry values", async () => {
    const database = await makeDatabase()
    try {
      insertValidGraph(database)
      const statements = [
        "UPDATE project_artifact_scope SET time_created = -1 WHERE id = 'pas_project'",
        "UPDATE project_artifact SET revision = -1 WHERE scope_id = 'pas_project'",
        "UPDATE project_artifact SET revision = 1.5 WHERE scope_id = 'pas_project'",
        "UPDATE project_artifact SET last_used_at = -1 WHERE scope_id = 'pas_project'",
        "UPDATE project_artifact_version SET time_state_changed = -1 WHERE id = 'pav_project-next'",
        "UPDATE project_artifact_version SET first_qualified_at = -1 WHERE id = 'pav_project-next'",
        "UPDATE project_artifact_version SET last_evaluated_at = -1 WHERE id = 'pav_project-next'",
        "UPDATE project_artifact_version SET last_restored_at = -1 WHERE id = 'pav_project-next'",
        "UPDATE project_artifact_version SET last_governor_transition_at = -1 WHERE id = 'pav_project-next'",
        "UPDATE project_artifact_trash SET deleted_at = -1, purge_after = 2591999999 WHERE deletion_id = 'pad_valid'",
        "UPDATE project_artifact_activation SET boundary_seq = -1 WHERE id = 'paa_valid'",
        "UPDATE project_artifact_activation SET deactivated_at = -1 WHERE id = 'paa_valid'",
        "UPDATE project_artifact_observation SET active_artifact_count = -1 WHERE id = 'pao_valid'",
        "UPDATE project_artifact_observation SET eligible = 2 WHERE id = 'pao_valid'",
        "UPDATE project_artifact_observation SET input_tokens = -1 WHERE id = 'pao_valid'",
        "UPDATE project_artifact_observation SET observed_at = -1 WHERE id = 'pao_valid'",
        "UPDATE project_artifact_feedback SET time_created = -1 WHERE id = 'paf_valid'",
        "UPDATE project_artifact_write SET time_created = -1 WHERE scope_id = 'pas_project'",
        "UPDATE project_artifact_legacy_cleanup SET attempts = -1 WHERE id = 1",
        "UPDATE project_artifact_legacy_cleanup SET completed_at = -1 WHERE id = 1",
        "UPDATE project_artifact_trash SET purge_after = purge_after + 1 WHERE deletion_id = 'pad_valid'",
      ]
      for (const statement of statements) expect(() => database.run(statement)).toThrow()
    } finally {
      database.close()
    }
  })

  test("accepts a complete valid ownership graph for all Phase-1 tables", async () => {
    const database = await makeDatabase()
    try {
      insertValidGraph(database)
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(
        database
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB 'project_artifact*'")
          .get()?.count,
      ).toBe(13)
      expect(
        database
          .query<
            { current_version_id: string; fallback_version_id: string },
            []
          >("SELECT current_version_id, fallback_version_id FROM project_artifact WHERE scope_id = 'pas_project' AND kind = 'skill' AND artifact_id = 'artifact-a'")
          .get(),
      ).toEqual({ current_version_id: "pav_project-next", fallback_version_id: "pav_project-current" })
    } finally {
      database.close()
    }
  })
})

async function makeDatabase(filename = ":memory:") {
  const database = new Database(filename)
  database.exec("PRAGMA foreign_keys = ON")
  for (const statement of (await productionSql())
    .split("--> statement-breakpoint")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)) {
    database.exec(statement)
  }
  expect(database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1)
  return database
}

function openDatabase(filename: string) {
  const database = new Database(filename)
  database.exec("PRAGMA foreign_keys = ON")
  expect(database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1)
  return database
}

function productionSql() {
  generatedSql ??= generateProductionSql()
  return generatedSql
}

async function generateProductionSql() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-artifact-schema-"))
  const output = path.join(temporary, "out")
  const config = path.join(temporary, "drizzle.config.ts")
  try {
    await fs.mkdir(output)
    await Bun.write(
      config,
      `import config from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)}, dbCredentials: { url: ${JSON.stringify(path.join(temporary, "schema.db"))} } }
`,
    )
    const process = Bun.spawn(["bun", "drizzle-kit", "generate", "--config", config, "--name", "schema"], {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exit = await process.exited
    if (exit !== 0) throw new Error(await new Response(process.stderr).text())
    const migrations = await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: output }))
    const migration = migrations[0]
    if (migrations.length !== 1 || !migration)
      throw new Error(`Expected one generated schema, found ${migrations.length}`)
    return Bun.file(path.join(output, migration)).text()
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

function insertProject(database: Database, id: string) {
  database
    .query(
      "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?1, '/tmp/project', 0, 0, '[]')",
    )
    .run(id)
}

function insertScope(database: Database, id: string, type: string, storageID?: string) {
  database
    .query(
      "INSERT INTO project_artifact_scope (id, type, storage_id, time_created, time_updated) VALUES (?1, ?2, ?3, 0, 0)",
    )
    .run(
      id,
      type,
      storageID ?? `${Bun.hash(id).toString(16).padStart(16, "0").slice(0, 8)}-0000-4000-8000-000000000000`,
    )
}

function insertArtifact(
  database: Database,
  scopeID: string,
  kind: string,
  artifactID: string,
  versionID: string,
  contentDigest: string,
  options: VersionOptions = {},
) {
  database.exec("BEGIN")
  database.exec("PRAGMA defer_foreign_keys = ON")
  try {
    database
      .query(
        "INSERT INTO project_artifact (scope_id, kind, artifact_id, revision, stage, current_version_id, time_created, time_updated) VALUES (?1, ?2, ?3, 0, 'trial', ?4, 0, 0)",
      )
      .run(scopeID, kind, artifactID, versionID)
    insertVersion(database, { id: versionID, scopeID, kind, artifactID, contentDigest, ...options })
    database.exec("COMMIT")
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

interface VersionOptions {
  readonly parentVersionID?: string
  readonly contentRelpath?: string
  readonly source?: string
  readonly insightDigest?: string
  readonly originScopeID?: string
  readonly originVersionID?: string
  readonly originEvidenceDigest?: string
}

interface OperationOptions {
  readonly id: string
  readonly scopeID: string
  readonly artifactID: string
  readonly operation: string
  readonly requestFingerprint: string
  readonly expectedRevision?: number
  readonly expectedVersionID?: string
  readonly expectedDigest?: string
  readonly sourceScopeID?: string
  readonly sourceVersionID?: string
  readonly sourceDigest?: string
  readonly targetVersionID?: string
  readonly targetDigest?: string
  readonly finalVersionID?: string
  readonly deletionID?: string
  readonly automaticSessionID?: string
  readonly automaticInsightDigest?: string
  readonly phase?: string
  readonly timeCreated?: number
  readonly timeUpdated?: number
}

function insertOperation(database: Database, input: OperationOptions) {
  database
    .query(
      "INSERT INTO project_artifact_operation (id, scope_id, kind, artifact_id, operation, request_fingerprint, expected_revision, expected_version_id, expected_digest, source_scope_id, source_version_id, source_digest, target_version_id, target_digest, final_version_id, deletion_id, automatic_session_id, automatic_insight_digest, phase, time_created, time_updated) VALUES (?1, ?2, 'skill', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
    )
    .run(
      input.id,
      input.scopeID,
      input.artifactID,
      input.operation,
      input.requestFingerprint,
      input.expectedRevision ?? null,
      input.expectedVersionID ?? null,
      input.expectedDigest ?? null,
      input.sourceScopeID ?? null,
      input.sourceVersionID ?? null,
      input.sourceDigest ?? null,
      input.targetVersionID ?? null,
      input.targetDigest ?? null,
      input.finalVersionID ?? null,
      input.deletionID ?? null,
      input.automaticSessionID ?? null,
      input.automaticInsightDigest ?? null,
      input.phase ?? "preparing",
      input.timeCreated ?? 0,
      input.timeUpdated ?? 0,
    )
}

function insertVersion(
  database: Database,
  input: VersionOptions & {
    readonly id: string
    readonly scopeID: string
    readonly kind: string
    readonly artifactID: string
    readonly contentDigest: string
  },
) {
  database
    .query(
      "INSERT INTO project_artifact_version (id, scope_id, kind, artifact_id, parent_version_id, state, content_digest, content_relpath, source, insight_digest, origin_scope_id, origin_version_id, origin_evidence_digest, time_created, time_state_changed) VALUES (?1, ?2, ?3, ?4, ?5, 'trial', ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, 0)",
    )
    .run(
      input.id,
      input.scopeID,
      input.kind,
      input.artifactID,
      input.parentVersionID ?? null,
      input.contentDigest,
      input.contentRelpath ?? "SKILL.md",
      input.source ?? "user",
      input.insightDigest ?? null,
      input.originScopeID ?? null,
      input.originVersionID ?? null,
      input.originEvidenceDigest ?? null,
    )
}

function insertValidGraph(database: Database) {
  insertProject(database, "project-a")
  insertScope(database, "pas_project", "project")
  database.run("INSERT INTO project_artifact_project_scope (scope_id, project_id) VALUES ('pas_project', 'project-a')")
  insertScope(database, "pas_global", "global")
  database.run("INSERT INTO project_artifact_global_scope (scope_id, singleton) VALUES ('pas_global', 1)")

  insertArtifact(database, "pas_project", "skill", "artifact-a", "pav_project-current", digest)
  insertVersion(database, {
    id: "pav_project-next",
    scopeID: "pas_project",
    kind: "skill",
    artifactID: "artifact-a",
    contentDigest: "b".repeat(64),
    parentVersionID: "pav_project-current",
    insightDigest: "c".repeat(64),
  })
  database.run(
    "UPDATE project_artifact SET revision = 1, current_version_id = 'pav_project-next', fallback_version_id = 'pav_project-current' WHERE scope_id = 'pas_project' AND kind = 'skill' AND artifact_id = 'artifact-a'",
  )
  insertArtifact(database, "pas_global", "skill", "artifact-a", "pav_global-current", "d".repeat(64), {
    source: "promotion",
    originScopeID: "pas_project",
    originVersionID: "pav_project-next",
    originEvidenceDigest: "e".repeat(64),
  })

  database.run(
    "INSERT INTO project_artifact_trash (deletion_id, scope_id, kind, artifact_id, prior_stage, prior_version_id, deleted_at, purge_after) VALUES ('pad_valid', 'pas_project', 'skill', 'artifact-a', 'trial', 'pav_project-next', 0, 2592000000)",
  )
  database.run(
    "INSERT INTO project_artifact_activation (id, scope_id, kind, artifact_id, version_id, project_id, session_id, agent_id, source, message_id, call_id, boundary_seq, activated_at, deactivated_at) VALUES ('paa_valid', 'pas_project', 'skill', 'artifact-a', 'pav_project-next', 'project-a', 'ses_valid', 'agent-a', 'manual', 'message-a', 'call-a', 0, 0, 1)",
  )
  database.run(
    `INSERT INTO project_artifact_observation (id, scope_id, kind, artifact_id, version_id, project_id, session_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, latency_ms, input_tokens, output_tokens, cache_read_tokens, completed_tool_count, failed_tool_count, terminal_message_id, observed_at) VALUES ('pao_valid', 'pas_project', 'skill', 'artifact-a', 'pav_project-next', 'project-a', 'ses_valid', '${"f".repeat(64)}', 1, 0, 1, 'succeeded', 'completed', 0, 1, 1, 1, 1, 1, 0, 'message-a', 1)`,
  )
  database.run(
    "INSERT INTO project_artifact_feedback (id, scope_id, kind, artifact_id, version_id, action, actor, time_created) VALUES ('paf_valid', 'pas_project', 'skill', 'artifact-a', 'pav_project-next', 'enable', 'user', 1)",
  )
  database.run(
    `INSERT INTO project_artifact_write (scope_id, session_id, insight_digest, operation, result, version_id, content_digest, time_created) VALUES ('pas_project', 'ses_valid', '${"1".repeat(64)}', 'update', 'updated', 'pav_project-next', '${"b".repeat(64)}', 1)`,
  )
  database.run(
    "INSERT INTO project_artifact_legacy_cleanup (id, status, cursor, attempts, removed_count, skipped_count, failed_count, last_attempt_at, completed_at) VALUES (1, 'complete', NULL, 1, 1, 0, 0, 1, 1)",
  )
}
