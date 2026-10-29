import { describe, expect, test } from "bun:test"
import { CcaChannelRpcError, runCcaChannelRpc } from "../src/remote-control/cca-channel-rpc"
import type { CcaChannel } from "../src/remote-control/cca-executor-transport"
import { CcaProofJournalError } from "../src/remote-control/cca-proof-journal"
import type {
  CcaEnvironmentInfo,
  CcaRpcHandler,
} from "../src/remote-control/cca-executor-rpc"

const environmentInfo: CcaEnvironmentInfo = {
  shell: { name: "bash", path: "/bin/bash" },
  executorVersion: "synthetic-1",
  capabilities: {},
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>

function fakeChannel() {
  const controller = new AbortController()
  const sent: Uint8Array[] = []
  const queue: Uint8Array[] = []
  let ended = false
  let waiter: (() => void) | undefined
  let sendFailure: Error | undefined
  let inFlight = 0
  let maxInFlight = 0
  let returnCalls = 0
  const wake = () => {
    waiter?.()
    waiter = undefined
  }
  const messages: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          while (queue.length === 0 && !ended) {
            await new Promise<void>((resolve) => {
              waiter = resolve
            })
          }
          const value = queue.shift()
          return value === undefined ? { value: undefined, done: true } : { value, done: false }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          returnCalls++
          ended = true
          wake()
          return { value: undefined, done: true }
        },
      }
    },
  }
  const channel: CcaChannel = {
    streamID: "synthetic-stream",
    signal: controller.signal,
    send: async (bytes) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      if (sendFailure) throw sendFailure
      sent.push(bytes)
    },
    messages,
  }
  return {
    channel,
    sent,
    push: (bytes: Uint8Array) => {
      queue.push(bytes)
      wake()
    },
    end: () => {
      ended = true
      wake()
    },
    abortChannel: () => controller.abort(),
    failSends: (error: Error) => {
      sendFailure = error
    },
    maxInFlight: () => maxInFlight,
    returnCalls: () => returnCalls,
  }
}

