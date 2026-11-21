import { expect, test } from "bun:test"
import { transportFixture } from "./wire-peer"

test("a finite Session log settles only after its synchronized stream ends", async () => {
  const fixture = transportFixture()
  const socket = fixture.sockets[0]!
  try {
    const result = fixture.transport.request("session.log", { sessionID: "ses_fixture", input: { after: 3, follow: false } })
    const dispatch = socket.dispatches.at(-1)!
    expect(dispatch.operation.diagnosticName).toBe("session.log")
    socket.result(dispatch, { subscription_id: "log_fixture" })
    socket.log("ses_fixture", "log_fixture", [], 3, false)
    let settled = false
    void result.then(() => { settled = true })
    fixture.advance(100)
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.body({ case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: "log_fixture" } })
    expect(await result).toEqual({ status: "ok", value: { watermark: 3 } })
  } finally {
    fixture.transport.close()
  }
})

test("finite log recovery retains the latest execution event and synchronized watermark", async () => {
  const fixture = transportFixture()
  const socket = fixture.sockets[0]!
  try {
    const result = fixture.transport.request("session.log", { sessionID: "ses_fixture", input: { after: 3, follow: false } })
    socket.result(socket.dispatches.at(-1)!, { subscription_id: "log_fixture" })
    socket.log("ses_fixture", "log_fixture", [
      { type: "session.execution.started", durable: { aggregateID: "ses_fixture", seq: 4, version: 1 }, data: { sessionID: "ses_fixture" } },
      { type: "session.execution.succeeded", durable: { aggregateID: "ses_fixture", seq: 5, version: 1 }, data: { sessionID: "ses_fixture" } },
    ], 3)
    fixture.advance(100)
    expect(await result).toMatchObject({ status: "ok", value: { watermark: 5, execution: { type: "session.execution.succeeded", durable: { seq: 5 } } } })
  } finally {
    fixture.transport.close()
  }
})

test("a log stream that ends without synchronization reports an unknown outcome", async () => {
  const fixture = transportFixture()
  const socket = fixture.sockets[0]!
  try {
    const result = fixture.transport.request("session.log", { sessionID: "ses_fixture", input: { follow: false } })
    socket.result(socket.dispatches.at(-1)!, { subscription_id: "log_fixture" })
    socket.body({ case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: "log_fixture" } })
    expect(await result).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
  } finally {
    fixture.transport.close()
  }
})
