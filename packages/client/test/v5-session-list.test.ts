import { expect, test } from "bun:test"
import {
  decodeStrict,
  session_list_RequestSchema,
  session_list_ResultSchema,
  StatusSchema,
  WireLimit,
} from "@ycoding-ai/protocol/v5"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"

test("remote Session filters retain waiting, pinned order and summary search on the wire", () => {
  const query = { limit: 50, order: "pinned", status: "waiting", searchFields: "summary", parentID: null }
  const bytes = encodeDomain(session_list_RequestSchema.typeName, { query })
  expect(decodeStrict(session_list_RequestSchema, bytes).query).toMatchObject({
    limit: 50n,
    order: 3,
    status: 3,
    searchFields: 1,
    parentID: { kind: { case: "clear" } },
  })
  expect(decodeDomain(session_list_RequestSchema.typeName, bytes)).toEqual({ query })
})

test("Session pages retain waiting and loss-only status without requiring it on local pages", () => {
  for (const status of [undefined, { running: [], attention: ["ses_lost"], lost: ["ses_lost"] }]) {
    const data = { data: [], cursor: {}, ...(status ? { status } : {}) }
    const bytes = encodeDomain(session_list_ResultSchema.typeName, { data })
    expect(decodeDomain(session_list_ResultSchema.typeName, bytes)).toEqual({ data })
    if (status)
      expect(decodeStrict(session_list_ResultSchema, bytes).data?.status).toMatchObject({
        running: [],
        attention: ["ses_lost"],
        lost: { items: ["ses_lost"] },
      })
  }
})

test("active Session refreshes retain their anchor and stale-page signal", () => {
  const query = { limit: 50, order: "active", around: "ses_anchor", before: 2 }
  const request = encodeDomain(session_list_RequestSchema.typeName, { query })
  expect(decodeDomain(session_list_RequestSchema.typeName, request)).toEqual({ query })
  const data = { data: [], cursor: {}, stale: true }
  const result = encodeDomain(session_list_ResultSchema.typeName, { data })
  expect(decodeDomain(session_list_ResultSchema.typeName, result)).toEqual({ data })
})

test("inline status lists retain collection and encoding limits", () => {
  expect(() => encodeDomain(StatusSchema.typeName, { running: "ses_one" })).toThrow("Expected domain list")
  expect(() => encodeDomain(StatusSchema.typeName, { running: Array(WireLimit.TOTAL_FIELDS + 1).fill("") })).toThrow(
    "Domain field limit",
  )
  expect(() => encodeDomain(StatusSchema.typeName, { running: ["ses_one"] }, 1)).toThrow("Domain byte limit")
})
