import { expect, test } from "bun:test"
import { WireLimit } from "@ycoding-ai/remote"
import { fillWindow, transportFixture } from "../../test/wire-peer"
import { describeOutcome } from "./outcome"
import type { RemoteRequestOutcome, RemoteResendRequest } from "./transport"

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function resendFixture(admission: boolean) {
  const admitted: RemoteResendRequest[] = []
  const f = transportFixture({
    revision: () => 7,
    admit: (request) => {
      admitted.push(request)
      return admission
    },
  })
  return { f, admitted }
}

/** One request that is written and one that is only queued behind the rate window, then a dropped socket. */
async function dropWithSentAndQueued(f: ReturnType<typeof transportFixture>, operation: string) {
  const reads = WireLimit.CLIENT_RATE - 5
  await fillWindow(f, reads)
  const sent = f.transport.request(operation, { sessionID: "ses_a", timeoutMs: 0 })
  const queued = f.transport.request(operation, { sessionID: "ses_a", timeoutMs: 0 })
  expect(f.sockets[0]!.requests().slice(reads)).toEqual([expect.objectContaining({ operation, sessionID: "ses_a" })])
  f.sockets[0]!.drop()
  return { sent, queued }
}

async function reopen(f: ReturnType<typeof transportFixture>) {
  f.advance(1)
  f.sockets[1]!.open()
  await settle()
}

test("REQ-WIRE-009 a request proven never written is resent once when the fence admits it", async () => {
  const { f, admitted } = resendFixture(true)
  try {
    const { sent, queued } = await dropWithSentAndQueued(f, "session.interrupt")
    expect(await sent).toMatchObject({ status: "unknown" })
    await reopen(f)
    const second = f.sockets[1]!
    expect(second.requests()).toEqual([expect.objectContaining({ operation: "session.interrupt", sessionID: "ses_a" })])
    second.result(second.dispatches[0]!, { data: {} })
    expect(await queued).toMatchObject({ status: "ok" })
    expect(admitted).toEqual([{ operation: "session.interrupt", sessionID: "ses_a", issuedRevision: 7 }])
    expect(f.sockets[0]!.requests().filter((request) => request.operation === "session.interrupt")).toHaveLength(1)
  } finally {
    f.transport.close()
  }
})

test("REQ-WIRE-009 a request proven never written is not resent when the fence rejects it", async () => {
  const { f, admitted } = resendFixture(false)
  try {
    const { queued } = await dropWithSentAndQueued(f, "session.interrupt")
    await reopen(f)
    const outcome = await queued
    expect(outcome).toEqual({ status: "unavailable", reason: "connection-changed" })
    expect(describeOutcome(outcome as Exclude<RemoteRequestOutcome, { status: "ok" }>, "Interrupt")).toBe(
      "Interrupt was not sent again because the connection changed. Check the current state, then try again.",
    )
    expect(admitted).toHaveLength(1)
    expect(f.sockets[1]!.requests()).toEqual([])
  } finally {
    f.transport.close()
  }
})

test("REQ-WIRE-009 a request whose transmission is uncertain is never resent and names the changed connection", async () => {
  const { f, admitted } = resendFixture(true)
  try {
    const { sent } = await dropWithSentAndQueued(f, "session.interrupt")
    const outcome = await sent
    expect(outcome).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    expect(describeOutcome(outcome as Exclude<RemoteRequestOutcome, { status: "ok" }>, "Interrupt")).toContain(
      "connection changed",
    )
    await reopen(f)
    expect(f.sockets[1]!.requests()).toHaveLength(1)
    expect(admitted).toHaveLength(1)
  } finally {
    f.transport.close()
  }
})

test("REQ-WIRE-009 resendUnsent never resends a cancelled request or a transmitted mutation", async () => {
  const { f, admitted } = resendFixture(true)
  try {
    const outcome = f.transport.request("session.interrupt", { sessionID: "ses_a", timeoutMs: 15 })
    expect(f.sockets[0]!.requests()).toEqual([expect.objectContaining({ operation: "session.interrupt" })])
    f.advance(15)
    expect(await outcome).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    f.sockets[0]!.drop()
    await reopen(f)
    expect(f.sockets[1]!.requests()).toEqual([])
    expect(admitted).toEqual([])
  } finally {
    f.transport.close()
  }
})
