import { expect, test } from "bun:test"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { Effect } from "effect"
import {
  projectArtifactError,
  ProjectArtifactHandler,
  refreshAfterProjectArtifactMutation,
} from "../src/handlers/project-artifact"

test("refreshes the Location-scoped artifact source only after a committed mutation", async () => {
  const calls: string[] = []
  const source = {
    refresh: () =>
      Effect.sync(() => {
        calls.push("refresh")
      }),
  }

  await Effect.runPromise(
    refreshAfterProjectArtifactMutation(
      Effect.sync(() => {
        calls.push("store")
        return "committed"
      }),
      source,
    ),
  )
  expect(calls).toEqual(["store", "refresh"])

  const failed = await Effect.runPromiseExit(
    refreshAfterProjectArtifactMutation(
      Effect.fail("store failure"),
      source,
    ),
  )
  expect(failed._tag).toBe("Failure")
  expect(calls).toEqual(["store", "refresh"])

  await Effect.runPromise(
    refreshAfterProjectArtifactMutation(
      Effect.sync(() => {
        calls.push("store")
        return "committed"
      }),
      {
        refresh: () =>
          Effect.sync(() => {
            calls.push("refresh")
          }),
      },
    ),
  )
  expect(calls).toEqual(["store", "refresh", "store", "refresh"])
})

test("maps typed Store errors to stable HTTP error classes without leaking Store messages", () => {
  const cases = [
    ["InvalidScope", "ArtifactBadRequest"],
    ["ArtifactNotFound", "ArtifactNotFound"],
    ["VersionConflict", "ArtifactConflict"],
    ["ConfirmationExpired", "ArtifactGone"],
    ["ContentTooLarge", "ArtifactTooLarge"],
    ["WriteRateExceeded", "ArtifactRateLimited"],
    ["StorageUnavailable", "ArtifactUnavailable"],
  ] as const

  for (const [code, tag] of cases) {
    const error = projectArtifactError(
      new ProjectArtifactStore.StoreError({
        code,
        message: "/private/path and secret content never leave Store",
      }),
    )
    expect(error._tag).toBe(tag)
    expect(error.code).toBe(code)
    expect(JSON.stringify(error)).not.toContain("/private/path")
    expect(JSON.stringify(error)).not.toContain("secret content")
  }
})

test("handles every artifact operation through the Store boundary", async () => {
  const source = await Bun.file(new URL("../src/handlers/project-artifact.ts", import.meta.url)).text()

  expect(ProjectArtifactHandler).toBeDefined()
  for (const operation of [
    "artifact.list",
    "artifact.get",
    "artifact.create",
    "artifact.update",
    "artifact.confirmGlobal",
    "artifact.disable",
    "artifact.enable",
    "artifact.remove",
    "artifact.restore",
    "artifact.revert",
    "artifact.metrics",
    "artifact.promotion.preview",
    "artifact.promotion.confirm",
    "artifact.fork.preview",
    "artifact.fork.confirm",
    "artifact.shadow.preview",
    "artifact.shadow.confirm",
    "artifact.purge",
  ]) {
    expect(source).toContain(`"${operation}"`)
  }
  expect(source).toContain("Location.Service")
  expect(source).toContain("ProjectArtifactStore.Service")
  expect(source).not.toContain("storageID: ctx")
  expect(source).not.toContain("collision: ctx")
})

test("refreshes exactly the successful discovery-affecting mutation paths", async () => {
  const source = await Bun.file(new URL("../src/handlers/project-artifact.ts", import.meta.url)).text()

  for (const operation of [
    "artifact.create",
    "artifact.update",
    "artifact.confirmGlobal",
    "artifact.remove",
    "artifact.restore",
    "artifact.revert",
    "artifact.promotion.confirm",
    "artifact.fork.confirm",
    "artifact.shadow.confirm",
  ]) {
    const start = source.indexOf(`"${operation}"`)
    const end = source.indexOf(".handle(", start + operation.length)
    expect(source.slice(start, end === -1 ? undefined : end)).toContain("refreshMutation")
  }
  expect(source).toContain('.handle("artifact.disable", (ctx) => changeEnabled(ctx, false))')
  expect(source).toContain('.handle("artifact.enable", (ctx) => changeEnabled(ctx, true))')
  expect(source.slice(source.indexOf("function changeEnabled"))).toContain("refreshMutation(effect)")
  expect(source.slice(source.indexOf('"artifact.purge"'))).not.toContain("refreshMutation(store.purge())")
})
