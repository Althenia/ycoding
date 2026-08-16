import { afterAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import { mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { Project } from "@ycoding-ai/schema/project"
import { Session } from "@ycoding-ai/schema/session"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactPackage } from "@ycoding-ai/core/project-artifact/package"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { ProjectArtifactStandardSourceRegistry } from "@ycoding-ai/core/project-artifact/source-registry"
import {
  ProjectArtifactProjectScopeTable,
  ProjectArtifactScopeTable,
  ProjectArtifactOperationTable,
  ProjectArtifactTable,
  ProjectArtifactVersionTable,
  ProjectArtifactWriteTable,
} from "@ycoding-ai/core/project-artifact/sql"
import { Database } from "@ycoding-ai/core/database/database"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { Global } from "@ycoding-ai/core/global"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { EffectFlock } from "@ycoding-ai/core/util/effect-flock"
import { testEffect } from "./lib/effect"

const root = mkdtempSync(path.join(os.tmpdir(), "project-artifact-store-"))
const layer = LayerNode.compile(
  LayerNode.group([
    ProjectArtifactStore.node,
    ProjectArtifactAccounting.node,
    ProjectArtifactStandardSourceRegistry.registryNode,
    Database.node,
    EffectFlock.node,
    Global.node,
  ]),
  [
  [
    Global.node,
    Global.layerWith({
      data: path.join(root, "data"),
      state: path.join(root, "state"),
      config: path.join(root, "config"),
      home: path.join(root, "home"),
    }),
  ],
  ],
)
const it = testEffect(layer)

const reconcileRoot = mkdtempSync(path.join(os.tmpdir(), "project-artifact-reconcile-"))
const reconcileScanned = Promise.withResolvers<void>()
const releaseReconcile = Promise.withResolvers<void>()
const reconcileNode = makeGlobalNode({
  service: ProjectArtifactStore.Service,
  layer: ProjectArtifactStore.layerWith(undefined, {
    afterReconcileScan: () =>
      Effect.promise(async () => {
        reconcileScanned.resolve()
        await releaseReconcile.promise
      }),
  }),
  deps: [
    Database.node,
    Global.node,
    EffectFlock.node,
    ProjectArtifactAccounting.node,
    ProjectArtifactStandardSourceRegistry.registryNode,
  ],
})
const reconcileLayer = LayerNode.compile(
  LayerNode.group([reconcileNode, Database.node]),
  [[
    Global.node,
    Global.layerWith({
      data: path.join(reconcileRoot, "data"),
      state: path.join(reconcileRoot, "state"),
      config: path.join(reconcileRoot, "config"),
      home: path.join(reconcileRoot, "home"),
    }),
  ]],
)
const reconcileIt = testEffect(reconcileLayer)

afterAll(() => Promise.all([
  fs.rm(root, { recursive: true, force: true }),
  fs.rm(reconcileRoot, { recursive: true, force: true }),
]))

describe("ProjectArtifactStore scope and automatic writes", () => {
  it.live("restores a missing project scope marker before a subsequent automatic write", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-missing-scope-marker")
      yield* insertProject(projectID)
      const first = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_missing_scope_marker_first"),
        insightKey: "missing-scope-marker-first",
        id: "missing-scope-marker-first",
        definition: skillDefinition("missing-scope-marker-first"),
        now: 10_000,
      })
      const scope = yield* store.resolveProjectScope(projectID)
      const marker = ProjectArtifactPackage.scopeMarkerPath(
        path.join(root, "data", "project-artifacts", scope.storageID),
      )
      yield* Effect.promise(() => fs.rm(marker))

      const second = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_missing_scope_marker_second"),
        insightKey: "missing-scope-marker-second",
        id: "missing-scope-marker-second",
        definition: skillDefinition("missing-scope-marker-second"),
        now: 10_001,
      })

      expect(first.result).toBe("created")
      expect(second.result).toBe("created")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
    }),
  )

  it.live("preserves a conflicting project scope marker and rejects the write", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-conflicting-scope-marker")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      const marker = ProjectArtifactPackage.scopeMarkerPath(
        path.join(root, "data", "project-artifacts", scope.storageID),
      )
      const conflicting = JSON.stringify({
        schema: 1,
        scopeID: scope.id,
        type: "project",
        storageID: "00000000-0000-4000-8000-000000000000",
      })
      yield* Effect.promise(() => fs.writeFile(marker, conflicting))

      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID: Session.ID.make("ses_conflicting_scope_marker"),
              insightKey: "conflicting-scope-marker",
              id: "conflicting-scope-marker",
              definition: skillDefinition("conflicting-scope-marker"),
              now: 10_100,
            }),
          )
        ).code,
      ).toBe("OwnershipMismatch")
      expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe(conflicting)
    }),
  )

  it.live("restores project and global scope markers from their database rows", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-restored-scope-marker-content")
      yield* insertProject(projectID)
      const project = yield* store.resolveProjectScope(projectID)
      const global = yield* store.resolveGlobalScope()
      const scopes = [project, global]
      yield* Effect.forEach(
        scopes,
        (scope) => Effect.promise(() => fs.rm(ProjectArtifactPackage.scopeMarkerPath(path.join(root, "data", "project-artifacts", scope.storageID)))),
        { discard: true },
      )

      const restoredProject = yield* store.resolveProjectScope(projectID)
      const restoredGlobal = yield* store.resolveGlobalScope()
      yield* Effect.forEach(
        [restoredProject, restoredGlobal],
        (scope) =>
          Effect.gen(function* () {
            const row = yield* db
              .select({ id: ProjectArtifactScopeTable.id, type: ProjectArtifactScopeTable.type, storageID: ProjectArtifactScopeTable.storage_id })
              .from(ProjectArtifactScopeTable)
              .where(eq(ProjectArtifactScopeTable.id, scope.id))
              .get()
            expect(row).toBeDefined()
            expect(
              JSON.parse(
                yield* Effect.promise(() =>
                  fs.readFile(ProjectArtifactPackage.scopeMarkerPath(path.join(root, "data", "project-artifacts", scope.storageID)), "utf8"),
                ),
              ),
            ).toEqual({ schema: 1, scopeID: row?.id, type: row?.type, storageID: row?.storageID })
          }),
        { discard: true },
      )
    }),
  )

  it.live("shares scope across locations, rejects global, and adopts without moving storage", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const previous = Project.ID.make("project-previous")
      const current = Project.ID.make("project-current")
      yield* insertProject(previous)
      yield* insertProject(current)

      const first = yield* store.resolveProjectScope(previous)
      const linked = yield* store.resolveProjectScope(previous)
      expect(linked).toEqual(first)
      expect((yield* Effect.flip(store.resolveProjectScope(Project.ID.global))).code).toBe("ProjectIdentityUnavailable")

      const adoption = yield* db.transaction((tx) => store.adoptProject({ previousProjectID: previous, projectID: current }, tx))
      expect(adoption.scope.storageID).toBe(first.storageID)
      yield* adoption.postCommit
      expect((yield* store.resolveProjectScope(current)).storageID).toBe(first.storageID)
    }),
  )

  it.live("defers cyclic artifact-version ownership for every pair-creation path", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-deferred-ownership")
      yield* insertProject(projectID)

      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_deferred_create"),
        insightKey: "deferred-create",
        id: "deferred-create",
        definition: skillDefinition("deferred-create"),
        now: 100_000,
      })
      const updated = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_deferred_update"),
        insightKey: "deferred-update",
        id: "deferred-create",
        definition: skillDefinition("deferred-update"),
        baseVersionID: created.versionID,
        now: 3_700_000,
      })
      expect(updated.versionID).not.toBe(created.versionID)

      const scope = yield* store.resolveProjectScope(projectID)
      const reconciledMarker = ProjectArtifactPackage.marker({
        scopeID: scope.id,
        storageID: scope.storageID,
        kind: "command",
        id: ProjectArtifact.ID.make("deferred-reconcile"),
        versionID: ProjectArtifact.VersionID.make("pav_deferred-reconcile"),
        content: "---\nname: Deferred reconcile\ndescription: Reconciles a cyclic owner pair\n---\nReconcile.",
      })
      yield* ProjectArtifactPackage.commit({
        root: path.join(root, "data", "project-artifacts", scope.storageID),
        marker: reconciledMarker,
        content: "---\nname: Deferred reconcile\ndescription: Reconciles a cyclic owner pair\n---\nReconcile.",
      })
      yield* store.reconcile(scope.id)
      expect(
        (
          yield* store.get({
            scope: { type: "project" },
            projectID,
            kind: reconciledMarker.kind,
            id: reconciledMarker.id,
          })
        ).currentVersion.id,
      ).toBe(reconciledMarker.versionID)

      const promotionSource = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_deferred_promotion"),
        insightKey: "deferred-promotion",
        id: "deferred-promotion",
        definition: skillDefinition("deferred-promotion"),
        now: 4_000_000,
      })
      const promotion = yield* store.previewPromotion({
        projectID,
        kind: promotionSource.kind,
        id: promotionSource.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: promotionSource.versionID,
        expectedDigest: promotionSource.contentDigest,
        now: 4_000_001,
      })
      const promoted = yield* store.confirmPromotion(promotion.token, 4_000_002)
      expect(promoted.scopeID).not.toBe(promotionSource.scopeID)

      const globalPreview = yield* store.previewManual({
        id: "deferred-fork",
        definition: skillDefinition("deferred-fork"),
        now: 4_000_003,
      })
      const globalArtifact = yield* store.confirmManual(globalPreview.token, 4_000_004)
      yield* registerSources("deferred-fork", [managedGlobalSource(globalArtifact)])
      const forkPreview = yield* store.previewFork({
        projectID,
        kind: globalArtifact.kind,
        id: globalArtifact.id,
        expectedVersionID: globalArtifact.versionID,
        expectedDigest: globalArtifact.contentDigest,
        now: 4_000_005,
      })
      const forked = yield* store.confirmFork(forkPreview.token, 4_000_006)
      expect(forked.scopeID).toBe(scope.id)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    }),
  )

  it.live("reconciles exact retries and enforces session rate and optimistic updates", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-write")
      yield* insertProject(projectID)
      const sessionID = Session.ID.make("ses_project_artifact")
      const input = {
        projectID,
        sessionID,
        insightKey: "focused-core-tests",
        id: "focused-core-tests",
        definition: {
          kind: "skill" as const,
          name: "Focused Core tests",
          description: "Run focused Core tests",
          content: "Run the focused Core package tests before broad checks.",
        },
        now: 1_000_000,
      }
      const created = yield* store.writeAutomatic(input)
      expect((yield* store.writeAutomatic(input))).toEqual(created)

      const updatedInput = {
        ...input,
        insightKey: "focused-core-tests-update",
        definition: { ...input.definition, content: "Run focused Core tests before broader package checks." },
        baseVersionID: created.versionID,
        now: input.now + 3_600_000,
      }
      const outcomes = yield* Effect.all(
        [store.writeAutomatic(updatedInput), store.writeAutomatic({ ...updatedInput, insightKey: "competing-update" })].map(
          (effect) => effect.pipe(Effect.as("ok" as const), Effect.catch((error) => Effect.succeed(error.code))),
        ),
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(1)
      expect(outcomes).toContain("VersionConflict")
    }),
  )

  it.live("enforces three successful automatic writes per session without charging reconciliation", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-rate")
      const sessionID = Session.ID.make("ses_project_rate")
      yield* insertProject(projectID)
      const write = (index: number) =>
        store.writeAutomatic({
          projectID,
          sessionID,
          insightKey: `insight-${index}`,
          id: `artifact-${index}`,
          definition: {
            kind: "skill",
            name: `Artifact ${index}`,
            description: "Reusable focused guidance",
            content: `Prefer focused check number ${index}.`,
          },
          now: 2_000_000 + index,
        })
      const first = yield* write(1)
      expect((yield* write(1)).versionID).toBe(first.versionID)
      yield* write(2)
      yield* write(3)
      expect((yield* Effect.flip(write(4))).code).toBe("WriteRateExceeded")
    }),
  )

  it.live("rechecks promotion collision and leaves the project source unchanged", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-promotion-collision")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_promotion_collision"),
        insightKey: "promotion-collision",
        id: "promotion-collision",
        definition: {
          kind: "skill",
          name: "Promotion collision",
          description: "Tests promotion collision handling",
          content: "Retain the project source after a destination collision.",
        },
        now: 3_000_000,
      })
      const preview = yield* store.previewPromotion({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("promotion-collision"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 3_000_001,
      })
      const destination = path.join(root, "home", ".agents", "skills", "promotion-collision", "SKILL.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, "user-owned")
      })
      expect((yield* Effect.flip(store.confirmPromotion(preview.token, 3_000_002))).code).toBe("DestinationExists")
      const scope = yield* store.resolveProjectScope(projectID)
      expect(
        yield* Effect.promise(() =>
          fs.readFile(
            ProjectArtifactPackage.activeContentPath(
              path.join(root, "data", "project-artifacts", scope.storageID),
              "skill",
              "promotion-collision",
            ),
            "utf8",
          ),
        ),
      ).toContain("Retain the project source")
    }),
  )

  it.live("restores the exact project digest before the 30-day boundary", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-trash")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_trash"),
        insightKey: "trash-restore",
        id: "trash-restore",
        definition: {
          kind: "command",
          name: "Trash restore",
          description: "Tests exact restoration",
          template: "Restore the owned command exactly.",
          subtask: false,
        },
        now: 4_000_000,
      })
      const scope = yield* store.resolveProjectScope(projectID)
      const trash = yield* store.remove({
        scopeID: scope.id,
        kind: "command",
        id: ProjectArtifact.ID.make("trash-restore"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 4_000_001,
      })
      yield* store.restore(trash.deletionID, trash.deletedAt + 29 * 86_400_000)
      const restored = yield* Effect.promise(() =>
        fs.readFile(
          ProjectArtifactPackage.activeContentPath(
            path.join(root, "data", "project-artifacts", scope.storageID),
            "command",
            "trash-restore",
          ),
          "utf8",
        ),
      )
      expect(ProjectArtifact.Digest.make(new Bun.CryptoHasher("sha256").update(restored).digest("hex"))).toBe(
        created.contentDigest,
      )
    }),
  )

  it.live("promotes an independent global snapshot with a single-use token", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-promotion-snapshot")
      yield* insertProject(projectID)
      const initial = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_promotion_snapshot"),
        insightKey: "promotion-snapshot",
        id: "promotion-snapshot",
        definition: {
          kind: "skill",
          name: "Promotion snapshot",
          description: "Tests independent global snapshots",
          content: "Original project guidance.",
        },
        now: 5_000_000,
      })
      const preview = yield* store.previewPromotion({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("promotion-snapshot"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: initial.versionID,
        expectedDigest: initial.contentDigest,
        now: 5_000_001,
      })
      const promoted = yield* store.confirmPromotion(preview.token, 5_000_002)
      expect((yield* Effect.flip(store.confirmPromotion(preview.token, 5_000_003))).code).toBe("ConfirmationExpired")
      yield* registerSources("promotion-snapshot", [managedGlobalSource(promoted)])
      const destination = path.join(root, "home", ".agents", "skills", "promotion-snapshot", "SKILL.md")
      const before = yield* Effect.promise(() => fs.readFile(destination, "utf8"))
      yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_promotion_update"),
        insightKey: "promotion-snapshot-update",
        id: "promotion-snapshot",
        definition: {
          kind: "skill",
          name: "Promotion snapshot",
          description: "Tests independent global snapshots",
          content: "Updated project guidance.",
        },
        baseVersionID: initial.versionID,
        now: 5_000_000 + 3_600_000,
      })
      expect(yield* Effect.promise(() => fs.readFile(destination, "utf8"))).toBe(before)
    }),
  )

  it.live("reports persisted accounting metrics in promotion previews", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("project-promotion-metrics")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_promotion_metrics"),
        insightKey: "promotion-metrics",
        id: "promotion-metrics",
        definition: skillDefinition("promotion-metrics"),
        now: 5_500_000,
      })
      const feedback = ProjectArtifact.Feedback.make({
        artifact: {
          scopeID: created.scopeID,
          kind: created.kind,
          id: created.id,
          versionID: created.versionID,
        },
        action: "disable",
        actor: "user",
        timeCreated: ProjectArtifact.TimestampMillis.make(5_500_001),
      })
      const feedbackID = yield* accounting.feedback(feedback)
      expect(yield* accounting.feedback(feedback)).toBe(feedbackID)

      const preview = yield* store.previewPromotion({
        projectID,
        kind: "skill",
        id: created.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 5_500_002,
      })
      expect(preview.metrics.penaltyUnits).toBe(4)
      expect(preview.metrics.score).toBeLessThan(0)
    }),
  )

  it.live("atomically activates a qualified trial on the exact second governor evaluation", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("project-governor-activation")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_governor_create"),
        insightKey: "governor-activation",
        id: "governor-activation",
        definition: skillDefinition("governor-activation"),
        now: 1,
      })
      for (const index of Array.from({ length: 20 }, (_, index) => index)) {
        const sessionID = Session.ID.make(`ses_governor_${index}`)
        const boundarySeq = ProjectArtifact.Revision.make(index + 1)
        yield* accounting.activate(
          ProjectArtifact.Activation.make({
            id: ProjectArtifact.ActivationID.make(`paa_governor-${index}`),
            artifact: {
              scopeID: created.scopeID,
              kind: created.kind,
              id: created.id,
              versionID: created.versionID,
            },
            projectID,
            sessionID,
            source: "skill-tool",
            boundarySeq,
            activatedAt: ProjectArtifact.TimestampMillis.make(1_000 + index),
          }),
        )
        yield* accounting.observe({
          projectID,
          sessionID,
          terminalMessageID: `governor-${index}`,
          boundarySeq,
          kind: "skill",
          modelID: "model-governor",
          goalMode: false,
          standardInvocationCount: ProjectArtifact.Revision.make(0),
          externalConfounded: false,
          terminalOutcome: "succeeded",
          goalStatus: "completed",
          repeatFix: false,
          observedAt: ProjectArtifact.TimestampMillis.make(8 * 86_400_000 - index),
        })
      }
      const input = {
        scopeID: created.scopeID,
        kind: created.kind,
        id: created.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        modelID: "model-governor",
        goalMode: false,
      }
      const first = yield* store.evaluateGovernor({ ...input, now: 8 * 86_400_000 })
      expect(first.action).toBe("none")
      expect(
        (
          yield* db
            .select({ firstQualifiedAt: ProjectArtifactVersionTable.first_qualified_at })
            .from(ProjectArtifactVersionTable)
            .where(eq(ProjectArtifactVersionTable.id, created.versionID))
            .get()
        )?.firstQualifiedAt,
      ).toBe(8 * 86_400_000)
      expect((yield* store.evaluateGovernor({ ...input, now: 9 * 86_400_000 - 1 })).action).toBe("none")
      expect((yield* store.evaluateGovernor({ ...input, now: 9 * 86_400_000 })).action).toBe("activate")
      const activated = yield* store.get({
        scope: { type: "project" },
        projectID,
        kind: created.kind,
        id: created.id,
      })
      expect(activated.artifact.stage).toBe("active")
      expect(activated.currentVersion.state).toBe("active")
    }),
  )

  it.live("atomically degrades an active version on the exact second governor evaluation", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("project-governor-degradation")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_governor_degrade_create"),
        insightKey: "governor-degradation",
        id: "governor-degradation",
        definition: skillDefinition("governor-degradation"),
        now: 1,
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "active" })
            .where(eq(ProjectArtifactTable.scope_id, created.scopeID))
            .run()
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "active", time_state_changed: 1 })
            .where(eq(ProjectArtifactVersionTable.id, created.versionID))
            .run()
        }),
      )
      for (const index of Array.from({ length: 20 }, (_, index) => index)) {
        const sessionID = Session.ID.make(`ses_governor_degrade_${index}`)
        const boundarySeq = ProjectArtifact.Revision.make(index + 1)
        yield* accounting.activate(
          ProjectArtifact.Activation.make({
            id: ProjectArtifact.ActivationID.make(`paa_governor-degrade-${index}`),
            artifact: {
              scopeID: created.scopeID,
              kind: created.kind,
              id: created.id,
              versionID: created.versionID,
            },
            projectID,
            sessionID,
            source: "skill-tool",
            boundarySeq,
            activatedAt: ProjectArtifact.TimestampMillis.make(2_000 + index),
          }),
        )
        yield* accounting.observe({
          projectID,
          sessionID,
          terminalMessageID: `governor-degrade-${index}`,
          boundarySeq,
          kind: "skill",
          modelID: "model-governor-degrade",
          goalMode: false,
          standardInvocationCount: ProjectArtifact.Revision.make(0),
          externalConfounded: false,
          terminalOutcome: "failed",
          goalStatus: "exhausted",
          repeatFix: false,
          observedAt: ProjectArtifact.TimestampMillis.make(8 * 86_400_000 - index),
        })
      }
      for (const index of Array.from({ length: 30 }, (_, index) => index)) {
        yield* accounting.observe({
          projectID,
          sessionID: Session.ID.make(`ses_governor_baseline_${index}`),
          terminalMessageID: `governor-baseline-${index}`,
          boundarySeq: ProjectArtifact.Revision.make(index + 100),
          kind: "skill",
          modelID: "model-governor-degrade",
          goalMode: false,
          standardInvocationCount: ProjectArtifact.Revision.make(0),
          externalConfounded: false,
          terminalOutcome: "succeeded",
          goalStatus: "completed",
          repeatFix: false,
          observedAt: ProjectArtifact.TimestampMillis.make(8 * 86_400_000 - index),
        })
      }
      const input = {
        scopeID: created.scopeID,
        kind: created.kind,
        id: created.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        modelID: "model-governor-degrade",
        goalMode: false,
      }
      expect((yield* store.evaluateGovernor({ ...input, now: 8 * 86_400_000 })).action).toBe("none")
      expect((yield* store.evaluateGovernor({ ...input, now: 9 * 86_400_000 })).action).toBe("degrade")
      const degraded = yield* store.get({
        scope: { type: "project" },
        projectID,
        kind: created.kind,
        id: created.id,
      })
      expect(degraded.artifact).toEqual(expect.objectContaining({ revision: 1, stage: "degraded" }))
      expect(degraded.currentVersion).toEqual(
        expect.objectContaining({ state: "degraded", timeStateChanged: 9 * 86_400_000 }),
      )
    }),
  )

  it.live("atomically rolls governor degradation back to the durable fallback", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("project-governor-fallback")
      yield* insertProject(projectID)
      const first = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_governor_fallback_first"),
        insightKey: "governor-fallback-first",
        id: "governor-fallback",
        definition: skillDefinition("governor-fallback-first"),
        now: 1,
      })
      const second = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_governor_fallback_second"),
        insightKey: "governor-fallback-second",
        id: "governor-fallback",
        definition: skillDefinition("governor-fallback-second"),
        baseVersionID: first.versionID,
        now: 3_600_001,
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "active" })
            .where(eq(ProjectArtifactTable.scope_id, second.scopeID))
            .run()
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "active", time_state_changed: 3_600_001 })
            .where(eq(ProjectArtifactVersionTable.id, second.versionID))
            .run()
        }),
      )
      yield* recordGovernorDegradation(accounting, second, projectID, "fallback", "model-governor-fallback")
      const input = {
        scopeID: second.scopeID,
        kind: second.kind,
        id: second.id,
        expectedRevision: ProjectArtifact.Revision.make(1),
        expectedVersionID: second.versionID,
        expectedDigest: second.contentDigest,
        modelID: "model-governor-fallback",
        goalMode: false,
      }
      expect((yield* store.evaluateGovernor({ ...input, now: 8 * 86_400_000 })).action).toBe("none")
      expect((yield* store.evaluateGovernor({ ...input, now: 9 * 86_400_000 })).action).toBe("degrade")
      const degraded = yield* store.get({
        scope: { type: "project" },
        projectID,
        kind: second.kind,
        id: second.id,
      })
      expect(degraded.artifact).toEqual(expect.objectContaining({ revision: 2, stage: "active" }))
      expect(degraded.currentVersion.id).toBe(first.versionID)
      expect(degraded.versions.find((version) => version.id === second.versionID)?.state).toBe("degraded")
      const scope = yield* store.resolveProjectScope(projectID)
      expect(
        yield* Effect.promise(() =>
          Bun.file(
            ProjectArtifactPackage.activeContentPath(
              path.join(root, "data", "project-artifacts", scope.storageID),
              second.kind,
              second.id,
            ),
          ).text(),
        ),
      ).toContain("governor-fallback-first")
    }),
  )

  it.live("recovers a governor disable journal before atomically finalizing degradation", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const accounting = yield* ProjectArtifactAccounting.Service
      const projectID = Project.ID.make("project-governor-restart")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_governor_restart_create"),
        insightKey: "governor-restart",
        id: "governor-restart",
        definition: skillDefinition("governor-restart"),
        now: 1,
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(ProjectArtifactTable)
            .set({ stage: "active" })
            .where(eq(ProjectArtifactTable.scope_id, created.scopeID))
            .run()
          yield* tx
            .update(ProjectArtifactVersionTable)
            .set({ state: "active", time_state_changed: 1 })
            .where(eq(ProjectArtifactVersionTable.id, created.versionID))
            .run()
        }),
      )
      yield* recordGovernorDegradation(accounting, created, projectID, "restart", "model-governor-restart")
      const input = {
        scopeID: created.scopeID,
        kind: created.kind,
        id: created.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        modelID: "model-governor-restart",
        goalMode: false,
      }
      expect((yield* store.evaluateGovernor({ ...input, now: 8 * 86_400_000 })).action).toBe("none")
      const operationID = "pop_governor-restart"
      const now = 9 * 86_400_000
      yield* db
        .insert(ProjectArtifactOperationTable)
        .values({
          id: operationID,
          scope_id: created.scopeID,
          kind: created.kind,
          artifact_id: created.id,
          operation: "disable",
          request_fingerprint: digest(20_002),
          expected_revision: input.expectedRevision,
          expected_version_id: created.versionID,
          expected_digest: created.contentDigest,
          target_version_id: created.versionID,
          target_digest: created.contentDigest,
          phase: "preparing",
          time_created: now,
          time_updated: now,
        })
        .run()
      const scope = yield* store.resolveProjectScope(projectID)
      const scopeRoot = path.join(root, "data", "project-artifacts", scope.storageID)
      const crashed = { value: false }
      expect(
        yield* ProjectArtifactPackage.stateTransaction(
          {
            root: scopeRoot,
            operationID,
            operation: "disable",
            current: ProjectArtifactPackage.marker({
              scopeID: created.scopeID,
              storageID: scope.storageID,
              kind: created.kind,
              id: created.id,
              versionID: created.versionID,
              content: yield* Effect.promise(() =>
                Bun.file(ProjectArtifactPackage.activeContentPath(scopeRoot, created.kind, created.id)).text(),
              ),
            }),
            context: JSON.stringify({ modelID: input.modelID, goalMode: false, now }),
            filesystem: {
              lstat: fs.lstat,
              realpath: fs.realpath,
              readdir: fs.readdir,
              readFile: fs.readFile,
              beforeMutation: async () => {
                if (crashed.value) throw new Error("simulated process loss")
              },
              afterMutation: async (mutation) => {
                if (
                  mutation.operation !== "rename" ||
                  mutation.source?.includes(`${path.sep}staging${path.sep}`) ||
                  mutation.destination?.includes(`${path.sep}staging${path.sep}`)
                ) {
                  return
                }
                crashed.value = true
                throw new Error("simulated process loss")
              },
            },
          },
          { reserve: () => Effect.void, finalize: () => Effect.void, abort: () => Effect.void },
        ).pipe(
          Effect.as("success" as const),
          Effect.catch(() => Effect.succeed("failure" as const)),
        ),
      ).toBe("failure")
      expect((yield* ProjectArtifactPackage.readStateTransactions(scopeRoot))[0]?.context).toBe(
        JSON.stringify({ modelID: input.modelID, goalMode: false, now }),
      )
      yield* store.reconcile(created.scopeID)
      const degraded = yield* store.get({
        scope: { type: "project" },
        projectID,
        kind: created.kind,
        id: created.id,
      })
      expect(degraded.artifact.stage).toBe("degraded")
      expect(degraded.currentVersion.state).toBe("degraded")
      expect(
        yield* db
          .select({ phase: ProjectArtifactOperationTable.phase })
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, operationID))
          .get(),
      ).toEqual({ phase: "finalized" })
    }),
  )

  it.live("compensates authoritative bytes when DB finalization fails after the filesystem commit", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-db-compensation")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      yield* db.run(
        "CREATE TRIGGER project_artifact_fail_finalize BEFORE INSERT ON project_artifact_version BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END",
      )
      const input = {
          projectID,
          sessionID: Session.ID.make("ses_project_db_compensation"),
          insightKey: "db-compensation",
          id: "db-compensation",
          definition: {
            kind: "skill",
            name: "DB compensation",
            description: "Exercises DB finalization compensation",
            content: "Keep either the old complete version or no version.",
          },
          now: 6_000_000,
        }
      const result = yield* store
        .writeAutomatic(input)
        .pipe(
          Effect.as("success" as const),
          Effect.catch((error) => Effect.succeed(error.code)),
          Effect.ensuring(db.run("DROP TRIGGER project_artifact_fail_finalize").pipe(Effect.orDie)),
        )
      expect(result).toBe("ReconciliationRequired")
      expect(
        yield* Effect.promise(() =>
          Bun.file(
            ProjectArtifactPackage.activeContentPath(
              path.join(root, "data", "project-artifacts", scope.storageID),
              "skill",
              "db-compensation",
            ),
          ).exists(),
        ),
      ).toBe(false)
      expect(
        yield* db
          .select()
          .from(ProjectArtifactTable)
          .where(eq(ProjectArtifactTable.artifact_id, ProjectArtifact.ID.make("db-compensation")))
          .get(),
      ).toBeUndefined()
      const aborted = yield* db
        .select()
        .from(ProjectArtifactOperationTable)
        .where(eq(ProjectArtifactOperationTable.artifact_id, ProjectArtifact.ID.make("db-compensation")))
        .get()
      if (!aborted) throw new Error("Expected compensated Store operation")
      expect(aborted).toEqual(expect.objectContaining({ phase: "aborted" }))
      expect(aborted.id.startsWith("pop_")).toBe(true)
      const retried = yield* store.writeAutomatic(input)
      expect(retried.result).toBe("created")
      expect((yield* store.writeAutomatic(input)).versionID).toBe(retried.versionID)
      expect(
        yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, aborted.id))
          .get(),
      ).toEqual(expect.objectContaining({ phase: "finalized", final_version_id: retried.versionID }))
    }),
  )

  it.live("retains finalized SQL and new bytes across post-finalize Package cleanup failures", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const registry = yield* ProjectArtifactStandardSourceRegistry.StandardSourceRegistry
      const dependencies = Layer.mergeAll(
        Layer.succeed(Database.Service, yield* Database.Service),
        Layer.succeed(Global.Service, yield* Global.Service),
        Layer.succeed(EffectFlock.Service, yield* EffectFlock.Service),
        Layer.succeed(ProjectArtifactAccounting.Service, yield* ProjectArtifactAccounting.Service),
      )
      const stateFailure: { operationID?: string; failed: boolean } = { failed: false }
      const stateLayer = ProjectArtifactStore.layerWith(registry, {
        packageFilesystem: {
          lstat: fs.lstat,
          realpath: fs.realpath,
          readdir: fs.readdir,
          readFile: fs.readFile,
          beforeMutation: async (mutation) => {
            if (
              stateFailure.failed ||
              mutation.operation !== "write" ||
              !mutation.path?.includes(".ycoding-state-operation.json.") ||
              !stateFailure.operationID ||
              !mutation.path.includes(`${path.sep}${stateFailure.operationID}${path.sep}`)
            ) {
              return
            }
            stateFailure.failed = true
            throw new Error("post-finalize state journal write failure")
          },
        },
        afterPackageFinalize: (operationID) => Effect.sync(() => {
          stateFailure.operationID = operationID
        }),
      }).pipe(Layer.provide(dependencies))
      const stateStore = yield* ProjectArtifactStore.Service.pipe(Effect.provide(stateLayer))
      const projectID = Project.ID.make("project-post-finalize-state")
      yield* insertProject(projectID)
      const created = yield* stateStore.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_post_finalize_state"),
        insightKey: "post-finalize-state",
        id: "post-finalize-state",
        definition: skillDefinition("post-finalize-state"),
        now: 47_000_000,
      })
      const disableInput = {
        scopeID: created.scopeID,
        kind: created.kind,
        id: created.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 47_000_001,
      }
      yield* stateStore.disable(disableInput)
      const scope = yield* stateStore.resolveProjectScope(projectID)
      const scopeRoot = path.join(root, "data", "project-artifacts", scope.storageID)
      const stateJournal = (yield* ProjectArtifactPackage.readStateTransactions(scopeRoot))[0]
      expect(stateJournal?.phase).toBe("finalizing")
      expect(
        yield* db
          .select({ phase: ProjectArtifactOperationTable.phase })
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, stateJournal?.operationID ?? ""))
          .get(),
      ).toEqual({ phase: "finalized" })
      expect(
        yield* Effect.promise(() =>
          Bun.file(
            path.join(
              scopeRoot,
              "disabled",
              created.kind,
              created.id,
              created.versionID,
              created.kind === "skill" ? "SKILL.md" : `${created.id}.md`,
            ),
          ).exists(),
        ),
      ).toBe(true)
      yield* stateStore.reconcile(scope.id)
      expect(yield* ProjectArtifactPackage.readStateTransactions(scopeRoot)).toEqual([])
      yield* stateStore.disable(disableInput)
      expect(
        (yield* stateStore.get({ scope: { type: "project" }, projectID, kind: created.kind, id: created.id })).artifact,
      ).toEqual(expect.objectContaining({ revision: 1, stage: "disabled" }))

      const commitFailure: { operationID?: string; failed: boolean } = { failed: false }
      const commitLayer = ProjectArtifactStore.layerWith(registry, {
        packageFilesystem: {
          lstat: fs.lstat,
          realpath: fs.realpath,
          readdir: fs.readdir,
          readFile: fs.readFile,
          beforeMutation: async (mutation) => {
            if (
              commitFailure.failed ||
              mutation.operation !== "write" ||
              !mutation.path?.includes(".ycoding-operation.json.") ||
              !commitFailure.operationID ||
              !mutation.path.includes(`${path.sep}${commitFailure.operationID}${path.sep}`)
            ) {
              return
            }
            commitFailure.failed = true
            throw new Error("post-finalize commit journal write failure")
          },
        },
        afterPackageFinalize: (operationID) => Effect.sync(() => {
          commitFailure.operationID = operationID
        }),
      }).pipe(Layer.provide(dependencies))
      const commitStore = yield* ProjectArtifactStore.Service.pipe(Effect.provide(commitLayer))
      const commitProjectID = Project.ID.make("project-post-finalize-commit")
      yield* insertProject(commitProjectID)
      const commitInput = {
        projectID: commitProjectID,
        sessionID: Session.ID.make("ses_post_finalize_commit"),
        insightKey: "post-finalize-commit",
        id: "post-finalize-commit",
        definition: skillDefinition("post-finalize-commit"),
        now: 47_100_000,
      }
      const committed = yield* commitStore.writeAutomatic(commitInput)
      const commitScope = yield* commitStore.resolveProjectScope(commitProjectID)
      const commitRoot = path.join(root, "data", "project-artifacts", commitScope.storageID)
      const commitJournal = (yield* ProjectArtifactPackage.readCommitTransactions(commitRoot))[0]
      expect(commitJournal?.phase).toBe("finalizing")
      expect(
        yield* db
          .select({ phase: ProjectArtifactOperationTable.phase })
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, commitJournal?.operationID ?? ""))
          .get(),
      ).toEqual({ phase: "finalized" })
      yield* commitStore.reconcile(commitScope.id)
      expect(yield* ProjectArtifactPackage.readCommitTransactions(commitRoot)).toEqual([])
      expect((yield* commitStore.writeAutomatic(commitInput)).versionID).toBe(committed.versionID)
    }),
  )

  it.live("recovers the shared SQL and Package journal before generic reconciliation", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-restart-journal")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      const content =
        "---\nname: Restart journal\ndescription: Recovers the shared Store and Package journal\n---\nRecover before generic reconciliation."
      const marker = ProjectArtifactPackage.marker({
        scopeID: scope.id,
        storageID: scope.storageID,
        kind: "skill",
        id: ProjectArtifact.ID.make("restart-journal"),
        versionID: ProjectArtifact.VersionID.make("pav_restart-journal"),
        content,
      })
      const operationID = "pop_restart-journal"
      const requestFingerprint = digest(20_001)
      yield* db
        .insert(ProjectArtifactOperationTable)
        .values({
          id: operationID,
          scope_id: scope.id,
          kind: marker.kind,
          artifact_id: marker.id,
          operation: "create",
          request_fingerprint: requestFingerprint,
          target_version_id: marker.versionID,
          target_digest: marker.contentDigest,
          phase: "preparing",
          time_created: 6_500_000,
          time_updated: 6_500_000,
        })
        .run()
      const scopeRoot = path.join(root, "data", "project-artifacts", scope.storageID)
      const prepared = yield* ProjectArtifactPackage.prepareCommit({
        root: scopeRoot,
        marker,
        content,
        operationID,
      })
      yield* ProjectArtifactPackage.makeAvailable(prepared)

      const restartedLayer = ProjectArtifactStore.layerWith().pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Database.Service, yield* Database.Service),
            Layer.succeed(Global.Service, yield* Global.Service),
            Layer.succeed(EffectFlock.Service, yield* EffectFlock.Service),
            Layer.succeed(ProjectArtifactAccounting.Service, yield* ProjectArtifactAccounting.Service),
          ),
        ),
      )
      const restarted = yield* ProjectArtifactStore.Service.pipe(Effect.provide(restartedLayer))
      yield* restarted.reconcile(scope.id)
      const recovered = yield* restarted.get({
        scope: { type: "project" },
        projectID,
        kind: marker.kind,
        id: marker.id,
      })
      expect(recovered.currentVersion.id).toBe(marker.versionID)
      expect(recovered.currentVersion.contentDigest).toBe(marker.contentDigest)
      expect(
        yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.id, operationID))
          .get(),
      ).toEqual(expect.objectContaining({ phase: "finalized", final_version_id: marker.versionID }))
      expect(yield* Effect.promise(() => Bun.file(path.join(scopeRoot, "staging", operationID)).exists())).toBe(false)
    }),
  )

  it.live("rejects conflicting reuse of an insight key for another artifact ID", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-insight-fingerprint")
      const sessionID = Session.ID.make("ses_project_insight_fingerprint")
      yield* insertProject(projectID)
      const definition = {
        kind: "skill" as const,
        name: "Exact retry",
        description: "Exercises exact retry fingerprints",
        content: "Only exact operation retries reconcile.",
      }
      const first = yield* store.writeAutomatic({
        projectID,
        sessionID,
        insightKey: "same-insight",
        id: "first-id",
        definition,
        now: 7_000_000,
      })
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID,
              insightKey: "same-insight",
              id: "second-id",
              definition,
              now: 7_000_001,
            }),
          )
        ).code,
      ).toBe("VersionConflict")
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID,
              insightKey: "same-insight",
              id: "first-id",
              definition: { ...definition, content: "Different content cannot reuse the insight." },
              now: 7_000_002,
            }),
          )
        ).code,
      ).toBe("VersionConflict")
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID,
              insightKey: "same-insight",
              id: "first-id",
              definition,
              baseVersionID: first.versionID,
              now: 7_000_003,
            }),
          )
        ).code,
      ).toBe("VersionConflict")
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID,
              insightKey: "same-insight",
              id: "first-id",
              definition: {
                kind: "command",
                name: "Exact retry",
                description: "Exercises exact retry fingerprints",
                template: "Only exact operation retries reconcile.",
                subtask: false,
              },
              now: 7_000_004,
            }),
          )
        ).code,
      ).toBe("VersionConflict")
    }),
  )

  it.live("allows one winner for concurrent cross-ID reuse of an insight key", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-concurrent-insight-fingerprint")
      const sessionID = Session.ID.make("ses_concurrent_insight_fingerprint")
      yield* insertProject(projectID)
      yield* store.resolveProjectScope(projectID)
      const write = (id: string) =>
        store.writeAutomatic({
          projectID,
          sessionID,
          insightKey: "one-concurrent-insight",
          id,
          definition: skillDefinition(id),
          now: 7_100_000,
        })
      const outcomes = yield* Effect.all(
        [write("concurrent-insight-a"), write("concurrent-insight-b")].map((effect) =>
          effect.pipe(
            Effect.map((result) => result.id),
            Effect.catch((error) => Effect.succeed(error.code)),
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((outcome) => outcome === "VersionConflict")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome !== "VersionConflict")).toHaveLength(1)
    }),
  )

  it.live("atomically reserves the third session write across different artifact IDs", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-cross-id-session-rate")
      const sessionID = Session.ID.make("ses_cross_id_session_rate")
      yield* insertProject(projectID)
      const write = (id: string, now: number) =>
        store.writeAutomatic({
          projectID,
          sessionID,
          insightKey: id,
          id,
          definition: {
            kind: "skill",
            name: id,
            description: "Concurrent reservation boundary",
            content: `Use the ${id} reservation boundary.`,
          },
          now,
        })
      yield* write("reserved-one", 8_000_000)
      yield* write("reserved-two", 8_000_001)
      const outcomes = yield* Effect.all(
        [write("reserved-three", 8_000_002), write("reserved-four", 8_000_003)].map((effect) =>
          effect.pipe(
            Effect.as("success" as const),
            Effect.catch((error) => Effect.succeed(error.code)),
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === "WriteRateExceeded")).toHaveLength(1)
    }),
  )

  it.live("atomically reserves the tenth daily project write across different artifact IDs", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-cross-id-daily-rate")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      for (const index of Array.from({ length: 9 }, (_, index) => index)) {
        yield* seedArtifact(scope.id, "skill", `daily-seed-${index}`, index + 1)
        yield* seedWrite(scope.id, `daily-seed-${index}`, index + 1, 30_000_000 - index)
      }
      const outcomes = yield* concurrentWrites(
        store,
        projectID,
        ["daily-boundary-a", "daily-boundary-b"],
        30_000_001,
      )
      expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === "WriteRateExceeded")).toHaveLength(1)
    }),
  )

  it.live("atomically reserves the thirty-second live artifact across different IDs", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-cross-id-artifact-cap")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      for (const index of Array.from({ length: 31 }, (_, index) => index)) {
        const kind = index < 23 ? "skill" : index < 30 ? "command" : "agent"
        yield* seedArtifact(scope.id, kind, `artifact-cap-seed-${index}`, index + 100)
      }
      const outcomes = yield* concurrentWrites(
        store,
        projectID,
        ["artifact-cap-a", "artifact-cap-b"],
        31_000_000,
        "agent",
      )
      expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === "ScopeQuotaExceeded")).toHaveLength(1)
    }),
  )

  it.live("atomically reserves each per-kind artifact boundary", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      for (const [kind, cap] of [
        ["skill", 24],
        ["command", 8],
        ["agent", 4],
      ] as const) {
        const projectID = Project.ID.make(`project-${kind}-artifact-cap`)
        yield* insertProject(projectID)
        const scope = yield* store.resolveProjectScope(projectID)
        for (const index of Array.from({ length: cap - 1 }, (_, index) => index)) {
          yield* seedArtifact(scope.id, kind, `${kind}-cap-seed-${index}`, index + cap * 100)
        }
        const outcomes = yield* concurrentWrites(
          store,
          projectID,
          [`${kind}-cap-a`, `${kind}-cap-b`],
          32_000_000 + cap,
          kind,
        )
        expect(outcomes.filter((outcome) => outcome === "success"), kind).toHaveLength(1)
        expect(outcomes.filter((outcome) => outcome === "ScopeQuotaExceeded"), kind).toHaveLength(1)
      }
    }),
  )

  it.live("never retains a seventeenth automatic version under concurrent updates", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const db = (yield* Database.Service).db
      const projectID = Project.ID.make("project-version-cap")
      yield* insertProject(projectID)
      const current = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_version_cap_create"),
        insightKey: "version-cap-create",
        id: "version-cap",
        definition: skillDefinition("version-cap-create"),
        now: 33_000_000,
      })
      const scope = yield* store.resolveProjectScope(projectID)
      for (const index of Array.from({ length: 14 }, (_, index) => index)) {
        yield* db
          .insert(ProjectArtifactVersionTable)
          .values({
            id: versionID(index + 500),
            scope_id: scope.id,
            kind: "skill",
            artifact_id: ProjectArtifact.ID.make("version-cap"),
            parent_version_id: current.versionID,
            state: "superseded",
            content_digest: digest(index + 500),
            content_relpath: ProjectArtifact.ContentRelpath.make("SKILL.md"),
            source: "user",
            time_created: 1,
            time_state_changed: 1,
          })
          .run()
      }
      const update = (suffix: string) =>
        store.writeAutomatic({
          projectID,
          sessionID: Session.ID.make(`ses_version_cap_${suffix}`),
          insightKey: `version-cap-${suffix}`,
          id: "version-cap",
          definition: skillDefinition(`version-cap-${suffix}`),
          baseVersionID: current.versionID,
          now: 33_000_000 + 3_600_000,
        })
      const outcomes = yield* Effect.all(
        [update("a"), update("b")].map((effect) =>
          effect.pipe(
            Effect.as("success" as const),
            Effect.catch((error) => Effect.succeed(error.code)),
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1)
      expect(
        (
          yield* db
            .select()
            .from(ProjectArtifactVersionTable)
            .where(
              and(
                eq(ProjectArtifactVersionTable.scope_id, scope.id),
                eq(ProjectArtifactVersionTable.artifact_id, ProjectArtifact.ID.make("version-cap")),
              ),
            )
            .all()
        ).length,
      ).toBe(16)
    }),
  )

  it.live("atomically reserves owned bytes across different artifact IDs", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-owned-byte-cap")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      const scopeRoot = path.join(root, "data", "project-artifacts", scope.storageID)
      const filler = "x".repeat(8 * 1_024 * 1_024 - 30 * 1_024)
      yield* ProjectArtifactPackage.commit({
        root: scopeRoot,
        marker: ProjectArtifactPackage.marker({
          scopeID: scope.id,
          storageID: scope.storageID,
          kind: "skill",
          id: ProjectArtifact.ID.make("owned-filler"),
          versionID: versionID(900),
          content: filler,
        }),
        content: filler,
      })
      const write = (suffix: string) =>
        store.writeAutomatic({
          projectID,
          sessionID: Session.ID.make(`ses_owned_bytes_${suffix}`),
          insightKey: `owned-bytes-${suffix}`,
          id: `owned-bytes-${suffix}`,
          definition: {
            kind: "skill" as const,
            name: `Owned bytes ${suffix}`,
            description: "Concurrent owned-byte reservation boundary",
            content: `Owned byte guidance ${suffix} ${"x".repeat(20 * 1_024)}`,
          },
          now: 34_000_000,
        })
      const outcomes = yield* Effect.all(
        [write("a"), write("b")].map((effect) =>
          effect.pipe(
            Effect.as("success" as const),
            Effect.catch((error) => Effect.succeed(error.code)),
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === "ScopeQuotaExceeded")).toHaveLength(1)
    }),
  )

  it.live("releases retained owned-byte quota only after trash purge", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-purge-byte-release")
      yield* insertProject(projectID)
      const scope = yield* store.resolveProjectScope(projectID)
      const content = "x".repeat(8 * 1_024 * 1_024)
      const marker = ProjectArtifactPackage.marker({
        scopeID: scope.id,
        storageID: scope.storageID,
        kind: "skill",
        id: ProjectArtifact.ID.make("purge-byte-filler"),
        versionID: versionID(901),
        content,
      })
      yield* ProjectArtifactPackage.commit({
        root: path.join(root, "data", "project-artifacts", scope.storageID),
        marker,
        content,
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.run("PRAGMA defer_foreign_keys = ON")
          yield* tx
            .insert(ProjectArtifactTable)
            .values({
              scope_id: scope.id,
              kind: marker.kind,
              artifact_id: marker.id,
              revision: 0,
              stage: "trial",
              current_version_id: marker.versionID,
              time_created: 35_000_000,
              time_updated: 35_000_000,
            })
            .run()
          yield* tx
            .insert(ProjectArtifactVersionTable)
            .values({
              id: marker.versionID,
              scope_id: scope.id,
              kind: marker.kind,
              artifact_id: marker.id,
              state: "trial",
              content_digest: marker.contentDigest,
              content_relpath: marker.contentRelpath,
              source: "user",
              time_created: 35_000_000,
              time_state_changed: 35_000_000,
            })
            .run()
        }),
      )
      const trash = yield* store.remove({
        scopeID: scope.id,
        kind: marker.kind,
        id: marker.id,
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: marker.versionID,
        expectedDigest: marker.contentDigest,
        now: 35_000_001,
      })
      const write = store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_purge_byte_release"),
        insightKey: "purge-byte-release",
        id: "purge-byte-release",
        definition: skillDefinition("purge-byte-release"),
        now: 35_000_002,
      })
      expect((yield* Effect.flip(write)).code).toBe("ScopeQuotaExceeded")
      expect(yield* store.purge(trash.purgeAfter)).toBe(1)
      expect((yield* write).result).toBe("created")
    }),
  )

  it.live("derives standard-source collision facts without caller-supplied bypass data", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-standard-collision")
      yield* insertProject(projectID)
      const destination = path.join(root, "home", ".agents", "skills", "standard-collision", "SKILL.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, "---\nname: Standard\ndescription: Existing source\n---\nExisting")
      })
      yield* registerSources("standard-collision", [
        {
          scope: "global",
          kind: "skill",
          id: ProjectArtifact.ID.make("standard-collision"),
        },
      ])
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID: Session.ID.make("ses_project_standard_collision"),
              insightKey: "standard-collision",
              id: "standard-collision",
              definition: {
                kind: "skill",
                name: "Managed collision",
                description: "Must not replace the standard source",
                content: "Reject this write before staging.",
              },
              now: 9_000_000,
            }),
          )
        ).code,
      ).toBe("ArtifactCollision")
      expect(yield* Effect.promise(() => fs.readFile(destination, "utf8"))).toContain("Existing source")
    }),
  )

  it.live("resolves scoped project and global source snapshots through the production Store", () =>
    Effect.gen(function* () {
      yield* setup()
      const registry = yield* ProjectArtifactStandardSourceRegistry.StandardSourceRegistry
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-source-registry")
      yield* insertProject(projectID)

      yield* Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() =>
            registry.replace("project-source-registry", [
              {
                scope: "project",
                projectID,
                kind: "skill",
                id: ProjectArtifact.ID.make("registered-project-source"),
              },
              {
                scope: "global",
                kind: "skill",
                id: ProjectArtifact.ID.make("registered-global-source"),
              },
            ]),
          ),
          () => Effect.sync(() => registry.remove("project-source-registry")),
        ).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              expect(registry.size()).toBe(1)
              expect(
                yield* registry.resolve({
                  scope: "project",
                  projectID,
                  kind: "skill",
                  id: ProjectArtifact.ID.make("registered-project-source"),
                }),
              ).toEqual([{ scope: "project" }])
              expect(
                yield* registry.resolve({
                  scope: "global",
                  kind: "skill",
                  id: ProjectArtifact.ID.make("registered-global-source"),
                }),
              ).toEqual([{ scope: "global" }])
              expect(
                (
                  yield* Effect.flip(
                    store.writeAutomatic({
                      projectID,
                      sessionID: Session.ID.make("ses_registered_project_source"),
                      insightKey: "registered-project-source",
                      id: "registered-project-source",
                      definition: skillDefinition("registered-project-source"),
                      now: 9_050_000,
                    }),
                  )
                ).code,
              ).toBe("ArtifactCollision")
              expect(
                (
                  yield* Effect.flip(
                    store.writeAutomatic({
                      projectID,
                      sessionID: Session.ID.make("ses_registered_global_source"),
                      insightKey: "registered-global-source",
                      id: "registered-global-source",
                      definition: skillDefinition("registered-global-source"),
                      now: 9_050_001,
                    }),
                  )
                ).code,
              ).toBe("ArtifactCollision")
            }),
          ),
        ),
      )

      expect(registry.size()).toBe(0)
      expect(
        (
          yield* store.writeAutomatic({
            projectID,
            sessionID: Session.ID.make("ses_removed_project_source"),
            insightKey: "registered-project-source-after-cleanup",
            id: "registered-project-source",
            definition: skillDefinition("registered-project-source"),
            now: 9_050_002,
          })
        ).result,
      ).toBe("created")
    }),
  )

  it.live("checks project standard roots through the Store-owned source resolver", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-local-standard-collision")
      yield* insertProject(projectID)
      const destination = path.join(root, projectID, ".ycoding", "commands", "local-standard.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, "---\ndescription: Existing project command\n---\nExisting")
      })
      yield* registerSources("local-standard", [
        {
          scope: "project",
          projectID,
          kind: "command",
          id: ProjectArtifact.ID.make("local-standard"),
        },
      ])
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID: Session.ID.make("ses_project_local_standard_collision"),
              insightKey: "local-standard-collision",
              id: "local-standard",
              definition: {
                kind: "command",
                name: "Local standard",
                description: "Must not replace the project standard source",
                template: "Reject before staging.",
                subtask: false,
              },
              now: 9_100_000,
            }),
          )
        ).code,
      ).toBe("ArtifactCollision")
    }),
  )

  it.live("rejects a marker-only global destination without overwriting its marker", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-marker-only-promotion")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_marker_only_promotion"),
        insightKey: "marker-only-promotion",
        id: "marker-only-promotion",
        definition: skillDefinition("marker-only-promotion"),
        now: 9_200_000,
      })
      const preview = yield* store.previewPromotion({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("marker-only-promotion"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 9_200_001,
      })
      const marker = path.join(
        root,
        "home",
        ".agents",
        "skills",
        "marker-only-promotion",
        ".ycoding-project-artifact.json",
      )
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(marker), { recursive: true })
        await fs.writeFile(marker, "user-owned-marker")
      })
      const code = (yield* Effect.flip(store.confirmPromotion(preview.token, 9_200_002))).code
      expect(code).toBe("DestinationExists")
      expect(yield* Effect.promise(() => fs.readFile(marker, "utf8"))).toBe("user-owned-marker")
    }),
  )

  it.live("uses the owning Project transaction for the no-previous-scope adoption branch", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const previousProjectID = Project.ID.make("project-adoption-uncommitted-previous")
      const projectID = Project.ID.make("project-adoption-uncommitted-current")
      const storageRoot = path.join(root, "data", "project-artifacts")
      const before = yield* Effect.promise(() => fs.readdir(storageRoot).catch(() => []))
      const outcome = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(ProjectTable)
              .values([
                {
                  id: previousProjectID,
                  worktree: AbsolutePath.make(path.join(root, previousProjectID)),
                  sandboxes: [],
                  time_created: 1,
                  time_updated: 1,
                },
                {
                  id: projectID,
                  worktree: AbsolutePath.make(path.join(root, projectID)),
                  sandboxes: [],
                  time_created: 1,
                  time_updated: 1,
                },
              ])
              .run()
            const adoption = yield* store.adoptProject({ previousProjectID, projectID }, tx)
            expect(adoption.scope.projectID).toBe(projectID)
            expect(
              yield* Effect.promise(() =>
                Bun.file(
                  path.join(root, "data", "project-artifacts", adoption.scope.storageID, ".ycoding-scope.json"),
                ).exists(),
              ),
            ).toBe(false)
            return yield* Effect.fail("forced-outer-rollback" as const)
          }),
        )
        .pipe(Effect.flip)
      expect(outcome).toBe("forced-outer-rollback")
      expect(yield* Effect.promise(() => fs.readdir(storageRoot).catch(() => []))).toEqual(before)
      expect(
        yield* db
          .select()
          .from(ProjectArtifactProjectScopeTable)
          .where(eq(ProjectArtifactProjectScopeTable.project_id, projectID))
          .get(),
      ).toBeUndefined()
    }),
  )

  it.live("makes adoption idempotent and rolls back different-scope conflicts", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const previousProjectID = Project.ID.make("project-adoption-idempotent-previous")
      const projectID = Project.ID.make("project-adoption-idempotent-current")
      const conflictProjectID = Project.ID.make("project-adoption-conflict")
      yield* insertProject(previousProjectID)
      yield* insertProject(projectID)
      yield* insertProject(conflictProjectID)
      const previous = yield* store.resolveProjectScope(previousProjectID)
      yield* store.resolveProjectScope(conflictProjectID)

      const first = yield* db.transaction((tx) =>
        store.adoptProject({ previousProjectID, projectID }, tx),
      )
      yield* first.postCommit
      const second = yield* db.transaction((tx) =>
        store.adoptProject({ previousProjectID, projectID }, tx),
      )
      yield* second.postCommit
      expect(second.scope.storageID).toBe(previous.storageID)

      const conflict = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .update(ProjectArtifactProjectScopeTable)
              .set({ project_id: previousProjectID })
              .where(eq(ProjectArtifactProjectScopeTable.project_id, projectID))
              .returning()
              .get()
            expect(row).toBeDefined()
            return yield* store.adoptProject({ previousProjectID, projectID: conflictProjectID }, tx)
          }),
        )
        .pipe(Effect.flip)
      if (!(conflict instanceof ProjectArtifactStore.StoreError)) throw conflict
      expect(conflict.code).toBe("ProjectAdoptionConflict")
      expect((yield* store.resolveProjectScope(projectID)).storageID).toBe(previous.storageID)
    }),
  )

  it.live("keeps intact global standard artifacts active and rebuilds an empty global index", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-global-reconcile")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_global_reconcile"),
        insightKey: "global-reconcile",
        id: "global-reconcile",
        definition: {
          kind: "command",
          name: "Global reconcile",
          description: "Rebuilds global standard ownership",
          template: "Reconcile the global command.",
          subtask: false,
        },
        now: 10_000_000,
      })
      const preview = yield* store.previewPromotion({
        projectID,
        kind: "command",
        id: ProjectArtifact.ID.make("global-reconcile"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 10_000_001,
      })
      yield* store.confirmPromotion(preview.token, 10_000_002)
      const globalScope = yield* store.resolveGlobalScope()
      yield* store.reconcile(globalScope.id)
      expect(
        (
          yield* db
            .select()
            .from(ProjectArtifactTable)
            .where(eq(ProjectArtifactTable.scope_id, globalScope.id))
            .get()
        )?.stage,
      ).toBe("trial")

      yield* db
        .delete(ProjectArtifactOperationTable)
        .where(eq(ProjectArtifactOperationTable.scope_id, globalScope.id))
        .run()
      yield* db.delete(ProjectArtifactTable).where(eq(ProjectArtifactTable.scope_id, globalScope.id)).run()
      yield* store.reconcile(globalScope.id)
      const rebuilt = yield* db
        .select()
        .from(ProjectArtifactTable)
        .where(eq(ProjectArtifactTable.scope_id, globalScope.id))
        .get()
      expect(rebuilt).toEqual(expect.objectContaining({ artifact_id: "global-reconcile", stage: "trial" }))
      expect(
        yield* Effect.promise(() =>
          Bun.file(path.join(root, "config", "commands", "global-reconcile.md")).exists(),
        ),
      ).toBe(true)
    }),
  )

  reconcileIt.live("rechecks a changed marker while serializing concurrent global confirmation", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const initialPreview = yield* store.previewManual({
        id: "reconcile-marker-race",
        definition: {
          kind: "command",
          name: "Reconcile marker race",
          description: "Rechecks marker and content before folding",
          template: "Initial reconciled content.",
          subtask: false,
        },
        now: 10_500_000,
      })
      yield* store.confirmManual(initialPreview.token, 10_500_001)
      const concurrentPreview = yield* store.previewManual({
        id: "reconcile-concurrent-confirm",
        definition: {
          kind: "command",
          name: "Reconcile concurrent confirm",
          description: "Must remain active after concurrent reconciliation",
          template: "Concurrent confirmed content.",
          subtask: false,
        },
        now: 10_500_002,
      })
      const globalScope = yield* store.resolveGlobalScope()
      const reconciliation = yield* Effect.forkChild(store.reconcile(globalScope.id))
      yield* Effect.promise(() => reconcileScanned.promise)
      const confirmation = yield* Effect.forkChild(store.confirmManual(concurrentPreview.token, 10_500_003))
      const content =
        "---\nname: Reconcile marker race\ndescription: Rechecks marker and content before folding\n---\nExternally updated content."
      const marker = ProjectArtifactPackage.marker({
        scopeID: globalScope.id,
        storageID: globalScope.storageID,
        kind: "command",
        id: ProjectArtifact.ID.make("reconcile-marker-race"),
        versionID: versionID(950),
        content,
      })
      yield* Effect.promise(async () => {
        const directory = path.join(reconcileRoot, "config", "commands")
        await fs.writeFile(path.join(directory, "reconcile-marker-race.md"), content)
        await fs.writeFile(
          path.join(directory, ".reconcile-marker-race.ycoding-project-artifact.json"),
          JSON.stringify(marker),
        )
      })
      releaseReconcile.resolve()
      yield* Fiber.join(reconciliation)
      yield* Fiber.join(confirmation)

      const reconciled = yield* store.get({
        scope: { type: "global" },
        kind: "command",
        id: ProjectArtifact.ID.make("reconcile-marker-race"),
      })
      expect(reconciled.currentVersion.id).toBe(marker.versionID)
      expect(reconciled.currentVersion.contentDigest).toBe(marker.contentDigest)
      expect(
        (
          yield* store.get({
            scope: { type: "global" },
            kind: "command",
            id: ProjectArtifact.ID.make("reconcile-concurrent-confirm"),
          })
        ).artifact.stage,
      ).toBe("trial")
    }),
  )

  it.live("deletes and restores a disabled artifact with all owned layouts", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-disabled-trash")
      yield* insertProject(projectID)
      const first = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_disabled_trash_first"),
        insightKey: "disabled-trash-first",
        id: "disabled-trash",
        definition: {
          kind: "skill",
          name: "Disabled trash",
          description: "Preserves every owned version layout",
          content: "First owned version.",
        },
        now: 11_000_000,
      })
      const second = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_disabled_trash_second"),
        insightKey: "disabled-trash-second",
        id: "disabled-trash",
        definition: {
          kind: "skill",
          name: "Disabled trash",
          description: "Preserves every owned version layout",
          content: "Second owned version.",
        },
        baseVersionID: first.versionID,
        now: 11_000_000 + 3_600_000,
      })
      const scope = yield* store.resolveProjectScope(projectID)
      yield* store.disable({
        scopeID: scope.id,
        kind: "skill",
        id: ProjectArtifact.ID.make("disabled-trash"),
        expectedRevision: ProjectArtifact.Revision.make(1),
        expectedVersionID: second.versionID,
        expectedDigest: second.contentDigest,
        now: 15_000_001,
      })
      const trash = yield* store.remove({
        scopeID: scope.id,
        kind: "skill",
        id: ProjectArtifact.ID.make("disabled-trash"),
        expectedRevision: ProjectArtifact.Revision.make(2),
        expectedVersionID: second.versionID,
        expectedDigest: second.contentDigest,
        now: 15_000_002,
      })
      yield* store.restore(trash.deletionID, trash.deletedAt + 29 * 86_400_000)
      const scopeRoot = path.join(root, "data", "project-artifacts", scope.storageID)
      expect(
        yield* Effect.promise(() =>
          Bun.file(path.join(scopeRoot, "disabled", "skill", "disabled-trash", second.versionID, "SKILL.md")).exists(),
        ),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(scopeRoot, {
        schema: 1,
        scopeID: scope.id,
        storageID: scope.storageID,
        kind: "skill",
        id: ProjectArtifact.ID.make("disabled-trash"),
        versionID: first.versionID,
        contentDigest: first.contentDigest,
        contentRelpath: ProjectArtifact.ContentRelpath.make("SKILL.md"),
      })).exists())).toBe(true)
    }),
  )

  it.live("exposes list/get, manual writes, global confirmation, fork, shadow, and expiry purge through Store", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-manual-api")
      yield* insertProject(projectID)
      const created = yield* store.writeManual({
        scope: { type: "project" },
        projectID,
        id: "manual-command",
        definition: {
          kind: "command",
          name: "Manual command name",
          description: "Manual command description",
          template: "Run the manual command.",
          subtask: false,
        },
        now: 20_000_000,
      })
      expect((yield* store.list({ scope: { type: "project" }, projectID })).map((item) => item.id)).toContain(
        ProjectArtifact.ID.make("manual-command"),
      )
      expect(
        (yield* store.get({ scope: { type: "project" }, projectID, kind: "command", id: ProjectArtifact.ID.make("manual-command") }))
          .definition,
      ).toEqual(expect.objectContaining({ name: "Manual command name", description: "Manual command description" }))

      const globalPreview = yield* store.previewManual({
        id: "manual-global",
        definition: {
          kind: "skill",
          name: "Manual global",
          description: "Requires explicit global confirmation",
          content: "Create only after confirmation.",
        },
        now: 20_000_001,
      })
      const global = yield* store.confirmManual(globalPreview.token, 20_000_002)
      expect((yield* Effect.flip(store.confirmManual(globalPreview.token, 20_000_003))).code).toBe("ConfirmationExpired")
      yield* registerSources("manual-global", [managedGlobalSource(global)])
      const forkPreview = yield* store.previewFork({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("manual-global"),
        expectedVersionID: global.versionID,
        expectedDigest: global.contentDigest,
        now: 20_000_004,
      })
      const fork = yield* store.confirmFork(forkPreview.token, 20_000_005)
      expect(fork.scopeID).not.toBe(global.scopeID)
      const shadowPreview = yield* store.previewShadow({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("manual-global"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: fork.versionID,
        expectedDigest: fork.contentDigest,
        globalScopeID: global.scopeID,
        globalExpectedRevision: ProjectArtifact.Revision.make(0),
        globalVersionID: global.versionID,
        globalDigest: global.contentDigest,
        now: 20_000_005,
      })
      yield* store.confirmShadow(shadowPreview.token, 20_000_006)

      const scope = yield* store.resolveProjectScope(projectID)
      const trash = yield* store.remove({
        scopeID: scope.id,
        kind: "command",
        id: ProjectArtifact.ID.make("manual-command"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 20_000_007,
      })
      expect(yield* store.purge(trash.purgeAfter - 1)).toBe(0)
      expect(yield* store.purge(trash.purgeAfter)).toBe(1)
      expect((yield* Effect.flip(store.restore(trash.deletionID, trash.purgeAfter))).code).toBe("DeletionNotFound")
      expect(
        yield* db
          .select()
          .from(ProjectArtifactOperationTable)
          .where(eq(ProjectArtifactOperationTable.artifact_id, ProjectArtifact.ID.make("manual-command")))
          .all(),
      ).toHaveLength(0)
    }),
  )

  it.live("rejects an alternative global source that appears after promotion preview", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-alternative-root-promotion")
      yield* insertProject(projectID)
      const created = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_alternative_root_promotion"),
        insightKey: "alternative-root-promotion",
        id: "alternative-root-promotion",
        definition: skillDefinition("alternative-root-promotion"),
        now: 40_000_000,
      })
      const preview = yield* store.previewPromotion({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("alternative-root-promotion"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: created.versionID,
        expectedDigest: created.contentDigest,
        now: 40_000_001,
      })
      const alternative = path.join(root, "home", ".claude", "skills", "alternative-root-promotion", "SKILL.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(alternative), { recursive: true })
        await fs.writeFile(alternative, "---\nname: Existing\ndescription: Alternative source\n---\nExisting")
      })
      yield* registerSources("alternative-root-promotion", [
        {
          scope: "global",
          kind: "skill",
          id: ProjectArtifact.ID.make("alternative-root-promotion"),
        },
      ])

      expect((yield* Effect.flip(store.confirmPromotion(preview.token, 40_000_002))).code).toBe("DestinationExists")
      expect(yield* Effect.promise(() => fs.readFile(alternative, "utf8"))).toContain("Alternative source")
    }),
  )

  it.live("rejects a project source that appears after fork preview", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-fork-source-race")
      yield* insertProject(projectID)
      const globalPreview = yield* store.previewManual({
        id: "fork-source-race",
        definition: {
          kind: "command",
          name: "Fork source race",
          description: "Rejects a late project source",
          template: "Keep the global source unchanged.",
          subtask: false,
        },
        now: 41_000_000,
      })
      const globalArtifact = yield* store.confirmManual(globalPreview.token, 41_000_001)
      yield* registerSources("fork-source-race-global", [managedGlobalSource(globalArtifact)])
      const preview = yield* store.previewFork({
        projectID,
        kind: "command",
        id: ProjectArtifact.ID.make("fork-source-race"),
        expectedVersionID: globalArtifact.versionID,
        expectedDigest: globalArtifact.contentDigest,
        now: 41_000_002,
      })
      const projectSource = path.join(root, projectID, ".ycoding", "commands", "fork-source-race.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(projectSource), { recursive: true })
        await fs.writeFile(projectSource, "---\ndescription: Explicit project source\n---\nExisting")
      })
      yield* registerSources("fork-source-race-project", [
        {
          scope: "project",
          projectID,
          kind: "command",
          id: ProjectArtifact.ID.make("fork-source-race"),
        },
      ])

      expect((yield* Effect.flip(store.confirmFork(preview.token, 41_000_003))).code).toBe("ArtifactCollision")
      expect(yield* Effect.promise(() => fs.readFile(projectSource, "utf8"))).toContain("Explicit project source")
    }),
  )

  it.live("rejects a project source that appears before a managed manual update", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-manual-source-race")
      yield* insertProject(projectID)
      const created = yield* store.writeManual({
        scope: { type: "project" },
        projectID,
        id: "manual-source-race",
        definition: {
          kind: "command",
          name: "Manual source race",
          description: "Rejects a late explicit source",
          template: "Initial managed definition.",
          subtask: false,
        },
        now: 42_000_000,
      })
      const projectSource = path.join(root, projectID, ".ycoding", "commands", "manual-source-race.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(projectSource), { recursive: true })
        await fs.writeFile(projectSource, "---\ndescription: Explicit project source\n---\nExisting")
      })
      yield* registerSources("manual-source-race", [
        {
          scope: "project",
          projectID,
          kind: "command",
          id: ProjectArtifact.ID.make("manual-source-race"),
        },
      ])

      expect(
        (
          yield* Effect.flip(
            store.writeManual({
              scope: { type: "project" },
              projectID,
              id: "manual-source-race",
              definition: {
                kind: "command",
                name: "Manual source race",
                description: "Rejects a late explicit source",
                template: "Updated managed definition.",
                subtask: false,
              },
              expectedRevision: ProjectArtifact.Revision.make(0),
              expectedVersionID: created.versionID,
              expectedDigest: created.contentDigest,
              now: 42_000_001,
            }),
          )
        ).code,
      ).toBe("ArtifactCollision")
      expect(yield* Effect.promise(() => fs.readFile(projectSource, "utf8"))).toContain("Explicit project source")
    }),
  )

  it.live("lists project and global trash with restart-stable deletion metadata", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-trash-list")
      yield* insertProject(projectID)
      const projectArtifact = yield* store.writeAutomatic({
        projectID,
        sessionID: Session.ID.make("ses_project_trash_list"),
        insightKey: "project-trash-list",
        id: "project-trash-list",
        definition: skillDefinition("project-trash-list"),
        now: 43_000_000,
      })
      const projectScope = yield* store.resolveProjectScope(projectID)
      const projectTrash = yield* store.remove({
        scopeID: projectScope.id,
        kind: "skill",
        id: ProjectArtifact.ID.make("project-trash-list"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: projectArtifact.versionID,
        expectedDigest: projectArtifact.contentDigest,
        now: 43_000_001,
      })
      const globalPreview = yield* store.previewManual({
        id: "global-trash-list",
        definition: {
          kind: "command",
          name: "Global trash list",
          description: "Exposes restart-stable deletion metadata",
          template: "Keep the trash manifest discoverable.",
          subtask: false,
        },
        now: 43_000_002,
      })
      const globalArtifact = yield* store.confirmManual(globalPreview.token, 43_000_003)
      yield* registerSources("global-trash-list", [managedGlobalSource(globalArtifact)])
      const globalDetails = yield* store.get({
        scope: { type: "global" },
        kind: "command",
        id: ProjectArtifact.ID.make("global-trash-list"),
      })
      const globalRemove = yield* store.previewRemove({
        scopeID: globalArtifact.scopeID,
        kind: "command",
        id: ProjectArtifact.ID.make("global-trash-list"),
        expectedRevision: globalDetails.artifact.revision,
        expectedVersionID: globalArtifact.versionID,
        expectedDigest: globalArtifact.contentDigest,
        now: 43_000_004,
      })
      const globalTrash = yield* store.confirmRemove(globalRemove.token, 43_000_005)

      const restartedLayer = ProjectArtifactStore.layerWith().pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Database.Service, yield* Database.Service),
            Layer.succeed(Global.Service, yield* Global.Service),
            Layer.succeed(EffectFlock.Service, yield* EffectFlock.Service),
            Layer.succeed(ProjectArtifactAccounting.Service, yield* ProjectArtifactAccounting.Service),
          ),
        ),
      )
      const restarted = yield* ProjectArtifactStore.Service.pipe(Effect.provide(restartedLayer))
      expect(yield* restarted.list({ scope: { type: "project" }, projectID, trash: true })).toEqual([
        expect.objectContaining({
          deletionID: projectTrash.deletionID,
          priorStage: "trial",
          priorVersionID: projectArtifact.versionID,
          deletedAt: projectTrash.deletedAt,
          purgeAfter: projectTrash.purgeAfter,
          definition: expect.objectContaining({ kind: "skill", name: "project-trash-list" }),
        }),
      ])
      expect((yield* restarted.getTrash(projectTrash.deletionID)).definition).toEqual(
        expect.objectContaining({ kind: "skill", name: "project-trash-list" }),
      )
      expect(yield* restarted.list({ scope: { type: "global" }, trash: true })).toEqual([
        expect.objectContaining({
          deletionID: globalTrash.deletionID,
          priorStage: "trial",
          priorVersionID: globalArtifact.versionID,
          deletedAt: globalTrash.deletedAt,
          purgeAfter: globalTrash.purgeAfter,
          definition: expect.objectContaining({ kind: "command", name: "Global trash list" }),
        }),
      ])
      yield* restarted.restore(projectTrash.deletionID, 43_000_006)
    }),
  )

  it.live("requires five-minute single-use tokens for every global state mutation", () =>
    Effect.gen(function* () {
      yield* setup()
      const db = (yield* Database.Service).db
      const store = yield* ProjectArtifactStore.Service
      const firstPreview = yield* store.previewManual({
        id: "global-mutation-token",
        definition: {
          kind: "command",
          name: "Global mutation token",
          description: "Requires explicit confirmation for every global mutation",
          template: "First global version.",
          subtask: false,
        },
        now: 44_000_000,
      })
      const first = yield* store.confirmManual(firstPreview.token, 44_000_001)
      const registry = yield* registerSources("global-mutation-token", [managedGlobalSource(first)])
      const secondPreview = yield* store.previewManual({
        id: "global-mutation-token",
        definition: {
          kind: "command",
          name: "Global mutation token",
          description: "Requires explicit confirmation for every global mutation",
          template: "Second global version.",
          subtask: false,
        },
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: first.versionID,
        expectedDigest: first.contentDigest,
        now: 44_000_002,
      })
      const second = yield* store.confirmManual(secondPreview.token, 44_000_003)
      registry.replace("global-mutation-token", [managedGlobalSource(second)])
      const globalScope = yield* store.resolveGlobalScope()
      const id = ProjectArtifact.ID.make("global-mutation-token")
      const beforeDisable = yield* store.get({ scope: { type: "global" }, kind: "command", id })
      const disableInput = {
        scopeID: globalScope.id,
        kind: "command" as const,
        id,
        expectedRevision: beforeDisable.artifact.revision,
        expectedVersionID: beforeDisable.currentVersion.id,
        expectedDigest: beforeDisable.currentVersion.contentDigest,
      }
      expect((yield* Effect.flip(store.disable(disableInput))).code).toBe("InvalidScope")
      const expiringDisable = yield* store.previewDisable({ ...disableInput, now: 44_000_010 })
      expect((yield* Effect.flip(store.confirmDisable(expiringDisable.token, expiringDisable.expiresAt))).code).toBe(
        "ConfirmationExpired",
      )
      const disable = yield* store.previewDisable({ ...disableInput, now: 44_000_011 })
      yield* store.confirmDisable(disable.token, 44_000_012)
      registry.replace("global-mutation-token", [])
      expect((yield* Effect.flip(store.confirmDisable(disable.token, 44_000_013))).code).toBe("ConfirmationExpired")

      const beforeEnable = yield* store.get({ scope: { type: "global" }, kind: "command", id })
      const enableInput = {
        scopeID: globalScope.id,
        kind: "command" as const,
        id,
        expectedRevision: beforeEnable.artifact.revision,
        expectedVersionID: beforeEnable.currentVersion.id,
        expectedDigest: beforeEnable.currentVersion.contentDigest,
      }
      expect((yield* Effect.flip(store.enable(enableInput))).code).toBe("InvalidScope")
      const expiringEnable = yield* store.previewEnable({ ...enableInput, now: 44_000_020 })
      expect((yield* Effect.flip(store.confirmEnable(expiringEnable.token, expiringEnable.expiresAt))).code).toBe(
        "ConfirmationExpired",
      )
      const collidingEnable = yield* store.previewEnable({ ...enableInput, now: 44_000_021 })
      const destination = path.join(root, "config", "commands", "global-mutation-token.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, "user-owned destination")
      })
      expect((yield* Effect.flip(store.confirmEnable(collidingEnable.token, 44_000_022))).code).toBe("DestinationExists")
      yield* Effect.promise(() => fs.rm(destination, { force: true }))
      const enable = yield* store.previewEnable({ ...enableInput, now: 44_000_023 })
      yield* store.confirmEnable(enable.token, 44_000_024)
      registry.replace("global-mutation-token", [managedGlobalSource(second)])
      expect((yield* Effect.flip(store.confirmEnable(enable.token, 44_000_025))).code).toBe("ConfirmationExpired")

      const beforeRevert = yield* store.get({ scope: { type: "global" }, kind: "command", id })
      const revertInput = {
        scopeID: globalScope.id,
        kind: "command" as const,
        id,
        expectedRevision: beforeRevert.artifact.revision,
        expectedVersionID: beforeRevert.currentVersion.id,
        expectedDigest: beforeRevert.currentVersion.contentDigest,
        targetVersionID: first.versionID,
      }
      expect((yield* Effect.flip(store.revert(revertInput))).code).toBe("InvalidScope")
      const expiringRevert = yield* store.previewRevert({ ...revertInput, now: 44_000_030 })
      expect((yield* Effect.flip(store.confirmRevert(expiringRevert.token, expiringRevert.expiresAt))).code).toBe(
        "ConfirmationExpired",
      )
      const revert = yield* store.previewRevert({ ...revertInput, now: 44_000_031 })
      yield* store.confirmRevert(revert.token, 44_000_032)
      registry.replace("global-mutation-token", [managedGlobalSource(first)])
      expect((yield* Effect.flip(store.confirmRevert(revert.token, 44_000_033))).code).toBe("ConfirmationExpired")

      const beforeRemove = yield* store.get({ scope: { type: "global" }, kind: "command", id })
      const removeInput = {
        scopeID: globalScope.id,
        kind: "command" as const,
        id,
        expectedRevision: beforeRemove.artifact.revision,
        expectedVersionID: beforeRemove.currentVersion.id,
        expectedDigest: beforeRemove.currentVersion.contentDigest,
      }
      expect((yield* Effect.flip(store.remove(removeInput))).code).toBe("InvalidScope")
      const expiringRemove = yield* store.previewRemove({ ...removeInput, now: 44_000_040 })
      expect((yield* Effect.flip(store.confirmRemove(expiringRemove.token, expiringRemove.expiresAt))).code).toBe(
        "ConfirmationExpired",
      )
      const remove = yield* store.previewRemove({ ...removeInput, now: 44_000_041 })
      const trash = yield* store.confirmRemove(remove.token, 44_000_042)
      registry.replace("global-mutation-token", [])
      expect((yield* Effect.flip(store.confirmRemove(remove.token, 44_000_043))).code).toBe("ConfirmationExpired")

      expect((yield* Effect.flip(store.restore(trash.deletionID, 44_000_044))).code).toBe("InvalidScope")
      const expiringRestore = yield* store.previewRestore({ deletionID: trash.deletionID, now: 44_000_045 })
      expect((yield* Effect.flip(store.confirmRestore(expiringRestore.token, expiringRestore.expiresAt))).code).toBe(
        "ConfirmationExpired",
      )
      const collidingRestore = yield* store.previewRestore({ deletionID: trash.deletionID, now: 44_000_046 })
      yield* Effect.promise(() => fs.writeFile(destination, "user-owned destination"))
      expect((yield* Effect.flip(store.confirmRestore(collidingRestore.token, 44_000_047))).code).toBe("DestinationExists")
      yield* Effect.promise(() => fs.rm(destination, { force: true }))
      const restore = yield* store.previewRestore({ deletionID: trash.deletionID, now: 44_000_048 })
      yield* store.confirmRestore(restore.token, 44_000_049)
      registry.replace("global-mutation-token", [managedGlobalSource(first)])
      expect((yield* Effect.flip(store.confirmRestore(restore.token, 44_000_050))).code).toBe("ConfirmationExpired")
      expect((yield* store.get({ scope: { type: "global" }, kind: "command", id })).currentVersion.id).toBe(
        first.versionID,
      )
      expect(second.versionID).not.toBe(first.versionID)
      const operations = yield* db
        .select({ operation: ProjectArtifactOperationTable.operation, phase: ProjectArtifactOperationTable.phase })
        .from(ProjectArtifactOperationTable)
        .where(eq(ProjectArtifactOperationTable.artifact_id, id))
        .all()
      expect(operations.every((operation) => operation.phase === "finalized")).toBe(true)
      expect(new Set(operations.map((operation) => operation.operation))).toEqual(
        new Set(["create", "update", "disable", "enable", "revert", "remove", "restore"]),
      )
    }),
  )

  it.live("binds shadow confirmation to five-minute project and global expectations", () =>
    Effect.gen(function* () {
      yield* setup()
      const store = yield* ProjectArtifactStore.Service
      const projectID = Project.ID.make("project-shadow-token")
      yield* insertProject(projectID)
      const globalPreview = yield* store.previewManual({
        id: "shadow-token",
        definition: {
          kind: "skill",
          name: "Shadow token",
          description: "Binds project and global source expectations",
          content: "Initial global source.",
        },
        now: 45_000_000,
      })
      const globalArtifact = yield* store.confirmManual(globalPreview.token, 45_000_001)
      const registry = yield* registerSources("shadow-token", [managedGlobalSource(globalArtifact)])
      const forkPreview = yield* store.previewFork({
        projectID,
        kind: "skill",
        id: ProjectArtifact.ID.make("shadow-token"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: globalArtifact.versionID,
        expectedDigest: globalArtifact.contentDigest,
        now: 45_000_002,
      })
      const projectArtifact = yield* store.confirmFork(forkPreview.token, 45_000_003)
      const shadowInput = {
        projectID,
        kind: "skill" as const,
        id: ProjectArtifact.ID.make("shadow-token"),
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: projectArtifact.versionID,
        expectedDigest: projectArtifact.contentDigest,
        globalScopeID: globalArtifact.scopeID,
        globalExpectedRevision: ProjectArtifact.Revision.make(0),
        globalVersionID: globalArtifact.versionID,
        globalDigest: globalArtifact.contentDigest,
      }
      const expiring = yield* store.previewShadow({ ...shadowInput, now: 45_000_004 })
      expect((yield* Effect.flip(store.confirmShadow(expiring.token, expiring.expiresAt))).code).toBe(
        "ConfirmationExpired",
      )

      const stale = yield* store.previewShadow({ ...shadowInput, now: 45_000_005 })
      const updatePreview = yield* store.previewManual({
        id: "shadow-token",
        definition: {
          kind: "skill",
          name: "Shadow token",
          description: "Binds project and global source expectations",
          content: "Updated global source.",
        },
        expectedRevision: ProjectArtifact.Revision.make(0),
        expectedVersionID: globalArtifact.versionID,
        expectedDigest: globalArtifact.contentDigest,
        now: 45_000_006,
      })
      const updatedGlobal = yield* store.confirmManual(updatePreview.token, 45_000_007)
      registry.replace("shadow-token", [managedGlobalSource(updatedGlobal)])
      expect((yield* Effect.flip(store.confirmShadow(stale.token, 45_000_008))).code).toBe("VersionConflict")

      const confirmed = yield* store.previewShadow({
        ...shadowInput,
        globalExpectedRevision: ProjectArtifact.Revision.make(1),
        globalVersionID: updatedGlobal.versionID,
        globalDigest: updatedGlobal.contentDigest,
        now: 45_000_009,
      })
      yield* store.confirmShadow(confirmed.token, 45_000_010)
      expect((yield* Effect.flip(store.confirmShadow(confirmed.token, 45_000_011))).code).toBe("ConfirmationExpired")

      const extra = path.join(root, "home", ".claude", "skills", "shadow-token", "SKILL.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(extra), { recursive: true })
        await fs.writeFile(extra, "---\nname: Extra\ndescription: Extra global source\n---\nExtra")
      })
      registry.replace("shadow-token", [
        managedGlobalSource(updatedGlobal),
        {
          scope: "global",
          kind: "skill",
          id: ProjectArtifact.ID.make("shadow-token"),
        },
      ])
      expect(
        (
          yield* Effect.flip(
            store.writeAutomatic({
              projectID,
              sessionID: Session.ID.make("ses_shadow_token_update"),
              insightKey: "shadow-token-update",
              id: "shadow-token",
              definition: {
                kind: "skill",
                name: "Shadow token",
                description: "Binds project and global source expectations",
                content: "Managed project update.",
              },
              baseVersionID: projectArtifact.versionID,
              now: 45_000_003 + 3_600_000,
            }),
          )
        ).code,
      ).toBe("ArtifactCollision")
    }),
  )
})

