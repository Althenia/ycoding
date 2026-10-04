import { expect, test } from "bun:test"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { Effect } from "effect"
import {
  projectArtifactError,
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
