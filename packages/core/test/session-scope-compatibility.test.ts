import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Session } from "@ycoding-ai/schema/session"

const info = {
  id: "ses_synthetic",
  projectID: "prj_synthetic",
  title: "Synthetic",
  location: { directory: "/synthetic" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const created = {
  sessionID: "ses_synthetic",
  projectID: "prj_synthetic",
  title: "Synthetic",
  location: { directory: "/synthetic" },
  created: 1,
}
const decodeInfo = Schema.decodeUnknownSync(Session.Info)
const encodeInfo = Schema.encodeSync(Session.Info)
const decodeCreated = Schema.decodeUnknownSync(Session.Event.Created.data)
const encodeCreated = Schema.encodeSync(Session.Event.Created.data)

test("legacy Session Info and Created payloads default to bound scope", () => {
  expect(decodeInfo(info).scope).toBe("bound")
  expect(decodeCreated(created).scope).toBe("bound")
})

test("standalone Session Info and Created payloads survive encode and decode", () => {
  const decodedInfo = decodeInfo({ ...info, scope: "standalone" })
  const decodedCreated = decodeCreated({ ...created, scope: "standalone" })
  expect(encodeInfo(decodedInfo).scope).toBe("standalone")
  expect(encodeCreated(decodedCreated).scope).toBe("standalone")
  expect(decodeInfo(encodeInfo(decodedInfo)).scope).toBe("standalone")
  expect(decodeCreated(encodeCreated(decodedCreated)).scope).toBe("standalone")
})
