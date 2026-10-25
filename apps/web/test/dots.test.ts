import { describe, expect, test } from "bun:test"
import { remoteDotsPeerLabel, type RemoteDotsTarget } from "@ycoding-ai/remote"
import type { RemoteLink } from "../src/remote/queries"
import { createDotsCapabilityReader, dotsClient } from "../src/remote/dots"

const target: RemoteDotsTarget = {
  profile: "synthetic",
  dotID: "dot-1",
  threadID: "thread-1",
  generation: "generation-1",
  label: "Dot / conversation",
}

function fixture(onStatus?: () => void) {
  const calls: Array<{ operation: string; input: unknown; sessionID: string | undefined }> = []
  let bound: RemoteDotsTarget | undefined
  const link: RemoteLink = {
    recoveries: () => 0,
    recovered: async () => false,
    request: async (_scope, operation, request) => {
      calls.push({ operation, input: request?.input, sessionID: request?.sessionID })
      if (operation === "session.dots.bind") bound = target
      if (operation === "session.dots.status") onStatus?.()
      const value =
        operation === "session.dots.targets"
          ? { data: [target] }
          : operation === "session.attachment.upload"
            ? { uri: `ycoding-upload://${request?.input?.uploadID}` }
            : operation === "session.dots.send"
              ? { data: { messageID: request?.input?.id, status: "accepted", turnID: "turn-1" } }
              : { data: { enabled: true, state: "connected", ...(bound ? { target: bound } : {}) } }
      return { status: "ok", value }
    },
  }
  return {
    calls,
    client: dotsClient(link, { deviceID: "device-1", generation: 1 }, "ses_local"),
    rebind: (value: RemoteDotsTarget) => {
      bound = value
    },
  }
}

