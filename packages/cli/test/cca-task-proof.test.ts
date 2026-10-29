import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CcaConnectProofError } from "../src/remote-control/cca-connect-proof"
import type { CcaExperimentState } from "../src/remote-control/cca-executor-registration"
import type { CcaEnvironmentInfo, CcaRpcHandler } from "../src/remote-control/cca-executor-rpc"
import type {
  CcaChannel,
  CcaNoiseIdentity,
  CcaNoiseTransport,
  StartCcaExecutorTransportOptions,
} from "../src/remote-control/cca-executor-transport"
import { CcaProofJournalError, createCcaProofJournal } from "../src/remote-control/cca-proof-journal"
import { runCcaTaskProof, type RunCcaTaskProofInput } from "../src/remote-control/cca-task-proof"
import {
  composeCcaTaskCleanup,
  CcaTaskRuntimeCloseError,
} from "../src/remote-control/cca-task-runtime"

const state: CcaExperimentState = {
  installationID: "synthetic-installation",
  accountHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  executorID: "ccarenv_b64_synthetic",
}
const credential = { accessToken: "synthetic_access_token_secret", accountID: "abc" }
const environmentInfo: CcaEnvironmentInfo = {
  shell: { name: "bash", path: "/bin/bash" },
  capabilities: {},
}
const identity: CcaNoiseIdentity & { readonly _private: { readonly marker: string } } = {
  publicKey: { suite: "noise_hybrid_ik_v1", x25519_public_key: "synthetic_x", mlkem768_public_key: "synthetic_m" },
  _private: { marker: "synthetic-private" },
}
const noiseTransport: CcaNoiseTransport = {
  encrypt: async (bytes) => bytes,
  decrypt: async (bytes) => bytes,
}
const acceptHandshake = async () => ({ response: new Uint8Array([1]), transport: noiseTransport })

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))
const initializeFrame = encode({ id: 1, method: "initialize", params: { clientName: "synthetic-client" } })
const initializedFrame = encode({ method: "initialized" })
const startFrame = encode({
  id: 2,
  method: "process/start",
  params: { processId: "p1", argv: ["/bin/true"], cwd: "file:///workspace", env: {} },
})
const readFrame = encode({ id: 3, method: "process/read", params: { processId: "p1" } })

function fakeChannel() {
  const controller = new AbortController()
  const sent: Uint8Array[] = []
  const queue: Uint8Array[] = []
  let ended = false
  let waiter: (() => void) | undefined
  let sendFailure: Error | undefined
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
          ended = true
          wake()
          return { value: undefined, done: true }
        },
      }
    },
  }
  const channel: CcaChannel = {
    streamID: "synthetic-stream-must-not-be-logged",
    signal: controller.signal,
    send: async (bytes) => {
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
    abortChannel: () => controller.abort(),
    failSends: (error: Error) => {
      sendFailure = error
    },
  }
}

function fakeHandler(
  options: { closeFails?: boolean; closeGate?: Promise<void>; onCloseStarted?: () => void } = {},
) {
  let initializeCalls = 0
  let closeCalls = 0
  const notifyBySession = new Map<string, (method: string, params: unknown) => Promise<void> | void>()
  const startSessionIDs: string[] = []
  const handler: CcaRpcHandler & { close(): Promise<void> } = {
    initialize: async (_params, ctx) => {
      const sessionId = `synthetic-session-${++initializeCalls}`
      notifyBySession.set(sessionId, ctx.notify)
      return { sessionId }
    },
    startProcess: async (params, ctx) => {
      startSessionIDs.push(ctx.sessionId)
      await notifyBySession.get(ctx.sessionId)?.("process/output", {
        processId: params.processId,
        chunk: "synthetic-output",
      })
      return { processId: params.processId, sandboxType: "none" }
    },
    readProcess: async () => ({ chunks: [], nextSeq: 0, exited: true, exitCode: 0, closed: true }),
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
    close: async () => {
      closeCalls++
      options.onCloseStarted?.()
      await options.closeGate
      if (options.closeFails) throw new Error("handler-close-secret")
    },
  }
  return {
    handler,
    initializeCalls: () => initializeCalls,
    closeCalls: () => closeCalls,
    startSessionIDs: () => [...startSessionIDs],
  }
}