function fakeHandler() {
  let notify: ((method: string, params: unknown) => Promise<void> | void) | undefined
  let initializeSignal: AbortSignal | undefined
  let lastSignal: AbortSignal | undefined
  const handler: CcaRpcHandler = {
    initialize: async (_params, ctx) => {
      notify = ctx.notify
      initializeSignal = ctx.signal
      return { sessionId: "synthetic-session" }
    },
    startProcess: async (params, ctx) => {
      lastSignal = ctx.signal
      await notify?.("process/output", { processId: params.processId, chunk: "synthetic-output" })
      return { processId: params.processId, sandboxType: "none" }
    },
    readProcess: async (_params, ctx) => {
      lastSignal = ctx.signal
      return { chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }
    },
    writeProcess: async () => ({ status: "accepted" }),
    signalProcess: async () => ({}),
    terminateProcess: async () => ({ running: false }),
    readFile: async () => ({ dataBase64: "" }),
    writeFile: async () => ({}),
    getMetadata: async () => ({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: 0,
      createdAtMs: 0,
      modifiedAtMs: 0,
    }),
    readDirectory: async () => ({ entries: [] }),
    canonicalize: async (params) => ({ path: params.path }),
  }
  return {
    handler,
    initializeSignal: () => initializeSignal,
    lastSignal: () => lastSignal,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

async function waitFor(predicate: () => boolean, timeoutMs = 750): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

const sentIds = (fake: ReturnType<typeof fakeChannel>) => fake.sent.map(decode).map((frame) => frame.id)

const initializeFrame = encode({ id: 1, method: "initialize", params: { clientName: "synthetic-client" } })
const initializedFrame = encode({ method: "initialized" })

describe("runCcaChannelRpc", () => {
  test("pumps initialize, start with pre-response output notification, read, and unknown method in wire order", async () => {
    const fake = fakeChannel()
    const { handler, initializeSignal, lastSignal } = fakeHandler()
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    fake.push(
      encode({
        id: 2,
        method: "process/start",
        params: { processId: "p1", argv: ["/bin/true"], cwd: "file:///workspace", env: {} },
      }),
    )
    fake.push(encode({ id: 3, method: "process/read", params: { processId: "p1" } }))
    fake.push(encode({ id: 4, method: "unknown/method" }))
    fake.end()

    const result = await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })

    expect(result).toEqual({ requests: 5, responses: 4, notifications: 1 })
    const frames = fake.sent.map(decode)
    expect(frames).toHaveLength(5)
    for (const frame of frames) expect(frame.jsonrpc).toBeUndefined()
    expect(frames[0].id).toBe(1)
    expect(frames[0].result.sessionId).toBe("synthetic-session")
    expect(frames[0].result.environmentInfo).toEqual(environmentInfo)
    expect(Object.keys(frames[1]).sort()).toEqual(["method", "params"])
    expect(frames[1].method).toBe("process/output")
    expect(frames[1].params).toEqual({ processId: "p1", chunk: "synthetic-output" })
    expect(frames[2].id).toBe(2)
    expect(frames[2].result).toEqual({ processId: "p1", sandboxType: "none" })
    expect(frames[3].id).toBe(3)
    expect(frames[3].result.exited).toBe(true)
    expect(frames[4].id).toBe(4)
    expect(frames[4].error.code).toBe(-32601)
    expect(fake.maxInFlight()).toBe(1)
    expect(initializeSignal()?.aborted).toBe(true)
    expect(lastSignal()?.aborted).toBe(true)
  })

  test("channel signal abort mid-iteration closes the session and resolves counts", async () => {
    const fake = fakeChannel()
    const { handler, initializeSignal } = fakeHandler()
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    const running = runCcaChannelRpc({
      channel: fake.channel,
      environmentInfo: async () => environmentInfo,
      handler,
    })
    await flush()
    fake.abortChannel()
    await expect(running).resolves.toEqual({ requests: 2, responses: 1, notifications: 0 })
    expect(initializeSignal()?.aborted).toBe(true)
  })

  test("external signal abort mid-iteration closes the session and rejects aborted", async () => {
    const fake = fakeChannel()
    const { handler, initializeSignal } = fakeHandler()
    const external = new AbortController()
    fake.push(initializeFrame)
    const running = runCcaChannelRpc({
      channel: fake.channel,
      environmentInfo,
      handler,
      signal: external.signal,
    })
    const settled = running.catch((error: unknown) => error)
    await flush()
    external.abort()
    const error = await settled
    expect(error).toBeInstanceOf(CcaChannelRpcError)
    expect((error as CcaChannelRpcError).code).toBe("aborted")
    expect(initializeSignal()?.aborted).toBe(true)
    await flush()
    expect(fake.returnCalls()).toBeGreaterThan(0)
  })

  test("send failure stops the bridge, closes the session, and is sanitized", async () => {
    const fake = fakeChannel()
    const { handler, initializeSignal } = fakeHandler()
    fake.failSends(new Error("wss://secret"))
    fake.push(initializeFrame)
    fake.end()
    const error = await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(CcaChannelRpcError)
    expect((error as CcaChannelRpcError).code).toBe("channel_send_failed")
    expect((error as Error).message).not.toContain("wss://secret")
    expect((error as Error).message).not.toContain("secret")
    expect(initializeSignal()?.aborted).toBe(true)
  })

  test("wire control bypass: terminate handler and response complete while process/read is blocked", async () => {
    const fake = fakeChannel()
    let releaseRead: () => void = () => {}
    let markReadStarted: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let readSettled = false
    let terminateCalls = 0
    const handler: CcaRpcHandler = {
      ...fakeHandler().handler,
      readProcess: async () => {
        markReadStarted()
        await readGate
        readSettled = true
        return { chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }
      },
      terminateProcess: async () => {
        terminateCalls++
        return { running: false }
      },
    }
    const running = runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    expect(await waitFor(() => sentIds(fake).includes(1))).toBe(true)

    fake.push(encode({ id: 2, method: "process/read", params: { processId: "p1" } }))
    await readStarted
    fake.push(encode({ id: 3, method: "process/terminate", params: { processId: "p1" } }))

    const terminatedBeforeRelease = await waitFor(() => sentIds(fake).includes(3))
    const terminateCallsBeforeRelease = terminateCalls
    const readSettledBeforeRelease = readSettled
    const readFrameBeforeRelease = sentIds(fake).includes(2)

    releaseRead()
    fake.end()
    const result = await running

    expect(terminatedBeforeRelease).toBe(true)
    expect(terminateCallsBeforeRelease).toBe(1)
    expect(readSettledBeforeRelease).toBe(false)
    expect(readFrameBeforeRelease).toBe(false)
    expect(result).toEqual({ requests: 4, responses: 3, notifications: 0 })
    expect(sentIds(fake)).toEqual([1, 3, 2])
    const terminateFrame = fake.sent.map(decode).find((frame) => frame.id === 3)
    expect(terminateFrame).toBeDefined()
    if (!terminateFrame) throw new Error("expected terminate response frame")
    expect(terminateFrame.result).toEqual({ running: false })
    expect(fake.maxInFlight()).toBe(1)
  })

  test("wire control bypass: 64 blocked ordinary reads do not block a following terminate", async () => {
    const fake = fakeChannel()
    let releaseReads: () => void = () => {}
    let markFirstReadStarted: () => void = () => {}
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let terminateCalls = 0
    const handler: CcaRpcHandler = {
      ...fakeHandler().handler,
      readProcess: async () => {
        markFirstReadStarted()
        await readGate
        return { chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }
      },
      terminateProcess: async () => {
        terminateCalls++
        return { running: false }
      },
    }
    const running = runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    expect(await waitFor(() => sentIds(fake).includes(1))).toBe(true)

    fake.push(encode({ id: 100, method: "process/read", params: { processId: "p1" } }))
    await firstReadStarted
    for (let i = 1; i < 64; i++) {
      fake.push(encode({ id: 100 + i, method: "process/read", params: { processId: "p1" } }))
    }
    fake.push(encode({ id: 999, method: "process/terminate", params: { processId: "p1" } }))

    const terminatedBeforeRelease = await waitFor(() => sentIds(fake).includes(999))
    const terminateCallsBeforeRelease = terminateCalls

    releaseReads()
    fake.end()
    const result = await running

    expect(terminatedBeforeRelease).toBe(true)
    expect(terminateCallsBeforeRelease).toBe(1)
    expect(result).toEqual({ requests: 67, responses: 66, notifications: 0 })
    expect(fake.maxInFlight()).toBe(1)
  })

  test("channel abort unwinds a signal-aware blocked read instead of waiting forever", async () => {
    const fake = fakeChannel()
    let markReadStarted: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let observedAbort = false
    const handler: CcaRpcHandler = {
      ...fakeHandler().handler,
      readProcess: async (_params, ctx) => {
        markReadStarted()
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve()
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        observedAbort = ctx.signal.aborted
        return { chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }
      },
    }
    const running = runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    expect(await waitFor(() => sentIds(fake).includes(1))).toBe(true)
    fake.push(encode({ id: 2, method: "process/read", params: { processId: "p1" } }))
    await readStarted

    fake.abortChannel()
    const outcome = await Promise.race([
      running.then(
        (result) => ({ kind: "resolved" as const, result }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 750)),
    ])
    expect(outcome.kind).toBe("resolved")
    if (outcome.kind === "resolved") {
      expect(outcome.result.requests).toBe(3)
    }
    expect(observedAbort).toBe(true)
  })

  test("resumeSessionId null initializes fresh through the channel bridge", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    const nullInit = encode({
      id: 1,
      method: "initialize",
      params: { clientName: "synthetic-client", resumeSessionId: null },
    })
    expect(new TextDecoder().decode(nullInit)).toContain('"resumeSessionId":null')
    fake.push(nullInit)
    fake.push(initializedFrame)
    fake.push(encode({ id: 2, method: "environment/status" }))
    fake.end()

    const result = await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })

    expect(result).toEqual({ requests: 3, responses: 2, notifications: 0 })
    const frames = fake.sent.map(decode)
    expect(frames[0].id).toBe(1)
    expect(frames[0].error).toBeUndefined()
    expect(frames[0].result.sessionId).toBe("synthetic-session")
    expect(frames[0].result.environmentInfo).toEqual(environmentInfo)
    expect(frames[1].id).toBe(2)
    expect(frames[1].result).toEqual({ status: "ready" })
  })

  test("optional wire fields: synthetic null arg0 traverses channel bridge and read after fresh init", async () => {
    const fake = fakeChannel()
    const seen: unknown[] = []
    const base = fakeHandler().handler
    const handler: CcaRpcHandler = {
      ...base,
      startProcess: async (params, ctx) => { seen.push(params); return base.startProcess(params, ctx) },
      readProcess: async (params, ctx) => { seen.push(params); return base.readProcess(params, ctx) },
    }
    fake.push(encode({ id: 1, method: "initialize", params: { clientName: "synthetic-client", resumeSessionId: null } }))
    fake.push(initializedFrame)
    const start = encode({ id: 2, method: "process/start", params: {
      processId: "synthetic-process", argv: ["echo", ""], cwd: "file:///workspace", env: {},
      arg0: null, metadata: { threadId: null, toolCallId: null }, envPolicy: null,
      shellSnapshot: null, sandbox: null, managedNetwork: null, networkProxy: null,
      tty: false, pipeStdin: false, enforceManagedNetwork: false,
    } })
    expect(new TextDecoder().decode(start)).toContain('"arg0":null')
    fake.push(start)
    fake.push(encode({ id: 3, method: "process/read", params: { processId: "synthetic-process", afterSeq: null, maxBytes: null, waitMs: null } }))
    fake.end()

    expect(await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })).toEqual({ requests: 4, responses: 3, notifications: 1 })
    const frames = fake.sent.map(decode)
    expect(frames.map((frame) => frame.error)).toEqual([undefined, undefined, undefined, undefined])
    expect(frames[1].method).toBe("process/output")
    expect(frames[2].result).toEqual({ processId: "synthetic-process", sandboxType: "none" })
    expect(frames[3].result).toEqual({ chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true })
    expect(seen).toEqual([
      { processId: "synthetic-process", argv: ["echo", ""], cwd: "file:///workspace", env: {}, metadata: {}, tty: false, pipeStdin: false, enforceManagedNetwork: false },
      { processId: "synthetic-process" },
    ])
  })

  test("empty channel end resolves zero counts", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    fake.end()
    await expect(runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler })).resolves.toEqual({
      requests: 0,
      responses: 0,
      notifications: 0,
    })
    expect(fake.sent).toEqual([])
  })
})