describe("local Dots relay framing; synthetic responses do not prove service acceptance", () => {
  test("status preserves only the closed native runtime states", async () => {
    for (const runtimeState of ["paused", "unpaused", "unknown", undefined, "running", {}, 1]) {
      const link: RemoteLink = {
        recoveries: () => 0, recovered: async () => false,
        request: async () => ({ status: "ok", value: { data: { enabled: true, state: "connected", target, runtimeState } } }),
      }
      const client = dotsClient(link, { deviceID: "device-1", generation: 1 }, "ses_local")
      if (runtimeState === undefined || runtimeState === "paused" || runtimeState === "unpaused" || runtimeState === "unknown")
        expect(await client.status()).toEqual({ enabled: true, state: "connected", target, ...(runtimeState ? { runtimeState } : {}) })
      else expect(await client.status().then(() => "", (error: unknown) => error instanceof Error ? error.message : "Unexpected error")).toContain("runtime state")
    }
  })

  test("Pause and Resume send only the displayed target and use the returned status", async () => {
    const calls: unknown[] = []
    const link: RemoteLink = { recoveries: () => 0, recovered: async () => false, request: async (_scope, operation, request) => {
      calls.push({ operation, sessionID: request?.sessionID, input: request?.input })
      return { status: "ok", value: { data: { enabled: true, state: "connected", target, runtimeState: operation === "session.dots.pause" ? "paused" : "unpaused" } } }
    } }
    const client = dotsClient(link, { deviceID: "device-1", generation: 1 }, "ses_local")
    expect(await client.pause(target)).toEqual({ enabled: true, state: "connected", target, runtimeState: "paused" })
    expect(await client.resume(target)).toEqual({ enabled: true, state: "connected", target, runtimeState: "unpaused" })
    expect(calls).toEqual(["pause", "resume"].map((action) => ({ operation: `session.dots.${action}`, sessionID: "ses_local", input: { expectedTarget: target } })))
  })

  test("status requires an explicit boolean enabled field and fails closed otherwise", async () => {
    const read = (data: unknown) => {
      const link: RemoteLink = {
        recoveries: () => 0, recovered: async () => false,
        request: async () => ({ status: "ok", value: { data } }),
      }
      return dotsClient(link, { deviceID: "device-1", generation: 1 }, "ses_local").status()
    }
    expect(await read({ enabled: false, state: "disconnected" })).toEqual({ enabled: false, state: "disconnected" })
    for (const enabled of [undefined, "true", 1, null])
      expect(await read({ enabled, state: "connected" }).then(() => "", (error: unknown) => error instanceof Error ? error.message : "")).toContain("enabled")
  })

  test("a disabled backend sends no upload and no conversation message", async () => {
    const calls: string[] = []
    const link: RemoteLink = {
      recoveries: () => 0, recovered: async () => false,
      request: async (_scope, operation) => {
        calls.push(operation)
        return { status: "ok", value: { data: { enabled: false, state: "disconnected" } } }
      },
    }
    const client = dotsClient(link, { deviceID: "device-1", generation: 1 }, "ses_local")
    await expect(client.send({ id: "msg_off", text: "hello", expectedTarget: target, files: [{ uri: "data:text/plain;base64,eA==", name: "chosen.txt" }] })).rejects.toThrow("disabled")
    expect(calls).toEqual(["session.dots.status"])
  })

  test("status read forwards the caller's abort signal", async () => {
    const controller = new AbortController()
    const signals: unknown[] = []
    const link: RemoteLink = {
      recoveries: () => 0, recovered: async () => false,
      request: async (_scope, _operation, request) => {
        signals.push(request?.signal)
        return { status: "ok", value: { data: { enabled: true, state: "connected" } } }
      },
    }
    await dotsClient(link, { deviceID: "device-1", generation: 1 }, "ses_local").status(controller.signal)
    expect(signals).toEqual([controller.signal])
  })

  test("cancellation during destination verification prevents a text-only send", async () => {
    const controller = new AbortController()
    const view = fixture(() => controller.abort(new Error("Dots send cancelled")))
    await view.client.bind(target)
    await expect(
      view.client.send({ id: "msg_cancelled", text: "current text", expectedTarget: target }, controller.signal),
    ).rejects.toThrow("cancelled")
    expect(view.calls.map((call) => call.operation)).toEqual(["session.dots.bind", "session.dots.status"])
  })
  test("constructing, listing and confirming a destination never sends conversation input", async () => {
    const view = fixture()
    expect(view.calls).toEqual([])
    expect(await view.client.targets("synthetic")).toEqual([target])
    await view.client.bind(target)
    expect(view.calls.map((call) => call.operation)).toEqual(["session.dots.targets", "session.dots.bind"])
  })

  test("explicit Send whitelists the current payload and preserves Session correlation", async () => {
    const view = fixture()
    await view.client.bind(target)
    const input = {
      id: "msg_current",
      text: "pasted text\nsecond line",
      expectedTarget: target,
      editor: "ambient editor",
      history: ["unrelated history"],
    }
    expect(await view.client.send(input)).toEqual({ messageID: "msg_current", status: "accepted", turnID: "turn-1" })
    const sent = view.calls.find((call) => call.operation === "session.dots.send")
    expect(sent).toEqual({
      operation: "session.dots.send",
      sessionID: "ses_local",
      input: { id: "msg_current", text: input.text, expectedTarget: target },
    })
  })

  test("chosen files and pasted images use the existing Session-scoped local upload plumbing", async () => {
    const view = fixture()
    await view.client.bind(target)
    await view.client.send({
      id: "msg_files",
      text: "chosen files",
      expectedTarget: target,
      files: [
        { uri: "data:text/plain;base64,eA==", name: "chosen.txt" },
        { uri: "data:image/png;base64,eA==", name: "pasted.png" },
      ],
    })
    const uploads = view.calls.filter((call) => call.operation === "session.attachment.upload")
    expect(uploads).toHaveLength(2)
    expect(uploads.every((call) => call.sessionID === "ses_local")).toBe(true)
    const sent = view.calls.find((call) => call.operation === "session.dots.send")
    expect(sent?.input).toMatchObject({
      files: [
        { name: "chosen.txt", uri: expect.stringContaining("ycoding-upload://") },
        { name: "pasted.png", uri: expect.stringContaining("ycoding-upload://") },
      ],
    })
  })

  test("missing or changed targets cause no upload and no conversation send", async () => {
    const view = fixture()
    const input = {
      id: "msg_fenced",
      text: "hello",
      expectedTarget: target,
      files: [{ uri: "data:text/plain;base64,eA==", name: "chosen.txt" }],
    }
    await expect(view.client.send(input)).rejects.toThrow("destination changed")
    view.rebind({ ...target, generation: "generation-2" })
    await expect(view.client.send(input)).rejects.toThrow("destination changed")
    expect(view.calls.map((call) => call.operation)).toEqual(["session.dots.status", "session.dots.status"])
  })
})

