import { expect, test } from "bun:test"
import { validateRegeneration } from "./migration"

const previous = { version: "7", dialect: "sqlite", id: "previous", prevIds: ["older"], ddl: [] }
const current = { version: "7", dialect: "sqlite", id: "current", prevIds: ["previous"], ddl: [] }
const valid = {
  regenerate: "20261103050046_session-scope",
  baseline: "/synthetic/previous.json",
  migrations: ["20261101000000_earlier", "20261103050046_session-scope"],
  current,
  previous,
}

test("regeneration accepts the latest target and its compatible previous snapshot", () => {
  expect(() => validateRegeneration(valid)).not.toThrow()
  expect(() => validateRegeneration({ ...valid, generatedCount: 1 })).not.toThrow()
})

test("regeneration options must be paired and exclude check reset and name", () => {
  expect(() => validateRegeneration({ ...valid, baseline: undefined })).toThrow()
  expect(() => validateRegeneration({ ...valid, regenerate: undefined })).toThrow()
  expect(() => validateRegeneration({ ...valid, check: true })).toThrow()
  expect(() => validateRegeneration({ ...valid, reset: true })).toThrow()
  expect(() => validateRegeneration({ ...valid, name: "scope" })).toThrow()
})

test("regeneration rejects unsafe missing and nonlatest migration targets", () => {
  const targets = [
    "../20261103050046_session-scope",
    "/synthetic/target",
    "20261103050046_missing",
    "20261101000000_earlier",
  ]
  for (const regenerate of targets) {
    expect(() => validateRegeneration({ ...valid, regenerate })).toThrow()
  }
})

test("regeneration rejects malformed or incompatible snapshot data", () => {
  const snapshots = [
    null,
    {},
    { ...valid.previous, ddl: null },
    { ...valid.previous, prevIds: "older" },
    { ...valid.previous, version: "6" },
    { ...valid.previous, dialect: "postgresql" },
  ]
  for (const previous of snapshots) {
    expect(() => validateRegeneration({ ...valid, previous })).toThrow()
  }
  expect(() => validateRegeneration({ ...valid, current: { ...current, ddl: null } })).toThrow()
  expect(() => validateRegeneration({ ...valid, current: { ...current, dialect: "postgresql" } })).toThrow()
})

test("regeneration rejects the current snapshot and a snapshot outside its parent chain", () => {
  expect(() => validateRegeneration({ ...valid, previous: current })).toThrow()
  expect(() => validateRegeneration({ ...valid, previous: { ...previous, id: "unrelated" } })).toThrow()
})

test("regeneration requires exactly one generated incremental migration", () => {
  expect(() => validateRegeneration({ ...valid, generatedCount: 0 })).toThrow()
  expect(() => validateRegeneration({ ...valid, generatedCount: 2 })).toThrow()
  expect(() => validateRegeneration({ ...valid, generatedCount: 1, generatedSql: "  " })).toThrow()
})