type DiagnosticRecord = {
  readonly phase: string
  readonly event: string
  readonly method?: string
  readonly outcome?: string
  readonly resumeRequested?: boolean
  readonly requests?: number
  readonly channels?: number
}

function recorder() {
  const records: DiagnosticRecord[] = []
  return { records, onDiagnostic: (record: DiagnosticRecord) => void records.push(record) }
}

const rpcPhases = (records: readonly DiagnosticRecord[]) => records.filter((record) => record.phase.startsWith("rpc-"))
const summarize = (records: readonly DiagnosticRecord[]) =>
  rpcPhases(records).map((record) => [record.phase, record.event, record.method, record.outcome, record.requests])

describe("runCcaChannelRpc diagnostics", () => {
  test("fresh initialize with missing or null resume reports resumeRequested=false and result", async () => {
    for (const params of [{ clientName: "synthetic-client" }, { clientName: "synthetic-client", resumeSessionId: null }]) {
      const fake = fakeChannel()
      const { handler } = fakeHandler()
      const { records, onDiagnostic } = recorder()
      fake.push(encode({ id: 1, method: "initialize", params }))
      fake.end()
      await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
      expect(records).toEqual([
        { phase: "rpc-received", event: "observed", method: "initialize", resumeRequested: false, requests: 1 },
        { phase: "rpc-response", event: "completed", method: "initialize", outcome: "result", requests: 1 },
      ])
    }
  })

  test("initialize with a non-null resume value reports true, invalid_request, and never copies the value", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    const { records, onDiagnostic } = recorder()
    fake.push(
      encode({ id: "req-sentinel-id", method: "initialize", params: { clientName: "synthetic-client", resumeSessionId: "resume-sentinel-value" } }),
    )
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    expect(records).toEqual([
      { phase: "rpc-received", event: "observed", method: "initialize", resumeRequested: true, requests: 1 },
      { phase: "rpc-response", event: "completed", method: "initialize", outcome: "invalid_request", requests: 1 },
    ])
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain("resume-sentinel-value")
    expect(serialized).not.toContain("req-sentinel-id")
    expect(decode(fake.sent[0]!).error.code).toBe(-32600)
  })

  test("initialize with a non-string non-null resume value reports resumeRequested=true and invalid_params", async () => {
    const cases: readonly [unknown, string][] = [
      [123, "invalid_params"],
      [{}, "invalid_params"],
      [false, "invalid_params"],
      ["", "invalid_request"],
    ]
    for (const [resumeSessionId, outcome] of cases) {
      const fake = fakeChannel()
      const { handler } = fakeHandler()
      const { records, onDiagnostic } = recorder()
      fake.push(encode({ id: 1, method: "initialize", params: { clientName: "synthetic-client", resumeSessionId } }))
      fake.end()
      await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
      expect(records).toEqual([
        { phase: "rpc-received", event: "observed", method: "initialize", resumeRequested: true, requests: 1 },
        { phase: "rpc-response", event: "completed", method: "initialize", outcome, requests: 1 },
      ])
    }
  })

  test("late handler notifications after the bridge resolves emit no diagnostics", async () => {
    const fake = fakeChannel()
    const base = fakeHandler().handler
    let notify: ((method: string, params: unknown) => Promise<void> | void) | undefined
    const handler: CcaRpcHandler = {
      ...base,
      initialize: async (params, ctx) => {
        notify = ctx.notify
        return base.initialize(params, ctx)
      },
    }
    const { records, onDiagnostic } = recorder()
    fake.push(initializeFrame)
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    const settledCount = records.length
    await Promise.resolve(notify?.("process/exited", { processId: "late-sentinel" })).catch(() => {})
    await flush()
    expect(settledCount).toBeGreaterThan(0)
    expect(records).toHaveLength(settledCount)
  })

  test("resumeRequested appears only on initialize records", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    const { records, onDiagnostic } = recorder()
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    fake.push(encode({ id: 2, method: "environment/status", params: { resumeSessionId: "x" } }))
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    const withResume = records.filter((record) => "resumeRequested" in record)
    expect(withResume.map((record) => record.method)).toEqual(["initialize"])
  })

  test("uninitialized discoverV2 and discoverV1 are invalid requests, and arbitrary unsupported methods collapse to other", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    const { records, onDiagnostic } = recorder()
    fake.push(encode({ id: 1, method: "capabilities/discoverV2" }))
    fake.push(encode({ id: 2, method: "capabilityRoots/discoverV1" }))
    fake.push(encode({ id: 3, method: "synthetic/secret-method-name", params: { token: "param-sentinel" } }))
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    expect(summarize(records).filter((entry) => entry[0] === "rpc-received")).toEqual([
      ["rpc-received", "observed", "capabilities/discoverV2", undefined, 1],
      ["rpc-received", "observed", "capabilityRoots/discoverV1", undefined, 2],
      ["rpc-received", "observed", "other", undefined, 3],
    ])
    const responses = rpcPhases(records).filter((record) => record.phase === "rpc-response")
    expect(responses.map((record) => [record.event, record.method, record.outcome])).toEqual([
      ["completed", "capabilities/discoverV2", "invalid_request"],
      ["completed", "capabilityRoots/discoverV1", "invalid_request"],
      ["completed", "other", "method_not_found"],
    ])
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain("secret-method-name")
    expect(serialized).not.toContain("param-sentinel")
  })

  test("denied process start reports permission_denied without changing wire execution", async () => {
    const run = async (withObserver: boolean) => {
      const fake = fakeChannel()
      let starts = 0
      const handler: CcaRpcHandler = {
        ...fakeHandler().handler,
        startProcess: async () => {
          starts++
          throw Object.assign(new Error("denied-secret-message"), { code: -32001 })
        },
      }
      const { records, onDiagnostic } = recorder()
      fake.push(initializeFrame)
      fake.push(initializedFrame)
      fake.push(encode({ id: 2, method: "process/start", params: { processId: "p1", argv: ["/bin/true"], cwd: "file:///workspace", env: {} } }))
      fake.end()
      const result = await runCcaChannelRpc({
        channel: fake.channel,
        environmentInfo,
        handler,
        ...(withObserver ? { onDiagnostic } : {}),
      })
      return { result, records, starts, sent: fake.sent.map((bytes) => new TextDecoder().decode(bytes)) }
    }
    const observed = await run(true)
    const plain = await run(false)
    expect(observed.starts).toBe(1)
    expect(observed.result).toEqual(plain.result)
    expect(observed.sent).toEqual(plain.sent)
    const denied = observed.records.find((record) => record.method === "process/start" && record.phase === "rpc-response")
    expect(denied).toEqual({ phase: "rpc-response", event: "completed", method: "process/start", outcome: "permission_denied", requests: 3 })
    expect(JSON.stringify(observed.records)).not.toContain("denied-secret-message")
    expect(plain.records).toEqual([])
  })

  test("error codes map to fixed outcomes and unknown codes to other_error", async () => {
    const fake = fakeChannel()
    const handler: CcaRpcHandler = {
      ...fakeHandler().handler,
      readProcess: async () => {
        throw new Error("internal-secret")
      },
      writeProcess: async () => {
        throw Object.assign(new Error("x"), { code: -32602 })
      },
    }
    const { records, onDiagnostic } = recorder()
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    fake.push(encode({ id: 2, method: "process/read", params: { processId: "p1" } }))
    fake.push(encode({ id: 3, method: "process/write", params: { processId: "p1", chunkBase64: "AAAA" } }))
    fake.push(encode({ id: 4, method: "process/write", params: "bad" }))
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    const outcomes = records.filter((record) => record.phase === "rpc-response").map((record) => [record.method, record.outcome])
    expect(outcomes).toContainEqual(["process/read", "internal_error"])
    expect(outcomes).toContainEqual(["process/write", "invalid_params"])
    expect(JSON.stringify(records)).not.toContain("internal-secret")
  })

  test("sent notifications report fixed methods and outcome with sentinel data fully redacted", async () => {
    const fake = fakeChannel()
    const base = fakeHandler().handler
    let notify: ((method: string, params: unknown) => Promise<void> | void) | undefined
    const startHandler: CcaRpcHandler = {
      ...base,
      initialize: async (params, ctx) => {
        notify = ctx.notify
        return base.initialize(params, ctx)
      },
      startProcess: async (params) => {
        await notify?.("process/output", { processId: "pid-sentinel", chunk: "output-sentinel" })
        await notify?.("process/exited", { processId: "pid-sentinel", exitCode: 7731 })
        await notify?.("process/closed", { processId: "pid-sentinel" })
        await notify?.("synthetic/secret-notification", { data: "unknown-sentinel" })
        return { processId: params.processId, sandboxType: "none" }
      },
    }
    const { records, onDiagnostic } = recorder()
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    fake.push(encode({ id: 2, method: "process/start", params: { processId: "pid-sentinel", argv: ["/bin/true"], cwd: "file:///workspace", env: {} } }))
    fake.end()
    const result = await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler: startHandler, onDiagnostic })
    expect(result.notifications).toBe(4)
    const notifications = records.filter((record) => record.phase === "rpc-notification")
    expect(notifications.map((record) => [record.event, record.method, record.outcome])).toEqual([
      ["completed", "process/output", "notification"],
      ["completed", "process/exited", "notification"],
      ["completed", "process/closed", "notification"],
      ["completed", "other", "notification"],
    ])
    const serialized = JSON.stringify(records)
    for (const sentinel of ["pid-sentinel", "output-sentinel", "unknown-sentinel", "secret-notification", "7731"]) {
      expect(serialized).not.toContain(sentinel)
    }
    const order = records.map((record) => record.phase)
    expect(order.indexOf("rpc-notification")).toBeLessThan(order.lastIndexOf("rpc-response"))
  })

  test("malformed UTF-8, malformed JSON, and non-object frames classify as other with invalid_request", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    const { records, onDiagnostic } = recorder()
    fake.push(new Uint8Array([0xff, 0xfe, 0xfd]))
    fake.push(new TextEncoder().encode("{not json secret-fragment"))
    fake.push(encode([1, 2, 3]))
    fake.push(encode({ id: 9, method: 42 }))
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    expect(summarize(records)).toEqual([
      ["rpc-received", "observed", "other", undefined, 1],
      ["rpc-received", "observed", "other", undefined, 2],
      ["rpc-received", "observed", "other", undefined, 3],
      ["rpc-received", "observed", "other", undefined, 4],
      ["rpc-response", "completed", "other", "invalid_request", 1],
      ["rpc-response", "completed", "other", "invalid_request", 2],
      ["rpc-response", "completed", "other", "invalid_request", 3],
      ["rpc-response", "completed", "other", "invalid_request", 4],
    ])
    expect(JSON.stringify(records)).not.toContain("secret-fragment")
  })

  test("failed response send is reported as failed send_failed and never as completed", async () => {
    const fake = fakeChannel()
    const { handler } = fakeHandler()
    const { records, onDiagnostic } = recorder()
    fake.failSends(new Error("wss://secret-send-error"))
    fake.push(initializeFrame)
    fake.end()
    const error = await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic }).catch((caught: unknown) => caught)
    expect((error as CcaChannelRpcError).code).toBe("channel_send_failed")
    expect(records).toEqual([
      { phase: "rpc-received", event: "observed", method: "initialize", resumeRequested: false, requests: 1 },
      { phase: "rpc-response", event: "failed", method: "initialize", outcome: "send_failed", requests: 1 },
    ])
    expect(JSON.stringify(records)).not.toContain("secret-send-error")
  })

  test("failed notification send is reported as failed send_failed", async () => {
    const fake = fakeChannel()
    const base = fakeHandler().handler
    const handler: CcaRpcHandler = {
      ...base,
      initialize: async (_params, ctx) => {
        await Promise.resolve(ctx.notify("process/output", { chunk: "x" })).catch(() => {})
        return { sessionId: "synthetic-session" }
      },
    }
    const { records, onDiagnostic } = recorder()
    fake.failSends(new Error("send-failure-secret"))
    fake.push(initializeFrame)
    fake.end()
    await runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic }).catch(() => {})
    const notification = records.filter((record) => record.phase === "rpc-notification")
    expect(notification.map((record) => [record.event, record.method, record.outcome])).toEqual([
      ["failed", "process/output", "send_failed"],
    ])
    expect(records.some((record) => record.event === "completed")).toBe(false)
  })

  test("no observer keeps wire bytes and counts identical to an observed run", async () => {
    const run = async (observe: boolean) => {
      const fake = fakeChannel()
      const { handler } = fakeHandler()
      fake.push(initializeFrame)
      fake.push(initializedFrame)
      fake.push(encode({ id: 2, method: "process/start", params: { processId: "p1", argv: ["/bin/true"], cwd: "file:///workspace", env: {} } }))
      fake.push(encode({ id: 3, method: "capabilities/discoverV2" }))
      fake.push(new Uint8Array([0xff]))
      fake.end()
      const { onDiagnostic } = recorder()
      const result = await runCcaChannelRpc({
        channel: fake.channel,
        environmentInfo,
        handler,
        ...(observe ? { onDiagnostic } : {}),
      })
      return { result, sent: fake.sent.map((bytes) => Array.from(bytes)) }
    }
    expect(await run(true)).toEqual(await run(false))
  })

  test("observer failure is sanitized, surfaces after cleanup, and does not skip session close", async () => {
    const fake = fakeChannel()
    const { handler, initializeSignal } = fakeHandler()
    let calls = 0
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    fake.end()
    const error = await runCcaChannelRpc({
      channel: fake.channel,
      environmentInfo,
      handler,
      onDiagnostic: (record) => {
        calls++
        if (record.phase === "rpc-response") throw new Error("observer-secret")
      },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaProofJournalError)
    expect((error as Error).message).not.toContain("observer-secret")
    expect(calls).toBeGreaterThan(0)
    expect(initializeSignal()?.aborted).toBe(true)
    expect(sentIds(fake)).toEqual([1])
  })

  test("control bypass ordering reports completion order with per-frame captured request counts", async () => {
    const fake = fakeChannel()
    let releaseRead: () => void = () => {}
    let markReadStarted: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const handler: CcaRpcHandler = {
      ...fakeHandler().handler,
      readProcess: async () => {
        markReadStarted()
        await readGate
        return { chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }
      },
    }
    const { records, onDiagnostic } = recorder()
    const running = runCcaChannelRpc({ channel: fake.channel, environmentInfo, handler, onDiagnostic })
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    expect(await waitFor(() => sentIds(fake).includes(1))).toBe(true)
    fake.push(encode({ id: 3, method: "process/read", params: { processId: "p1" } }))
    await readStarted
    fake.push(encode({ id: 4, method: "process/terminate", params: { processId: "p1" } }))
    expect(await waitFor(() => sentIds(fake).includes(4))).toBe(true)
    releaseRead()
    fake.end()
    await running
    const responses = records.filter((record) => record.phase === "rpc-response")
    expect(responses.map((record) => [record.method, record.outcome, record.requests])).toEqual([
      ["initialize", "result", 1],
      ["process/terminate", "result", 4],
      ["process/read", "result", 3],
    ])
    expect(records.filter((record) => record.phase === "rpc-received").map((record) => [record.method, record.requests])).toEqual([
      ["initialize", 1],
      ["initialized", 2],
      ["process/read", 3],
      ["process/terminate", 4],
    ])
  })
  const inFlightReadSendFailure = async (abortWith: "channel" | "input") => {
    const fake = fakeChannel()
    const external = new AbortController()
    let releaseRead: () => void = () => {}
    let markReadStarted: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const handler: CcaRpcHandler = {
      ...fakeHandler().handler,
      readProcess: async () => {
        markReadStarted()
        await readGate
        return { chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }
      },
    }
    const { records, onDiagnostic } = recorder()
    const running = runCcaChannelRpc({
      channel: fake.channel,
      environmentInfo,
      handler,
      onDiagnostic,
      signal: external.signal,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    expect(await waitFor(() => sentIds(fake).includes(1))).toBe(true)
    fake.push(encode({ id: 2, method: "process/read", params: { processId: "p1" } }))
    await readStarted
    fake.failSends(new Error("send-reset-secret"))
    if (abortWith === "channel") fake.abortChannel()
    else external.abort()
    releaseRead()
    const settled = await running
    const readRecords = records.filter((record) => record.method === "process/read" && record.phase === "rpc-response")
    return { settled, readRecords, sent: sentIds(fake) }
  }

  test("in-flight read send failure after channel signal abort reports send_failed, never completed", async () => {
    const { settled, readRecords, sent } = await inFlightReadSendFailure("channel")
    expect(readRecords).toEqual([
      { phase: "rpc-response", event: "failed", method: "process/read", outcome: "send_failed", requests: 3 },
    ])
    expect(sent).toEqual([1])
    expect("result" in settled || (settled as { error: unknown }).error instanceof CcaChannelRpcError).toBe(true)
  })

  test("in-flight read send failure after input signal abort reports aborted, never completed", async () => {
    const { settled, readRecords, sent } = await inFlightReadSendFailure("input")
    expect(readRecords).toEqual([
      { phase: "rpc-response", event: "failed", method: "process/read", outcome: "aborted", requests: 3 },
    ])
    expect(sent).toEqual([1])
    expect((settled as { error: CcaChannelRpcError }).error).toBeInstanceOf(CcaChannelRpcError)
    expect((settled as { error: CcaChannelRpcError }).error.code).toBe("aborted")
  })
})