describe("Dots peer heading", () => {
  const label = "Dot dot-1 · external peer · thread-1"
  const peer = { origin: "dots-peer", profile: "p", dotID: "dot-1", threadID: "thread-1", itemID: "i" }

  test("completed peer replies keep external attribution with or without a turn", () => {
    expect(remoteDotsPeerLabel({ dots: peer })).toBe(label)
    expect(remoteDotsPeerLabel({ dots: { ...peer, turnID: "t" } })).toBe(label)
  })

  test("invalid peer identities are rejected", () => {
    expect(remoteDotsPeerLabel({ dots: { ...peer, itemID: "" } })).toBeUndefined()
    expect(remoteDotsPeerLabel(undefined)).toBeUndefined()
  })
})


describe("Dots capability reader", () => {
  function readerFixture() {
    const reads: { signal: AbortSignal; settle: (value: boolean | Error) => void }[] = []
    const published: boolean[] = []
    let resets = 0
    const reader = createDotsCapabilityReader({
      read: (signal) =>
        new Promise<boolean>((resolve, reject) => {
          reads.push({ signal, settle: (value) => (value instanceof Error ? reject(value) : resolve(value)) })
        }),
      reset: () => { resets++ },
      publish: (enabled) => { published.push(enabled) },
    })
    return { reader, reads, published, resets: () => resets, enabled: () => published.at(-1) === true, flush: () => new Promise<void>((resolve) => setImmediate(resolve)) }
  }

  test("stays hidden until the selected Session's backend reports enabled; one read per start", async () => {
    const view = readerFixture()
    view.reader.start(true)
    expect(view.enabled()).toBe(false)
    expect(view.reads).toHaveLength(1)
    view.reads[0]!.settle(true)
    await view.flush()
    expect(view.enabled()).toBe(true)
    expect(view.reads).toHaveLength(1)
  })

  test.each([["a disabled", false], ["a failed", new Error("unavailable")]] as const)("%s read keeps the feature hidden", async (_name, outcome) => {
    const view = readerFixture()
    view.reader.start(true)
    view.reads[0]!.settle(outcome)
    await view.flush()
    expect(view.enabled()).toBe(false)
  })

  test("a late result for a previous Session or connection cannot enable the current one", async () => {
    const view = readerFixture()
    view.reader.start(true)
    view.reads[0]!.settle(true)
    await view.flush()
    const before = view.resets()
    view.reader.start(true)
    expect(view.enabled()).toBe(false)
    expect(view.resets()).toBeGreaterThan(before)
    view.reader.start(true)
    expect(view.reads[1]!.signal.aborted).toBe(true)
    view.reads[1]!.settle(true)
    await view.flush()
    expect(view.enabled()).toBe(false)
    view.reads[2]!.settle(true)
    await view.flush()
    expect(view.enabled()).toBe(true)
  })

  test("an unselected Session reads nothing and hides", async () => {
    const view = readerFixture()
    view.reader.start(true)
    view.reads[0]!.settle(true)
    await view.flush()
    view.reader.start(false)
    expect(view.enabled()).toBe(false)
    expect(view.reads).toHaveLength(1)
  })

  test("disable aborts in-flight work, advances the fence and drops a late result", async () => {
    const view = readerFixture()
    view.reader.start(true)
    const fence = view.reader.fence()
    view.reader.disable()
    expect(view.reader.fence()).not.toBe(fence)
    expect(view.reads[0]!.signal.aborted).toBe(true)
    view.reads[0]!.settle(true)
    await view.flush()
    expect(view.enabled()).toBe(false)
  })
})