function setup() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("PRAGMA foreign_keys = ON")
  })
}

function registerSources(
  key: string,
  records: ReadonlyArray<ProjectArtifactStandardSourceRegistry.Record>,
) {
  return Effect.gen(function* () {
    const registry = yield* ProjectArtifactStandardSourceRegistry.StandardSourceRegistry
    yield* Effect.acquireRelease(
      Effect.sync(() => registry.replace(key, records)),
      () => Effect.sync(() => registry.remove(key)),
    )
    return registry
  })
}

function managedGlobalSource(result: ProjectArtifactStore.WriteResult) {
  return {
    scope: "global" as const,
    kind: result.kind,
    id: result.id,
    managedScopeID: result.scopeID,
    managedVersionID: result.versionID,
    managedDigest: result.contentDigest,
  }
}

function recordGovernorDegradation(
  accounting: ProjectArtifactAccounting.Interface,
  artifact: ProjectArtifactStore.WriteResult,
  projectID: Project.ID,
  prefix: string,
  modelID: string,
) {
  return Effect.gen(function* () {
    yield* Effect.forEach(
      Array.from({ length: 20 }, (_, index) => index),
      (index) => {
        const sessionID = Session.ID.make(`ses_governor_${prefix}_${index}`)
        const boundarySeq = ProjectArtifact.Revision.make(index + 1)
        return accounting
          .activate(
            ProjectArtifact.Activation.make({
              id: ProjectArtifact.ActivationID.make(`paa_governor-${prefix}-${index}`),
              artifact: {
                scopeID: artifact.scopeID,
                kind: artifact.kind,
                id: artifact.id,
                versionID: artifact.versionID,
              },
              projectID,
              sessionID,
              source: "skill-tool",
              boundarySeq,
              activatedAt: ProjectArtifact.TimestampMillis.make(2_000 + index),
            }),
          )
          .pipe(
            Effect.andThen(
              accounting.observe({
                projectID,
                sessionID,
                terminalMessageID: `governor-${prefix}-${index}`,
                boundarySeq,
                kind: artifact.kind,
                modelID,
                goalMode: false,
                standardInvocationCount: ProjectArtifact.Revision.make(0),
                externalConfounded: false,
                terminalOutcome: "failed",
                goalStatus: "exhausted",
                repeatFix: false,
                observedAt: ProjectArtifact.TimestampMillis.make(8 * 86_400_000 - index),
              }),
            ),
          )
      },
      { discard: true },
    )
    yield* Effect.forEach(
      Array.from({ length: 30 }, (_, index) => index),
      (index) =>
        accounting.observe({
          projectID,
          sessionID: Session.ID.make(`ses_governor_${prefix}_baseline_${index}`),
          terminalMessageID: `governor-${prefix}-baseline-${index}`,
          boundarySeq: ProjectArtifact.Revision.make(index + 100),
          kind: artifact.kind,
          modelID,
          goalMode: false,
          standardInvocationCount: ProjectArtifact.Revision.make(0),
          externalConfounded: false,
          terminalOutcome: "succeeded",
          goalStatus: "completed",
          repeatFix: false,
          observedAt: ProjectArtifact.TimestampMillis.make(8 * 86_400_000 - index),
        }),
      { discard: true },
    )
  })
}

