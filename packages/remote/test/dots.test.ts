import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperationAccess, remoteDotsPeerLabel } from "../src/index"

test("attributes completed turnless room replies and rejects an empty turn identity", () => {
  const dots = {
    origin: "dots-peer",
    profile: "synthetic",
    dotID: "dot-1",
    threadID: "thread-1",
    itemID: "room-message",
  }
  expect(remoteDotsPeerLabel({ dots })).toBe("Dot dot-1 · external peer · thread-1")
  expect(remoteDotsPeerLabel({ dots: { ...dots, turnID: "" } })).toBeUndefined()
})

const target = {
  profile: "synthetic",
  dotID: "dot-1",
  threadID: "thread-1",
  generation: "generation-1",
  label: "V / conversation",
}
const parse = (operation: string, input?: unknown, sessionID: string | null = "ses_test") =>
  parseClientMessage(JSON.stringify({ type: "request", id: "req_test", operation, sessionID, input }))

test("Dots controls require a Session and stay in the closed operation set", () => {
  for (const [operation, input] of [
    ["session.dots.targets", { profile: "synthetic" }],
    ["session.dots.status", undefined],
    ["session.dots.bind", target],
    ["session.dots.send", { id: "msg_test", text: "hello", expectedTarget: target }],
    ["session.dots.pause", { expectedTarget: target }],
    ["session.dots.resume", { expectedTarget: target }],
  ] as const) {
    expect(parse(operation, input).ok).toBe(true)
    expect(parse(operation, input, null).ok).toBe(false)
  }
  expect(remoteOperationAccess["session.dots.send"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.bind"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.status"]).toBe("read")
  expect(remoteOperationAccess["session.dots.pause"]).toBe("mutation")
  expect(remoteOperationAccess["session.dots.resume"]).toBe("mutation")
  expect(parse("session.dots.cancel", { turnID: "turn-1" }).ok).toBe(false)
})

test("runtime controls reject missing targets, stale target shapes and caller-selected paths", () => {
  for (const operation of ["session.dots.pause", "session.dots.resume"]) {
    for (const input of [undefined, {}, { turnID: "turn" }, { expectedTarget: { ...target, generation: "" } },
      { expectedTarget: target, path: "/other" }, { expectedTarget: target, directory: "/tmp" }, { expectedTarget: target, turnID: "turn" }])
      expect(parse(operation, input).ok).toBe(false)
  }
})

test("the relay rejects target guessing and ambient context fields", () => {
  expect(parse("session.dots.bind", { profile: "synthetic", label: "V" }).ok).toBe(false)
  expect(parse("session.dots.send", { text: "missing client identity" }).ok).toBe(false)
  for (const extra of [
    { history: ["ambient"] },
    { editor: "selection" },
    { accessToken: "synthetic-not-a-secret" },
    { target },
  ])
    expect(parse("session.dots.send", { id: "msg_test", text: "hello", expectedTarget: target, ...extra }).ok).toBe(
      false,
    )
})
