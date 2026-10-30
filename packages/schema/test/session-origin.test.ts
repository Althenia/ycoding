import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Session } from "../src/session.js"
import { SessionEvent } from "../src/session-event.js"

const info = {
  id: "ses_origin",
  projectID: "prj_origin",
  title: "Dots · synthetic",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  location: { directory: "/work" },
  time: { created: 1, updated: 2 },
}
const created = {
  sessionID: "ses_origin",
  projectID: "prj_origin",
  location: { directory: "/work" },
  title: "Dots · synthetic",
  created: 1,
}

test("Session.Info decodes with and without an origin and rejects unknown origins", () => {
  const decode = Schema.decodeUnknownSync(Session.Info)
  expect(decode(info).origin).toBeUndefined()
  expect(decode({ ...info, origin: "dots-executor" }).origin).toBe("dots-executor")
  expect(() => decode({ ...info, origin: "other" })).toThrow()
})

test("Session.Info encoding omits an absent origin", () => {
  const encode = Schema.encodeSync(Session.Info)
  const decoded = Schema.decodeUnknownSync(Session.Info)(info)
  expect(Object.keys(encode(decoded))).not.toContain("origin")
  expect(encode(Schema.decodeUnknownSync(Session.Info)({ ...info, origin: "dots-executor" })).origin).toBe("dots-executor")
})

test("session.created v2 decodes historical payloads without an origin and carries an executor origin", () => {
  const decode = Schema.decodeUnknownSync(SessionEvent.Created.data)
  expect(decode(created).origin).toBeUndefined()
  expect(decode({ ...created, origin: "dots-executor" }).origin).toBe("dots-executor")
  expect(() => decode({ ...created, origin: "other" })).toThrow()
  expect(SessionEvent.Created.durable?.version).toBe(2)
  expect(Object.keys(Schema.encodeSync(SessionEvent.Created.data)(decode(created)))).not.toContain("origin")
})