function insertProject(id: Project.ID) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({
        id,
        worktree: AbsolutePath.make(path.join(root, id)),
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .onConflictDoNothing()
      .run()
  })
}

function concurrentWrites(
  store: ProjectArtifactStore.Interface,
  projectID: Project.ID,
  ids: readonly [string, string],
  now: number,
  kind: "skill" | "command" | "agent" = "skill",
) {
  return Effect.all(
    ids.map((id, index) =>
      store
        .writeAutomatic({
          projectID,
          sessionID: Session.ID.make(`ses_${id}`),
          insightKey: id,
          id,
          definition: definition(kind, id),
          now: now + index,
        })
        .pipe(
          Effect.as("success" as const),
          Effect.catch((error) => Effect.succeed(error.code)),
        ),
    ),
    { concurrency: "unbounded" },
  )
}

function definition(kind: "skill" | "command" | "agent", id: string) {
  if (kind === "skill") return skillDefinition(id)
  if (kind === "command") {
    return {
      kind,
      name: id,
      description: "Concurrent command reservation boundary",
      template: `Use the ${id} command boundary.`,
      subtask: false as const,
    }
  }
  return {
    kind,
    name: id,
    description: "Concurrent agent reservation boundary",
    system: `Use the ${id} agent boundary.`,
    mode: "subagent" as const,
    permissions: [] as const,
  }
}

