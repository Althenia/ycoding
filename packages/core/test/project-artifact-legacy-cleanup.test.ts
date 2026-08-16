import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ProjectArtifactLegacyCleanup } from "@ycoding-ai/core/project-artifact/legacy-cleanup"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("ProjectArtifactLegacyCleanup", () => {
  it.live("removes only bounded positively marked legacy children", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-cleanup-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "generated")
          const owned = legacyDirectory("aaa-owned", "location", "artifact")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(root, owned), { recursive: true })
            await fs.writeFile(
              path.join(root, owned, ".ycoding-generated.json"),
              JSON.stringify({
                generated: true,
                locationID: "location",
                artifactID: "artifact",
                versionID: "version",
                versionDigest: "a".repeat(64),
              }),
            )
            await fs.mkdir(path.join(root, "unmarked"), { recursive: true })
            await fs.mkdir(path.join(root, "linked-123456789abc"), { recursive: true })
            await fs.symlink(
              path.join(root, "unmarked"),
              path.join(root, "linked-123456789abc", ".ycoding-generated.json"),
            )
          })
          const report = yield* ProjectArtifactLegacyCleanup.run({ root, limit: 1 })
          expect(report).toEqual(expect.objectContaining({ removed: 1, scanned: 1, status: "partial" }))
          expect(yield* exists(path.join(root, owned))).toBe(false)
          expect(yield* exists(path.join(root, "unmarked"))).toBe(true)
          expect(yield* exists(path.join(root, "linked-123456789abc"))).toBe(true)
          const remainder = yield* ProjectArtifactLegacyCleanup.run({ root, cursor: report.cursor, limit: 256 })
          expect(remainder).toEqual(expect.objectContaining({ removed: 0, skipped: 2, status: "complete" }))
        }),
      ),
    ),
  )


  it.live("keeps a marker whose basename suffix is not the exact legacy ownership hash", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-cleanup-hash-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "generated")
          const child = path.join(root, "owned-123456789abc")
          yield* Effect.promise(async () => {
            await fs.mkdir(child, { recursive: true })
            await writeMarker(child, "location", "artifact")
          })
          expect(yield* ProjectArtifactLegacyCleanup.run({ root })).toEqual(
            expect.objectContaining({ removed: 0, skipped: 1, failed: 0 }),
          )
          expect(yield* exists(child)).toBe(true)
        }),
      ),
    ),
  )

  it.live("rejects empty ownership IDs even when the basename hash matches", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-cleanup-empty-id-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "generated")
          const names = [legacyDirectory("empty-location", "", "artifact"), legacyDirectory("empty-artifact", "location", "")]
          yield* Effect.promise(async () => {
            for (const name of names) {
              const child = path.join(root, name)
              await fs.mkdir(child, { recursive: true })
              await writeMarker(child, name === names[0] ? "" : "location", name === names[0] ? "artifact" : "")
            }
          })
          expect(yield* ProjectArtifactLegacyCleanup.run({ root })).toEqual(
            expect.objectContaining({ status: "complete", removed: 0, skipped: 2, failed: 0 }),
          )
          for (const name of names) expect(yield* exists(path.join(root, name))).toBe(true)
        }),
      ),
    ),
  )

  it.live("retains a failed cursor entry and removes it on retry", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-cleanup-retry-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "generated")
          const name = legacyDirectory("retry", "location", "artifact")
          const child = path.join(root, name)
          yield* Effect.promise(async () => {
            await fs.mkdir(child, { recursive: true })
            await writeMarker(child, "location", "artifact")
          })
          const failed = yield* ProjectArtifactLegacyCleanup.run(
            { root },
            {
              remove: async () => {
                throw new Error("injected remove failure")
              },
            },
          )
          expect(failed).toEqual(
            expect.objectContaining({ status: "partial", removed: 0, failed: 1, errorCode: "remove-failed" }),
          )
          expect(failed.cursor).not.toBe(name)
          expect(yield* exists(child)).toBe(true)
          const retried = yield* ProjectArtifactLegacyCleanup.run({ root, cursor: failed.cursor })
          expect(retried).toEqual(expect.objectContaining({ status: "complete", removed: 1, failed: 0 }))
          expect(yield* exists(child)).toBe(false)
        }),
      ),
    ),
  )

  it.live("returns safe reports for unreadable roots and markers and enforces the 256-entry bound", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-cleanup-bound-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const unavailable = yield* ProjectArtifactLegacyCleanup.run({ root: path.join(tmp.path, "missing") })
          expect(unavailable).toEqual(expect.objectContaining({ status: "failed", errorCode: "root-unavailable" }))

          const root = path.join(tmp.path, "generated")
          yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: 257 }, (_, index) =>
                fs.mkdir(path.join(root, `unmarked-${String(index).padStart(3, "0")}`), { recursive: true }),
              ),
            ),
          )
          const first = yield* ProjectArtifactLegacyCleanup.run({ root })
          expect(first).toEqual(expect.objectContaining({ status: "partial", scanned: 256 }))
          const second = yield* ProjectArtifactLegacyCleanup.run({ root, cursor: first.cursor })
          expect(second).toEqual(expect.objectContaining({ status: "complete", scanned: 1 }))
        }),
      ),
    ),
  )

  it.live("refuses root, marker, and child replacement at the removal boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("project-artifact-cleanup-replacement-")),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const cases = ["root", "marker", "child"] as const
          for (const replacement of cases) {
            const root = path.join(tmp.path, `generated-${replacement}`)
            const backup = path.join(tmp.path, `backup-${replacement}`)
            const external = path.join(tmp.path, `external-${replacement}`)
            const name = legacyDirectory("owned", "location", replacement)
            const child = path.join(root, name)
            const externalChild = path.join(external, name)
            yield* Effect.promise(async () => {
              await fs.mkdir(child, { recursive: true })
              await writeMarker(child, "location", replacement)
              await fs.mkdir(externalChild, { recursive: true })
              await fs.writeFile(path.join(externalChild, "sentinel"), "external")
            })

            const report = yield* ProjectArtifactLegacyCleanup.run(
              { root },
              {
                beforeRemove: async () => {
                  if (replacement === "root") {
                    await fs.rename(root, backup)
                    await fs.symlink(external, root)
                    return
                  }
                  if (replacement === "marker") {
                    const marker = path.join(child, ".ycoding-generated.json")
                    await fs.rename(marker, `${marker}.old`)
                    await fs.writeFile(marker, "{}")
                    return
                  }
                  await fs.rename(child, backup)
                  await fs.symlink(externalChild, child)
                },
              },
            )

            expect(report).toEqual(expect.objectContaining({ status: "partial", removed: 0, failed: 1 }))
            expect(report.cursor).not.toBe(name)
            expect(yield* exists(path.join(externalChild, "sentinel"))).toBe(true)

            yield* Effect.promise(async () => {
              if (replacement === "root") {
                await fs.rm(root)
                await fs.rename(backup, root)
                return
              }
              if (replacement === "child") {
                await fs.rm(child)
                await fs.rename(backup, child)
              }
            })
          }
        }),
      ),
    ),
  )
})

function exists(file: string) {
  return Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  )
}


function legacyDirectory(name: string, locationID: string, artifactID: string) {
  const digest = new Bun.CryptoHasher("sha256").update(`${locationID}\0${artifactID}`).digest("hex")
  return `${name}-${digest.slice(0, 12)}`
}

function writeMarker(directory: string, locationID: string, artifactID: string) {
  return fs.writeFile(
    path.join(directory, ".ycoding-generated.json"),
    JSON.stringify({
      generated: true,
      locationID,
      artifactID,
      versionID: "version",
      versionDigest: "a".repeat(64),
    }),
  )
}
