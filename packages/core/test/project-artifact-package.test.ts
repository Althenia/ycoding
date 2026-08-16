import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectArtifactPackage } from "@ycoding-ai/core/project-artifact/package"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EffectFlock } from "@ycoding-ai/core/util/effect-flock"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.merge(Layer.empty, LayerNode.compile(EffectFlock.node)))
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(ProjectArtifactPackage.Marker))

describe("ProjectArtifactPackage", () => {
  it.live("atomically updates, reconciles, trashes, and restores owned bytes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-package-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scope = ProjectArtifact.StorageID.make("11111111-1111-4111-8111-111111111111")
          const root = path.join(tmp.path, scope)
          const scopeID = ProjectArtifact.ScopeID.make("pas_scope")
          yield* Effect.promise(() => writeScope(root, scopeID, scope))
          const first = ProjectArtifactPackage.marker({
            scopeID,
            storageID: scope,
            kind: "skill",
            id: ProjectArtifact.ID.make("review"),
            versionID: ProjectArtifact.VersionID.make("pav_first"),
            content: "first",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
          const second = ProjectArtifactPackage.marker({
            ...first,
            versionID: ProjectArtifact.VersionID.make("pav_second"),
            content: "second",
          })
          yield* ProjectArtifactPackage.commit({
            root,
            marker: second,
            content: "second",
            expectedVersionID: first.versionID,
          })
          expect(
            yield* Effect.promise(() =>
              fs.readFile(ProjectArtifactPackage.activeContentPath(root, "skill", "review"), "utf8"),
            ),
          ).toBe("second")
          expect(
            yield* Effect.promise(() => fs.readFile(ProjectArtifactPackage.versionContentPath(root, first), "utf8")),
          ).toBe("first")
          expect((yield* ProjectArtifactPackage.reconcile(root)).map((item) => item.versionID)).toContain(
            second.versionID,
          )

          const deletionID = ProjectArtifact.DeletionID.make("pad_delete")
          yield* ProjectArtifactPackage.trash({ root, marker: second, deletionID })
          expect(
            yield* Effect.promise(() =>
              Bun.file(ProjectArtifactPackage.activeContentPath(root, "skill", "review")).exists(),
            ),
          ).toBe(false)
          yield* ProjectArtifactPackage.restore({ root, marker: second, deletionID })
          expect(
            yield* Effect.promise(() =>
              fs.readFile(ProjectArtifactPackage.activeContentPath(root, "skill", "review"), "utf8"),
            ),
          ).toBe("second")
        }),
      ),
    ),
  )

  it.live("serializes concurrent same-base updates and leaves one complete version", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-lock-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_scope")
          const storageID = ProjectArtifact.StorageID.make("22222222-2222-4222-8222-222222222222")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("review"),
            versionID: ProjectArtifact.VersionID.make("pav_original"),
            content: "original",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "original" })
          const results = yield* Effect.all(
            ["one", "two"].map((content) =>
              ProjectArtifactPackage.commit({
                root,
                marker: ProjectArtifactPackage.marker({
                  ...original,
                  versionID: ProjectArtifact.VersionID.make(`pav_${content}`),
                  content,
                }),
                content,
                expectedVersionID: original.versionID,
              }).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              ),
            ),
            { concurrency: "unbounded" },
          )
          expect(results.filter(Boolean)).toHaveLength(1)
          expect(results.filter((result) => !result)).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live("restores the old complete version when archiving fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-compensation-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_compensation")
          const storageID = ProjectArtifact.StorageID.make("33333333-3333-4333-8333-333333333333")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("review"),
            versionID: ProjectArtifact.VersionID.make("pav_compensation-original"),
            content: "original",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "original" })
          const metadata = path.dirname(ProjectArtifactPackage.activeMarkerPath(root, "skill", "review"))
          yield* Effect.promise(() => fs.chmod(metadata, 0o500))
          const result = yield* ProjectArtifactPackage.commit({
            root,
            marker: ProjectArtifactPackage.marker({
              ...original,
              versionID: ProjectArtifact.VersionID.make("pav_compensation-new"),
              content: "new",
            }),
            content: "new",
            expectedVersionID: original.versionID,
          }).pipe(
            Effect.as("success" as const),
            Effect.catch(() => Effect.succeed("failure" as const)),
            Effect.ensuring(Effect.promise(() => fs.chmod(metadata, 0o700))),
          )
          expect(result).toBe("failure")
          expect(
            yield* Effect.promise(() =>
              fs.readFile(ProjectArtifactPackage.activeContentPath(root, "skill", "review"), "utf8"),
            ),
          ).toBe("original")
        }),
      ),
    ),
  )

  it.live("rejects symlink roots, intermediate directories, and pre-existing content symlinks", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-symlink-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scopeID = ProjectArtifact.ScopeID.make("pas_symlink")
          const storageID = ProjectArtifact.StorageID.make("44444444-4444-4444-8444-444444444444")
          const root = path.join(tmp.path, "scope")
          const linkedRoot = path.join(tmp.path, "linked-scope")
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID)
            await fs.symlink(root, linkedRoot)
          })
          const marker = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("symlink-check"),
            versionID: ProjectArtifact.VersionID.make("pav_symlink-root"),
            content: "root",
          })
          expect(
            yield* ProjectArtifactPackage.commit({ root: linkedRoot, marker, content: "root" }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("OwnershipMismatch")

          const outside = path.join(tmp.path, "outside")
          yield* Effect.promise(async () => {
            await fs.mkdir(outside)
            await fs.symlink(outside, path.join(root, "active"))
          })
          expect(
            yield* ProjectArtifactPackage.commit({ root, marker, content: "root" }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("OwnershipMismatch")
          expect(
            yield* Effect.promise(() => Bun.file(path.join(outside, "skills", "symlink-check", "SKILL.md")).exists()),
          ).toBe(false)

          yield* Effect.promise(async () => {
            await fs.rm(path.join(root, "active"))
            const contentPath = ProjectArtifactPackage.activeContentPath(root, "skill", "symlink-check")
            await fs.mkdir(path.dirname(contentPath), { recursive: true })
            await fs.writeFile(path.join(tmp.path, "outside-content"), "outside")
            await fs.symlink(path.join(tmp.path, "outside-content"), contentPath)
          })
          expect(
            yield* ProjectArtifactPackage.commit({ root, marker, content: "root" }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("OwnershipMismatch")

          yield* Effect.promise(async () => {
            await fs.rm(ProjectArtifactPackage.activeContentPath(root, "skill", "symlink-check"), { force: true })
            const markerPath = ProjectArtifactPackage.activeMarkerPath(root, "skill", "symlink-check")
            await fs.mkdir(path.dirname(markerPath), { recursive: true })
            await fs.writeFile(path.join(tmp.path, "outside-marker"), JSON.stringify(marker))
            await fs.symlink(path.join(tmp.path, "outside-marker"), markerPath)
          })
          expect(
            yield* ProjectArtifactPackage.commit({ root, marker, content: "root" }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("OwnershipMismatch")
        }),
      ),
    ),
  )

  it.live("uses the injected filesystem boundary and restores the old version after an active-marker failure", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-injected-failure-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_injected")
          const storageID = ProjectArtifact.StorageID.make("55555555-5555-4555-8555-555555555555")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("injected"),
            versionID: ProjectArtifact.VersionID.make("pav_injected-old"),
            content: "old",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
          const attempted = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_injected-new"),
            content: "new",
          })
          const result = yield* ProjectArtifactPackage.commit({
            root,
            marker: attempted,
            content: "new",
            expectedVersionID: original.versionID,
            filesystem: {
              ...nativeFilesystem,
              beforeMutation: async (mutation) => {
                if (
                  mutation.operation === "rename" &&
                  mutation.destination === ProjectArtifactPackage.activeMarkerPath(root, "command", "injected")
                ) {
                  throw new Error("injected marker rename failure")
                }
              },
            },
          }).pipe(
            Effect.as("success" as const),
            Effect.catch(() => Effect.succeed("failure" as const)),
          )
          expect(result).toBe("failure")
          expect(
            yield* Effect.promise(() =>
              fs.readFile(ProjectArtifactPackage.activeContentPath(root, "command", "injected"), "utf8"),
            ),
          ).toBe("old")
          expect((yield* ProjectArtifactPackage.readActive(root, "command", "injected"))?.versionID).toBe(
            original.versionID,
          )
        }),
      ),
    ),
  )

  it.live("compensates a disable failure after the content rename", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-disable-compensation-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_disable-compensation")
          const storageID = ProjectArtifact.StorageID.make("56565656-5656-4565-8565-565656565656")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const current = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("disable-compensation"),
            versionID: ProjectArtifact.VersionID.make("pav_disable-compensation"),
            content: "current",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: current, content: "current" })
          const disabled = path.join(root, "disabled", current.kind, current.id, current.versionID)
          const result = yield* ProjectArtifactPackage.disable({
            root,
            marker: current,
            filesystem: {
              ...nativeFilesystem,
              beforeMutation: async (mutation) => {
                if (
                  mutation.operation === "rename" &&
                  mutation.destination === path.join(disabled, ".ycoding-project-artifact.json")
                ) {
                  throw new Error("injected disabled marker rename failure")
                }
              },
            },
          }).pipe(
            Effect.as("success" as const),
            Effect.catch(() => Effect.succeed("failure" as const)),
          )
          expect(result).toBe("failure")
          expect(yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.activeContentPath(root, current.kind, current.id)).exists())).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.activeMarkerPath(root, current.kind, current.id)).exists())).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(path.join(disabled, current.contentRelpath)).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(path.join(disabled, ".ycoding-project-artifact.json")).exists())).toBe(false)
        }),
      ),
    ),
  )

  it.live("reconciles and exactly retries every state-mutation rename after process loss", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-state-recovery-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.forEach(
          [
            { operation: "disable" as const, boundaries: 2 },
            { operation: "enable" as const, boundaries: 2 },
            { operation: "rollback" as const, boundaries: 4 },
          ],
          (scenario) =>
            Effect.forEach(
              [false, true],
              (standard) =>
                Effect.forEach(
                  Array.from({ length: scenario.boundaries }, (_, index) => index + 1),
                  (boundary) =>
                    Effect.gen(function* () {
                      const suffix = `${scenario.operation}-${standard ? "global" : "project"}-${boundary}`
                      const root = path.join(tmp.path, suffix, "scope")
                      const scopeID = ProjectArtifact.ScopeID.make(`pas_${suffix}`)
                      const storageID = ProjectArtifact.StorageID.make(
                        `${boundary}${boundary}${boundary}${boundary}${boundary}${boundary}${boundary}${boundary}-1111-4111-8111-${scenario.operation === "rollback" ? "333333333333" : scenario.operation === "enable" ? "222222222222" : "111111111111"}`,
                      )
                      yield* Effect.promise(() => writeScope(root, scopeID, storageID, standard ? "global" : "project"))
                      const first = ProjectArtifactPackage.marker({
                        scopeID,
                        storageID,
                        kind: "command",
                        id: ProjectArtifact.ID.make(suffix),
                        versionID: ProjectArtifact.VersionID.make(`pav_${suffix}-first`),
                        content: "first",
                      })
                      const second = ProjectArtifactPackage.marker({
                        ...first,
                        versionID: ProjectArtifact.VersionID.make(`pav_${suffix}-second`),
                        content: "second",
                      })
                      const contentPath = standard
                        ? path.join(tmp.path, suffix, "commands", `${first.id}.md`)
                        : ProjectArtifactPackage.activeContentPath(root, first.kind, first.id)
                      const markerPath = standard
                        ? path.join(tmp.path, suffix, "commands", `.${first.id}.ycoding-project-artifact.json`)
                        : ProjectArtifactPackage.activeMarkerPath(root, first.kind, first.id)
                      if (standard) {
                        yield* Effect.promise(() => fs.mkdir(path.dirname(contentPath), { recursive: true }))
                        yield* ProjectArtifactPackage.commitStandard({ root, marker: first, content: "first", contentPath, markerPath })
                      } else {
                        yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
                      }
                      if (scenario.operation === "rollback") {
                        if (standard) {
                          yield* ProjectArtifactPackage.commitStandard({
                            root,
                            marker: second,
                            content: "second",
                            expectedVersionID: first.versionID,
                            contentPath,
                            markerPath,
                          })
                        } else {
                          yield* ProjectArtifactPackage.commit({
                            root,
                            marker: second,
                            content: "second",
                            expectedVersionID: first.versionID,
                          })
                        }
                      }
                      if (scenario.operation === "enable") {
                        if (standard) {
                          yield* ProjectArtifactPackage.disableStandard({ root, marker: first, contentPath, markerPath })
                        } else {
                          yield* ProjectArtifactPackage.disable({ root, marker: first })
                        }
                      }
                      const current = scenario.operation === "rollback" ? second : first
                      const state = { renames: 0, crashed: false }
                      const filesystem = {
                        ...nativeFilesystem,
                        beforeMutation: async () => {
                          if (state.crashed) throw new Error("simulated process loss")
                        },
                        afterMutation: async (mutation: { readonly operation: string; readonly source?: string; readonly destination?: string }) => {
                          if (
                            mutation.operation !== "rename" ||
                            mutation.source?.includes(`${path.sep}staging${path.sep}`) ||
                            mutation.destination?.includes(`${path.sep}staging${path.sep}`)
                          ) {
                            return
                          }
                          state.renames++
                          if (state.renames !== boundary) return
                          state.crashed = true
                          throw new Error("simulated process loss")
                        },
                      }
                      const operationID = `pop_${suffix}`
                      const mutate = scenario.operation === "rollback"
                        ? standard
                          ? ProjectArtifactPackage.rollbackStandard({
                              root,
                              current,
                              target: first,
                              contentPath,
                              markerPath,
                              operationID,
                              filesystem,
                            })
                          : ProjectArtifactPackage.rollback({ root, current, target: first, operationID, filesystem })
                        : scenario.operation === "enable"
                          ? standard
                            ? ProjectArtifactPackage.enableStandard({ root, marker: current, contentPath, markerPath, operationID, filesystem })
                            : ProjectArtifactPackage.enable({ root, marker: current, operationID, filesystem })
                          : standard
                            ? ProjectArtifactPackage.disableStandard({ root, marker: current, contentPath, markerPath, operationID, filesystem })
                            : ProjectArtifactPackage.disable({ root, marker: current, operationID, filesystem })
                      expect(
                        yield* mutate.pipe(
                          Effect.as("success" as const),
                          Effect.catch(() => Effect.succeed("failure" as const)),
                        ),
                      ).toBe("failure")
                      yield* ProjectArtifactPackage.reconcile(root)
                      const restoredMarkerExists = yield* Effect.promise(() => Bun.file(markerPath).exists())
                      const restoredMarker = restoredMarkerExists
                        ? decodeMarker(yield* Effect.promise(() => fs.readFile(markerPath, "utf8")))
                        : undefined
                      expect(restoredMarker?.versionID).toBe(
                        scenario.operation === "enable" ? undefined : current.versionID,
                      )
                      if (scenario.operation === "enable") {
                        expect(
                          yield* Effect.promise(() =>
                            Bun.file(path.join(root, "disabled", current.kind, current.id, current.versionID, current.contentRelpath)).exists(),
                          ),
                        ).toBe(true)
                      }
                      if (scenario.operation === "rollback") {
                        expect(yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).exists())).toBe(true)
                      }
                      if (scenario.operation === "rollback") {
                        if (standard) {
                          yield* ProjectArtifactPackage.rollbackStandard({ root, current, target: first, contentPath, markerPath, operationID })
                        } else {
                          yield* ProjectArtifactPackage.rollback({ root, current, target: first, operationID })
                        }
                      } else if (scenario.operation === "enable") {
                        if (standard) {
                          yield* ProjectArtifactPackage.enableStandard({ root, marker: current, contentPath, markerPath, operationID })
                        } else {
                          yield* ProjectArtifactPackage.enable({ root, marker: current, operationID })
                        }
                      } else if (standard) {
                        yield* ProjectArtifactPackage.disableStandard({ root, marker: current, contentPath, markerPath, operationID })
                      } else {
                        yield* ProjectArtifactPackage.disable({ root, marker: current, operationID })
                      }
                      const finalMarkerExists = yield* Effect.promise(() => Bun.file(markerPath).exists())
                      const finalMarker = finalMarkerExists
                        ? decodeMarker(yield* Effect.promise(() => fs.readFile(markerPath, "utf8")))
                        : undefined
                      expect(finalMarker?.versionID).toBe(
                        scenario.operation === "disable" ? undefined : scenario.operation === "rollback" ? first.versionID : current.versionID,
                      )
                    }),
                  { discard: true },
                ),
              { discard: true },
            ),
          { discard: true },
        ),
      ),
    ),
    30_000,
  )

  it.live("compensates state bytes when durable finalization rolls back", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-state-finalize-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_state-finalize")
          const storageID = ProjectArtifact.StorageID.make("57575757-5757-4575-8575-575757575757")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const current = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("state-finalize"),
            versionID: ProjectArtifact.VersionID.make("pav_state-finalize"),
            content: "current",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: current, content: "current" })
          const hooks = { aborted: false }
          expect(
            yield* ProjectArtifactPackage.stateTransaction(
              {
                root,
                operationID: "pop_state-finalize",
                operation: "disable",
                current,
              },
              {
                reserve: () => Effect.void,
                finalize: () => Effect.fail("database rollback" as const),
                abort: () => Effect.sync(() => {
                  hooks.aborted = true
                }),
              },
            ).pipe(
              Effect.as("success" as const),
              Effect.catch(() => Effect.succeed("failure" as const)),
            ),
          ).toBe("failure")
          expect(hooks.aborted).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.activeContentPath(root, current.kind, current.id)).text())).toBe("current")
          expect((yield* ProjectArtifactPackage.readActive(root, current.kind, current.id))?.versionID).toBe(current.versionID)
          expect(yield* Effect.promise(() => Bun.file(path.join(root, "staging", "pop_state-finalize")).exists())).toBe(false)
        }),
      ),
    ),
  )

  it.live("keeps finalized state bytes when post-finalize journal cleanup fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-state-post-finalize-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.forEach(
          [
            { standard: false, failure: "committed-write" as const },
            { standard: false, failure: "staging-remove" as const },
            { standard: true, failure: "committed-write" as const },
            { standard: true, failure: "staging-remove" as const },
          ],
          (scenario, index) =>
            Effect.gen(function* () {
              const suffix = `${scenario.standard ? "global" : "project"}-${scenario.failure}`
              const root = path.join(tmp.path, suffix, "scope")
              const scopeID = ProjectArtifact.ScopeID.make(`pas_state-${suffix}`)
              const storageID = ProjectArtifact.StorageID.make(
                `5858585${index}-5858-4585-8585-585858585858`,
              )
              yield* Effect.promise(() => writeScope(root, scopeID, storageID, scenario.standard ? "global" : "project"))
              const current = ProjectArtifactPackage.marker({
                scopeID,
                storageID,
                kind: "command",
                id: ProjectArtifact.ID.make(`state-${suffix}`),
                versionID: ProjectArtifact.VersionID.make(`pav_state-${suffix}`),
                content: "current",
              })
              const contentPath = scenario.standard
                ? path.join(tmp.path, suffix, "commands", `${current.id}.md`)
                : ProjectArtifactPackage.activeContentPath(root, current.kind, current.id)
              const markerPath = scenario.standard
                ? path.join(tmp.path, suffix, "commands", `.${current.id}.ycoding-project-artifact.json`)
                : ProjectArtifactPackage.activeMarkerPath(root, current.kind, current.id)
              if (scenario.standard) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(contentPath), { recursive: true }))
                yield* ProjectArtifactPackage.commitStandard({ root, marker: current, content: "current", contentPath, markerPath })
              } else {
                yield* ProjectArtifactPackage.commit({ root, marker: current, content: "current" })
              }
              const operationID = `pop_state-${suffix}`
              const stageRoot = path.join(root, "staging", operationID)
              const state = { finalized: false, finalizeCount: 0, abortCount: 0, failed: false }
              const result = yield* ProjectArtifactPackage.stateTransaction(
                {
                  root,
                  operationID,
                  operation: "disable",
                  current,
                  ...(scenario.standard ? { contentPath, markerPath } : {}),
                  filesystem: {
                    ...nativeFilesystem,
                    beforeMutation: async (mutation) => {
                      if (!state.finalized || state.failed) return
                      const committedWrite =
                        scenario.failure === "committed-write" &&
                        mutation.operation === "write" &&
                        mutation.path?.includes(".ycoding-state-operation.json.")
                      const stagingRemove =
                        scenario.failure === "staging-remove" &&
                        mutation.operation === "remove" &&
                        mutation.path === stageRoot
                      if (!committedWrite && !stagingRemove) return
                      state.failed = true
                      throw new Error(`post-finalize ${scenario.failure}`)
                    },
                  },
                },
                {
                  reserve: () => Effect.void,
                  finalize: () => Effect.sync(() => {
                    state.finalized = true
                    state.finalizeCount++
                  }),
                  abort: () => Effect.sync(() => {
                    state.abortCount++
                  }),
                },
              ).pipe(
                Effect.as("success" as const),
                Effect.catch(() => Effect.succeed("failure" as const)),
              )
              expect(result).toBe("success")
              expect(state.finalizeCount).toBe(1)
              expect(state.abortCount).toBe(0)
              expect(yield* Effect.promise(() => Bun.file(contentPath).exists())).toBe(false)
              const disabled = path.join(root, "disabled", current.kind, current.id, current.versionID)
              expect(yield* Effect.promise(() => Bun.file(path.join(disabled, current.contentRelpath)).text())).toBe("current")
              expect(
                decodeMarker(yield* Effect.promise(() => fs.readFile(path.join(disabled, ".ycoding-project-artifact.json"), "utf8"))).versionID,
              ).toBe(current.versionID)
              const journal = (yield* ProjectArtifactPackage.readStateTransactions(root))[0]
              expect(journal?.phase).toBe(scenario.failure === "committed-write" ? "finalizing" : "committed")
              if (!journal) return
              yield* ProjectArtifactPackage.cleanupStateTransaction(journal)
              yield* ProjectArtifactPackage.cleanupStateTransaction(journal)
              expect(yield* Effect.promise(() => Bun.file(stageRoot).exists())).toBe(false)
            }),
          { discard: true },
        ),
      ),
    ),
  )

  it.live("keeps finalized commit bytes when post-finalize journal cleanup fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-commit-post-finalize-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.forEach(
          [
            { standard: false, failure: "committed-write" as const },
            { standard: false, failure: "staging-remove" as const },
            { standard: true, failure: "committed-write" as const },
            { standard: true, failure: "staging-remove" as const },
          ],
          (scenario, index) =>
            Effect.gen(function* () {
              const suffix = `${scenario.standard ? "global" : "project"}-${scenario.failure}`
              const root = path.join(tmp.path, suffix, "scope")
              const scopeID = ProjectArtifact.ScopeID.make(`pas_commit-${suffix}`)
              const storageID = ProjectArtifact.StorageID.make(
                `5959595${index}-5959-4595-8595-595959595959`,
              )
              yield* Effect.promise(() => writeScope(root, scopeID, storageID, scenario.standard ? "global" : "project"))
              const first = ProjectArtifactPackage.marker({
                scopeID,
                storageID,
                kind: "command",
                id: ProjectArtifact.ID.make(`commit-${suffix}`),
                versionID: ProjectArtifact.VersionID.make(`pav_commit-${suffix}-first`),
                content: "first",
              })
              const second = ProjectArtifactPackage.marker({
                ...first,
                versionID: ProjectArtifact.VersionID.make(`pav_commit-${suffix}-second`),
                content: "second",
              })
              const contentPath = scenario.standard
                ? path.join(tmp.path, suffix, "commands", `${first.id}.md`)
                : ProjectArtifactPackage.activeContentPath(root, first.kind, first.id)
              const markerPath = scenario.standard
                ? path.join(tmp.path, suffix, "commands", `.${first.id}.ycoding-project-artifact.json`)
                : ProjectArtifactPackage.activeMarkerPath(root, first.kind, first.id)
              if (scenario.standard) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(contentPath), { recursive: true }))
                yield* ProjectArtifactPackage.commitStandard({ root, marker: first, content: "first", contentPath, markerPath })
              } else {
                yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
              }
              const operationID = `pop_commit-${suffix}`
              const stageRoot = path.join(root, "staging", operationID)
              const state = { finalized: false, finalizeCount: 0, abortCount: 0, failed: false }
              const result = yield* ProjectArtifactPackage.commitTransaction(
                {
                  root,
                  marker: second,
                  content: "second",
                  expectedVersionID: first.versionID,
                  operationID,
                  ...(scenario.standard ? { contentPath, markerPath } : {}),
                  filesystem: {
                    ...nativeFilesystem,
                    beforeMutation: async (mutation) => {
                      if (!state.finalized || state.failed) return
                      const committedWrite =
                        scenario.failure === "committed-write" &&
                        mutation.operation === "write" &&
                        mutation.path?.includes(".ycoding-operation.json.")
                      const stagingRemove =
                        scenario.failure === "staging-remove" &&
                        mutation.operation === "remove" &&
                        mutation.path === stageRoot
                      if (!committedWrite && !stagingRemove) return
                      state.failed = true
                      throw new Error(`post-finalize ${scenario.failure}`)
                    },
                  },
                },
                {
                  reserve: () => Effect.void,
                  finalize: () => Effect.sync(() => {
                    state.finalized = true
                    state.finalizeCount++
                  }),
                  abort: () => Effect.sync(() => {
                    state.abortCount++
                  }),
                },
              ).pipe(
                Effect.as("success" as const),
                Effect.catch(() => Effect.succeed("failure" as const)),
              )
              expect(result).toBe("success")
              expect(state.finalizeCount).toBe(1)
              expect(state.abortCount).toBe(0)
              expect(yield* Effect.promise(() => Bun.file(contentPath).text())).toBe("second")
              expect(decodeMarker(yield* Effect.promise(() => fs.readFile(markerPath, "utf8"))).versionID).toBe(second.versionID)
              expect(yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).text())).toBe("first")
              const journal = (yield* ProjectArtifactPackage.readCommitTransactions(root))[0]
              expect(journal?.phase).toBe(scenario.failure === "committed-write" ? "finalizing" : "committed")
              if (!journal) return
              yield* ProjectArtifactPackage.cleanupCommitTransaction(journal)
              yield* ProjectArtifactPackage.cleanupCommitTransaction(journal)
              expect(yield* Effect.promise(() => Bun.file(stageRoot).exists())).toBe(false)
            }),
          { discard: true },
        ),
      ),
    ),
  )

  it.live("does not cross back into compensation when interrupted after finalize", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-post-finalize-interrupt-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.forEach(
          [
            { operation: "state" as const, standard: false },
            { operation: "state" as const, standard: true },
            { operation: "commit" as const, standard: false },
            { operation: "commit" as const, standard: true },
          ],
          (scenario, index) =>
            Effect.gen(function* () {
              const suffix = `${scenario.operation}-${scenario.standard ? "global" : "project"}`
              const root = path.join(tmp.path, suffix, "scope")
              const scopeID = ProjectArtifact.ScopeID.make(`pas_interrupt-${suffix}`)
              const storageID = ProjectArtifact.StorageID.make(
                `6060606${index}-6060-4606-8606-606060606060`,
              )
              yield* Effect.promise(() => writeScope(root, scopeID, storageID, scenario.standard ? "global" : "project"))
              const first = ProjectArtifactPackage.marker({
                scopeID,
                storageID,
                kind: "command",
                id: ProjectArtifact.ID.make(`interrupt-${suffix}`),
                versionID: ProjectArtifact.VersionID.make(`pav_interrupt-${suffix}-first`),
                content: "first",
              })
              const second = ProjectArtifactPackage.marker({
                ...first,
                versionID: ProjectArtifact.VersionID.make(`pav_interrupt-${suffix}-second`),
                content: "second",
              })
              const contentPath = scenario.standard
                ? path.join(tmp.path, suffix, "commands", `${first.id}.md`)
                : ProjectArtifactPackage.activeContentPath(root, first.kind, first.id)
              const markerPath = scenario.standard
                ? path.join(tmp.path, suffix, "commands", `.${first.id}.ycoding-project-artifact.json`)
                : ProjectArtifactPackage.activeMarkerPath(root, first.kind, first.id)
              if (scenario.standard) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(contentPath), { recursive: true }))
                yield* ProjectArtifactPackage.commitStandard({ root, marker: first, content: "first", contentPath, markerPath })
              } else {
                yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
              }
              const cleanupEntered = Promise.withResolvers<void>()
              const releaseCleanup = Promise.withResolvers<void>()
              const state = { finalized: false, finalizeCount: 0, abortCount: 0 }
              const filesystem = {
                ...nativeFilesystem,
                beforeMutation: async (mutation: { readonly operation: string; readonly path?: string }) => {
                  if (
                    !state.finalized ||
                    mutation.operation !== "write" ||
                    !mutation.path?.includes(
                      scenario.operation === "state" ? ".ycoding-state-operation.json." : ".ycoding-operation.json.",
                    )
                  ) {
                    return
                  }
                  cleanupEntered.resolve()
                  await releaseCleanup.promise
                },
              }
              const hooks = {
                reserve: () => Effect.void,
                finalize: () => Effect.sync(() => {
                  state.finalized = true
                  state.finalizeCount++
                }),
                abort: () => Effect.sync(() => {
                  state.abortCount++
                }),
              }
              const transaction = scenario.operation === "state"
                ? ProjectArtifactPackage.stateTransaction(
                    {
                      root,
                      operationID: `pop_interrupt-${suffix}`,
                      operation: "disable",
                      current: first,
                      ...(scenario.standard ? { contentPath, markerPath } : {}),
                      filesystem,
                    },
                    hooks,
                  )
                : ProjectArtifactPackage.commitTransaction(
                    {
                      root,
                      marker: second,
                      content: "second",
                      expectedVersionID: first.versionID,
                      operationID: `pop_interrupt-${suffix}`,
                      ...(scenario.standard ? { contentPath, markerPath } : {}),
                      filesystem,
                    },
                    hooks,
                  )
              const transactionFiber = yield* Effect.forkChild(transaction)
              yield* Effect.promise(() => cleanupEntered.promise)
              const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(transactionFiber))
              releaseCleanup.resolve()
              yield* Fiber.join(interruptFiber)
              const exit = yield* Fiber.await(transactionFiber)
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
              expect(state.finalizeCount).toBe(1)
              expect(state.abortCount).toBe(0)
              if (scenario.operation === "state") {
                expect(yield* Effect.promise(() => Bun.file(contentPath).exists())).toBe(false)
                expect(
                  yield* Effect.promise(() =>
                    Bun.file(path.join(root, "disabled", first.kind, first.id, first.versionID, first.contentRelpath)).text(),
                  ),
                ).toBe("first")
              } else {
                expect(yield* Effect.promise(() => Bun.file(contentPath).text())).toBe("second")
                expect(decodeMarker(yield* Effect.promise(() => fs.readFile(markerPath, "utf8"))).versionID).toBe(second.versionID)
              }
            }),
          { discard: true },
        ),
      ),
    ),
  )

  it.live("quarantines markers that disagree with scope ownership or their metadata path", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-marker-binding-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_marker-scope")
          const storageID = ProjectArtifact.StorageID.make("66666666-6666-4666-8666-666666666666")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const copied = ProjectArtifactPackage.marker({
            scopeID: ProjectArtifact.ScopeID.make("pas_other-scope"),
            storageID: ProjectArtifact.StorageID.make("77777777-7777-4777-8777-777777777777"),
            kind: "skill",
            id: ProjectArtifact.ID.make("copied"),
            versionID: ProjectArtifact.VersionID.make("pav_copied"),
            content: "copied",
          })
          const mismatched = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("actual-id"),
            versionID: ProjectArtifact.VersionID.make("pav_path-mismatch"),
            content: "mismatch",
          })
          yield* Effect.promise(async () => {
            const copiedContent = ProjectArtifactPackage.activeContentPath(root, "skill", "copied")
            const copiedMarker = ProjectArtifactPackage.activeMarkerPath(root, "skill", "copied")
            await fs.mkdir(path.dirname(copiedContent), { recursive: true })
            await fs.mkdir(path.dirname(copiedMarker), { recursive: true })
            await fs.writeFile(copiedContent, "copied")
            await fs.writeFile(copiedMarker, JSON.stringify(copied))
            const actualContent = ProjectArtifactPackage.activeContentPath(root, "command", "actual-id")
            const wrongMarker = ProjectArtifactPackage.activeMarkerPath(root, "command", "wrong-id")
            await fs.mkdir(path.dirname(actualContent), { recursive: true })
            await fs.mkdir(path.dirname(wrongMarker), { recursive: true })
            await fs.writeFile(actualContent, "mismatch")
            await fs.writeFile(wrongMarker, JSON.stringify(mismatched))

            const malformedMarker = ProjectArtifactPackage.activeMarkerPath(root, "agent", "malformed")
            const malformedContent = ProjectArtifactPackage.activeContentPath(root, "agent", "malformed")
            await fs.mkdir(path.dirname(malformedMarker), { recursive: true })
            await fs.mkdir(path.dirname(malformedContent), { recursive: true })
            await fs.writeFile(malformedMarker, "not-json")
            await fs.writeFile(malformedContent, "malformed")

            const digest = ProjectArtifactPackage.marker({
              scopeID,
              storageID,
              kind: "skill",
              id: ProjectArtifact.ID.make("bad-digest"),
              versionID: ProjectArtifact.VersionID.make("pav_bad-digest"),
              content: "expected",
            })
            const digestMarker = ProjectArtifactPackage.activeMarkerPath(root, "skill", "bad-digest")
            const digestContent = ProjectArtifactPackage.activeContentPath(root, "skill", "bad-digest")
            await fs.mkdir(path.dirname(digestMarker), { recursive: true })
            await fs.mkdir(path.dirname(digestContent), { recursive: true })
            await fs.writeFile(digestMarker, JSON.stringify(digest))
            await fs.writeFile(digestContent, "tampered")
          })
          expect(yield* ProjectArtifactPackage.reconcile(root)).toEqual([])
          expect(
            yield* Effect.promise(() =>
              Bun.file(ProjectArtifactPackage.activeMarkerPath(root, "skill", "copied")).exists(),
            ),
          ).toBe(false)
          expect(
            yield* Effect.promise(() =>
              Bun.file(ProjectArtifactPackage.activeMarkerPath(root, "command", "wrong-id")).exists(),
            ),
          ).toBe(false)
          const quarantined = yield* Effect.promise(() =>
            Array.fromAsync(new Bun.Glob("quarantine/**/*").scan({ cwd: root, onlyFiles: true })),
          )
          expect(quarantined.length).toBeGreaterThan(0)
        }),
      ),
    ),
  )

  it.live("compensates every update rename boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-rename-boundaries-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scopeID = ProjectArtifact.ScopeID.make("pas_boundaries")
          const storageID = ProjectArtifact.StorageID.make("88888888-8888-4888-8888-888888888888")
          for (const boundary of [1, 2, 3, 4]) {
            const root = path.join(tmp.path, `scope-${boundary}`)
            yield* Effect.promise(() => writeScope(root, scopeID, storageID))
            const original = ProjectArtifactPackage.marker({
              scopeID,
              storageID,
              kind: "command",
              id: ProjectArtifact.ID.make("boundary"),
              versionID: ProjectArtifact.VersionID.make(`pav_old-${boundary}`),
              content: "old",
            })
            yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
            const attempted = ProjectArtifactPackage.marker({
              ...original,
              versionID: ProjectArtifact.VersionID.make(`pav_new-${boundary}`),
              content: "new",
            })
            const renames = { value: 0 }
            const destinations = new Set([
              ProjectArtifactPackage.versionContentPath(root, original),
              ProjectArtifactPackage.versionMarkerPath(root, original),
              ProjectArtifactPackage.activeContentPath(root, "command", "boundary"),
              ProjectArtifactPackage.activeMarkerPath(root, "command", "boundary"),
            ])
            const result = yield* ProjectArtifactPackage.commit({
              root,
              marker: attempted,
              content: "new",
              expectedVersionID: original.versionID,
              filesystem: {
                ...nativeFilesystem,
                beforeMutation: async (mutation) => {
                  if (
                    mutation.operation !== "rename" ||
                    !mutation.destination ||
                    !destinations.has(mutation.destination)
                  )
                    return
                  renames.value++
                  if (renames.value === boundary) throw new Error(`rename boundary ${boundary}`)
                },
              },
            }).pipe(
              Effect.as("success" as const),
              Effect.catch(() => Effect.succeed("failure" as const)),
            )
            expect(result).toBe("failure")
            expect(
              yield* Effect.promise(() =>
                fs.readFile(ProjectArtifactPackage.activeContentPath(root, "command", "boundary"), "utf8"),
              ),
            ).toBe("old")
            expect((yield* ProjectArtifactPackage.readActive(root, "command", "boundary"))?.versionID).toBe(
              original.versionID,
            )
          }
        }),
      ),
    ),
  )

  it.live("reconciles a restart after content availability but before marker availability", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-restart-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_restart")
          const storageID = ProjectArtifact.StorageID.make("99999999-9999-4999-8999-999999999999")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("restart"),
            versionID: ProjectArtifact.VersionID.make("pav_restart-old"),
            content: "old",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
          const attempted = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_restart-new"),
            content: "new",
          })
          yield* ProjectArtifactPackage.withArtifactLock(
            { root, marker: attempted },
            Effect.gen(function* () {
              const prepared = yield* ProjectArtifactPackage.prepareCommit({
                root,
                marker: attempted,
                content: "new",
                expectedVersionID: original.versionID,
              })
              const result = yield* ProjectArtifactPackage.makeAvailable(prepared, {
                ...nativeFilesystem,
                beforeMutation: async (mutation) => {
                  if (
                    mutation.operation === "rename" &&
                    mutation.destination === ProjectArtifactPackage.activeMarkerPath(root, "skill", "restart")
                  ) {
                    throw new Error("simulated process loss before marker rename")
                  }
                },
              }).pipe(
                Effect.as("success" as const),
                Effect.catch(() => Effect.succeed("crashed" as const)),
              )
              expect(result).toBe("crashed")
            }),
          )

          const reconciled = yield* ProjectArtifactPackage.reconcile(root)
          expect(reconciled.map((item) => item.versionID)).toEqual([attempted.versionID])
          expect(
            yield* Effect.promise(() =>
              fs.readFile(ProjectArtifactPackage.activeContentPath(root, "skill", "restart"), "utf8"),
            ),
          ).toBe("new")
          expect((yield* ProjectArtifactPackage.readActive(root, "skill", "restart"))?.versionID).toBe(
            attempted.versionID,
          )
          expect(
            yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, original)).exists()),
          ).toBe(true)
          const retryPhases: ProjectArtifactPackage.CommitTransactionPhase[] = []
          yield* ProjectArtifactPackage.commitTransaction(
            { root, marker: attempted, content: "new", expectedVersionID: original.versionID },
            {
              reserve: (metadata) => Effect.sync(() => retryPhases.push(metadata.phase)),
              finalize: (metadata) => Effect.sync(() => retryPhases.push(metadata.phase)),
              abort: () => Effect.void,
            },
          )
          expect(retryPhases).toEqual(["available", "available"])
          expect(yield* ProjectArtifactPackage.readCommitTransactions(root)).toEqual([])
        }),
      ),
    ),
  )

  it.live("rejects a mutation-time symlink replacement before writing outside the scope", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-race-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const outside = path.join(tmp.path, "outside")
          const scopeID = ProjectArtifact.ScopeID.make("pas_race")
          const storageID = ProjectArtifact.StorageID.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID)
            await fs.mkdir(outside)
          })
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("race"),
            versionID: ProjectArtifact.VersionID.make("pav_race-old"),
            content: "old",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
          const attempted = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_race-new"),
            content: "new",
          })
          let replaced = false
          const result = yield* ProjectArtifactPackage.commit({
            root,
            marker: attempted,
            content: "new",
            expectedVersionID: original.versionID,
            filesystem: {
              ...nativeFilesystem,
              beforeMutation: async (mutation) => {
                if (replaced || mutation.operation !== "rename") return
                if (mutation.destination !== ProjectArtifactPackage.activeContentPath(root, "skill", "race")) return
                replaced = true
                await fs.rm(path.join(root, "active", "skills"), { recursive: true, force: true })
                await fs.symlink(outside, path.join(root, "active", "skills"))
              },
            },
          }).pipe(
            Effect.as("success" as const),
            Effect.catch((error) => Effect.succeed(error.code)),
          )
          expect(result).toBe("OwnershipMismatch")
          expect(yield* Effect.promise(() => Bun.file(path.join(outside, "race", "SKILL.md")).exists())).toBe(false)

          yield* Effect.promise(async () => {
            await fs.rm(path.join(root, "active", "skills"))
            await fs.mkdir(path.join(root, "active", "skills"), { recursive: true })
          })
          const reconciled = yield* ProjectArtifactPackage.reconcile(root)
          expect(reconciled.map((item) => item.versionID)).toContain(attempted.versionID)
        }),
      ),
    ),
  )

  it.live("rebuilds global owned targets and distinguishes unsafe standard targets", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-global-scan-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const roots = {
            skill: path.join(tmp.path, "skills"),
            command: path.join(tmp.path, "commands"),
            agent: path.join(tmp.path, "agents"),
          }
          const scopeID = ProjectArtifact.ScopeID.make("pas_global-scan")
          const storageID = ProjectArtifact.StorageID.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID, "global")
            await Promise.all(Object.values(roots).map((item) => fs.mkdir(item, { recursive: true })))
          })
          const owned = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("owned"),
            versionID: ProjectArtifact.VersionID.make("pav_global-owned"),
            content: "owned",
          })
          const ownedContent = path.join(roots.command, "owned.md")
          const ownedMarker = path.join(roots.command, ".owned.ycoding-project-artifact.json")
          yield* ProjectArtifactPackage.commitStandard({
            root,
            marker: owned,
            content: "owned",
            contentPath: ownedContent,
            markerPath: ownedMarker,
            noOverwrite: true,
          })
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(roots.command, "user-owned.md"), "user")
            const markerOnly = ProjectArtifactPackage.marker({
              ...owned,
              id: ProjectArtifact.ID.make("marker-only"),
              versionID: ProjectArtifact.VersionID.make("pav_marker-only"),
              content: "missing",
            })
            await fs.writeFile(
              path.join(roots.command, ".marker-only.ycoding-project-artifact.json"),
              JSON.stringify(markerOnly),
            )
            await fs.writeFile(path.join(roots.agent, "corrupt.md"), "corrupt")
            await fs.writeFile(path.join(roots.agent, ".corrupt.ycoding-project-artifact.json"), "not-json")
            const copied = ProjectArtifactPackage.marker({
              ...owned,
              scopeID: ProjectArtifact.ScopeID.make("pas_copied"),
              id: ProjectArtifact.ID.make("copied"),
              versionID: ProjectArtifact.VersionID.make("pav_copied-global"),
              content: "copied",
            })
            await fs.writeFile(path.join(roots.command, "copied.md"), "copied")
            await fs.writeFile(
              path.join(roots.command, ".copied.ycoding-project-artifact.json"),
              JSON.stringify(copied),
            )
          })

          const scan = yield* ProjectArtifactPackage.reconcileStandard({ root, scopeID, storageID, roots })
          expect(scan.owned.map((item) => item.versionID)).toEqual([owned.versionID])
          const expectedStatuses: Array<(typeof scan.issues)[number]["status"]> = [
            "content-only",
            "corrupt-marker",
            "copied-marker",
            "marker-only",
          ]
          expect(scan.issues.map((item) => item.status).toSorted()).toEqual(expectedStatuses.toSorted())
          expect(scan.issues.find((item) => item.status === "content-only")?.ownership).toBe("user-owned")

          const collision = ProjectArtifactPackage.marker({
            ...owned,
            id: ProjectArtifact.ID.make("marker-only"),
            versionID: ProjectArtifact.VersionID.make("pav_collision"),
            content: "new",
          })
          expect(
            yield* ProjectArtifactPackage.commitStandard({
              root,
              marker: collision,
              content: "new",
              contentPath: path.join(roots.command, "marker-only.md"),
              markerPath: path.join(roots.command, ".marker-only.ycoding-project-artifact.json"),
              noOverwrite: true,
            }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("DestinationExists")
        }),
      ),
    ),
  )

  it.live("trashes, restores, and purges an exact multi-layout owned manifest", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-trash-manifest-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_trash-layout")
          const storageID = ProjectArtifact.StorageID.make("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const first = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "agent",
            id: ProjectArtifact.ID.make("layouts"),
            versionID: ProjectArtifact.VersionID.make("pav_layout-one"),
            content: "one",
          })
          const second = ProjectArtifactPackage.marker({
            ...first,
            versionID: ProjectArtifact.VersionID.make("pav_layout-two"),
            content: "two",
          })
          const third = ProjectArtifactPackage.marker({
            ...first,
            versionID: ProjectArtifact.VersionID.make("pav_layout-three"),
            content: "three",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: first, content: "one" })
          yield* ProjectArtifactPackage.commit({
            root,
            marker: second,
            content: "two",
            expectedVersionID: first.versionID,
          })
          yield* ProjectArtifactPackage.rollback({ root, current: second, target: first })
          yield* ProjectArtifactPackage.commit({
            root,
            marker: third,
            content: "three",
            expectedVersionID: first.versionID,
          })
          yield* ProjectArtifactPackage.disable({ root, marker: third })

          const deletionID = ProjectArtifact.DeletionID.make("pad_layouts")
          const deletedAt = 1_000
          yield* ProjectArtifactPackage.trash({
            root,
            marker: third,
            deletionID,
            priorStage: "degraded",
            deletedAt,
          })
          const manifest = yield* ProjectArtifactPackage.readTrashManifest(root, deletionID)
          expect(manifest.priorStage).toBe("degraded")
          expect(manifest.entries.map((item) => `${item.layout}:${item.versionID}`).toSorted()).toEqual(
            [`disabled:${second.versionID}`, `disabled:${third.versionID}`, `version:${first.versionID}`].toSorted(),
          )
          expect(
            yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).exists()),
          ).toBe(false)
          expect(
            yield* Effect.promise(() =>
              Bun.file(
                path.join(root, "disabled", third.kind, third.id, third.versionID, third.contentRelpath),
              ).exists(),
            ),
          ).toBe(false)

          yield* ProjectArtifactPackage.restore({ root, marker: third, deletionID })
          expect(
            yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).exists()),
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              Bun.file(
                path.join(root, "disabled", second.kind, second.id, second.versionID, second.contentRelpath),
              ).exists(),
            ),
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              Bun.file(
                path.join(root, "disabled", third.kind, third.id, third.versionID, third.contentRelpath),
              ).exists(),
            ),
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              Bun.file(ProjectArtifactPackage.activeContentPath(root, "agent", "layouts")).exists(),
            ),
          ).toBe(false)

          const purgeID = ProjectArtifact.DeletionID.make("pad_layouts-purge")
          yield* ProjectArtifactPackage.trash({
            root,
            marker: third,
            deletionID: purgeID,
            priorStage: "degraded",
            deletedAt,
          })
          expect(
            yield* ProjectArtifactPackage.purge({
              root,
              marker: third,
              deletionID: purgeID,
              now: deletedAt + 30 * 86_400_000 - 1,
            }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("TrashExpired")
          yield* ProjectArtifactPackage.purge({
            root,
            marker: third,
            deletionID: purgeID,
            now: deletedAt + 30 * 86_400_000,
          })
          expect(yield* Effect.promise(() => Bun.file(path.join(root, "trash", purgeID)).exists())).toBe(false)
        }),
      ),
    ),
  )

  it.live("owns one lock across reservation and finalization and compensates a failed finalization", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-transaction-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_transaction")
          const storageID = ProjectArtifact.StorageID.make("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("transaction"),
            versionID: ProjectArtifact.VersionID.make("pav_transaction-original"),
            content: "original",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "original" })
          const first = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_transaction-first"),
            content: "first",
          })
          const second = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_transaction-second"),
            content: "second",
          })
          const reserveEntered = Promise.withResolvers<void>()
          const releaseReserve = Promise.withResolvers<void>()
          const finalizeEntered = Promise.withResolvers<void>()
          const releaseFinalize = Promise.withResolvers<void>()
          const secondReserveEntered = Promise.withResolvers<void>()
          const state = { secondReserved: false }
          const firstFiber = yield* Effect.forkChild(
            ProjectArtifactPackage.commitTransaction(
              { root, marker: first, content: "first", expectedVersionID: original.versionID },
              {
                reserve: (metadata) =>
                  Effect.promise(async () => {
                    expect(metadata.phase).toBe("prepared")
                    reserveEntered.resolve()
                    await releaseReserve.promise
                  }),
                finalize: (metadata) =>
                  Effect.promise(async () => {
                    expect(metadata.phase).toBe("available")
                    finalizeEntered.resolve()
                    await releaseFinalize.promise
                  }),
                abort: () => Effect.void,
              },
            ),
          )
          yield* Effect.promise(() => reserveEntered.promise)
          const secondFiber = yield* Effect.forkChild(
            ProjectArtifactPackage.commitTransaction(
              { root, marker: second, content: "second", expectedVersionID: first.versionID },
              {
                reserve: () =>
                  Effect.sync(() => {
                    state.secondReserved = true
                    secondReserveEntered.resolve()
                  }),
                finalize: () => Effect.void,
                abort: () => Effect.void,
              },
            ),
          )
          yield* Effect.sleep("50 millis")
          expect(state.secondReserved).toBe(false)
          releaseReserve.resolve()
          yield* Effect.promise(() => finalizeEntered.promise)
          yield* Effect.sleep("50 millis")
          expect(state.secondReserved).toBe(false)
          releaseFinalize.resolve()
          yield* Fiber.join(firstFiber)
          yield* Effect.promise(() => secondReserveEntered.promise)
          yield* Fiber.join(secondFiber)

          const failed = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_transaction-failed"),
            content: "failed",
          })
          const aborts: ProjectArtifactPackage.CommitTransactionMetadata[] = []
          expect(
            yield* ProjectArtifactPackage.commitTransaction(
              { root, marker: failed, content: "failed", expectedVersionID: second.versionID },
              {
                reserve: () => Effect.void,
                finalize: () => Effect.fail("db-finalization" as const),
                abort: (metadata) =>
                  Effect.sync(() => {
                    aborts.push(metadata)
                  }),
              },
            ).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error)),
            ),
          ).toBe("db-finalization")
          expect(aborts.map((item) => item.phase)).toEqual(["compensated"])
          expect(
            yield* Effect.promise(() =>
              fs.readFile(ProjectArtifactPackage.activeContentPath(root, "command", "transaction"), "utf8"),
            ),
          ).toBe("second")
          expect((yield* ProjectArtifactPackage.readActive(root, "command", "transaction"))?.versionID).toBe(
            second.versionID,
          )
        }),
      ),
    ),
  )

  it.live("reconciles process loss after either archive rename and permits an exact retry", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-archive-crash-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scopeID = ProjectArtifact.ScopeID.make("pas_archive-crash")
          const storageID = ProjectArtifact.StorageID.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
          for (const boundary of ["content", "marker"] as const) {
            const root = path.join(tmp.path, boundary)
            yield* Effect.promise(() => writeScope(root, scopeID, storageID))
            const original = ProjectArtifactPackage.marker({
              scopeID,
              storageID,
              kind: "skill",
              id: ProjectArtifact.ID.make("archive-crash"),
              versionID: ProjectArtifact.VersionID.make(`pav_archive-old-${boundary}`),
              content: "old",
            })
            yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
            const attempted = ProjectArtifactPackage.marker({
              ...original,
              versionID: ProjectArtifact.VersionID.make(`pav_archive-new-${boundary}`),
              content: "new",
            })
            const destination =
              boundary === "content"
                ? ProjectArtifactPackage.versionContentPath(root, original)
                : ProjectArtifactPackage.versionMarkerPath(root, original)
            const reached = Promise.withResolvers<void>()
            const never = new Promise<void>(() => {})
            const filesystem = {
              ...nativeFilesystem,
              rename: async (source: string, target: string) => {
                await fs.rename(source, target)
                if (target !== destination) return
                reached.resolve()
                await never
              },
              afterMutation: async (mutation: { readonly operation: string; readonly destination?: string }) => {
                if (mutation.operation !== "rename" || mutation.destination !== destination) return
                reached.resolve()
                await never
              },
            }
            const fiber = yield* Effect.forkChild(
              ProjectArtifactPackage.withArtifactLock(
                { root, marker: attempted },
                Effect.gen(function* () {
                  const prepared = yield* ProjectArtifactPackage.prepareCommit({
                    root,
                    marker: attempted,
                    content: "new",
                    expectedVersionID: original.versionID,
                    filesystem,
                  })
                  yield* ProjectArtifactPackage.makeAvailable(prepared, filesystem)
                }),
              ),
            )
            yield* Effect.promise(() => reached.promise)
            yield* Fiber.interrupt(fiber)
            expect((yield* ProjectArtifactPackage.readCommitTransactions(root)).map((item) => item.phase)).toEqual([
              boundary === "content" ? "archiving-content" : "archiving-marker",
            ])

            const reconciled = yield* ProjectArtifactPackage.reconcile(root)
            expect(reconciled.map((item) => item.versionID)).toEqual([original.versionID])
            expect(
              yield* Effect.promise(() =>
                fs.readFile(ProjectArtifactPackage.activeContentPath(root, "skill", "archive-crash"), "utf8"),
              ),
            ).toBe("old")
            yield* ProjectArtifactPackage.commitTransaction(
              { root, marker: attempted, content: "new", expectedVersionID: original.versionID },
              { reserve: () => Effect.void, finalize: () => Effect.void, abort: () => Effect.void },
            )
            expect((yield* ProjectArtifactPackage.readActive(root, "skill", "archive-crash"))?.versionID).toBe(
              attempted.versionID,
            )
          }
        }),
      ),
    ),
  )

  it.live("reconciles nested standard Skills and holds their target lock through digest validation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-standard-skills-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const skills = path.join(tmp.path, "skills")
          const scopeID = ProjectArtifact.ScopeID.make("pas_standard-skills")
          const storageID = ProjectArtifact.StorageID.make("ffffffff-ffff-4fff-8fff-ffffffffffff")
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID, "global")
            await fs.mkdir(skills, { recursive: true })
          })
          const owned = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("owned-skill"),
            versionID: ProjectArtifact.VersionID.make("pav_owned-skill"),
            content: "owned",
          })
          const ownedDirectory = path.join(skills, owned.id)
          const ownedContent = path.join(ownedDirectory, "SKILL.md")
          const ownedMarker = path.join(ownedDirectory, ".ycoding-project-artifact.json")
          yield* Effect.promise(() => fs.mkdir(ownedDirectory, { recursive: true }))
          yield* ProjectArtifactPackage.commitStandard({
            root,
            marker: owned,
            content: "owned",
            contentPath: ownedContent,
            markerPath: ownedMarker,
            noOverwrite: true,
          })
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(skills, "content-only"), { recursive: true })
            await fs.writeFile(path.join(skills, "content-only", "SKILL.md"), "content-only")
            const markerOnly = ProjectArtifactPackage.marker({
              ...owned,
              id: ProjectArtifact.ID.make("marker-only"),
              versionID: ProjectArtifact.VersionID.make("pav_skill-marker-only"),
              content: "missing",
            })
            await fs.mkdir(path.join(skills, "marker-only"), { recursive: true })
            await fs.writeFile(
              path.join(skills, "marker-only", ".ycoding-project-artifact.json"),
              JSON.stringify(markerOnly),
            )
            await fs.mkdir(path.join(skills, "corrupt"), { recursive: true })
            await fs.writeFile(path.join(skills, "corrupt", "SKILL.md"), "corrupt")
            await fs.writeFile(path.join(skills, "corrupt", ".ycoding-project-artifact.json"), "not-json")
            const copied = ProjectArtifactPackage.marker({
              ...owned,
              scopeID: ProjectArtifact.ScopeID.make("pas_copied-skill"),
              id: ProjectArtifact.ID.make("copied"),
              versionID: ProjectArtifact.VersionID.make("pav_skill-copied"),
              content: "copied",
            })
            await fs.mkdir(path.join(skills, "copied"), { recursive: true })
            await fs.writeFile(path.join(skills, "copied", "SKILL.md"), "copied")
            await fs.writeFile(path.join(skills, "copied", ".ycoding-project-artifact.json"), JSON.stringify(copied))
          })

          const digestStarted = Promise.withResolvers<void>()
          const releaseDigest = Promise.withResolvers<void>()
          const mutationStarted = { value: false }
          const blocked = { value: false }
          const scanFiber = yield* Effect.forkChild(
            ProjectArtifactPackage.reconcileStandard({
              root,
              scopeID,
              storageID,
              roots: { skill: skills },
              filesystem: {
                ...nativeFilesystem,
                beforeRead: async (file) => {
                  if (!blocked.value && file === ownedContent) {
                    blocked.value = true
                    digestStarted.resolve()
                    await releaseDigest.promise
                  }
                },
              },
            }),
          )
          expect(
            yield* Effect.raceFirst(
              Effect.promise(() => digestStarted.promise).pipe(Effect.as("digest" as const)),
              Fiber.join(scanFiber).pipe(Effect.as("completed" as const)),
            ),
          ).toBe("digest")
          const updated = ProjectArtifactPackage.marker({
            ...owned,
            versionID: ProjectArtifact.VersionID.make("pav_owned-skill-updated"),
            content: "updated",
          })
          const updateFiber = yield* Effect.forkChild(
            ProjectArtifactPackage.commitStandard({
              root,
              marker: updated,
              content: "updated",
              contentPath: ownedContent,
              markerPath: ownedMarker,
              expectedVersionID: owned.versionID,
              filesystem: {
                ...nativeFilesystem,
                beforeMutation: async () => {
                  mutationStarted.value = true
                },
              },
            }),
          )
          yield* Effect.sleep("50 millis")
          expect(mutationStarted.value).toBe(false)
          releaseDigest.resolve()
          const scan = yield* Fiber.join(scanFiber)
          expect(scan.owned.map((item) => item.versionID)).toEqual([owned.versionID])
          expect(scan.issues.map((item) => `${item.id}:${item.status}`).toSorted()).toEqual(
            [
              "content-only:content-only",
              "copied:copied-marker",
              "corrupt:corrupt-marker",
              "marker-only:marker-only",
            ].toSorted(),
          )
          yield* Fiber.join(updateFiber)
          expect(yield* Effect.promise(() => fs.readFile(ownedContent, "utf8"))).toBe("updated")
        }),
      ),
    ),
  )

  it.live("reconciles process loss at every trash and restore rename", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-trash-crash-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scopeID = ProjectArtifact.ScopeID.make("pas_trash-crash")
          const storageID = ProjectArtifact.StorageID.make("12121212-1212-4212-8212-121212121212")
          for (const operation of ["trash", "restore"] as const) {
            for (const boundary of [1, 2, 3, 4, 5, 6]) {
              const root = path.join(tmp.path, `${operation}-${boundary}`)
              yield* Effect.promise(() => writeScope(root, scopeID, storageID))
              const first = ProjectArtifactPackage.marker({
                scopeID,
                storageID,
                kind: "agent",
                id: ProjectArtifact.ID.make("trash-crash"),
                versionID: ProjectArtifact.VersionID.make(`pav_${operation}-${boundary}-first`),
                content: "first",
              })
              const second = ProjectArtifactPackage.marker({
                ...first,
                versionID: ProjectArtifact.VersionID.make(`pav_${operation}-${boundary}-second`),
                content: "second",
              })
              const third = ProjectArtifactPackage.marker({
                ...first,
                versionID: ProjectArtifact.VersionID.make(`pav_${operation}-${boundary}-third`),
                content: "third",
              })
              yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
              yield* ProjectArtifactPackage.commit({
                root,
                marker: second,
                content: "second",
                expectedVersionID: first.versionID,
              })
              yield* ProjectArtifactPackage.rollback({ root, current: second, target: first })
              yield* ProjectArtifactPackage.commit({
                root,
                marker: third,
                content: "third",
                expectedVersionID: first.versionID,
              })
              const deletionID = ProjectArtifact.DeletionID.make(`pad_${operation}-${boundary}`)
              if (operation === "restore") yield* ProjectArtifactPackage.trash({ root, marker: third, deletionID })
              const reached = Promise.withResolvers<void>()
              const never = new Promise<void>(() => {})
              const state = { renames: 0 }
              const isEntryMove = (source: string, destination: string) =>
                operation === "trash"
                  ? destination.startsWith(path.join(root, "trash", deletionID, "entries"))
                  : source.startsWith(path.join(root, "trash", deletionID, "entries"))
              const after = async (source: string, destination: string) => {
                if (!isEntryMove(source, destination)) return
                state.renames++
                if (state.renames !== boundary) return
                reached.resolve()
                await never
              }
              const filesystem = {
                ...nativeFilesystem,
                rename: async (source: string, destination: string) => {
                  await fs.rename(source, destination)
                  await after(source, destination)
                },
                afterMutation: async (mutation: {
                  readonly operation: string
                  readonly source?: string
                  readonly destination?: string
                }) => {
                  if (mutation.operation !== "rename" || !mutation.source || !mutation.destination) return
                  await after(mutation.source, mutation.destination)
                },
              }
              const fiber = yield* Effect.forkChild(
                operation === "trash"
                  ? ProjectArtifactPackage.trash({ root, marker: third, deletionID, filesystem })
                  : ProjectArtifactPackage.restore({ root, marker: third, deletionID, filesystem }),
              )
              yield* Effect.promise(() => reached.promise)
              yield* Fiber.interrupt(fiber)
              yield* ProjectArtifactPackage.reconcile(root)
              expect(
                yield* Effect.promise(() =>
                  Bun.file(ProjectArtifactPackage.activeContentPath(root, "agent", "trash-crash")).exists(),
                ),
              ).toBe(true)
              expect(
                yield* Effect.promise(() =>
                  Bun.file(ProjectArtifactPackage.activeMarkerPath(root, "agent", "trash-crash")).exists(),
                ),
              ).toBe(true)
              expect(
                yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).exists()),
              ).toBe(true)
              expect(
                yield* Effect.promise(() =>
                  Bun.file(
                    path.join(root, "disabled", second.kind, second.id, second.versionID, second.contentRelpath),
                  ).exists(),
                ),
              ).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(path.join(root, "trash", deletionID)).exists())).toBe(false)
            }
          }
        }),
      ),
    ),
    30_000,
  )

  it.live("trashes and restores global active, historical, and disabled layouts", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-global-trash-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const commands = path.join(tmp.path, "commands")
          const contentPath = path.join(commands, "global-layouts.md")
          const markerPath = path.join(commands, ".global-layouts.ycoding-project-artifact.json")
          const scopeID = ProjectArtifact.ScopeID.make("pas_global-trash")
          const storageID = ProjectArtifact.StorageID.make("13131313-1313-4313-8313-131313131313")
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID, "global")
            await fs.mkdir(commands, { recursive: true })
          })
          const first = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id: ProjectArtifact.ID.make("global-layouts"),
            versionID: ProjectArtifact.VersionID.make("pav_global-layouts-first"),
            content: "first",
          })
          const second = ProjectArtifactPackage.marker({
            ...first,
            versionID: ProjectArtifact.VersionID.make("pav_global-layouts-second"),
            content: "second",
          })
          const third = ProjectArtifactPackage.marker({
            ...first,
            versionID: ProjectArtifact.VersionID.make("pav_global-layouts-third"),
            content: "third",
          })
          yield* ProjectArtifactPackage.commitStandard({
            root,
            marker: first,
            content: "first",
            contentPath,
            markerPath,
          })
          yield* ProjectArtifactPackage.commitStandard({
            root,
            marker: second,
            content: "second",
            contentPath,
            markerPath,
            expectedVersionID: first.versionID,
          })
          yield* ProjectArtifactPackage.rollbackStandard({
            root,
            current: second,
            target: first,
            contentPath,
            markerPath,
          })
          yield* ProjectArtifactPackage.commitStandard({
            root,
            marker: third,
            content: "third",
            contentPath,
            markerPath,
            expectedVersionID: first.versionID,
          })
          const deletionID = ProjectArtifact.DeletionID.make("pad_global-layouts")
          yield* ProjectArtifactPackage.trashStandard({
            root,
            marker: third,
            deletionID,
            contentPath,
            markerPath,
          })
          const manifest = yield* ProjectArtifactPackage.readTrashManifest(root, deletionID)
          expect(manifest.entries.map((item) => `${item.layout}:${item.versionID}`).toSorted()).toEqual(
            [`active:${third.versionID}`, `disabled:${second.versionID}`, `version:${first.versionID}`].toSorted(),
          )
          yield* ProjectArtifactPackage.restoreStandard({
            root,
            marker: third,
            deletionID,
            contentPath,
            markerPath,
          })
          expect(yield* Effect.promise(() => fs.readFile(contentPath, "utf8"))).toBe("third")
          expect(
            yield* Effect.promise(() => Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).exists()),
          ).toBe(true)
          expect(
            yield* Effect.promise(() =>
              Bun.file(
                path.join(root, "disabled", second.kind, second.id, second.versionID, second.contentRelpath),
              ).exists(),
            ),
          ).toBe(true)
        }),
      ),
    ),
  )

  it.live("rejects incomplete and tampered trash manifests and corrupted purge bytes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-trash-validation-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scopeID = ProjectArtifact.ScopeID.make("pas_trash-validation")
          const storageID = ProjectArtifact.StorageID.make("14141414-1414-4414-8414-141414141414")
          const cases = [
            ["empty", (value: ManifestJson) => ({ ...value, entries: [] })],
            ["truncated", (value: ManifestJson) => ({ ...value, entries: value.entries.slice(0, 1) })],
            [
              "duplicate",
              (value: ManifestJson) => ({ ...value, entries: [...value.entries, { ...value.entries[0] }] }),
            ],
            [
              "wrong-layout",
              (value: ManifestJson) => ({
                ...value,
                entries: value.entries.map((entry, index) => (index === 0 ? { ...entry, layout: "disabled" } : entry)),
              }),
            ],
            [
              "wrong-path",
              (value: ManifestJson) => ({
                ...value,
                entries: value.entries.map((entry, index) =>
                  index === 0 ? { ...entry, content: path.join(tmp.path, "outside") } : entry,
                ),
              }),
            ],
            [
              "wrong-version",
              (value: ManifestJson) => ({
                ...value,
                entries: value.entries.map((entry, index) =>
                  index === 0 ? { ...entry, versionID: "pav_wrong-version" } : entry,
                ),
              }),
            ],
            ["wrong-schema", (value: ManifestJson) => ({ ...value, schema: 99 })],
            [
              "wrong-digest",
              (value: ManifestJson) => ({
                ...value,
                entries: value.entries.map((entry, index) =>
                  index === 0 ? { ...entry, contentDigest: "0".repeat(64) } : entry,
                ),
              }),
            ],
          ] as const
          for (const [name, mutate] of cases) {
            const root = path.join(tmp.path, name)
            yield* Effect.promise(() => writeScope(root, scopeID, storageID))
            const first = ProjectArtifactPackage.marker({
              scopeID,
              storageID,
              kind: "command",
              id: ProjectArtifact.ID.make("manifest"),
              versionID: ProjectArtifact.VersionID.make(`pav_${name}-first`),
              content: "first",
            })
            const second = ProjectArtifactPackage.marker({
              ...first,
              versionID: ProjectArtifact.VersionID.make(`pav_${name}-second`),
              content: "second",
            })
            yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
            yield* ProjectArtifactPackage.commit({
              root,
              marker: second,
              content: "second",
              expectedVersionID: first.versionID,
            })
            const deletionID = ProjectArtifact.DeletionID.make(`pad_${name}`)
            yield* ProjectArtifactPackage.trash({ root, marker: second, deletionID })
            const manifestPath = path.join(root, "trash", deletionID, ".ycoding-trash.json")
            yield* Effect.promise(async () => {
              const value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ManifestJson
              await fs.writeFile(manifestPath, JSON.stringify(mutate(value)))
            })
            expect(
              yield* ProjectArtifactPackage.restore({ root, marker: second, deletionID }).pipe(
                Effect.as("success" as const),
                Effect.catch((error) => Effect.succeed(error.code)),
              ),
            ).toBe("OwnershipMismatch")
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "outside")).exists())).toBe(false)
          }

          const root = path.join(tmp.path, "digest-corruption")
          yield* Effect.promise(() => writeScope(root, scopeID, storageID))
          const value = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("digest-corruption"),
            versionID: ProjectArtifact.VersionID.make("pav_digest-corruption"),
            content: "owned",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: value, content: "owned" })
          const deletionID = ProjectArtifact.DeletionID.make("pad_digest-corruption")
          yield* ProjectArtifactPackage.trash({ root, marker: value, deletionID, deletedAt: 1_000 })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(root, "trash", deletionID, "entries", "active", value.versionID, value.contentRelpath),
              "tampered",
            ),
          )
          expect(
            yield* ProjectArtifactPackage.purge({
              root,
              marker: value,
              deletionID,
              now: 1_000 + 30 * 86_400_000,
            }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          ).toBe("OwnershipMismatch")
          expect(
            yield* Effect.promise(() =>
              Bun.file(path.join(root, "trash", deletionID, ".ycoding-trash.json")).exists(),
            ),
          ).toBe(true)
        }),
      ),
    ),
  )

  it.live("blocks reconcile while a commit transaction is paused in reserve or finalize", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-reconcile-transaction-lock-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const scopeID = ProjectArtifact.ScopeID.make("pas_reconcile-transaction-lock")
          const storageID = ProjectArtifact.StorageID.make("16161616-1616-4616-8616-161616161616")
          for (const paused of ["reserve", "finalize"] as const) {
            const root = path.join(tmp.path, paused)
            yield* Effect.promise(() => writeScope(root, scopeID, storageID))
            const original = ProjectArtifactPackage.marker({
              scopeID,
              storageID,
              kind: "command",
              id: ProjectArtifact.ID.make(`locked-${paused}`),
              versionID: ProjectArtifact.VersionID.make(`pav_locked-${paused}-old`),
              content: "old",
            })
            const attempted = ProjectArtifactPackage.marker({
              ...original,
              versionID: ProjectArtifact.VersionID.make(`pav_locked-${paused}-new`),
              content: "new",
            })
            yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
            const entered = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            const state = { reconciled: false }
            const transactionFiber = yield* Effect.forkChild(
              ProjectArtifactPackage.commitTransaction(
                { root, marker: attempted, content: "new", expectedVersionID: original.versionID },
                {
                  reserve: () =>
                    paused === "reserve"
                      ? Effect.promise(async () => {
                          entered.resolve()
                          await release.promise
                        })
                      : Effect.void,
                  finalize: () =>
                    paused === "finalize"
                      ? Effect.promise(async () => {
                          entered.resolve()
                          await release.promise
                        })
                      : Effect.void,
                  abort: () => Effect.void,
                },
              ).pipe(
                Effect.as("success" as const),
                Effect.catch((error) => Effect.succeed(error.code)),
              ),
            )
            yield* Effect.promise(() => entered.promise)
            const reconcileFiber = yield* Effect.forkChild(
              ProjectArtifactPackage.reconcile(root).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    state.reconciled = true
                  }),
                ),
                Effect.as("success" as const),
                Effect.catch((error) => Effect.succeed(error.code)),
              ),
            )
            yield* Effect.sleep("50 millis")
            const reconciledBeforeRelease = state.reconciled
            const pendingBeforeRelease = yield* ProjectArtifactPackage.readCommitTransactions(root)
            release.resolve()
            const transactionResult = yield* Fiber.join(transactionFiber)
            const reconcileResult = yield* Fiber.join(reconcileFiber)

            expect(reconciledBeforeRelease).toBe(false)
            expect(pendingBeforeRelease).toHaveLength(1)
            expect(pendingBeforeRelease[0]?.phase).toBe(paused === "reserve" ? "prepared" : "finalizing")
            expect(transactionResult).toBe("success")
            expect(reconcileResult).toBe("success")
            expect((yield* ProjectArtifactPackage.readActive(root, "command", original.id))?.versionID).toBe(
              attempted.versionID,
            )
          }
        }),
      ),
    ),
  )

  it.live(
    "blocks reconcile at every partial trash and restore rename",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir("project-artifact-reconcile-trash-lock-")),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const scopeID = ProjectArtifact.ScopeID.make("pas_reconcile-trash-lock")
            const storageID = ProjectArtifact.StorageID.make("17171717-1717-4717-8717-171717171717")
            for (const operation of ["trash", "restore"] as const) {
              for (const boundary of [1, 2, 3, 4, 5, 6]) {
                const root = path.join(tmp.path, `${operation}-${boundary}`)
                yield* Effect.promise(() => writeScope(root, scopeID, storageID))
                const first = ProjectArtifactPackage.marker({
                  scopeID,
                  storageID,
                  kind: "agent",
                  id: ProjectArtifact.ID.make("locked-trash"),
                  versionID: ProjectArtifact.VersionID.make(`pav_locked-${operation}-${boundary}-first`),
                  content: "first",
                })
                const second = ProjectArtifactPackage.marker({
                  ...first,
                  versionID: ProjectArtifact.VersionID.make(`pav_locked-${operation}-${boundary}-second`),
                  content: "second",
                })
                const third = ProjectArtifactPackage.marker({
                  ...first,
                  versionID: ProjectArtifact.VersionID.make(`pav_locked-${operation}-${boundary}-third`),
                  content: "third",
                })
                yield* ProjectArtifactPackage.commit({ root, marker: first, content: "first" })
                yield* ProjectArtifactPackage.commit({
                  root,
                  marker: second,
                  content: "second",
                  expectedVersionID: first.versionID,
                })
                yield* ProjectArtifactPackage.rollback({ root, current: second, target: first })
                yield* ProjectArtifactPackage.commit({
                  root,
                  marker: third,
                  content: "third",
                  expectedVersionID: first.versionID,
                })
                const deletionID = ProjectArtifact.DeletionID.make(`pad_locked-${operation}-${boundary}`)
                if (operation === "restore") yield* ProjectArtifactPackage.trash({ root, marker: third, deletionID })
                const entered = Promise.withResolvers<void>()
                const release = Promise.withResolvers<void>()
                const state = { renames: 0, reconciled: false }
                const filesystem = {
                  ...nativeFilesystem,
                  afterMutation: async (mutation: {
                    readonly operation: string
                    readonly source?: string
                    readonly destination?: string
                  }) => {
                    if (mutation.operation !== "rename" || !mutation.source || !mutation.destination) return
                    const entryMove =
                      operation === "trash"
                        ? mutation.destination.startsWith(path.join(root, "trash", deletionID, "entries"))
                        : mutation.source.startsWith(path.join(root, "trash", deletionID, "entries"))
                    if (!entryMove) return
                    state.renames++
                    if (state.renames !== boundary) return
                    entered.resolve()
                    await release.promise
                  },
                }
                const operationFiber = yield* Effect.forkChild(
                  (operation === "trash"
                    ? ProjectArtifactPackage.trash({ root, marker: third, deletionID, filesystem })
                    : ProjectArtifactPackage.restore({ root, marker: third, deletionID, filesystem })
                  ).pipe(
                    Effect.as("success" as const),
                    Effect.catch((error) => Effect.succeed(error.code)),
                  ),
                )
                yield* Effect.promise(() => entered.promise)
                const reconcileFiber = yield* Effect.forkChild(
                  ProjectArtifactPackage.reconcile(root).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        state.reconciled = true
                      }),
                    ),
                    Effect.as("success" as const),
                    Effect.catch((error) => Effect.succeed(error.code)),
                  ),
                )
                yield* Effect.sleep("25 millis")
                const reconciledBeforeRelease = state.reconciled
                release.resolve()
                const operationResult = yield* Fiber.join(operationFiber)
                const reconcileResult = yield* Fiber.join(reconcileFiber)

                expect(reconciledBeforeRelease).toBe(false)
                expect(operationResult).toBe("success")
                expect(reconcileResult).toBe("success")
                expect(
                  yield* Effect.promise(() =>
                    Bun.file(ProjectArtifactPackage.activeContentPath(root, "agent", third.id)).exists(),
                  ),
                ).toBe(operation === "restore")
                if (operation === "restore") {
                  expect(
                    yield* Effect.promise(() =>
                      Bun.file(ProjectArtifactPackage.versionContentPath(root, first)).exists(),
                    ),
                  ).toBe(true)
                  expect(
                    yield* Effect.promise(() =>
                      Bun.file(
                        path.join(root, "disabled", second.kind, second.id, second.versionID, second.contentRelpath),
                      ).exists(),
                    ),
                  ).toBe(true)
                }
              }
            }
          }),
        ),
      ),
    20_000,
  )

  it.live("prevents malformed-marker quarantine from racing a new transaction for the same path", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-reconcile-malformed-lock-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const scopeID = ProjectArtifact.ScopeID.make("pas_reconcile-malformed-lock")
          const storageID = ProjectArtifact.StorageID.make("18181818-1818-4818-8818-181818181818")
          const id = ProjectArtifact.ID.make("malformed-lock")
          const markerPath = ProjectArtifactPackage.activeMarkerPath(root, "command", id)
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID)
            await fs.mkdir(path.dirname(markerPath), { recursive: true })
            await fs.writeFile(markerPath, "not-json")
          })
          const quarantineEntered = Promise.withResolvers<void>()
          const releaseQuarantine = Promise.withResolvers<void>()
          const state = { paused: false, reserved: false }
          const reconcileFiber = yield* Effect.forkChild(
            ProjectArtifactPackage.reconcile(root, {
              ...nativeFilesystem,
              beforeMutation: async (mutation) => {
                if (state.paused || mutation.operation !== "rename" || mutation.source !== markerPath) return
                state.paused = true
                quarantineEntered.resolve()
                await releaseQuarantine.promise
              },
            }).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          )
          yield* Effect.promise(() => quarantineEntered.promise)
          const value = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "command",
            id,
            versionID: ProjectArtifact.VersionID.make("pav_malformed-lock"),
            content: "new",
          })
          const transactionFiber = yield* Effect.forkChild(
            ProjectArtifactPackage.commitTransaction(
              { root, marker: value, content: "new" },
              {
                reserve: () =>
                  Effect.sync(() => {
                    state.reserved = true
                  }),
                finalize: () => Effect.void,
                abort: () => Effect.void,
              },
            ).pipe(
              Effect.as("success" as const),
              Effect.catch((error) => Effect.succeed(error.code)),
            ),
          )
          yield* Effect.sleep("50 millis")
          const reservedBeforeRelease = state.reserved
          releaseQuarantine.resolve()
          const reconcileResult = yield* Fiber.join(reconcileFiber)
          const transactionResult = yield* Fiber.join(transactionFiber)

          expect(reservedBeforeRelease).toBe(false)
          expect(reconcileResult).toBe("success")
          expect(transactionResult).toBe("success")
          expect((yield* ProjectArtifactPackage.readActive(root, "command", id))?.versionID).toBe(value.versionID)
        }),
      ),
    ),
  )

  it.live("fails closed when a component identity changes inside the mutation boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-boundary-identity-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "scope")
          const outside = path.join(tmp.path, "outside")
          const scopeID = ProjectArtifact.ScopeID.make("pas_boundary-identity")
          const storageID = ProjectArtifact.StorageID.make("15151515-1515-4515-8515-151515151515")
          yield* Effect.promise(async () => {
            await writeScope(root, scopeID, storageID)
            await fs.mkdir(path.join(outside, "identity"), { recursive: true })
          })
          const original = ProjectArtifactPackage.marker({
            scopeID,
            storageID,
            kind: "skill",
            id: ProjectArtifact.ID.make("identity"),
            versionID: ProjectArtifact.VersionID.make("pav_identity-old"),
            content: "old",
          })
          yield* ProjectArtifactPackage.commit({ root, marker: original, content: "old" })
          const attempted = ProjectArtifactPackage.marker({
            ...original,
            versionID: ProjectArtifact.VersionID.make("pav_identity-new"),
            content: "new",
          })
          const skills = path.join(root, "active", "skills")
          const state = { replaced: false }
          const filesystem = {
            ...nativeFilesystem,
            beforeMutation: async (mutation: { readonly operation: string; readonly destination?: string }) => {
              if (state.replaced || mutation.operation !== "rename") return
              if (mutation.destination !== ProjectArtifactPackage.activeContentPath(root, "skill", "identity")) return
              state.replaced = true
              await fs.rename(skills, `${skills}-prior`)
              await fs.mkdir(skills)
            },
            rename: async (source: string, destination: string) => {
              if (destination !== ProjectArtifactPackage.activeContentPath(root, "skill", "identity")) {
                await fs.rename(source, destination)
                return
              }
              await fs.rm(skills, { recursive: true })
              await fs.symlink(outside, skills)
              await fs.rename(source, destination)
            },
          }
          const result = yield* ProjectArtifactPackage.commit({
            root,
            marker: attempted,
            content: "new",
            expectedVersionID: original.versionID,
            filesystem,
          }).pipe(
            Effect.as("success" as const),
            Effect.catch((error) => Effect.succeed(error.code)),
          )
          expect(result).toBe("OwnershipMismatch")
          expect(yield* Effect.promise(() => Bun.file(path.join(outside, "identity", "SKILL.md")).exists())).toBe(false)
        }),
      ),
    ),
  )
})

interface ManifestJson {
  readonly schema?: unknown
  readonly entries: ReadonlyArray<Record<string, unknown>>
  readonly [key: string]: unknown
}

const nativeFilesystem = {
  lstat: fs.lstat,
  realpath: fs.realpath,
  readdir: fs.readdir,
  readFile: fs.readFile,
}

async function writeScope(
  root: string,
  scopeID: ProjectArtifact.ScopeID,
  storageID: ProjectArtifact.StorageID,
  type: "project" | "global" = "project",
) {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    ProjectArtifactPackage.scopeMarkerPath(root),
    JSON.stringify({ schema: 1, scopeID, type, storageID }),
  )
}
