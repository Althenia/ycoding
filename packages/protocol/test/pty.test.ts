import { expect, test } from "bun:test"
import { Schema } from "effect"
import { PtyGroup } from "../src/groups/pty.js"
import { effectOmitEndpoints, promiseOmitEndpoints } from "../src/client.js"

function payload(endpoint: (typeof PtyGroup.endpoints)[keyof typeof PtyGroup.endpoints]) {
  const schema = endpoint.payload.values().next().value?.schemas[0]
  if (!schema) throw new Error("endpoint has no payload schema")
  return schema
}

test("PTY operations carry Session ownership and expose explicit fenced control", () => {
  const group = PtyGroup.endpoints
  const list = group["pty.list"]
  const create = group["pty.create"]
  const control = group["pty.control"]

  if (!list.query) throw new Error("list endpoint has no query schema")
  expect(Schema.is(list.query)({ sessionID: "ses_owner" })).toBe(true)
  expect(Schema.is(list.query)({})).toBe(false)
  expect(Schema.is(payload(create))({ sessionID: "ses_owner" })).toBe(true)
  expect(control.path).toBe("/api/pty/:ptyID/control")
  expect(control.method).toBe("POST")
  expect(
    Schema.is(payload(control))({
      sessionID: "ses_owner",
      generation: 1,
      expectedFence: 1,
      action: "take",
    }),
  ).toBe(true)
})

test("PTY websocket tickets declare inspect versus fenced control access", () => {
  const endpoint = PtyGroup.endpoints["pty.connectToken"]
  expect(
    Schema.is(payload(endpoint))({
      sessionID: "ses_owner",
      access: "control",
      generation: 1,
      expectedFence: 2,
    }),
  ).toBe(true)
  expect(Schema.is(payload(endpoint))({ sessionID: "ses_owner", access: "control", generation: 1 })).toBe(true)
})

test("PTY ticket issuance is generated with its required request header", () => {
  expect(promiseOmitEndpoints.has("pty.connectToken")).toBe(false)
  expect(effectOmitEndpoints.has("pty.connectToken")).toBe(false)
  expect(promiseOmitEndpoints.has("pty.connect")).toBe(true)
  expect(effectOmitEndpoints.has("pty.connect")).toBe(true)
  const headers = PtyGroup.endpoints["pty.connectToken"].headers
  if (!headers) throw new Error("ticket endpoint has no header schema")
  expect(Schema.is(headers)({ "x-ycoding-ticket": "1" })).toBe(true)
  expect(Schema.is(headers)({})).toBe(false)
  expect(Schema.is(headers)({ "x-ycoding-ticket": "0" })).toBe(false)
})
