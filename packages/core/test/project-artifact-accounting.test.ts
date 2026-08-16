import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Agent } from "@ycoding-ai/schema/agent"
import { Project } from "@ycoding-ai/schema/project"
import { Session } from "@ycoding-ai/schema/session"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { Database } from "@ycoding-ai/core/database/database"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import {
  ProjectArtifactActivationTable,
  ProjectArtifactFeedbackTable,
  ProjectArtifactGlobalScopeTable,
  ProjectArtifactObservationTable,
  ProjectArtifactProjectScopeTable,
  ProjectArtifactScopeTable,
  ProjectArtifactTable,
  ProjectArtifactVersionTable,
} from "@ycoding-ai/core/project-artifact/sql"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { testEffect } from "./lib/effect"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
const databaseLayer = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run(sql.raw("PRAGMA foreign_keys = ON"))
    const statements = (yield* Effect.promise(productionSql))
      .split("--> statement-breakpoint")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    yield* Effect.forEach(statements, (statement) => db.run(sql.raw(statement)), { discard: true })
    return { db }
  }),
).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })))
const serviceIt = testEffect(
  Layer.provideMerge(ProjectArtifactAccounting.layerWithSecret("private-test-key"), databaseLayer),
)

describe("ProjectArtifactAccounting", () => {
  test("marks multi-artifact and external outcomes confounded", () => {
    expect(
      ProjectArtifactAccounting.eligible({
        activeArtifactCount: 2,
        externalConfounded: false,
        terminalOutcome: "succeeded",
        goalStatus: "completed",
      }),
    ).toBe(false)
    expect(
      ProjectArtifactAccounting.eligible({
        activeArtifactCount: 1,
        externalConfounded: true,
        terminalOutcome: "succeeded",
        goalStatus: "completed",
      }),
    ).toBe(false)
    expect(
      ProjectArtifactAccounting.eligible({
        activeArtifactCount: 1,
        externalConfounded: false,
        terminalOutcome: "succeeded",
        goalStatus: "completed",
      }),
    ).toBe(true)
  })

  test("uses bounded observational rewards and explicit penalties", () => {
    expect(
      ProjectArtifactAccounting.reward({ terminalOutcome: "succeeded", goalStatus: "completed", repeatFix: false }),
    ).toBe(1)
    expect(
      ProjectArtifactAccounting.reward({ terminalOutcome: "succeeded", goalStatus: "none", repeatFix: true }),
    ).toBe(-0.25)
    expect(ProjectArtifactAccounting.reward({ terminalOutcome: "failed", goalStatus: "none", repeatFix: true })).toBe(
      -1,
    )
    expect(ProjectArtifactAccounting.penalty("disable")).toBe(4)
    expect(ProjectArtifactAccounting.penalty("revert")).toBe(5)
    expect(ProjectArtifactAccounting.penalty("delete")).toBe(6)
  })

  test("requires two confidence evaluations and a matched baseline before degradation", () => {
    const now = 30 * 86_400_000
    const candidate = { sampleCount: 30, successCount: 5 }
    const baseline = { sampleCount: 40, successCount: 36 }
    expect(
      ProjectArtifactAccounting.decision({
        stage: "active",
        createdAt: 0,
        lastTransitionAt: 0,
        state: { firstQualifiedAt: null },
        now,
        candidate,
        baseline,
      }),
    ).toEqual({ action: "none", state: { firstQualifiedAt: now } })
    expect(
      ProjectArtifactAccounting.decision({
        stage: "active",
        createdAt: 0,
        lastTransitionAt: 0,
        state: { firstQualifiedAt: now - 86_400_000 },
        now,
        candidate,
        baseline,
      }),
    ).toEqual({ action: "degrade", state: { firstQualifiedAt: null } })
    expect(
      ProjectArtifactAccounting.decision({
        stage: "active",
        createdAt: 0,
        lastTransitionAt: 0,
        state: { firstQualifiedAt: now - 86_400_000 },
        now,
        candidate,
      }),
    ).toEqual({ action: "none", state: { firstQualifiedAt: null } })
  })

  test("derives exact balanced global buckets from distinct candidate samples", () => {
    const base = {
      stage: "active" as const,
      createdAt: 0,
      lastTransitionAt: 0,
      state: { firstQualifiedAt: 29 * 86_400_000 },
      now: 30 * 86_400_000,
      candidate: { sampleCount: 30, successCount: 5 },
      baseline: { sampleCount: 40, successCount: 36 },
      global: true,
    }
    const balanced = Array.from({ length: 30 }, (_, index) => ({
      sampleID: `sample-${index}`,
      bucketID: `bucket-${index % 3}`,
    }))
    expect(ProjectArtifactAccounting.decision({ ...base, globalSamples: balanced })).toEqual({
      action: "degrade",
      state: { firstQualifiedAt: null },
    })
    expect(
      ProjectArtifactAccounting.decision({
        ...base,
        candidate: { sampleCount: 29, successCount: 4 },
        globalSamples: balanced.slice(0, 29),
      }),
    ).toEqual({ action: "none", state: { firstQualifiedAt: null } })
    expect(ProjectArtifactAccounting.decision({ ...base, globalSamples: balanced.slice(0, 29) })).toEqual({
      action: "none",
      state: { firstQualifiedAt: null },
    })
    expect(
      ProjectArtifactAccounting.decision({
        ...base,
        globalSamples: [...balanced, { sampleID: "sample-0", bucketID: "bucket-0" }],
      }),
    ).toEqual({
      action: "none",
      state: { firstQualifiedAt: null },
    })
    expect(
      ProjectArtifactAccounting.decision({
        ...base,
        globalSamples: [...balanced.slice(0, 29), { sampleID: "sample-0", bucketID: "bucket-0" }],
      }),
    ).toEqual({
      action: "none",
      state: { firstQualifiedAt: null },
    })
  })

  test("uses HMAC project buckets rather than raw or plain-hash project identity", () => {
    const first = ProjectArtifactAccounting.projectBucket("private-test-key", "project-a")
    expect(first).toBe(ProjectArtifactAccounting.projectBucket("private-test-key", "project-a"))
    expect(first).not.toBe(ProjectArtifactAccounting.projectBucket("private-test-key", "project-b"))
    expect(first).not.toContain("project-a")
    expect(first).not.toBe(new Bun.CryptoHasher("sha256").update("project-a").digest("hex"))
  })

  test("selects rolling matched zero-activation observational baselines", () => {
    const now = 40 * 86_400_000
    const clean = {
      projectID: "project-a",
      kind: "skill",
      agentID: "agent-a",
      modelID: "model-a",
      goalMode: false,
      eligible: true,
      externalConfounded: false,
      managedActivationCount: 0,
      standardInvocationCount: 0,
      observedAt: now,
    }
    expect(
      ProjectArtifactAccounting.matchedObservationalCohort({
        projectID: "project-a",
        kind: "skill",
        agentID,
        modelID: "model-a",
        goalMode: false,
        now,
        observations: [
          clean,
          { ...clean, projectID: "project-b" },
          { ...clean, externalConfounded: true },
          { ...clean, eligible: false },
          { ...clean, managedActivationCount: 1 },
          { ...clean, standardInvocationCount: 1 },
          { ...clean, observedAt: now - 30 * 86_400_000 - 1 },
        ],
      }),
    ).toEqual([clean])
  })

  test("validates exact 29/30 global sample and bucket boundaries", () => {
    const balanced = Array.from({ length: 30 }, (_, index) => ({
      sampleID: `sample-${index}`,
      bucketID: `bucket-${index % 3}`,
    }))
    expect(ProjectArtifactAccounting.globalConfidence(29, balanced.slice(0, 29))).toBe(false)
    expect(ProjectArtifactAccounting.globalConfidence(30, balanced)).toBe(true)
    expect(ProjectArtifactAccounting.globalConfidence(30, balanced.slice(0, 29))).toBe(false)
    expect(
      ProjectArtifactAccounting.globalConfidence(30, [...balanced, { sampleID: "inflated", bucketID: "bucket-0" }]),
    ).toBe(false)
    expect(
      ProjectArtifactAccounting.globalConfidence(30, [
        ...balanced.slice(0, 29),
        { sampleID: "sample-0", bucketID: "bucket-0" },
      ]),
    ).toBe(false)
    expect(
      ProjectArtifactAccounting.globalConfidence(
        30,
        Array.from({ length: 30 }, (_, index) => ({
          sampleID: `sample-${index}`,
          bucketID: index < 16 ? "bucket-0" : index < 23 ? "bucket-1" : "bucket-2",
        })),
      ),
    ).toBe(false)
  })

  test("calculates Wilson bounds at zero, small, and large sample boundaries", () => {
    expect(ProjectArtifactAccounting.wilson(0, 0)).toEqual({ lowerBound: 0, upperBound: 1 })
    expect(ProjectArtifactAccounting.wilson(1, 0).lowerBound).toBeCloseTo(0, 12)
    expect(ProjectArtifactAccounting.wilson(1, 1).upperBound).toBeCloseTo(1, 12)
    expect(ProjectArtifactAccounting.wilson(10_000, 10_000).lowerBound).toBeGreaterThan(0.999)
  })


  test("keeps observational scores finite and bounded for invalid and large inputs", () => {
    expect(ProjectArtifactAccounting.score(0, 0)).toBe(0)
    expect(ProjectArtifactAccounting.score(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(0)
    expect(ProjectArtifactAccounting.score(Number.POSITIVE_INFINITY, 1)).toBe(0)
    expect(ProjectArtifactAccounting.score(-1, 1)).toBe(0)
  })

  test("returns persistable governor state across failures and exact cooldown boundaries", () => {
    const day = 86_400_000
    const base = {
      stage: "trial" as const,
      createdAt: 0,
      lastTransitionAt: 0,
      now: 8 * day,
      candidate: { sampleCount: 40, successCount: 40 },
      state: { firstQualifiedAt: null },
    }
    const first = ProjectArtifactAccounting.decision(base)
    expect(first).toEqual({ action: "none", state: { firstQualifiedAt: 8 * day } })
    expect(
      ProjectArtifactAccounting.decision({
        ...base,
        now: 9 * day,
        candidate: { sampleCount: 40, successCount: 0 },
        state: first.state,
      }),
    ).toEqual({ action: "none", state: { firstQualifiedAt: null } })
    const restarted = ProjectArtifactAccounting.decision({ ...base, now: 10 * day })
    expect(ProjectArtifactAccounting.decision({ ...base, now: 11 * day - 1, state: restarted.state })).toEqual({
      action: "none",
      state: { firstQualifiedAt: 10 * day },
    })
    expect(ProjectArtifactAccounting.decision({ ...base, now: 11 * day, state: restarted.state })).toEqual({
      action: "activate",
      state: { firstQualifiedAt: null },
    })
    expect(
      ProjectArtifactAccounting.decision({
        ...base,
        now: 15 * day,
        restoredAt: 8 * day + 1,
        state: { firstQualifiedAt: 14 * day },
      }),
    ).toEqual({ action: "none", state: { firstQualifiedAt: null } })
    expect(
      ProjectArtifactAccounting.decision({
        ...base,
        now: 15 * day,
        restoredAt: 8 * day,
        state: { firstQualifiedAt: 14 * day },
      }),
    ).toEqual({ action: "activate", state: { firstQualifiedAt: null } })
  })

  test("honors exact 24-hour evaluation and seven-day transition boundaries", () => {
    const day = 86_400_000
    const base = {
      stage: "trial" as const,
      createdAt: 0,
      lastTransitionAt: 0,
      now: 8 * day,
      candidate: { sampleCount: 40, successCount: 40 },
    }
    expect(ProjectArtifactAccounting.decision({ ...base, state: { firstQualifiedAt: base.now - day + 1 } })).toEqual({
      action: "none",
      state: { firstQualifiedAt: base.now - day + 1 },
    })
    expect(ProjectArtifactAccounting.decision({ ...base, state: { firstQualifiedAt: base.now - day } })).toEqual({
      action: "activate",
      state: { firstQualifiedAt: null },
    })
    expect(ProjectArtifactAccounting.decision({ ...base, now: 7 * day - 1, state: { firstQualifiedAt: 0 } })).toEqual({
      action: "none",
      state: { firstQualifiedAt: null },
    })
    const degradation = {
      stage: "active" as const,
      createdAt: 0,
      now: 30 * day,
      candidate: { sampleCount: 30, successCount: 5 },
      baseline: { sampleCount: 40, successCount: 36 },
      state: { firstQualifiedAt: 29 * day },
    }
    expect(
      ProjectArtifactAccounting.decision({
        ...degradation,
        lastTransitionAt: degradation.now - 7 * day + 1,
      }),
    ).toEqual({ action: "none", state: { firstQualifiedAt: null } })
    expect(ProjectArtifactAccounting.decision({ ...degradation, lastTransitionAt: degradation.now - 7 * day })).toEqual(
      { action: "degrade", state: { firstQualifiedAt: null } },
    )
    expect(
      ProjectArtifactAccounting.decision({
        ...degradation,
        stage: "trial",
        lastTransitionAt: degradation.now - 7 * day,
      }),
    ).toEqual({ action: "degrade", state: { firstQualifiedAt: null } })
  })

  serviceIt.effect("uses generated foreign-key schema for present and absent activation identity retries", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("accounting-project")
      const scopeID = ProjectArtifact.ScopeID.make("pas_accounting-project")
      const artifactID = ProjectArtifact.ID.make("review")
      const versionID = ProjectArtifact.VersionID.make("pav_accounting-project")
      const sessionID = Session.ID.make("ses_accounting_project")
      yield* seedProjectArtifact(db, { projectID, scopeID, artifactID, versionID })
      expect((yield* db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`))?.foreign_keys).toBe(1)

      const presentInput = {
        id: ProjectArtifact.ActivationID.make("paa_present"),
        projectID,
        sessionID,
        scopeID,
        artifactID,
        versionID,
      }
      const present = activation(presentInput)
      expect((yield* accounting.activate(present)).id).toBe(present.id)
      expect((yield* accounting.activate(present)).id).toBe(present.id)
      expect(
        (yield* Effect.exit(
          accounting.activate(
            activation({
              ...presentInput,
              id: ProjectArtifact.ActivationID.make("paa_present-conflict"),
            }),
          ),
        ))._tag,
      ).toBe("Failure")

      const absentInput = {
        id: ProjectArtifact.ActivationID.make("paa_absent"),
        projectID,
        scopeID,
        artifactID,
        versionID,
        boundarySeq: ProjectArtifact.Revision.make(2),
      }
      const absent = activation(absentInput)
      expect((yield* accounting.activate(absent)).id).toBe(absent.id)
      expect((yield* accounting.activate(absent)).id).toBe(absent.id)
      expect(
        (yield* Effect.exit(
          accounting.activate(
            activation({
              ...absentInput,
              id: ProjectArtifact.ActivationID.make("paa_absent-conflict"),
            }),
          ),
        ))._tag,
      ).toBe("Failure")

      expect(
        (yield* Effect.exit(
          accounting.activate(
            activation({
              ...presentInput,
              id: ProjectArtifact.ActivationID.make("paa_wrong-owner"),
              artifactID: ProjectArtifact.ID.make("wrong-owner"),
              boundarySeq: ProjectArtifact.Revision.make(3),
            }),
          ),
        ))._tag,
      ).toBe("Failure")
    }),
  )

  serviceIt.effect("selects and compares stored present and absent observation identities", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("observation-project")
      const scopeID = ProjectArtifact.ScopeID.make("pas_observation-project")
      const artifactID = ProjectArtifact.ID.make("observation")
      const versionID = ProjectArtifact.VersionID.make("pav_observation-project")
      const sessionID = Session.ID.make("ses_observation_project")
      yield* seedProjectArtifact(db, { projectID, scopeID, artifactID, versionID })
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_observation"),
          projectID,
          sessionID,
          scopeID,
          artifactID,
          versionID,
        }),
      )

      const present = observeInput({ projectID, sessionID, terminalMessageID: "terminal-present" })
      const presentRows = yield* accounting.observe(present)
      expect((yield* accounting.observe(present)).map((observation) => observation.id)).toEqual(
        presentRows.map((observation) => observation.id),
      )
      yield* db
        .update(ProjectArtifactObservationTable)
        .set({ id: ProjectArtifact.ObservationID.make("pao_present-mutated") })
        .where(
          eq(
            ProjectArtifactObservationTable.id,
            presentRows[0]?.id ?? ProjectArtifact.ObservationID.make("pao_missing-present"),
          ),
        )
        .run()
      expect((yield* Effect.exit(accounting.observe(present)))._tag).toBe("Failure")

      const absent = observeInput({
        projectID,
        sessionID,
        boundarySeq: ProjectArtifact.Revision.make(2),
      })
      const absentRows = yield* accounting.observe(absent)
      expect((yield* accounting.observe(absent)).map((observation) => observation.id)).toEqual(
        absentRows.map((observation) => observation.id),
      )
      yield* db
        .update(ProjectArtifactObservationTable)
        .set({ id: ProjectArtifact.ObservationID.make("pao_absent-mutated") })
        .where(
          eq(
            ProjectArtifactObservationTable.id,
            absentRows[0]?.id ?? ProjectArtifact.ObservationID.make("pao_missing-absent"),
          ),
        )
        .run()
      expect((yield* Effect.exit(accounting.observe(absent)))._tag).toBe("Failure")
    }),
  )


  serviceIt.effect("isolates terminal-message-absent observation retries by Session", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("absent-observation-project")
      const scopeID = ProjectArtifact.ScopeID.make("pas_absent-observation")
      const artifactID = ProjectArtifact.ID.make("absent-observation")
      const versionID = ProjectArtifact.VersionID.make("pav_absent-observation")
      const firstSessionID = Session.ID.make("ses_absent_observation_first")
      const secondSessionID = Session.ID.make("ses_absent_observation_second")
      yield* seedProjectArtifact(db, { projectID, scopeID, artifactID, versionID })
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_absent-observation-first"),
          projectID,
          sessionID: firstSessionID,
          scopeID,
          artifactID,
          versionID,
        }),
      )
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_absent-observation-second"),
          projectID,
          sessionID: secondSessionID,
          scopeID,
          artifactID,
          versionID,
          boundarySeq: ProjectArtifact.Revision.make(2),
        }),
      )
      const first = observeInput({ projectID, sessionID: firstSessionID })
      const second = observeInput({
        projectID,
        sessionID: secondSessionID,
        boundarySeq: ProjectArtifact.Revision.make(2),
      })
      const firstRows = yield* accounting.observe(first)
      const secondRows = yield* accounting.observe(second)
      expect(firstRows[0]?.id).not.toBe(secondRows[0]?.id)
      expect((yield* accounting.observe(first))[0]?.id).toBe(firstRows[0]?.id)
      expect((yield* accounting.observe(second))[0]?.id).toBe(secondRows[0]?.id)
      expect(yield* db.select().from(ProjectArtifactObservationTable).all()).toHaveLength(2)
    }),
  )

  serviceIt.effect("stores observations, feedback, metrics, and move deactivation on generated schema", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("accounting-project")
      const sessionID = Session.ID.make("ses_accounting_project")
      const projectScopeID = ProjectArtifact.ScopeID.make("pas_accounting-project")
      const globalScopeID = ProjectArtifact.ScopeID.make("pas_accounting-global")
      const artifactID = ProjectArtifact.ID.make("review")
      const projectVersionID = ProjectArtifact.VersionID.make("pav_accounting-project")
      const globalVersionID = ProjectArtifact.VersionID.make("pav_accounting-global")
      yield* seedProjectArtifact(db, {
        projectID,
        scopeID: projectScopeID,
        artifactID,
        versionID: projectVersionID,
      })
      yield* seedGlobalArtifact(db, { scopeID: globalScopeID, artifactID, versionID: globalVersionID })
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_accounting-project"),
          projectID,
          sessionID,
          scopeID: projectScopeID,
          artifactID,
          versionID: projectVersionID,
        }),
      )
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_accounting-global"),
          projectID,
          sessionID,
          scopeID: globalScopeID,
          artifactID,
          versionID: globalVersionID,
        }),
      )
      const outcome = observeInput({ projectID, sessionID, terminalMessageID: "message-terminal" })
      const observations = yield* accounting.observe(outcome)
      expect(observations).toHaveLength(2)
      expect(observations.every((observation) => !observation.eligible)).toBe(true)
      expect(Object.keys(observations[0] ?? {})).not.toEqual(
        expect.arrayContaining(["prompt", "output", "path", "url", "error"]),
      )
      expect((yield* accounting.observe(outcome)).map((observation) => observation.id)).toEqual(
        observations.map((observation) => observation.id),
      )

      const feedback = ProjectArtifact.Feedback.make({
        artifact: { scopeID: projectScopeID, kind: "skill", id: artifactID, versionID: projectVersionID },
        action: "disable",
        actor: "user",
        timeCreated: ProjectArtifact.TimestampMillis.make(2),
      })
      const feedbackID = yield* accounting.feedback(feedback)
      expect(yield* accounting.feedback(feedback)).toBe(feedbackID)
      expect(yield* db.select().from(ProjectArtifactFeedbackTable).all()).toHaveLength(1)

      expect(
        yield* accounting.deactivateProject({
          sessionID,
          projectID,
          boundarySeq: ProjectArtifact.Revision.make(2),
          deactivatedAt: ProjectArtifact.TimestampMillis.make(3),
        }),
      ).toBe(1)
      expect(
        yield* accounting.deactivateProject({
          sessionID,
          projectID,
          boundarySeq: ProjectArtifact.Revision.make(2),
          deactivatedAt: ProjectArtifact.TimestampMillis.make(3),
        }),
      ).toBe(0)
      const rows = yield* db
        .select()
        .from(ProjectArtifactActivationTable)
        .where(eq(ProjectArtifactActivationTable.session_id, sessionID))
        .all()
      expect(rows.find((row) => row.scope_id === projectScopeID)?.deactivated_at).toBe(3)
      expect(rows.find((row) => row.scope_id === globalScopeID)?.deactivated_at).toBeNull()

      const metricsSessionID = Session.ID.make("ses_accounting_metrics")
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_accounting-metrics"),
          projectID,
          sessionID: metricsSessionID,
          scopeID: projectScopeID,
          artifactID,
          versionID: projectVersionID,
          boundarySeq: ProjectArtifact.Revision.make(4),
        }),
      )
      yield* accounting.observe(
        observeInput({ projectID, sessionID: metricsSessionID, terminalMessageID: "message-metrics" }),
      )
      const metrics = yield* accounting.metrics(projectVersionID)
      expect(metrics.confidence.sampleCount).toBe(1)
      expect(metrics.confidence.successCount).toBe(1)
      expect(metrics.rewardUnits).toBe(1)
      expect(metrics.penaltyUnits).toBe(4)
      expect(yield* db.select().from(ProjectArtifactObservationTable).all()).toHaveLength(3)
    }),
  )

  serviceIt.effect("rolls back in-transaction feedback with its owning stage transition", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("feedback-transaction-project")
      const scopeID = ProjectArtifact.ScopeID.make("pas_feedback-transaction")
      const artifactID = ProjectArtifact.ID.make("feedback-transaction")
      const versionID = ProjectArtifact.VersionID.make("pav_feedback-transaction")
      yield* seedProjectArtifact(db, { projectID, scopeID, artifactID, versionID })
      yield* db
        .update(ProjectArtifactVersionTable)
        .set({ first_qualified_at: ProjectArtifact.TimestampMillis.make(1) })
        .where(eq(ProjectArtifactVersionTable.id, versionID))
        .run()
      const feedback = ProjectArtifact.Feedback.make({
        artifact: { scopeID, kind: "skill", id: artifactID, versionID },
        action: "disable",
        actor: "user",
        timeCreated: ProjectArtifact.TimestampMillis.make(2),
      })

      const exit = yield* Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* accounting.feedbackInTransaction(tx, feedback)
            yield* tx
              .update(ProjectArtifactTable)
              .set({ stage: "disabled" })
              .where(eq(ProjectArtifactTable.scope_id, scopeID))
              .run()
            return yield* Effect.fail(new Error("rollback"))
          }),
        ),
      )
      expect(exit._tag).toBe("Failure")
      expect(yield* db.select().from(ProjectArtifactFeedbackTable).all()).toEqual([])
      expect(
        (yield* db
          .select({ stage: ProjectArtifactTable.stage })
          .from(ProjectArtifactTable)
          .where(eq(ProjectArtifactTable.scope_id, scopeID))
          .get())?.stage,
      ).toBe("trial")
      expect(
        (yield* db
          .select({ firstQualifiedAt: ProjectArtifactVersionTable.first_qualified_at })
          .from(ProjectArtifactVersionTable)
          .where(eq(ProjectArtifactVersionTable.id, versionID))
          .get())?.firstQualifiedAt,
      ).toBe(1)

      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* accounting.feedbackInTransaction(tx, feedback)
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "disabled" })
            .where(eq(ProjectArtifactTable.scope_id, scopeID))
            .run()
        }),
      )
      expect(yield* db.select().from(ProjectArtifactFeedbackTable).all()).toHaveLength(1)
      expect(
        (yield* db
          .select({ firstQualifiedAt: ProjectArtifactVersionTable.first_qualified_at })
          .from(ProjectArtifactVersionTable)
          .where(eq(ProjectArtifactVersionTable.id, versionID))
          .get())?.firstQualifiedAt,
      ).toBeNull()
    }),
  )

  serviceIt.effect("derives matched rolling baselines and HMAC buckets without raw global identity", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const day = 86_400_000
      const now = 40 * day
      const projectID = Project.ID.make("cohort-project")
      const otherProjectID = Project.ID.make("cohort-other")
      const scopeID = ProjectArtifact.ScopeID.make("pas_cohort-project")
      const globalScopeID = ProjectArtifact.ScopeID.make("pas_cohort-global")
      const artifactID = ProjectArtifact.ID.make("cohort")
      const versionID = ProjectArtifact.VersionID.make("pav_cohort-project")
      const globalVersionID = ProjectArtifact.VersionID.make("pav_cohort-global")
      yield* seedProjectArtifact(db, { projectID, scopeID, artifactID, versionID })
      yield* seedGlobalArtifact(db, { scopeID: globalScopeID, artifactID, versionID: globalVersionID })
      yield* insertProject(db, otherProjectID)

      const candidateSessionID = Session.ID.make("ses_cohort_candidate")
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_cohort-candidate"),
          projectID,
          sessionID: candidateSessionID,
          scopeID,
          artifactID,
          versionID,
        }),
      )
      yield* accounting.observe(
        observeInput({ projectID, sessionID: candidateSessionID, terminalMessageID: "candidate", observedAt: now }),
      )
      const globalCandidateSessionID = Session.ID.make("ses_cohort_global_candidate")
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_cohort-global-candidate"),
          projectID,
          sessionID: globalCandidateSessionID,
          scopeID: globalScopeID,
          artifactID,
          versionID: globalVersionID,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: globalCandidateSessionID,
          terminalMessageID: "global-candidate",
          observedAt: now,
        }),
      )
      const standardCandidateSessionID = Session.ID.make("ses_cohort_candidate_standard")
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_cohort-candidate-standard"),
          projectID,
          sessionID: standardCandidateSessionID,
          scopeID,
          artifactID,
          versionID,
          boundarySeq: ProjectArtifact.Revision.make(2),
        }),
      )
      const standardCandidate = yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: standardCandidateSessionID,
          terminalMessageID: "candidate-standard",
          standardInvocationCount: ProjectArtifact.Revision.make(1),
          observedAt: now,
        }),
      )
      expect(standardCandidate[0]?.eligible).toBe(false)
      expect(standardCandidate[0]?.externalConfounded).toBe(true)
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_baseline"),
          terminalMessageID: "baseline",
          observedAt: now,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_boundary"),
          terminalMessageID: "boundary",
          observedAt: now - 30 * day,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_expired"),
          terminalMessageID: "expired",
          observedAt: now - 30 * day - 1,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_standard"),
          terminalMessageID: "standard",
          standardInvocationCount: ProjectArtifact.Revision.make(1),
          observedAt: now,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID: otherProjectID,
          sessionID: Session.ID.make("ses_cohort_other"),
          terminalMessageID: "other",
          observedAt: now,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_kind"),
          terminalMessageID: "kind",
          kind: "command",
          observedAt: now,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_agent"),
          terminalMessageID: "agent",
          agentID: Agent.ID.make("agent-b"),
          observedAt: now,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_model"),
          terminalMessageID: "model",
          modelID: "model-b",
          observedAt: now,
        }),
      )
      yield* accounting.observe(
        observeInput({
          projectID,
          sessionID: Session.ID.make("ses_cohort_goal"),
          terminalMessageID: "goal",
          goalMode: true,
          observedAt: now,
        }),
      )

      const project = yield* accounting.cohort({
        scope: { type: "project", projectID },
        versionID,
        kind: "skill",
        agentID,
        modelID: "model-a",
        goalMode: false,
        now,
      })
      expect(project.candidate).toEqual({ sampleCount: 1, successCount: 1 })
      expect(project.baseline).toEqual({ sampleCount: 2, successCount: 2 })
      expect(project.projectBuckets).toEqual([])

      const global = yield* accounting.cohort({
        scope: { type: "global" },
        versionID: globalVersionID,
        kind: "skill",
        agentID,
        modelID: "model-a",
        goalMode: false,
        now,
      })
      expect(global.candidate).toEqual({ sampleCount: 1, successCount: 1 })
      expect(global.baseline).toEqual({ sampleCount: 2, successCount: 2 })
      expect(global.projectBuckets).toHaveLength(1)
      expect(global.projectBuckets[0]?.bucketID).toBe(
        ProjectArtifactAccounting.projectBucket("private-test-key", projectID),
      )
      const serialized = JSON.stringify(global)
      expect(serialized).not.toContain(projectID)
      expect(serialized).not.toContain(globalCandidateSessionID)
    }),
  )

  serviceIt.effect("rejects mismatched project, global, project ID, and kind owners before cohort or mutation", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("owner-project")
      const wrongProjectID = Project.ID.make("owner-wrong-project")
      const projectScopeID = ProjectArtifact.ScopeID.make("pas_owner-project")
      const globalScopeID = ProjectArtifact.ScopeID.make("pas_owner-global")
      const artifactID = ProjectArtifact.ID.make("owner")
      const projectVersionID = ProjectArtifact.VersionID.make("pav_owner-project")
      const globalVersionID = ProjectArtifact.VersionID.make("pav_owner-global")
      yield* seedProjectArtifact(db, {
        projectID,
        scopeID: projectScopeID,
        artifactID,
        versionID: projectVersionID,
      })
      yield* insertProject(db, wrongProjectID)
      yield* seedGlobalArtifact(db, {
        scopeID: globalScopeID,
        artifactID,
        versionID: globalVersionID,
      })
      const sessionID = Session.ID.make("ses_owner_project")
      yield* accounting.activate(
        activation({
          id: ProjectArtifact.ActivationID.make("paa_owner-project"),
          projectID,
          sessionID,
          scopeID: projectScopeID,
          artifactID,
          versionID: projectVersionID,
        }),
      )
      yield* accounting.observe(observeInput({ projectID, sessionID, terminalMessageID: "owner" }))

      const common = { agentID, modelID: "model-a", goalMode: false, now: 8 * 86_400_000 }
      const mismatches = [
        { scope: { type: "global" as const }, versionID: projectVersionID, kind: "skill" as const, ...common },
        {
          scope: { type: "project" as const, projectID },
          versionID: globalVersionID,
          kind: "skill" as const,
          ...common,
        },
        {
          scope: { type: "project" as const, projectID: wrongProjectID },
          versionID: projectVersionID,
          kind: "skill" as const,
          ...common,
        },
        {
          scope: { type: "project" as const, projectID },
          versionID: projectVersionID,
          kind: "command" as const,
          ...common,
        },
      ]
      for (const mismatch of mismatches) {
        expect((yield* Effect.exit(accounting.cohort(mismatch)))._tag).toBe("Failure")
        expect((yield* Effect.exit(db.transaction((tx) => accounting.decideInTransaction(tx, mismatch))))._tag).toBe(
          "Failure",
        )
      }
      expect(
        yield* db.get<{
          first_qualified_at: number | null
          last_evaluated_at: number | null
          last_restored_at: number | null
          last_governor_transition_at: number | null
        }>(
          sql`SELECT first_qualified_at, last_evaluated_at, last_restored_at, last_governor_transition_at FROM project_artifact_version WHERE id = ${projectVersionID}`,
        ),
      ).toEqual({
        first_qualified_at: null,
        last_evaluated_at: null,
        last_restored_at: null,
        last_governor_transition_at: null,
      })

      const wrongFeedback = ProjectArtifact.Feedback.make({
        artifact: { scopeID: projectScopeID, kind: "command", id: artifactID, versionID: projectVersionID },
        action: "disable",
        actor: "user",
        timeCreated: ProjectArtifact.TimestampMillis.make(1),
      })
      expect(
        (yield* Effect.exit(db.transaction((tx) => accounting.feedbackInTransaction(tx, wrongFeedback))))._tag,
      ).toBe("Failure")
      expect(yield* db.select().from(ProjectArtifactFeedbackTable).all()).toEqual([])
    }),
  )

  serviceIt.effect("persists decision state through reset and exact 24-hour and restore cooldown boundaries", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const accounting = yield* ProjectArtifactAccounting.Service
      const day = 86_400_000
      const projectID = Project.ID.make("decision-project")
      const scopeID = ProjectArtifact.ScopeID.make("pas_decision-project")
      const artifactID = ProjectArtifact.ID.make("decision")
      const versionID = ProjectArtifact.VersionID.make("pav_decision-project")
      yield* seedProjectArtifact(db, { projectID, scopeID, artifactID, versionID })
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const sessionID = Session.ID.make(`ses_decision_${index}`)
            yield* accounting.activate(
              activation({
                id: ProjectArtifact.ActivationID.make(`paa_decision-${index}`),
                projectID,
                sessionID,
                scopeID,
                artifactID,
                versionID,
                boundarySeq: ProjectArtifact.Revision.make(index),
              }),
            )
            yield* accounting.observe(
              observeInput({ projectID, sessionID, terminalMessageID: `decision-${index}`, observedAt: 8 * day }),
            )
          }),
        { discard: true },
      )
      const input = {
        scope: { type: "project" as const, projectID },
        versionID,
        kind: "skill" as const,
        agentID,
        modelID: "model-a",
        goalMode: false,
      }
      const rolledBackFirst = yield* Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            expect((yield* accounting.decideInTransaction(tx, { ...input, now: 8 * day })).state).toEqual({
              firstQualifiedAt: 8 * day,
            })
            return yield* Effect.fail(new Error("rollback"))
          }),
        ),
      )
      expect(rolledBackFirst._tag).toBe("Failure")
      expect(
        yield* db.get<{
          first_qualified_at: number | null
          last_evaluated_at: number | null
          last_restored_at: number | null
          last_governor_transition_at: number | null
        }>(
          sql`SELECT first_qualified_at, last_evaluated_at, last_restored_at, last_governor_transition_at FROM project_artifact_version WHERE id = ${versionID}`,
        ),
      ).toEqual({
        first_qualified_at: null,
        last_evaluated_at: null,
        last_restored_at: null,
        last_governor_transition_at: null,
      })

      expect((yield* accounting.decide({ ...input, now: 8 * day })).state).toEqual({ firstQualifiedAt: 8 * day })
      expect(
        (yield* db.get<{ first_qualified_at: number | null; last_evaluated_at: number | null }>(
          sql`SELECT first_qualified_at, last_evaluated_at FROM project_artifact_version WHERE id = ${versionID}`,
        ))?.first_qualified_at,
      ).toBe(8 * day)
      expect((yield* accounting.decide({ ...input, now: 9 * day, explicitNegative: true })).state).toEqual({
        firstQualifiedAt: null,
      })
      expect(
        (yield* db.transaction((tx) => accounting.decideInTransaction(tx, { ...input, now: 10 * day }))).state,
      ).toEqual({ firstQualifiedAt: 10 * day })
      expect(
        (yield* db.transaction((tx) => accounting.decideInTransaction(tx, { ...input, now: 11 * day - 1 }))).action,
      ).toBe("none")

      const rolledBackAction = yield* Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const result = yield* accounting.decideInTransaction(tx, { ...input, now: 11 * day })
            expect(result.action).toBe("activate")
            yield* tx
              .update(ProjectArtifactTable)
              .set({ stage: "active" })
              .where(eq(ProjectArtifactTable.scope_id, scopeID))
              .run()
            yield* tx
              .update(ProjectArtifactVersionTable)
              .set({ state: "active", time_state_changed: ProjectArtifact.TimestampMillis.make(11 * day) })
              .where(eq(ProjectArtifactVersionTable.id, versionID))
              .run()
            return yield* Effect.fail(new Error("rollback"))
          }),
        ),
      )
      expect(rolledBackAction._tag).toBe("Failure")
      expect(
        yield* db.get<{ first_qualified_at: number | null; last_governor_transition_at: number | null }>(
          sql`SELECT first_qualified_at, last_governor_transition_at FROM project_artifact_version WHERE id = ${versionID}`,
        ),
      ).toEqual({ first_qualified_at: 10 * day, last_governor_transition_at: null })

      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const result = yield* accounting.decideInTransaction(tx, { ...input, now: 11 * day })
          expect(result.action).toBe("activate")
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "active" })
            .where(eq(ProjectArtifactTable.scope_id, scopeID))
            .run()
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "active", time_state_changed: ProjectArtifact.TimestampMillis.make(11 * day) })
            .where(eq(ProjectArtifactVersionTable.id, versionID))
            .run()
        }),
      )
      expect(
        yield* db.get<{ stage: string; last_governor_transition_at: number | null }>(
          sql`SELECT a.stage, v.last_governor_transition_at FROM project_artifact a JOIN project_artifact_version v ON v.id = a.current_version_id WHERE v.id = ${versionID}`,
        ),
      ).toEqual({ stage: "active", last_governor_transition_at: 11 * day })

      const restored = ProjectArtifact.Feedback.make({
        artifact: { scopeID, kind: "skill", id: artifactID, versionID },
        action: "restore",
        actor: "user",
        timeCreated: ProjectArtifact.TimestampMillis.make(12 * day),
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* accounting.feedbackInTransaction(tx, restored)
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "trial" })
            .where(eq(ProjectArtifactTable.scope_id, scopeID))
            .run()
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "trial", time_state_changed: ProjectArtifact.TimestampMillis.make(12 * day) })
            .where(eq(ProjectArtifactVersionTable.id, versionID))
            .run()
        }),
      )
      expect(
        (yield* db.transaction((tx) => accounting.decideInTransaction(tx, { ...input, now: 19 * day - 1 }))).state,
      ).toEqual({ firstQualifiedAt: null })
      expect(
        (yield* db.transaction((tx) => accounting.decideInTransaction(tx, { ...input, now: 19 * day }))).state,
      ).toEqual({ firstQualifiedAt: 19 * day })
      expect((yield* Effect.exit(accounting.decide({ ...input, now: 20 * day })))._tag).toBe("Failure")
      expect(
        yield* db.get<{
          stage: string
          state: string
          first_qualified_at: number | null
          last_evaluated_at: number | null
          last_restored_at: number | null
          last_governor_transition_at: number | null
        }>(
          sql`SELECT a.stage, v.state, v.first_qualified_at, v.last_evaluated_at, v.last_restored_at, v.last_governor_transition_at FROM project_artifact a JOIN project_artifact_version v ON v.id = a.current_version_id WHERE v.id = ${versionID}`,
        ),
      ).toEqual({
        stage: "trial",
        state: "trial",
        first_qualified_at: 19 * day,
        last_evaluated_at: 19 * day,
        last_restored_at: 12 * day,
        last_governor_transition_at: 11 * day,
      })

      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const result = yield* accounting.decideInTransaction(tx, { ...input, now: 20 * day })
          expect(result.action).toBe("activate")
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "active" })
            .where(eq(ProjectArtifactTable.scope_id, scopeID))
            .run()
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "active", time_state_changed: ProjectArtifact.TimestampMillis.make(20 * day) })
            .where(eq(ProjectArtifactVersionTable.id, versionID))
            .run()
        }),
      )
      expect(
        yield* db.get<{
          stage: string
          state: string
          first_qualified_at: number | null
          last_evaluated_at: number | null
          last_restored_at: number | null
          last_governor_transition_at: number | null
        }>(
          sql`SELECT a.stage, v.state, v.first_qualified_at, v.last_evaluated_at, v.last_restored_at, v.last_governor_transition_at FROM project_artifact a JOIN project_artifact_version v ON v.id = a.current_version_id WHERE v.id = ${versionID}`,
        ),
      ).toEqual({
        stage: "active",
        state: "active",
        first_qualified_at: null,
        last_evaluated_at: 20 * day,
        last_restored_at: 12 * day,
        last_governor_transition_at: 20 * day,
      })
    }),
  )
})

const digest = ProjectArtifact.Digest.make("a".repeat(64))
const agentID = Agent.ID.make("agent-a")
const packageRoot = path.resolve(import.meta.dir, "..")
let generatedSql: Promise<string> | undefined

interface ActivationInput {
  readonly id: ProjectArtifact.ActivationID
  readonly projectID: Project.ID
  readonly sessionID?: Session.ID
  readonly scopeID: ProjectArtifact.ScopeID
  readonly artifactID: ProjectArtifact.ID
  readonly versionID: ProjectArtifact.VersionID
  readonly boundarySeq?: ProjectArtifact.Revision
}

function activation(input: ActivationInput) {
  return ProjectArtifact.Activation.make({
    id: input.id,
    artifact: {
      scopeID: input.scopeID,
      kind: "skill",
      id: input.artifactID,
      versionID: input.versionID,
    },
    projectID: input.projectID,
    sessionID: input.sessionID,
    source: "skill-tool",
    boundarySeq: input.boundarySeq ?? ProjectArtifact.Revision.make(1),
    activatedAt: ProjectArtifact.TimestampMillis.make(1),
  })
}

function observeInput(input: {
  readonly projectID: Project.ID
  readonly sessionID: Session.ID
  readonly terminalMessageID?: string
  readonly boundarySeq?: ProjectArtifact.Revision
  readonly kind?: ProjectArtifact.Kind
  readonly agentID?: Agent.ID
  readonly modelID?: string
  readonly goalMode?: boolean
  readonly standardInvocationCount?: ProjectArtifact.Revision
  readonly observedAt?: number
}): ProjectArtifactAccounting.ObserveInput {
  return {
    projectID: input.projectID,
    sessionID: input.sessionID,
    terminalMessageID: input.terminalMessageID,
    boundarySeq: input.boundarySeq ?? ProjectArtifact.Revision.make(1),
    kind: input.kind ?? "skill",
    agentID: input.agentID ?? agentID,
    modelID: input.modelID ?? "model-a",
    goalMode: input.goalMode ?? false,
    standardInvocationCount: input.standardInvocationCount ?? ProjectArtifact.Revision.make(0),
    externalConfounded: false,
    terminalOutcome: "succeeded",
    goalStatus: "completed",
    repeatFix: false,
    observedAt: ProjectArtifact.TimestampMillis.make(input.observedAt ?? 2),
  }
}

function insertProject(db: Database.Interface["db"], projectID: Project.ID) {
  return db.run(
    sql`INSERT INTO ${ProjectTable} (id, worktree, time_created, time_updated, sandboxes) VALUES (${projectID}, ${`/tmp/${projectID}`}, 0, 0, '[]')`,
  )
}

function seedProjectArtifact(
  db: Database.Interface["db"],
  input: {
    readonly projectID: Project.ID
    readonly scopeID: ProjectArtifact.ScopeID
    readonly artifactID: ProjectArtifact.ID
    readonly versionID: ProjectArtifact.VersionID
  },
) {
  return Effect.gen(function* () {
    yield* insertProject(db, input.projectID)
    yield* db
      .insert(ProjectArtifactScopeTable)
      .values({
        id: input.scopeID,
        type: "project",
        storage_id: storageID(input.scopeID),
        time_created: ProjectArtifact.TimestampMillis.make(0),
        time_updated: ProjectArtifact.TimestampMillis.make(0),
      })
      .run()
    yield* db
      .insert(ProjectArtifactProjectScopeTable)
      .values({ scope_id: input.scopeID, project_id: input.projectID })
      .run()
    yield* seedArtifact(db, input)
  })
}

function seedGlobalArtifact(
  db: Database.Interface["db"],
  input: {
    readonly scopeID: ProjectArtifact.ScopeID
    readonly artifactID: ProjectArtifact.ID
    readonly versionID: ProjectArtifact.VersionID
  },
) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectArtifactScopeTable)
      .values({
        id: input.scopeID,
        type: "global",
        storage_id: storageID(input.scopeID),
        time_created: ProjectArtifact.TimestampMillis.make(0),
        time_updated: ProjectArtifact.TimestampMillis.make(0),
      })
      .run()
    yield* db.insert(ProjectArtifactGlobalScopeTable).values({ scope_id: input.scopeID, singleton: 1 }).run()
    yield* seedArtifact(db, input)
  })
}

function seedArtifact(
  db: Database.Interface["db"],
  input: {
    readonly scopeID: ProjectArtifact.ScopeID
    readonly artifactID: ProjectArtifact.ID
    readonly versionID: ProjectArtifact.VersionID
  },
) {
  return db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.run(sql.raw("PRAGMA defer_foreign_keys = ON"))
      yield* tx
        .insert(ProjectArtifactTable)
        .values({
          scope_id: input.scopeID,
          kind: "skill",
          artifact_id: input.artifactID,
          revision: ProjectArtifact.Revision.make(0),
          stage: "trial",
          current_version_id: input.versionID,
          time_created: ProjectArtifact.TimestampMillis.make(0),
          time_updated: ProjectArtifact.TimestampMillis.make(0),
        })
        .run()
      yield* tx
        .insert(ProjectArtifactVersionTable)
        .values({
          id: input.versionID,
          scope_id: input.scopeID,
          kind: "skill",
          artifact_id: input.artifactID,
          state: "trial",
          content_digest: digest,
          content_relpath: ProjectArtifact.ContentRelpath.make("SKILL.md"),
          source: "user",
          time_created: ProjectArtifact.TimestampMillis.make(0),
          time_state_changed: ProjectArtifact.TimestampMillis.make(0),
        })
        .run()
    }),
  )
}

function storageID(scopeID: ProjectArtifact.ScopeID) {
  const hash = new Bun.CryptoHasher("sha256").update(scopeID).digest("hex")
  return ProjectArtifact.StorageID.make(
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
  )
}

function productionSql() {
  generatedSql ??= generateProductionSql()
  return generatedSql
}

async function generateProductionSql() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-artifact-accounting-schema-"))
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