function skillDefinition(id: string) {
  return {
    kind: "skill" as const,
    name: id,
    description: "Concurrent skill reservation boundary",
    content: `Use the ${id} skill boundary.`,
  }
}

function seedArtifact(
  scopeID: ProjectArtifact.ScopeID,
  kind: ProjectArtifact.Kind,
  id: string,
  index: number,
) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const artifactID = ProjectArtifact.ID.make(id)
    const currentVersionID = versionID(index)
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run("PRAGMA defer_foreign_keys = ON")
        yield* tx
          .insert(ProjectArtifactTable)
          .values({
            scope_id: scopeID,
            kind,
            artifact_id: artifactID,
            revision: 0,
            stage: kind === "plugin" ? "quarantine" : "trial",
            current_version_id: currentVersionID,
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* tx
          .insert(ProjectArtifactVersionTable)
          .values({
            id: currentVersionID,
            scope_id: scopeID,
            kind,
            artifact_id: artifactID,
            state: kind === "plugin" ? "quarantine" : "trial",
            content_digest: digest(index),
            content_relpath: ProjectArtifact.ContentRelpath.make(kind === "skill" ? "SKILL.md" : `${id}.md`),
            source: "user",
            time_created: 1,
            time_state_changed: 1,
          })
          .run()
      }),
    )
  })
}

function seedWrite(scopeID: ProjectArtifact.ScopeID, id: string, index: number, now: number) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectArtifactWriteTable)
      .values({
        scope_id: scopeID,
        session_id: Session.ID.make(`ses_${id}`),
        insight_digest: digest(index + 10_000),
        operation: "create",
        result: "created",
        version_id: versionID(index),
        content_digest: digest(index),
        time_created: now,
      })
      .run()
  })
}

function versionID(index: number) {
  return ProjectArtifact.VersionID.make(`pav_${index.toString(16).padStart(32, "0")}`)
}

function digest(index: number) {
  return ProjectArtifact.Digest.make(new Bun.CryptoHasher("sha256").update(String(index)).digest("hex"))
}
