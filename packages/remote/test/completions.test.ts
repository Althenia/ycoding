import { expect, test } from "bun:test"
import { parseAgentMessage, parseClientMessage, parseRelayToClientMessage, serializeCompletions } from "../src/index"

const receipt = { id: "evt_complete", seq: 12, created: 1_000, sessionID: "ses_root" }
const frame = { type: "completions", data: [receipt], more: false } as const

test("accepts bounded explicit completion receipts only from the local agent", () => {
  expect(parseAgentMessage(JSON.stringify(frame))).toEqual({ ok: true, value: frame })
  expect(parseAgentMessage(JSON.stringify({ ...frame, data: [], more: false })).ok).toBe(true)
  expect(parseAgentMessage(JSON.stringify({ ...frame, more: true })).ok).toBe(true)
  expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(false)
  expect(parseRelayToClientMessage(JSON.stringify(frame)).ok).toBe(false)
  const data = Array.from({ length: 200 }, (_, index) => ({ ...receipt, id: `evt_${index}`, sessionID: `ses_${index}` }))
  expect(parseAgentMessage(JSON.stringify({ ...frame, data })).ok).toBe(true)
  expect(parseAgentMessage(JSON.stringify({ ...frame, data: [...data, { ...receipt, sessionID: "ses_extra" }] })).ok).toBe(false)
})

test("rejects malformed, duplicate, unbounded, or content-bearing completion receipts", () => {
  for (const change of [
    { id: "wrong" }, { id: `evt_${"a".repeat(129)}` }, { seq: 0 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 },
    { created: -1 }, { created: Number.MAX_SAFE_INTEGER + 1 }, { sessionID: "wrong" }, { sessionID: `ses_${"a".repeat(129)}` },
    { transcript: "not evidence" }, { inputID: "msg_unneeded" },
  ]) expect(parseAgentMessage(JSON.stringify({ ...frame, data: [{ ...receipt, ...change }] })).ok).toBe(false)
  for (const change of [
    { more: undefined }, { more: "false" }, { data: null }, { data: [null] }, { data: [receipt, receipt] }, { extra: true },
  ]) expect(parseAgentMessage(JSON.stringify({ ...frame, ...change })).ok).toBe(false)
})

test("serializes only the completion identity needed by the relay", () => {
  const data = [{ ...receipt, inputID: "msg_input", assistantMessageID: "msg_final", transcript: "not transmitted" }]
  expect(JSON.parse(serializeCompletions({ type: "completions", data, more: false }))).toEqual(frame)
})

test("carries an optional bounded Session title for the completion alert", () => {
  const titled = { ...frame, data: [{ ...receipt, title: "Ship the release" }] }
  expect(parseAgentMessage(serializeCompletions(titled))).toEqual({ ok: true, value: titled })
  for (const title of ["", " padded", "two\nlines", "x".repeat(121), 7])
    expect(parseAgentMessage(JSON.stringify({ ...frame, data: [{ ...receipt, title }] })).ok).toBe(false)
})