function fakeTransport(channelsToAbort: readonly { abortChannel(): void }[] = []) {
  let startCalls = 0
  let closeCalls = 0
  let captured: StartCcaExecutorTransportOptions | undefined
  const startTransport = async (options: StartCcaExecutorTransportOptions) => {
    startCalls++
    captured = options
    return {
      close: async () => {
        closeCalls++
        for (const entry of channelsToAbort) entry.abortChannel()
      },
    }
  }
  return {
    startTransport,
    startCalls: () => startCalls,
    closeCalls: () => closeCalls,
    captured: () => captured,
  }
}

type ProofPhaseRecord = {
  readonly phase: string
  readonly event: string
  readonly channels?: number
  readonly requests?: number
  readonly method?: string
  readonly outcome?: string
  readonly resumeRequested?: boolean
}

const phaseNames = (records: readonly ProofPhaseRecord[]) =>
  records.filter((record) => !record.phase.startsWith("rpc-")).map((record) => `${record.phase}:${record.event}`)

type TaskProofInput = RunCcaTaskProofInput<typeof identity>

function baseInput(
  overrides: Partial<TaskProofInput> & Pick<TaskProofInput, "handler" | "startTransport">,
) {
  const controller = new AbortController()
  const statuses: string[] = []
  return {
    controller,
    statuses,
    input: {
      state,
      credential,
      identity,
      acceptHandshake,
      environmentInfo,
      signal: controller.signal,
      onStatus: (line: string) => {
        statuses.push(line)
      },
      ...overrides,
    } satisfies TaskProofInput,
  }
}

