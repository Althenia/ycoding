import { expect, test } from "bun:test"
import { groupNames } from "../src/client.js"
import { enums, messages } from "../src/generated/v5/contract.js"
import { operations } from "../src/generated/v5/index.js"
import { retiredOperations } from "../src/v5/retired-operations.js"

const removed = /ProjectArtifact|^Artifact[A-Z]|^artifact_|ArtifactProvenance|project_artifacts_ended|SessionLogItemValue5(?:_|$)/

test("the client exposes no project artifact group", () => {
  expect(Object.values(groupNames)).not.toContain("projectArtifact")
  expect(Object.keys(groupNames)).not.toContain("server.projectArtifact")
})

test("the generated v5 contract carries no project artifact types or operations", () => {
  expect(Object.keys(messages).filter((name) => removed.test(name))).toEqual([])
  expect(Object.keys(enums).filter((name) => removed.test(name))).toEqual([])
  expect(operations.map((operation) => operation.diagnosticName).filter((name) => name.startsWith("artifact."))).toEqual([])
})

test("project artifact operation identifiers stay retired", () => {
  const retired = Object.entries(retiredOperations).filter(([name]) => name.startsWith("artifact."))
  expect(retired.map(([, id]) => id).toSorted()).toEqual(Array.from({ length: 18 }, (_, index) => 2001 + index))
})
