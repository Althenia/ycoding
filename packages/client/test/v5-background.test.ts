import { expect, test } from "bun:test"
import { decodeStrict, session_list_RequestSchema, SessionsQuerySchema } from "@ycoding-ai/protocol/v5"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import type { BackendSessionsQuery } from "../src/v5/index.js"
import { enumLabels } from "../src/v5/generated/domain.js"

test("background Session filter transmits include and exclude and stays absent otherwise", () => {
  const cases = [
    { filter: "include", tag: 1 },
    { filter: "exclude", tag: 2 },
    { filter: undefined, tag: undefined },
  ] as const
  for (const { filter, tag } of cases) {
    const query = { limit: 25, ...(filter ? { background: filter } : {}) } satisfies BackendSessionsQuery
    const bytes = encodeDomain(session_list_RequestSchema.typeName, { query })
    const wire = decodeStrict(session_list_RequestSchema, bytes).query
    expect(wire?.limit).toBe(25n)
    expect(wire && Object.hasOwn(wire, "background")).toBe(tag !== undefined)
    if (tag !== undefined) expect(wire?.background).toBe(tag)
    expect(decodeDomain(session_list_RequestSchema.typeName, bytes)).toEqual({ query })
  }
})

test("background Session filter rejects unknown labels", () => {
  expect(() => encodeDomain(SessionsQuerySchema.typeName, { background: "only" })).toThrow()
})

test("SessionsQuery enum labels keep their numeric values", () => {
  expect(enumLabels["ycoding.v5.SessionsQuery_background"]).toEqual({ 1: "include", 2: "exclude" })
  expect(enumLabels["ycoding.v5.SessionsQuery_order"]).toEqual({ 1: "asc", 2: "desc", 3: "pinned", 4: "active" })
  expect(enumLabels["ycoding.v5.SessionsQuery_status"]).toEqual({ 1: "running", 2: "idle", 3: "waiting" })
  expect(enumLabels["ycoding.v5.SessionsQuery_searchFields"]).toEqual({ 1: "summary" })
})