describe("runCcaTaskProof", () => {
  test("runs a full initialize to process flow over one channel and closes handler and transport once", async () => {
    const fake = fakeChannel()
    const transport = fakeTransport([fake])
    const { handler, closeCalls } = fakeHandler()
    const phases: ProofPhaseRecord[] = []
    const { input, controller, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      requireChannel: true,
      onPhase: (record: ProofPhaseRecord) => {
        phases.push(record)
      },
    })
    const running = runCcaTaskProof(input)
    await flush()
    void transport.captured()?.onChannel(fake.channel)
    fake.push(initializeFrame)
    fake.push(initializedFrame)
    fake.push(startFrame)
    fake.push(readFrame)
    await flush()
    controller.abort()

    await expect(running).resolves.toEqual({ channels: 1, requests: 4, responses: 3, notifications: 1 })
    const frames = fake.sent.map(decode)
    expect(frames.map((frame) => frame.method ?? frame.id)).toEqual([1, "process/output", 2, 3])
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
    expect(phaseNames(phases)).toEqual([
      "transport-start:started",
      "transport-start:completed",
      "channel-established:observed",
      "abort-observed:observed",
      "transport-close:started",
      "transport-close:completed",
      "bridge-drain:started",
      "bridge-drain:completed",
      "handler-close:started",
      "handler-close:completed",
    ])
    expect(phases[2]?.channels).toBe(1)
    expect(statuses).toContain("cca-task: channel=rpc requests=4 responses=3 notifications=1")
    const joined = statuses.join("\n")
    expect(joined).not.toContain("ccarenv_b64_synthetic")
    expect(joined).not.toContain(credential.accessToken)
    expect(joined).not.toContain("synthetic-stream-must-not-be-logged")
    expect(joined).not.toContain("synthetic-output")
  })

  test("two concurrent channels get independent rpc sessions", async () => {
    const first = fakeChannel()
    const second = fakeChannel()
    const transport = fakeTransport([first, second])
    const { handler, initializeCalls, startSessionIDs } = fakeHandler()
    const { input, controller } = baseInput({ handler, startTransport: transport.startTransport })
    const running = runCcaTaskProof(input)
    await flush()
    void transport.captured()?.onChannel(first.channel)
    void transport.captured()?.onChannel(second.channel)
    for (const entry of [first, second]) {
      entry.push(initializeFrame)
      entry.push(initializedFrame)
      entry.push(startFrame)
    }
    await flush()
    controller.abort()

    await expect(running).resolves.toEqual({ channels: 2, requests: 6, responses: 4, notifications: 2 })
    expect(initializeCalls()).toBe(2)
    expect(new Set(startSessionIDs()).size).toBe(2)
    for (const entry of [first, second]) {
      const frames = entry.sent.map(decode)
      expect(frames.map((frame) => frame.method ?? frame.id)).toEqual([1, "process/output", 2])
    }
    const sessionIDs = [first, second].map((entry) => decode(entry.sent[0]!).result.sessionId)
    expect(new Set(sessionIDs).size).toBe(2)
  })

  test("a channel send failure is contained and the other channel completes", async () => {
    const bad = fakeChannel()
    bad.failSends(new Error("wss://secret"))
    const good = fakeChannel()
    const transport = fakeTransport([bad, good])
    const { handler, closeCalls } = fakeHandler()
    const { input, controller, statuses } = baseInput({ handler, startTransport: transport.startTransport })
    const running = runCcaTaskProof(input)
    await flush()
    void transport.captured()?.onChannel(bad.channel)
    void transport.captured()?.onChannel(good.channel)
    bad.push(initializeFrame)
    good.push(initializeFrame)
    good.push(initializedFrame)
    good.push(startFrame)
    await flush()
    expect(statuses).toContain("cca-task: channel=closed code=channel_send_failed")
    controller.abort()

    await expect(running).resolves.toEqual({ channels: 2, requests: 3, responses: 2, notifications: 1 })
    expect(good.sent.map(decode).map((frame) => frame.method ?? frame.id)).toEqual([1, "process/output", 2])
    expect(statuses.join("\n")).not.toContain("secret")
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
  })

  test("rpc diagnostics carry the captured channel number for each channel", async () => {
    const first = fakeChannel()
    const second = fakeChannel()
    const transport = fakeTransport([first, second])
    const { handler } = fakeHandler()
    const phases: ProofPhaseRecord[] = []
    const { input, controller } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase: (record: ProofPhaseRecord) => {
        phases.push(record)
      },
    })
    const running = runCcaTaskProof(input)
    await flush()
    void transport.captured()?.onChannel(first.channel)
    void transport.captured()?.onChannel(second.channel)
    first.push(initializeFrame)
    second.push(initializeFrame)
    second.push(encode({ id: 2, method: "fs/watchMissing" }))
    await flush()
    controller.abort()
    await running

    const rpc = phases.filter((record) => record.phase.startsWith("rpc-"))
    const select = (channel: number, phase: string) =>
      rpc
        .filter((record) => record.channels === channel && record.phase === phase)
        .map((record) => `${record.method}:${record.outcome ?? "-"}:${record.requests}`)
    expect(select(1, "rpc-received")).toEqual(["initialize:-:1"])
    expect(select(1, "rpc-response")).toEqual(["initialize:result:1"])
    expect(select(2, "rpc-received")).toEqual(["initialize:-:1", "other:-:2"])
    expect(select(2, "rpc-response")).toEqual(["initialize:result:1", "other:method_not_found:2"])
    expect(rpc.every((record) => record.channels === 1 || record.channels === 2)).toBe(true)
  })

  test("observer failure on an rpc record surfaces sanitized after handler and transport cleanup", async () => {
    const fake = fakeChannel()
    const transport = fakeTransport([fake])
    const { handler, closeCalls } = fakeHandler()
    const { input, controller, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase: (record: ProofPhaseRecord) => {
        if (record.phase === "rpc-response") throw new Error("observer-rpc-secret")
      },
    })
    const running = runCcaTaskProof(input)
    const settled = running.catch((caught: unknown) => caught)
    await flush()
    void transport.captured()?.onChannel(fake.channel)
    fake.push(initializeFrame)
    await flush()
    controller.abort()
    const error = await settled

    expect(error).toBeInstanceOf(CcaProofJournalError)
    expect((error as Error).message).not.toContain("observer-rpc-secret")
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
    expect(statuses.join("\n")).not.toContain("shutdown=clean")
  })

  test("serialized journal receives channel rpc diagnostics as JSONL with no protocol identifiers or payloads", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cca-task-proof-journal-"))
    try {
      const journal = createCcaProofJournal(path.join(directory, "journal.jsonl"))
      const fake = fakeChannel()
      const transport = fakeTransport([fake])
      const { handler } = fakeHandler()
      const { input, controller } = baseInput({
        handler,
        startTransport: transport.startTransport,
        onPhase: journal.record,
      })
      const running = runCcaTaskProof(input)
      await flush()
      void transport.captured()?.onChannel(fake.channel)
      fake.push(
        encode({ id: "request-id-sentinel", method: "initialize", params: { clientName: "client-sentinel", resumeSessionId: "resume-sentinel" } }),
      )
      fake.push(encode({ id: 2, method: "initialize", params: { clientName: "client-sentinel" } }))
      fake.push(initializedFrame)
      fake.push(
        encode({ id: 3, method: "process/start", params: { processId: "process-id-sentinel", argv: ["/bin/true"], cwd: "file:///workspace", env: {} } }),
      )
      fake.push(encode({ id: 4, method: "fs/watchMissing" }))
      await flush()
      controller.abort()
      await running
      journal.close()

      const text = readFileSync(path.join(directory, "journal.jsonl"), "utf8")
      const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      const rpc = lines.filter((line) => String(line.phase).startsWith("rpc-"))
      const select = (phase: string) =>
        rpc
          .filter((line) => line.phase === phase)
          .map((line) => [line.event, line.method, line.outcome, line.resumeRequested, line.channels, line.requests])
      expect(select("rpc-received")).toEqual([
        ["observed", "initialize", undefined, true, 1, 1],
        ["observed", "initialize", undefined, false, 1, 2],
        ["observed", "initialized", undefined, undefined, 1, 3],
        ["observed", "process/start", undefined, undefined, 1, 4],
        ["observed", "other", undefined, undefined, 1, 5],
      ])
      expect(select("rpc-response")).toEqual([
        ["completed", "initialize", "invalid_request", undefined, 1, 1],
        ["completed", "initialize", "result", undefined, 1, 2],
        ["completed", "process/start", "result", undefined, 1, 4],
        ["completed", "other", "method_not_found", undefined, 1, 5],
      ])
      expect(select("rpc-notification")).toEqual([["completed", "process/output", "notification", undefined, 1, undefined]])
      for (const sentinel of [
        "request-id-sentinel",
        "client-sentinel",
        "resume-sentinel",
        "process-id-sentinel",
        "synthetic-output",
        "synthetic-stream-must-not-be-logged",
      ]) {
        expect(text).not.toContain(sentinel)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("start failure is sanitized and still closes the handler once", async () => {
    const { handler, closeCalls } = fakeHandler()
    const phases: ProofPhaseRecord[] = []
    const { input } = baseInput({
      handler,
      startTransport: async () => {
        throw new Error("wss://secret")
      },
      onPhase: (record: ProofPhaseRecord) => {
        phases.push(record)
      },
    })
    const error = await runCcaTaskProof(input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaConnectProofError)
    expect((error as CcaConnectProofError).code).toBe("transport_failed")
    expect((error as Error).message).not.toContain("secret")
    expect(closeCalls()).toBe(1)
    expect(phaseNames(phases)).toEqual([
      "transport-start:started",
      "transport-start:failed",
      "bridge-drain:started",
      "bridge-drain:completed",
      "handler-close:started",
      "handler-close:completed",
    ])
  })

  test("handler close failure is sanitized and prevents clean shutdown status", async () => {
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler({ closeFails: true })
    const phases: ProofPhaseRecord[] = []
    const { input, controller, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase: (record: ProofPhaseRecord) => {
        phases.push(record)
      },
    })
    const running = runCcaTaskProof(input)
    const settled = running.catch((caught: unknown) => caught)
    await flush()
    controller.abort()
    const error = await settled
    expect(error).toBeInstanceOf(CcaConnectProofError)
    expect((error as CcaConnectProofError).code).toBe("transport_failed")
    expect((error as Error).message).not.toContain("handler-close-secret")
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
    expect(statuses.join("\n")).not.toContain("shutdown=clean")
    expect(statuses.join("\n")).not.toContain("channel=rpc")
    expect(phaseNames(phases)).toContain("handler-close:failed")
    expect(phaseNames(phases)).not.toContain("handler-close:completed")
  })

  test("observer failure at transport start surfaces only after cleanup", async () => {
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler()
    const attempted: string[] = []
    const { input, controller, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase: (record: ProofPhaseRecord) => {
        attempted.push(`${record.phase}:${record.event}`)
        if (record.phase === "transport-start" && record.event === "started") {
          throw new Error("observer-start-secret")
        }
      },
    })
    const running = runCcaTaskProof(input)
    const settled = running.catch((caught: unknown) => caught)
    await flush()
    controller.abort()
    const error = await settled

    expect(error).toBeInstanceOf(CcaProofJournalError)
    expect((error as Error).message).toBe("CCA proof status journal failed")
    expect((error as Error).message).not.toContain("observer-start-secret")
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
    expect(attempted).toContain("handler-close:completed")
    expect(statuses.join("\n")).not.toContain("shutdown=clean")
  })

  test("observer failure at handler cleanup does not skip handler close", async () => {
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler()
    const attempted: string[] = []
    const { input, controller, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase: (record: ProofPhaseRecord) => {
        attempted.push(`${record.phase}:${record.event}`)
        if (record.phase === "handler-close" && record.event === "started") {
          throw new Error("observer-cleanup-secret")
        }
      },
    })
    const running = runCcaTaskProof(input)
    const settled = running.catch((caught: unknown) => caught)
    await flush()
    controller.abort()
    const error = await settled

    expect(error).toBeInstanceOf(CcaProofJournalError)
    expect((error as Error).message).not.toContain("observer-cleanup-secret")
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
    expect(attempted).toContain("handler-close:completed")
    expect(statuses.join("\n")).not.toContain("shutdown=clean")
  })

  test("held handler cleanup remains closing until its gate is released", async () => {
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    let markCloseStarted!: () => void
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve
    })
    let markTransportReady!: () => void
    const transportReady = new Promise<void>((resolve) => {
      markTransportReady = resolve
    })
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler({ closeGate, onCloseStarted: markCloseStarted })
    const phases: ProofPhaseRecord[] = []
    const { input, controller } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase: (record: ProofPhaseRecord) => {
        phases.push(record)
        if (record.phase === "transport-start" && record.event === "completed") markTransportReady()
      },
    })
    const running = runCcaTaskProof(input)
    let settled = false
    void running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await transportReady
    controller.abort()
    await closeStarted

    expect(closeCalls()).toBe(1)
    expect(phaseNames(phases)).toContain("handler-close:started")
    expect(phaseNames(phases)).not.toContain("handler-close:completed")
    expect(settled).toBe(false)

    releaseClose()
    await expect(running).resolves.toEqual({ channels: 0, requests: 0, responses: 0, notifications: 0 })
    expect(phaseNames(phases)).toContain("handler-close:completed")
    expect(settled).toBe(true)
  })

  test("production cleanup composition attempts runtime close after executor failure and suppresses clean status", async () => {
    const transport = fakeTransport()
    const { handler: executor, closeCalls } = fakeHandler({ closeFails: true })
    const order: string[] = []
    const phases: ProofPhaseRecord[] = []
    const onPhase = (record: ProofPhaseRecord) => {
      phases.push(record)
    }
    let runtimeCloseAttempts = 0
    const close = composeCcaTaskCleanup({
      closeExecutor: async () => {
        order.push("executor")
        await executor.close()
      },
      runtime: {
        close: async () => {
          runtimeCloseAttempts++
          order.push("runtime")
          throw new Error("runtime-close-secret")
        },
      },
      onPhase,
    })
    const handler = { ...executor, close }
    const { input, controller, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase,
    })
    const running = runCcaTaskProof(input)
    const settled = running.catch((caught: unknown) => caught)
    await flush()
    controller.abort()
    const error = await settled
    expect(error).toBeInstanceOf(CcaConnectProofError)
    expect((error as CcaConnectProofError).code).toBe("transport_failed")
    expect((error as Error).message).not.toContain("secret")
    expect(order).toEqual(["executor", "runtime"])
    expect(closeCalls()).toBe(1)
    expect(runtimeCloseAttempts).toBe(1)
    expect(transport.closeCalls()).toBe(1)
    expect(statuses.join("\n")).not.toContain("shutdown=clean")
    expect(statuses.join("\n")).not.toContain("channel=rpc")
    expect(phaseNames(phases)).toContain("executor-close:failed")
    expect(phaseNames(phases)).toContain("handler-close:failed")
    expect(phaseNames(phases)).not.toContain("executor-close:completed")
    expect(phaseNames(phases)).not.toContain("handler-close:completed")
    const phaseCount = phases.length
    const closeError = await close().catch((caught: unknown) => caught)
    expect(closeError).toBeInstanceOf(CcaTaskRuntimeCloseError)
    expect((closeError as Error).message).not.toContain("secret")
    expect(order).toEqual(["executor", "runtime"])
    expect(phases.length).toBe(phaseCount)
  })

  test("held runtime close leaves executor completed while handler remains closing", async () => {
    let releaseRuntime!: () => void
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve
    })
    let markRuntimeStarted!: () => void
    const runtimeStarted = new Promise<void>((resolve) => {
      markRuntimeStarted = resolve
    })
    const transport = fakeTransport()
    const { handler: executor, closeCalls } = fakeHandler()
    const phases: ProofPhaseRecord[] = []
    const onPhase = (record: ProofPhaseRecord) => {
      phases.push(record)
    }
    let runtimeCloseAttempts = 0
    const close = composeCcaTaskCleanup({
      closeExecutor: async () => {
        await executor.close()
      },
      runtime: {
        close: async () => {
          runtimeCloseAttempts++
          markRuntimeStarted()
          await runtimeGate
        },
      },
      onPhase,
    })
    const handler = { ...executor, close }
    const { input, controller } = baseInput({
      handler,
      startTransport: transport.startTransport,
      onPhase,
    })
    const running = runCcaTaskProof(input)
    let settled = false
    void running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await flush()
    controller.abort()
    await runtimeStarted

    expect(closeCalls()).toBe(1)
    expect(runtimeCloseAttempts).toBe(1)
    expect(phaseNames(phases)).toContain("handler-close:started")
    expect(phaseNames(phases)).toContain("executor-close:started")
    expect(phaseNames(phases)).toContain("executor-close:completed")
    expect(phaseNames(phases)).not.toContain("handler-close:completed")
    expect(settled).toBe(false)

    releaseRuntime()
    await expect(running).resolves.toEqual({ channels: 0, requests: 0, responses: 0, notifications: 0 })
    expect(phaseNames(phases)).toContain("handler-close:completed")
    const phaseCount = phases.length
    await close()
    expect(runtimeCloseAttempts).toBe(1)
    expect(phases.length).toBe(phaseCount)
  })

  test("cleanup composition surfaces observer failure after executor and runtime teardown", async () => {
    const order: string[] = []
    const attempted: string[] = []
    let executorCloseAttempts = 0
    let runtimeCloseAttempts = 0
    const close = composeCcaTaskCleanup({
      closeExecutor: async () => {
        executorCloseAttempts++
        order.push("executor")
      },
      runtime: {
        close: async () => {
          runtimeCloseAttempts++
          order.push("runtime")
        },
      },
      onPhase: (record: ProofPhaseRecord) => {
        attempted.push(`${record.phase}:${record.event}`)
        if (record.phase === "executor-close" && record.event === "started") {
          throw new Error("compose-observer-secret")
        }
      },
    })

    const error = await close().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CcaTaskRuntimeCloseError)
    expect((error as Error).message).not.toContain("compose-observer-secret")
    expect(order).toEqual(["executor", "runtime"])
    expect(attempted).toEqual(["executor-close:started", "executor-close:completed"])
    const secondError = await close().catch((caught: unknown) => caught)
    expect(secondError).toBeInstanceOf(CcaTaskRuntimeCloseError)
    expect(executorCloseAttempts).toBe(1)
    expect(runtimeCloseAttempts).toBe(1)
    expect(attempted).toEqual(["executor-close:started", "executor-close:completed"])
  })

  test("precondition mismatch leaves handler and transport untouched, including handler close", async () => {
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler()
    const { input, statuses } = baseInput({
      handler,
      startTransport: transport.startTransport,
      state: { ...state, accountHash: "0".repeat(64) },
    })
    const error = await runCcaTaskProof(input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CcaConnectProofError)
    expect((error as CcaConnectProofError).code).toBe("account_mismatch")
    expect(transport.startCalls()).toBe(0)
    expect(closeCalls()).toBe(0)
    expect(statuses).toEqual([])
  })

  test("already-aborted signal leaves handler and transport untouched", async () => {
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler()
    const { input, controller } = baseInput({ handler, startTransport: transport.startTransport })
    controller.abort()
    const error = await runCcaTaskProof(input).catch((caught: unknown) => caught)
    expect((error as CcaConnectProofError).code).toBe("aborted")
    expect(transport.startCalls()).toBe(0)
    expect(closeCalls()).toBe(0)
  })

  test("requireChannel fails after closing handler and transport exactly once", async () => {
    const transport = fakeTransport()
    const { handler, closeCalls } = fakeHandler()
    const { input, controller } = baseInput({
      handler,
      startTransport: transport.startTransport,
      requireChannel: true,
    })
    const running = runCcaTaskProof(input)
    const settled = running.catch((error: unknown) => error)
    await flush()
    controller.abort()
    const error = await settled
    expect((error as CcaConnectProofError).code).toBe("channel_required")
    expect(closeCalls()).toBe(1)
    expect(transport.closeCalls()).toBe(1)
  })
})
