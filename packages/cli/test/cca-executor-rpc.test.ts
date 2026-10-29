import { describe, expect, test } from "bun:test"
import {
  ccaDetachedSessionTtlMs,
  createCcaRpcSession,
  createCcaSessionRegistry,
  type CcaEnvironmentInfo,
  type CcaInitializeContext,
  type CcaSessionResources,
  type CcaRpcHandler,
  type CcaRpcSession,
} from "../src/remote-control/cca-executor-rpc"
import { ccaRpcConnection } from "../src/remote-control/cca-executor-connection"

const mockEnvironmentInfo: CcaEnvironmentInfo = {
  shell: { name: "bash", path: "/bin/bash" },
  executorVersion: "1.0.0",
  platformOs: "linux",
  cwd: "file:///workspace",
  capabilities: {
    networkProxyLaunch: false,
    fileWriteStreaming: false,
  },
}

function createMockHandler(overrides: Partial<CcaRpcHandler> = {}): CcaRpcHandler {
  return {
    initialize: async (params) => ({ sessionId: `session_${params.clientName}` }),
    startProcess: async (params) => ({ processId: params.processId, sandboxType: "none" }),
    readProcess: async (params) => ({
      chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from("hello").toString("base64") }],
      nextSeq: 2,
      exited: false,
      closed: false,
      sandboxDenied: false,
    }),
    writeProcess: async () => ({ status: "accepted" }),
    signalProcess: async () => ({}),
    terminateProcess: async () => ({ running: false }),
    readFile: async (params) => ({ dataBase64: Buffer.from("file-content").toString("base64") }),
    writeFile: async () => ({}),
    getMetadata: async () => ({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: 12,
      createdAtMs: 1000,
      modifiedAtMs: 2000,
    }),
    readDirectory: async () => ({
      entries: [{ fileName: "test.txt", isDirectory: false, isFile: true }],
    }),
    canonicalize: async (params) => ({ path: params.path }),
    ...overrides,
  }
}

function encodeFrame(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg))
}

function decodeFrames(frames: readonly Uint8Array[]): any[] {
  return frames.map((f) => JSON.parse(new TextDecoder().decode(f)))
}

async function makeInitializedSession(handler: CcaRpcHandler): Promise<CcaRpcSession> {
  const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })
  await session.receive(encodeFrame({ id: 1, method: "initialize", params: { clientName: "test" } }))
  await session.receive(encodeFrame({ method: "initialized" }))
  return session
}

describe("CCA JSON-RPC Session Dispatcher", () => {
  test("dialect: responses and errors omit jsonrpc and preserve id types", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    const res1 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: "req-str-1",
          method: "initialize",
          params: { clientName: "test-client" },
        }),
      ),
    )
    expect(res1).toHaveLength(1)
    expect(res1[0].id).toBe("req-str-1")
    expect(res1[0].jsonrpc).toBeUndefined()
    expect(res1[0].result).toBeDefined()
    expect(res1[0].result.sessionId).toBe("session_test-client")
    expect(res1[0].result.environmentInfo).toEqual(mockEnvironmentInfo)

    const resInit = decodeFrames(await session.receive(encodeFrame({ method: "initialized" })))
    expect(resInit).toHaveLength(0)

    const res2 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 42,
          method: "environment/status",
        }),
      ),
    )
    expect(res2).toHaveLength(1)
    expect(res2[0].id).toBe(42)
    expect(res2[0].jsonrpc).toBeUndefined()
    expect(res2[0].result).toEqual({ status: "ready" })

    const resErr = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 99,
          method: "unknown/method",
        }),
      ),
    )
    expect(resErr).toHaveLength(1)
    expect(resErr[0].id).toBe(99)
    expect(resErr[0].jsonrpc).toBeUndefined()
    expect(resErr[0].error).toBeDefined()
    expect(resErr[0].error.code).toBe(-32601)
  })

  test("init gate: rejects calls before initialize with exact upstream error", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    const res = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 1,
          method: "process/start",
          params: {
            processId: "proc1",
            argv: ["echo", "hi"],
            cwd: "file:///workspace",
            env: {},
          },
        }),
      ),
    )
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe(1)
    expect(res[0].error.code).toBe(-32600)
    expect(res[0].error.message).toBe("client must call initialize before using exec methods")
  })

  test("init gate: rejects calls after initialize but before initialized notification", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({
        id: "init",
        method: "initialize",
        params: { clientName: "client-a" },
      }),
    )

    const res = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 2,
          method: "fs/readFile",
          params: { path: "file:///workspace/a.txt" },
        }),
      ),
    )
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe(2)
    expect(res[0].error.code).toBe(-32600)
    expect(res[0].error.message).toBe("client must send initialized before using filesystem methods")
  })

  test("init gate: double initialize rejected", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({
        id: 1,
        method: "initialize",
        params: { clientName: "client-a" },
      }),
    )

    const res = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 2,
          method: "initialize",
          params: { clientName: "client-b" },
        }),
      ),
    )
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe(2)
    expect(res[0].error.code).toBe(-32600)
    expect(res[0].error.message).toBe("initialize may only be sent once per connection")
  })

  test("unknown method and unknown notification handling", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({
        id: 1,
        method: "initialize",
        params: { clientName: "test" },
      }),
    )
    await session.receive(encodeFrame({ method: "initialized" }))

    const res1 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 10,
          method: "nonexistent/foo",
          params: { secretData: "secret" },
        }),
      ),
    )
    expect(res1).toHaveLength(1)
    expect(res1[0].error.code).toBe(-32601)
    expect(res1[0].error.message).toContain("Method not supported: nonexistent/foo")
    expect(res1[0].error.message).not.toContain("secret")

    const resNotif = decodeFrames(
      await session.receive(
        encodeFrame({
          method: "unknown/notification",
          params: { data: 123 },
        }),
      ),
    )
    expect(resNotif).toHaveLength(0)
  })

  test("validation: invalid params per family rejected with -32602", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({
        id: 1,
        method: "initialize",
        params: { clientName: "test" },
      }),
    )
    await session.receive(encodeFrame({ method: "initialized" }))

    const res1 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 2,
          method: "process/start",
          params: { processId: "p1", argv: [], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res1[0].error.code).toBe(-32602)

    const res2 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 3,
          method: "process/start",
          params: { processId: "p1", argv: ["ls"], cwd: "/native/path", env: {} },
        }),
      ),
    )
    expect(res2[0].error.code).toBe(-32602)

    const res3 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 4,
          method: "process/signal",
          params: { processId: "p1", signal: "SIGKILL" },
        }),
      ),
    )
    expect(res3[0].error.code).toBe(-32602)

    const res4 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 5,
          method: "process/write",
          params: { processId: "p1", chunk: Buffer.from("hi").toString("base64"), writeId: "" },
        }),
      ),
    )
    expect(res4[0].error.code).toBe(-32602)

    const res5 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 6,
          method: "fs/readFile",
          params: { path: "/etc/passwd" },
        }),
      ),
    )
    expect(res5[0].error.code).toBe(-32602)

    const res6 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 7,
          method: "fs/writeFile",
          params: { path: "file:///workspace/out.txt", dataBase64: "not-valid-base64?!" },
        }),
      ),
    )
    expect(res6[0].error.code).toBe(-32602)

    const resArg0 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 8,
          method: "process/start",
          params: {
            processId: "p1",
            argv: ["ls"],
            cwd: "file:///workspace",
            env: {},
            arg0: 12345,
          },
        }),
      ),
    )
    expect(resArg0[0].error.code).toBe(-32602)
  })

  test("security finding 13: oversized string request ID rejected as malformed id", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    const longId = "x".repeat(257)
    const res = decodeFrames(
      await session.receive(
        encodeFrame({
          id: longId,
          method: "initialize",
          params: { clientName: "test" },
        }),
      ),
    )
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe(-1)
    expect(res[0].error.code).toBe(-32600)
    expect(res[0].error.message).toBe("Invalid request ID")
  })

  test("handler errors keep allowlisted codes and verbatim messages and drop data", async () => {
    const cyclicObj: any = { secret: "hidden" }
    cyclicObj.self = cyclicObj

    let failureMode = "drop-data"
    const handler = createMockHandler({
      startProcess: async () => {
        if (failureMode === "drop-data") {
          const err: any = new Error("ok")
          err.code = -32602
          err.data = { secret: "x" }
          throw err
        }
        if (failureMode === "cyclic") {
          const err: any = new Error("ok")
          err.code = -32602
          err.data = cyclicObj
          throw err
        }
        if (failureMode === "weird-code") {
          const err: any = new Error("weird")
          err.code = 999
          throw err
        }
        if (failureMode === "newline") {
          const err: any = new Error("line1\nline2")
          err.code = -32602
          throw err
        }
        if (failureMode === "unicode") {
          const err: any = new Error("unicode: 🚀")
          err.code = -32602
          throw err
        }
        if (failureMode === "oversized") {
          const err: any = new Error("a".repeat(300))
          err.code = -32602
          throw err
        }
        return { processId: "p1" }
      },
    })

    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({ id: 1, method: "initialize", params: { clientName: "test" } }),
    )
    await session.receive(encodeFrame({ method: "initialized" }))

    failureMode = "drop-data"
    const res1 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 10,
          method: "process/start",
          params: { processId: "p", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res1[0].error.code).toBe(-32602)
    expect(res1[0].error.message).toBe("ok")
    expect(res1[0].error.data).toBeUndefined()
    expect(JSON.stringify(res1[0])).not.toContain("secret")

    failureMode = "cyclic"
    const res2 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 11,
          method: "process/start",
          params: { processId: "p", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res2[0].error.code).toBe(-32602)
    expect(res2[0].error.data).toBeUndefined()

    failureMode = "weird-code"
    const res3 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 12,
          method: "process/start",
          params: { processId: "p", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res3[0].error.code).toBe(-32603)
    expect(res3[0].error.message).toBe("Internal error")

    failureMode = "newline"
    const res4 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 13,
          method: "process/start",
          params: { processId: "p", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res4[0].error.code).toBe(-32602)
    expect(res4[0].error.message).toBe("line1\nline2")

    failureMode = "unicode"
    const res5 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 14,
          method: "process/start",
          params: { processId: "p", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res5[0].error.code).toBe(-32602)
    expect(res5[0].error.message).toBe("unicode: 🚀")

    failureMode = "oversized"
    const res6 = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 15,
          method: "process/start",
          params: { processId: "p", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(res6[0].error.code).toBe(-32602)
    expect(res6[0].error.message).toBe("a".repeat(300))
  })

  test("complexity and bomb rejection", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    let deep: any = { leaf: true }
    for (let i = 0; i < 150; i++) {
      deep = { nested: deep }
    }
    const resDepth = decodeFrames(
      await session.receive(encodeFrame({ id: 1, method: "test", params: deep })),
    )
    expect(resDepth).toHaveLength(1)
    expect(resDepth[0].error.code).toBe(-32600)
    expect(resDepth[0].error.message).toContain("complexity")

    const bigArr = new Array(300000).fill(1)
    const resNodes = decodeFrames(
      await session.receive(encodeFrame({ id: 2, method: "test", params: bigArr })),
    )
    expect(resNodes).toHaveLength(1)
    expect(resNodes[0].error.code).toBe(-32600)
  })

  test("handler not-found errors keep the upstream -32004 code and the handler message", async () => {
    const handler = createMockHandler({
      getMetadata: async () => {
        throw Object.assign(new Error("Path not found"), { code: -32004 })
      },
      readFile: async () => {
        throw Object.assign(new Error("missing /private/secret-path\u0000"), { code: -32004 })
      },
    })
    const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })
    await session.receive(encodeFrame({ id: 1, method: "initialize", params: { clientName: "test" } }))
    await session.receive(encodeFrame({ method: "initialized" }))
    const metadata = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "fs/getMetadata", params: { path: "file:///workspace/missing" } })))
    expect(metadata[0].error).toEqual({ code: -32004, message: "Path not found" })
    const read = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "fs/readFile", params: { path: "file:///workspace/missing" } })))
    expect(read[0].error).toEqual({ code: -32004, message: "missing /private/secret-path\u0000" })
  })

  test("handler error mapping: typed error passes through, unknown error sanitizes to -32603", async () => {
    const handler = createMockHandler({
      startProcess: async () => {
        const err = new Error("Resource not found") as any
        err.code = -32001
        throw err
      },
      readFile: async () => {
        throw new Error("Secret database password failed at db.connect(pass=12345)")
      },
    })

    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({
        id: 1,
        method: "initialize",
        params: { clientName: "test" },
      }),
    )
    await session.receive(encodeFrame({ method: "initialized" }))

    const resTyped = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 2,
          method: "process/start",
          params: { processId: "p1", argv: ["ls"], cwd: "file:///workspace", env: {} },
        }),
      ),
    )
    expect(resTyped[0].error.code).toBe(-32001)
    expect(resTyped[0].error.message).toBe("Resource not found")

    const resGeneric = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 3,
          method: "fs/readFile",
          params: { path: "file:///workspace/secret.txt" },
        }),
      ),
    )
    expect(resGeneric[0].error.code).toBe(-32603)
    expect(resGeneric[0].error.message).toBe("Internal error")
    expect(JSON.stringify(resGeneric[0])).not.toContain("password")
  })

  test("serialized receive() processing: in-order execution under slow handler", async () => {
    const order: number[] = []
    const handler = createMockHandler({
      readProcess: async (params) => {
        if (params.processId === "slow") {
          await new Promise((r) => setTimeout(r, 40))
          order.push(1)
        } else {
          order.push(2)
        }
        return {
          chunks: [],
          nextSeq: 1,
          exited: false,
          closed: false,
          sandboxDenied: false,
        }
      },
    })

    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    await session.receive(
      encodeFrame({ id: 1, method: "initialize", params: { clientName: "test" } }),
    )
    await session.receive(encodeFrame({ method: "initialized" }))

    const p1 = session.receive(
      encodeFrame({ id: 10, method: "process/read", params: { processId: "slow" } }),
    )
    const p2 = session.receive(
      encodeFrame({ id: 11, method: "process/read", params: { processId: "fast" } }),
    )

    const [r1, r2] = await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(decodeFrames(r1)[0].id).toBe(10)
    expect(decodeFrames(r2)[0].id).toBe(11)
  })

  test("abort signal stops execution and close() rejects new messages", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const handler = createMockHandler({
      startProcess: async (_params, ctx) => {
        observedSignal = ctx.signal
        return { processId: "p1" }
      },
    })

    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
      signal: controller.signal,
    })

    await session.receive(
      encodeFrame({ id: 1, method: "initialize", params: { clientName: "test" } }),
    )
    await session.receive(encodeFrame({ method: "initialized" }))

    await session.receive(
      encodeFrame({
        id: 2,
        method: "process/start",
        params: { processId: "p1", argv: ["cat"], cwd: "file:///workspace", env: {} },
      }),
    )
    expect(observedSignal?.aborted).toBe(false)

    controller.abort()
    expect(observedSignal?.aborted).toBe(true)

    await session.close()
    const resAfterClose = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 3,
          method: "process/terminate",
          params: { processId: "p1" },
        }),
      ),
    )
    expect(resAfterClose[0].error.code).toBe(-32603)
  })

  test("full synthetic happy path: init -> exec -> read -> write -> terminate -> fs roundtrip", async () => {
    const fsStorage = new Map<string, string>()
    const handler = createMockHandler({
      startProcess: async (params) => ({
        processId: params.processId,
        sandboxType: "none",
      }),
      readProcess: async (params) => ({
        chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from("stdout text\n").toString("base64") }],
        nextSeq: 2,
        exited: false,
        closed: false,
        sandboxDenied: false,
      }),
      writeProcess: async (params) => ({
        status: "accepted",
      }),
      terminateProcess: async (params) => ({
        running: true,
      }),
      writeFile: async (params) => {
        fsStorage.set(params.path, params.dataBase64)
        return {}
      },
      readFile: async (params) => {
        const dataBase64 = fsStorage.get(params.path)
        if (!dataBase64) {
          const err = new Error("File not found") as any
          err.code = -32004
          throw err
        }
        return { dataBase64 }
      },
      getMetadata: async (params) => {
        const data = fsStorage.get(params.path)
        return {
          isDirectory: false,
          isFile: true,
          isSymlink: false,
          size: data ? Buffer.from(data, "base64").length : 0,
          createdAtMs: 1000,
          modifiedAtMs: 2000,
        }
      },
      readDirectory: async () => ({
        entries: [{ fileName: "test.txt", isDirectory: false, isFile: true }],
      }),
      canonicalize: async (params) => ({ path: params.path }),
    })

    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
    })

    const initRes = decodeFrames(
      await session.receive(
        encodeFrame({ id: "init-1", method: "initialize", params: { clientName: "harness-client" } }),
      ),
    )
    expect(initRes[0].result.sessionId).toBe("session_harness-client")
    expect(initRes[0].result.environmentInfo.shell.name).toBe("bash")

    const initNotifRes = decodeFrames(await session.receive(encodeFrame({ method: "initialized" })))
    expect(initNotifRes).toHaveLength(0)

    const envInfoRes = decodeFrames(
      await session.receive(encodeFrame({ id: 2, method: "environment/info" })),
    )
    expect(envInfoRes[0].result.executorVersion).toBe("1.0.0")

    const envStatusRes = decodeFrames(
      await session.receive(encodeFrame({ id: 3, method: "environment/status" })),
    )
    expect(envStatusRes[0].result).toEqual({ status: "ready" })

    const startRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 4,
          method: "process/start",
          params: {
            processId: "proc-100",
            argv: ["python3", "main.py"],
            cwd: "file:///workspace/project",
            env: { FOO: "bar" },
            pipeStdin: true,
          },
        }),
      ),
    )
    expect(startRes[0].result).toEqual({ processId: "proc-100", sandboxType: "none" })

    const readRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 5,
          method: "process/read",
          params: { processId: "proc-100", afterSeq: 0, waitMs: 100 },
        }),
      ),
    )
    expect(readRes[0].result.chunks[0].chunk).toBe(Buffer.from("stdout text\n").toString("base64"))
    expect(readRes[0].result.nextSeq).toBe(2)

    const writeRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 6,
          method: "process/write",
          params: {
            processId: "proc-100",
            chunk: Buffer.from("input line\n").toString("base64"),
            writeId: "write-1",
          },
        }),
      ),
    )
    expect(writeRes[0].result).toEqual({ status: "accepted" })

    const termRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 7,
          method: "process/terminate",
          params: { processId: "proc-100" },
        }),
      ),
    )
    expect(termRes[0].result).toEqual({ running: true })

    const testContentB64 = Buffer.from("hello world").toString("base64")
    const writeFsRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 8,
          method: "fs/writeFile",
          params: { path: "file:///workspace/project/test.txt", dataBase64: testContentB64 },
        }),
      ),
    )
    expect(writeFsRes[0].result).toEqual({})

    const readFsRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 9,
          method: "fs/readFile",
          params: { path: "file:///workspace/project/test.txt" },
        }),
      ),
    )
    expect(readFsRes[0].result).toEqual({ dataBase64: testContentB64 })

    const metaRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 10,
          method: "fs/getMetadata",
          params: { path: "file:///workspace/project/test.txt" },
        }),
      ),
    )
    expect(metaRes[0].result.size).toBe(11)
    expect(metaRes[0].result.isFile).toBe(true)

    const readDirRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 11,
          method: "fs/readDirectory",
          params: { path: "file:///workspace/project" },
        }),
      ),
    )
    expect(readDirRes[0].result.entries).toEqual([
      { fileName: "test.txt", isDirectory: false, isFile: true },
    ])

    const canonRes = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 12,
          method: "fs/canonicalize",
          params: { path: "file:///workspace/project/test.txt" },
        }),
      ),
    )
    expect(canonRes[0].result).toEqual({ path: "file:///workspace/project/test.txt" })
  })

  test("resumeSessionId: a handler without sessions answers -32600 unknown session id <id>, malformed values are invalid params, retry works", async () => {
    for (const resumeSessionId of ["synthetic-resume-id", "", "x".repeat(300)]) {
      let initializeCalls = 0
      const handler = createMockHandler({
        initialize: async (params) => {
          initializeCalls++
          return { sessionId: `session_${params.clientName}` }
        },
      })
      const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })

      const res = decodeFrames(
        await session.receive(
          encodeFrame({ id: 1, method: "initialize", params: { clientName: "test", resumeSessionId } }),
        ),
      )
      expect(res[0].error.code).toBe(-32600)
      expect(res[0].error.message).toBe(`unknown session id ${resumeSessionId}`)
      expect(initializeCalls).toBe(0)

      const retry = decodeFrames(
        await session.receive(
          encodeFrame({ id: 2, method: "initialize", params: { clientName: "test" } }),
        ),
      )
      expect(retry[0].result.sessionId).toBe("session_test")
      expect(initializeCalls).toBe(1)
    }

    for (const resumeSessionId of [123, true, ["x"], { id: "x" }]) {
      let initializeCalls = 0
      const handler = createMockHandler({
        initialize: async (params) => {
          initializeCalls++
          return { sessionId: `session_${params.clientName}` }
        },
      })
      const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })
      const res = decodeFrames(
        await session.receive(
          encodeFrame({ id: 1, method: "initialize", params: { clientName: "test", resumeSessionId } }),
        ),
      )
      expect(res[0].error.code).toBe(-32602)
      expect(res[0].error.message).toBe("Invalid params: invalid resumeSessionId")
      expect(initializeCalls).toBe(0)

      const retry = decodeFrames(
        await session.receive(
          encodeFrame({ id: 2, method: "initialize", params: { clientName: "test" } }),
        ),
      )
      expect(retry[0].result.sessionId).toBe("session_test")
      expect(initializeCalls).toBe(1)
    }
  })

  test("resumeSessionId: absent and null are fresh initialization, initialized gate and ordinary operation follow", async () => {
    const variants: { clientName: string; resumeSessionId?: null }[] = [
      { clientName: "synthetic" },
      { clientName: "synthetic", resumeSessionId: null },
    ]
    for (const params of variants) {
      let initializeCalls = 0
      let seenInitParams: unknown
      const handler = createMockHandler({
        initialize: async (initParams) => {
          initializeCalls++
          seenInitParams = initParams
          return { sessionId: `session_${initParams.clientName}` }
        },
      })
      const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })

      const frame = encodeFrame({ id: "init-1", method: "initialize", params })
      if ("resumeSessionId" in params) {
        expect(new TextDecoder().decode(frame)).toContain('"resumeSessionId":null')
      }
      const initRes = decodeFrames(await session.receive(frame))
      expect(initRes[0].id).toBe("init-1")
      expect(initRes[0].error).toBeUndefined()
      expect(initRes[0].result.sessionId).toBe("session_synthetic")
      expect(initRes[0].result.environmentInfo).toEqual(mockEnvironmentInfo)
      expect(initializeCalls).toBe(1)
      expect(seenInitParams).toEqual({ clientName: "synthetic" })

      const gated = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "environment/status" })))
      expect(gated[0].error.code).toBe(-32600)
      expect(gated[0].error.message).toBe("client must send initialized before using environment status methods")

      const notif = decodeFrames(await session.receive(encodeFrame({ method: "initialized" })))
      expect(notif).toHaveLength(0)

      const status = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "environment/status" })))
      expect(status[0].result).toEqual({ status: "ready" })

      const start = decodeFrames(
        await session.receive(
          encodeFrame({
            id: 4,
            method: "process/start",
            params: { processId: "p1", argv: ["ls"], cwd: "file:///workspace", env: {} },
          }),
        ),
      )
      expect(start[0].result).toEqual({ processId: "p1", sandboxType: "none" })

      const repeated = decodeFrames(
        await session.receive(
          encodeFrame({ id: 5, method: "initialize", params: { clientName: "synthetic", resumeSessionId: null } }),
        ),
      )
      expect(repeated[0].error.code).toBe(-32600)
      expect(repeated[0].error.message).toBe("initialize may only be sent once per connection")
      expect(initializeCalls).toBe(1)
    }
  })

  test("strict booleans: non-boolean tty/pipeStdin/enforceManagedNetwork/followSymlinks rejected, booleans pass through", async () => {
    const seen: any[] = []
    const handler = createMockHandler({
      startProcess: async (params) => {
        seen.push(["start", params])
        return { processId: params.processId, sandboxType: "none" }
      },
      readFile: async (params) => {
        seen.push(["readFile", params])
        return { dataBase64: "" }
      },
      writeFile: async (params) => {
        seen.push(["writeFile", params])
        return {}
      },
      getMetadata: async (params) => {
        seen.push(["getMetadata", params])
        return { isDirectory: false, isFile: true, isSymlink: false, size: 0, createdAtMs: 0, modifiedAtMs: 0 }
      },
    })
    const session = await makeInitializedSession(handler)
    const start = { processId: "p1", argv: ["ls"], cwd: "file:///workspace", env: {} }
    const cases: [string, Record<string, unknown>][] = [
      ["process/start", { ...start, tty: "true" }],
      ["process/start", { ...start, tty: null }],
      ["process/start", { ...start, pipeStdin: 1 }],
      ["process/start", { ...start, enforceManagedNetwork: "yes" }],
      ["process/start", { ...start, enforceManagedNetwork: 0 }],
      ["fs/readFile", { path: "file:///workspace/a.txt", followSymlinks: "true" }],
      ["fs/writeFile", { path: "file:///workspace/a.txt", dataBase64: "aGk=", followSymlinks: 1 }],
      ["fs/getMetadata", { path: "file:///workspace/a.txt", followSymlinks: {} }],
    ]
    let id = 10
    for (const [method, params] of cases) {
      const res = decodeFrames(await session.receive(encodeFrame({ id: id++, method, params })))
      expect(res[0].error?.code).toBe(-32602)
    }
    expect(seen).toHaveLength(0)

    const okStart = decodeFrames(
      await session.receive(
        encodeFrame({
          id: 100,
          method: "process/start",
          params: { ...start, tty: true, pipeStdin: false, enforceManagedNetwork: true },
        }),
      ),
    )
    expect(okStart[0].result).toEqual({ processId: "p1", sandboxType: "none" })
    expect(seen[0][1].tty).toBe(true)
    expect(seen[0][1].pipeStdin).toBe(false)
    expect(seen[0][1].enforceManagedNetwork).toBe(true)

    const okFs = decodeFrames(
      await session.receive(
        encodeFrame({ id: 101, method: "fs/readFile", params: { path: "file:///workspace/a.txt", followSymlinks: false } }),
      ),
    )
    expect(okFs[0].result).toEqual({ dataBase64: "" })
    expect(seen[1][1].followSymlinks).toBe(false)
  })

  test("unknown method: -32601 before init gate at every init state, bounded name, notification stays lenient", async () => {
    const handler = createMockHandler()
    const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })

    const before = decodeFrames(await session.receive(encodeFrame({ id: 1, method: "unknown/thing" })))
    expect(before[0].error.code).toBe(-32601)
    expect(before[0].error.message).toBe("Method not supported: unknown/thing")

    const notif = decodeFrames(await session.receive(encodeFrame({ method: "unknown/thing" })))
    expect(notif).toHaveLength(0)

    await session.receive(encodeFrame({ id: 2, method: "initialize", params: { clientName: "test" } }))
    const mid = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "bogus/method" })))
    expect(mid[0].error.code).toBe(-32601)
    expect(mid[0].error.message).toBe("Method not supported: bogus/method")

    await session.receive(encodeFrame({ method: "initialized" }))
    const longMethod = `nope/${"a".repeat(100)}`
    const after = decodeFrames(await session.receive(encodeFrame({ id: 4, method: longMethod })))
    expect(after[0].error.code).toBe(-32601)
    expect(after[0].error.message).toBe(`Method not supported: ${longMethod.slice(0, 64)}`)
    expect(after[0].error.message.length).toBe("Method not supported: ".length + 64)
  })

  test("control lane: blocked process/read does not block process/terminate once initialized", async () => {
    let releaseRead: () => void = () => {}
    let markReadStarted: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let readSettled = false
    const handler = createMockHandler({
      readProcess: async () => {
        markReadStarted()
        await readGate
        return { chunks: [], nextSeq: 1, exited: false, closed: false, sandboxDenied: false }
      },
      terminateProcess: async () => ({ running: false }),
    })
    const session = await makeInitializedSession(handler)

    const completion: string[] = []
    const pRead = session
      .receive(encodeFrame({ id: 10, method: "process/read", params: { processId: "p1" } }))
      .then((frames) => {
        readSettled = true
        completion.push("read")
        return frames
      })
    await readStarted

    const pTerm = session
      .receive(encodeFrame({ id: 11, method: "process/terminate", params: { processId: "p1" } }))
      .then((frames) => {
        completion.push("terminate")
        return frames
      })
    const termOutcome = await Promise.race([
      pTerm.then(() => "terminate" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])
    expect(termOutcome).toBe("terminate")
    expect(readSettled).toBe(false)
    const termRes = decodeFrames(await pTerm)
    expect(termRes[0].id).toBe(11)
    expect(termRes[0].result).toEqual({ running: false })

    releaseRead()
    const readRes = decodeFrames(await pRead)
    expect(readRes[0].id).toBe(10)
    expect(completion).toEqual(["terminate", "read"])
  })

  test("control lane: control methods are serial with each other", async () => {
    let releaseTerm: () => void = () => {}
    let markTermStarted: () => void = () => {}
    const termStarted = new Promise<void>((resolve) => {
      markTermStarted = resolve
    })
    const termGate = new Promise<void>((resolve) => {
      releaseTerm = resolve
    })
    const calls: string[] = []
    const handler = createMockHandler({
      terminateProcess: async () => {
        calls.push("terminate")
        markTermStarted()
        await termGate
        return { running: false }
      },
      signalProcess: async () => {
        calls.push("signal")
        return {}
      },
    })
    const session = await makeInitializedSession(handler)

    const pTerm = session.receive(encodeFrame({ id: 1, method: "process/terminate", params: { processId: "p1" } }))
    await termStarted
    const pSig = session.receive(
      encodeFrame({ id: 2, method: "process/signal", params: { processId: "p1", signal: "interrupt" } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(calls).toEqual(["terminate"])

    releaseTerm()
    expect(decodeFrames(await pTerm)[0].result).toEqual({ running: false })
    expect(decodeFrames(await pSig)[0].result).toEqual({})
    expect(calls).toEqual(["terminate", "signal"])
  })

  test("control lane: no bypass before fully initialized, control methods keep gate errors", async () => {
    let controlCalls = 0
    const handler = createMockHandler({
      terminateProcess: async () => {
        controlCalls++
        return { running: false }
      },
      signalProcess: async () => {
        controlCalls++
        return {}
      },
    })
    const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })

    const beforeInit = decodeFrames(
      await session.receive(encodeFrame({ id: 1, method: "process/terminate", params: { processId: "p1" } })),
    )
    expect(beforeInit[0].error.code).toBe(-32600)
    expect(beforeInit[0].error.message).toBe("client must call initialize before using exec methods")

    const beforeInitEnv = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "environment/info" })))
    expect(beforeInitEnv[0].error.code).toBe(-32600)
    expect(beforeInitEnv[0].error.message).toBe("client must call initialize before using environment info methods")

    await session.receive(encodeFrame({ id: 3, method: "initialize", params: { clientName: "test" } }))

    const beforeInitialized = decodeFrames(
      await session.receive(
        encodeFrame({ id: 4, method: "process/signal", params: { processId: "p1", signal: "interrupt" } }),
      ),
    )
    expect(beforeInitialized[0].error.code).toBe(-32600)
    expect(beforeInitialized[0].error.message).toBe("client must send initialized before using exec methods")

    const beforeInitializedEnv = decodeFrames(await session.receive(encodeFrame({ id: 5, method: "environment/status" })))
    expect(beforeInitializedEnv[0].error.code).toBe(-32600)
    expect(beforeInitializedEnv[0].error.message).toBe(
      "client must send initialized before using environment status methods",
    )
    expect(controlCalls).toBe(0)
  })
})

const syntheticStart = { processId: "synthetic-process", argv: ["echo", ""], cwd: "file:///workspace", env: { EMPTY: "" } }
const syntheticShellSnapshot = { scopeId: "synthetic-scope", shell: { name: "zsh", path: "/bin/zsh" } }
const syntheticNetworkProxy = {
  proxy: {
    enabled: true,
    credentialMasking: false,
    credentialProviders: {},
    enableSocks5: false,
    enableSocks5Udp: false,
    allowUpstreamProxy: false,
    dangerouslyAllowAllUnixSockets: false,
    mode: "limited",
    domains: { "example.com": "allow" },
    reviewDomains: ["review.example.com"],
    allowLocalBinding: false,
  },
  auditMetadata: { conversationId: "synthetic-conversation" },
  policyDecisionTimeoutMs: 1000,
}
const syntheticEnvPolicy = { inherit: "none", ignoreDefaultExcludes: false, exclude: [], set: { EMPTY: "" }, includeOnly: [] }

function recordingHandler(seen: unknown[]): CcaRpcHandler {
  const base = createMockHandler()
  return {
    ...base,
    startProcess: async (params, ctx) => { seen.push(params); return base.startProcess(params, ctx) },
    readProcess: async (params, ctx) => { seen.push(params); return base.readProcess(params, ctx) },
    readFile: async (params, ctx) => { seen.push(params); return base.readFile(params, ctx) },
    writeFile: async (params, ctx) => { seen.push(params); return base.writeFile(params, ctx) },
    getMetadata: async (params, ctx) => { seen.push(params); return base.getMetadata(params, ctx) },
    readDirectory: async (params, ctx) => { seen.push(params); return base.readDirectory(params, ctx) },
    canonicalize: async (params, ctx) => { seen.push(params); return base.canonicalize(params, ctx) },
  }
}

describe("CCA optional wire fields", () => {
  const startOptions = [
    { field: "arg0", valid: ["", "synthetic-argv0"], invalid: [false, 0, [], {}] },
    { field: "metadata", valid: [{}, { toolCallId: "" }], invalid: [false, 0, "", []] },
    { field: "envPolicy", valid: [syntheticEnvPolicy], invalid: [false, 0, "", []] },
    { field: "shellSnapshot", valid: [syntheticShellSnapshot], invalid: [false, 0, "", [], {}, { scopeId: "s", shell: { name: "zsh" } }] },
    { field: "networkProxy", valid: [syntheticNetworkProxy], invalid: [false, 0, "", [], {}, { proxy: { ...syntheticNetworkProxy.proxy, mode: "open" } }] },
    ...["sandbox", "managedNetwork"].map((field) => ({
      field, valid: [{}], invalid: [false, 0, "", []],
    })),
  ]
  const optionalCases = [
    ...startOptions.map((option) => ({
      ...option, method: "process/start", base: syntheticStart,
      expected: { ...syntheticStart, tty: false, pipeStdin: false },
    })),
    ...["afterSeq", "maxBytes", "waitMs"].map((field) => ({
      field, method: "process/read", base: { processId: "synthetic-process" },
      expected: { processId: "synthetic-process" }, valid: [0, 1], invalid: [false, "0", [], {}, -1, 1.5],
    })),
    ...["fs/readFile", "fs/writeFile", "fs/getMetadata", "fs/readDirectory", "fs/canonicalize"].flatMap((method) => {
      const base = { path: "file:///workspace/synthetic.txt", ...(method === "fs/writeFile" ? { dataBase64: "" } : {}) }
      return [
        { method, base, expected: base, field: "sandbox", valid: [{}], invalid: [false, 0, "", []] },
        ...(["fs/readFile", "fs/writeFile", "fs/getMetadata"].includes(method)
          ? [{ method, base, expected: base, field: "followSymlinks", valid: [false, true], invalid: [0, "false", [], {}] }]
          : []),
      ]
    }),
  ]

  for (const { method, field, base, expected, valid, invalid } of optionalCases) {
    test(`${method}.${field}: synthetic absent/null normalize, values survive, malformed input never dispatches`, async () => {
      const seen: unknown[] = []
      const session = await makeInitializedSession(recordingHandler(seen))
      let id = 10
      try {
        for (const value of [undefined, null, ...valid]) {
          const frame = encodeFrame({ id: id++, method, params: { ...base, [field]: value } })
          if (value === null) expect(new TextDecoder().decode(frame)).toContain(`"${field}":null`)
          const response = decodeFrames(await session.receive(frame))[0]
          expect(response.error).toBeUndefined()
          expect(seen.pop()).toEqual({ ...expected, ...(value == null ? {} : { [field]: value }) })
        }
        for (const value of invalid) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: id++, method, params: { ...base, [field]: value } })))[0]
          expect(response.error?.code).toBe(-32602)
          expect(seen).toHaveLength(0)
        }
        const retry = decodeFrames(await session.receive(encodeFrame({ id: id++, method, params: base })))[0]
        expect(retry.error).toBeUndefined()
        expect(seen).toEqual([expected])
      } finally {
        await session.close()
      }
    })
  }

  test("process/start.arg0: synthetic null request completes receive and subsequent read", async () => {
    const seen: unknown[] = []
    const session = await makeInitializedSession(recordingHandler(seen))
    try {
      const response = decodeFrames(await session.receive(encodeFrame({
        id: 2, method: "process/start", params: { ...syntheticStart, arg0: null },
      })))[0]
      expect(response.result).toEqual({ processId: "synthetic-process", sandboxType: "none" })
      expect(seen[0]).toEqual({ ...syntheticStart, tty: false, pipeStdin: false })
      const read = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "process/read", params: {
        processId: "synthetic-process", afterSeq: null, maxBytes: null, waitMs: null,
      } })))[0]
      expect(read.result.chunks[0].chunk).toBe(Buffer.from("hello").toString("base64"))
      expect(seen[1]).toEqual({ processId: "synthetic-process" })
    } finally {
      await session.close()
    }
  })

  for (const field of ["threadId", "toolCallId"]) {
    test(`process/start.metadata.${field}: synthetic nested Option decoding`, async () => {
      const seen: unknown[] = []
      const session = await makeInitializedSession(recordingHandler(seen))
      const values = field === "threadId" ? ["00000000-0000-0000-0000-000000000000"] : ["", "synthetic-call"]
      try {
        for (const value of [undefined, null, ...values]) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "process/start", params: {
            ...syntheticStart, metadata: { [field]: value },
          } })))[0]
          expect(response.error).toBeUndefined()
          expect(seen.pop()).toEqual({ ...syntheticStart, tty: false, pipeStdin: false, metadata: value == null ? {} : { [field]: value } })
        }
        for (const value of [false, 0, [], {}, ...(field === "threadId" ? ["", "not-a-uuid"] : [])]) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "process/start", params: {
            ...syntheticStart, metadata: { [field]: value },
          } })))[0]
          expect(response.error?.code).toBe(-32602)
          expect(seen).toHaveLength(0)
        }
      } finally {
        await session.close()
      }
    })
  }

  test("process/start.envPolicy: synthetic required nested members reject missing/null/malformed, preserve false and empty values", async () => {
    const seen: unknown[] = []
    const session = await makeInitializedSession(recordingHandler(seen))
    const invalid = [
      { field: "inherit", values: [false, "invalid", ""] },
      { field: "ignoreDefaultExcludes", values: [0, "false"] },
      { field: "exclude", values: [false, "", [null]] },
      { field: "set", values: [false, [], { KEY: null }] },
      { field: "includeOnly", values: [false, "", [0]] },
    ]
    try {
      for (const { field, values } of invalid) {
        for (const value of [undefined, null, ...values]) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "process/start", params: {
            ...syntheticStart, envPolicy: { ...syntheticEnvPolicy, [field]: value },
          } })))[0]
          expect(response.error?.code).toBe(-32602)
          expect(seen).toHaveLength(0)
        }
      }
      for (const inherit of ["none", "core", "all"]) {
        const envPolicy = { ...syntheticEnvPolicy, inherit }
        const response = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "process/start", params: {
          ...syntheticStart, envPolicy,
        } })))[0]
        expect(response.error).toBeUndefined()
        expect(seen.pop()).toEqual({ ...syntheticStart, tty: false, pipeStdin: false, envPolicy })
      }
    } finally {
      await session.close()
    }
  })

  test("process/start: synthetic non-Option flags reject null, retain local omitted tty default and explicit false", async () => {
    const seen: unknown[] = []
    const session = await makeInitializedSession(recordingHandler(seen))
    try {
      for (const field of ["tty", "pipeStdin", "enforceManagedNetwork"]) {
        for (const value of [null, 0, "false", [], {}]) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "process/start", params: {
            ...syntheticStart, [field]: value,
          } })))[0]
          expect(response.error?.code).toBe(-32602)
          expect(seen).toHaveLength(0)
        }
        for (const value of [false, true]) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: 3, method: "process/start", params: {
            ...syntheticStart, [field]: value,
          } })))[0]
          expect(response.error).toBeUndefined()
          expect(seen.pop()).toEqual({ ...syntheticStart, tty: false, pipeStdin: false, [field]: value })
        }
      }
    } finally {
      await session.close()
    }
  })

  test("required process primitives remain strict with nullable options present", async () => {
    const seen: unknown[] = []
    const session = await makeInitializedSession(recordingHandler(seen))
    try {
      for (const field of ["processId", "argv", "cwd", "env"]) {
        for (const value of [undefined, null, false, 0]) {
          const response = decodeFrames(await session.receive(encodeFrame({ id: 2, method: "process/start", params: {
            ...syntheticStart, arg0: null, [field]: value,
          } })))[0]
          expect(response.error?.code).toBe(-32602)
          expect(seen).toHaveLength(0)
        }
      }
    } finally {
      await session.close()
    }
  })
})

describe("CCA exec-server session registry (server/session_registry.rs, server/handler.rs:initialize)", () => {
  type Opened = { readonly index: number; closed: number; notify?: CcaInitializeContext["notify"]; readonly calls: string[] }

  function registryHarness(options: { readonly ttlMs?: number; readonly now?: () => number } = {}) {
    const opened: Opened[] = []
    const registry = createCcaSessionRegistry(options)
    const open = async (): Promise<CcaSessionResources> => {
      const entry: Opened = { index: opened.length + 1, closed: 0, calls: [] }
      opened.push(entry)
      return {
        handler: createMockHandler({
          initialize: async (_params, ctx) => {
            entry.notify = ctx.notify
            return { sessionId: `synthetic-session-${entry.index}` }
          },
          startProcess: async (params, ctx) => {
            entry.calls.push(`${ctx.sessionId}:${params.processId}`)
            return { processId: params.processId, sandboxType: "none" }
          },
        }),
        environmentInfo: () => ({ ...mockEnvironmentInfo, cwd: `file:///session-${entry.index}` }),
        close: async () => { entry.closed++ },
      }
    }
    const connect = () => {
      const notifications: string[] = []
      const connection = registry.connect(open)
      const session = createCcaRpcSession({
        environmentInfo: connection.environmentInfo,
        handler: connection.handler,
        sendNotification: (method) => { notifications.push(method) },
      })
      const call = async (message: unknown) => decodeFrames(await session.receive(encodeFrame(message)))[0]
      return { connection, session, notifications, call }
    }
    return { registry, opened, connect }
  }

  test("each fresh initialize creates a new session and gates on initialized", async () => {
    const harness = registryHarness()
    const first = harness.connect()
    const second = harness.connect()
    const a = await first.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    const b = await second.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    expect([a.result.sessionId, b.result.sessionId]).toEqual(["synthetic-session-1", "synthetic-session-2"])
    expect(a.result.environmentInfo.cwd).toBe("file:///session-1")
    expect((await first.call({ id: 2, method: "environment/status" })).error.code).toBe(-32600)
    await first.session.receive(encodeFrame({ method: "initialized" }))
    await first.call({ id: 3, method: "process/start", params: { processId: "p1", argv: ["ls"], cwd: "file:///workspace", env: {} } })
    expect(harness.opened[0]!.calls).toEqual(["synthetic-session-1:p1"])
    await harness.registry.shutdown()
  })

  test("a live attachment answers -32010, a detached session resumes with redirected notifications, and retry works on the same connection", async () => {
    const harness = registryHarness()
    const owner = harness.connect()
    await owner.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    const other = harness.connect()
    const busy = await other.call({ id: 1, method: "initialize", params: { clientName: "synthetic", resumeSessionId: "synthetic-session-1" } })
    expect(busy.error).toEqual({ code: -32010, message: "session synthetic-session-1 is already attached to another connection" })

    await harness.opened[0]!.notify!("process/output", {})
    owner.connection.detach()
    await harness.opened[0]!.notify!("process/exited", {})
    const resumed = await other.call({ id: 2, method: "initialize", params: { clientName: "synthetic", resumeSessionId: "synthetic-session-1" } })
    expect(resumed.result).toEqual({ sessionId: "synthetic-session-1", environmentInfo: { ...mockEnvironmentInfo, cwd: "file:///session-1" } })
    await harness.opened[0]!.notify!("process/closed", {})
    expect(owner.notifications).toEqual(["process/output"])
    expect(other.notifications).toEqual(["process/closed"])
    expect(harness.opened).toHaveLength(1)

    await other.session.receive(encodeFrame({ method: "initialized" }))
    await other.call({ id: 3, method: "process/start", params: { processId: "p2", argv: ["ls"], cwd: "file:///workspace", env: {} } })
    expect(harness.opened[0]!.calls).toEqual(["synthetic-session-1:p2"])
    expect((await other.call({ id: 4, method: "initialize", params: { clientName: "synthetic" } })).error.message).toBe("initialize may only be sent once per connection")
    await harness.registry.shutdown()
    expect(harness.opened[0]!.closed).toBe(1)
  })

  test("an unknown session id answers -32600 unknown session id <id>", async () => {
    const harness = registryHarness()
    const client = harness.connect()
    const response = await client.call({ id: 1, method: "initialize", params: { clientName: "synthetic", resumeSessionId: "synthetic-missing" } })
    expect(response.error).toEqual({ code: -32600, message: "unknown session id synthetic-missing" })
    expect(harness.opened).toHaveLength(0)
    expect((await client.call({ id: 2, method: "initialize", params: { clientName: "synthetic" } })).result.sessionId).toBe("synthetic-session-1")
    await harness.registry.shutdown()
  })

  test("a detached session expires after the TTL, shutting its processes down, and is then unknown", async () => {
    expect(ccaDetachedSessionTtlMs).toBe(30_000)
    const harness = registryHarness({ ttlMs: 20 })
    const owner = harness.connect()
    await owner.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    owner.connection.detach()
    expect(harness.opened[0]!.closed).toBe(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(harness.opened[0]!.closed).toBe(1)
    const late = await harness.connect().call({ id: 1, method: "initialize", params: { clientName: "synthetic", resumeSessionId: "synthetic-session-1" } })
    expect(late.error).toEqual({ code: -32600, message: "unknown session id synthetic-session-1" })
    await harness.registry.shutdown()
    expect(harness.opened[0]!.closed).toBe(1)
  })

  test("a resume past the deadline is refused even before the expiry timer runs", async () => {
    let clock = 0
    const harness = registryHarness({ ttlMs: 60_000, now: () => clock })
    const owner = harness.connect()
    await owner.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    owner.connection.detach()
    clock = 60_000
    const late = await harness.connect().call({ id: 1, method: "initialize", params: { clientName: "synthetic", resumeSessionId: "synthetic-session-1" } })
    expect(late.error.code).toBe(-32600)
    expect(harness.opened[0]!.closed).toBe(1)
    await harness.registry.shutdown()
  })

  test("reattaching before the TTL keeps the session alive, and shutdown closes every session once", async () => {
    const harness = registryHarness({ ttlMs: 20 })
    const owner = harness.connect()
    await owner.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    owner.connection.detach()
    const next = harness.connect()
    await next.call({ id: 1, method: "initialize", params: { clientName: "synthetic", resumeSessionId: "synthetic-session-1" } })
    owner.connection.detach()
    await new Promise((r) => setTimeout(r, 60))
    expect(harness.opened[0]!.closed).toBe(0)
    const detached = harness.connect()
    await detached.call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    detached.connection.detach()
    await harness.registry.shutdown()
    expect(harness.opened.map((entry) => entry.closed)).toEqual([1, 1])
    const after = await harness.connect().call({ id: 1, method: "initialize", params: { clientName: "synthetic" } })
    expect(after.error.code).toBe(-32603)
  })
})

describe("CCA exec-server environmentConfig/read and capabilityRoots/discoverV1 decoding", () => {
  const environmentConfig = { userHomeDir: "file:///synthetic", codexHomeDir: "file:///synthetic/.codex", hostname: "synthetic", config: { layers: [], cloudInsertionIndex: 0 }, requirements: { layers: [], cloudInsertionIndex: 0 } }

  async function session(overrides: Partial<CcaRpcHandler>, initialize = true) {
    const seen: unknown[] = []
    const handler = createMockHandler({
      readEnvironmentConfig: async (params) => {
        seen.push(params)
        return environmentConfig
      },
      discoverCapabilityRoots: async (params) => {
        seen.push(params)
        return { roots: [] }
      },
      ...overrides,
    })
    const rpc = initialize ? await makeInitializedSession(handler) : createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler })
    let id = 10
    const call = async (method: string, params?: unknown) => decodeFrames(await rpc.receive(encodeFrame({ id: ++id, method, ...(params === undefined ? {} : { params }) })))[0]
    return { call, seen }
  }

  test("well-formed requests reach the handler with decoded params and return its result", async () => {
    const { call, seen } = await session({})
    const read = await call("environmentConfig/read", { cwd: "file:///tmp/codex-task.synthetic", configPaths: [["mcp_servers"]], requirementsPaths: [["mcp_servers"]], extra: 1 })
    expect(read.result).toEqual(environmentConfig)
    const discover = await call("capabilityRoots/discoverV1", { roots: [{ id: "codex-home-skills", path: "file:///synthetic/.agents/skills", sandbox: null }] })
    expect(discover.result).toEqual({ roots: [] })
    expect(seen).toEqual([
      { cwd: "file:///tmp/codex-task.synthetic", configPaths: [["mcp_servers"]], requirementsPaths: [["mcp_servers"]] },
      { roots: [{ id: "codex-home-skills", path: "file:///synthetic/.agents/skills" }] },
    ])
  })

  test("malformed params answer the official serde messages", async () => {
    const { call, seen } = await session({})
    const cases: [string, unknown, string][] = [
      ["environmentConfig/read", undefined, "invalid type: null, expected struct EnvironmentConfigReadParams"],
      ["environmentConfig/read", { configPaths: [["a"]] }, "missing field `cwd`"],
      ["environmentConfig/read", { cwd: "file:///synthetic", requirementsPaths: [] }, "missing field `configPaths`"],
      ["environmentConfig/read", { cwd: "file:///synthetic", configPaths: [["a"]] }, "missing field `requirementsPaths`"],
      ["environmentConfig/read", { cwd: "file:///synthetic", configPaths: "x", requirementsPaths: [] }, 'invalid type: string "x", expected a sequence'],
      ["environmentConfig/read", { cwd: "file:///synthetic", configPaths: [[1]], requirementsPaths: [] }, "invalid type: number, expected a string"],
      ["environmentConfig/read", { cwd: "relative/path", configPaths: [["a"]], requirementsPaths: [] }, "invalid URI: relative URL without a base"],
      ["environmentConfig/read", { cwd: "http://example.com/x", configPaths: [["a"]], requirementsPaths: [] }, "unsupported path URI scheme `http`"],
      ["capabilityRoots/discoverV1", {}, "missing field `roots`"],
    ]
    for (const [method, params, message] of cases) expect((await call(method, params)).error).toEqual({ code: -32602, message })
    expect(seen).toEqual([])
  })

  test("both methods are gated on initialization and answer -32601 when the handler lacks them", async () => {
    const gated = await session({}, false)
    expect((await gated.call("environmentConfig/read", { cwd: "file:///x", configPaths: [["a"]], requirementsPaths: [] })).error).toEqual({
      code: -32600,
      message: "client must call initialize before using environment config methods",
    })
    expect((await gated.call("capabilityRoots/discoverV1", { roots: [] })).error).toEqual({
      code: -32600,
      message: "client must call initialize before using capability discovery methods",
    })
    const bare = await session({ readEnvironmentConfig: undefined, discoverCapabilityRoots: undefined })
    expect((await bare.call("environmentConfig/read", { cwd: "file:///x", configPaths: [["a"]], requirementsPaths: [] })).error.code).toBe(-32601)
    expect((await bare.call("capabilityRoots/discoverV1", { roots: [] })).error.code).toBe(-32601)
  })
})

describe("CCA exec-server connection resources, executor-to-cloud calls, and error text", () => {
  function connectionHandler(events: string[], http?: (params: any, ctx: any) => Promise<any>) {
    return createMockHandler({
      openRpcConnection: () => {
        events.push("open")
        return ccaRpcConnection({
          fs: {
            createDirectory: async () => ({}),
            open: async (params: any) => ({ handleId: params.handleId }),
            readBlock: async () => ({ chunk: new Uint8Array([104, 105]), eof: true }),
            writeBlock: async () => ({}),
            close: async () => ({}),
            walk: async () => ({ entries: [], errors: [], truncated: false }),
            remove: async () => ({}),
            copy: async () => ({}),
          },
          http: { request: http ?? (async () => ({ response: { status: 204, headers: [], body: new Uint8Array() } })) },
          close: async () => {
            events.push("close")
          },
        })
      },
    })
  }

  test("a connection opens after initialize, serves the extended methods through the wire codecs, and closes with the session", async () => {
    const events: string[] = []
    const session = createCcaRpcSession({ environmentInfo: () => mockEnvironmentInfo, handler: connectionHandler(events) })
    expect(decodeFrames(await session.receive(encodeFrame({ id: 1, method: "fs/open", params: {} })))[0].error.code).toBe(-32600)
    await session.receive(encodeFrame({ id: 2, method: "initialize", params: { clientName: "test" } }))
    await session.receive(encodeFrame({ method: "initialized" }))
    expect(events).toEqual(["open"])
    const call = async (id: number, method: string, params: unknown) => decodeFrames(await session.receive(encodeFrame({ id, method, params })))[0]
    expect((await call(3, "fs/open", { handleId: "h1", path: "file:///synthetic/a.txt" })).result).toEqual({ handleId: "h1" })
    expect((await call(4, "fs/readBlock", { handleId: "h1", offset: 0, len: 2 })).result).toEqual({ chunk: "aGk=", eof: true })
    expect((await call(5, "fs/close", {})).error).toEqual({ code: -32602, message: "missing field `handleId`" })
    expect((await call(6, "http/request", { method: "GET", url: "http://127.0.0.1:1/", requestId: "r1" })).result).toEqual({ status: 204, headers: [], bodyBase64: "" })
    await session.close()
    expect(events).toEqual(["open", "close"])
  })

  test("a streamed http/request sends its response frame before the body stream starts, and cancels when the response cannot be sent", async () => {
    const order: string[] = []
    let failSend = false
    const stream = { start: async () => { order.push("start") }, cancel: async () => { order.push("cancel") } }
    const handler = connectionHandler([], async (_params, ctx) => {
      void ctx
      return { response: { status: 200, headers: [{ name: "x", value: "1" }], body: new Uint8Array() }, stream }
    })
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler,
      sendFrame: async (bytes) => {
        if (failSend) throw new Error("synthetic send failure")
        order.push(`frame ${JSON.parse(new TextDecoder().decode(bytes)).id}`)
      },
    })
    await session.receive(encodeFrame({ id: 1, method: "initialize", params: { clientName: "test" } }))
    await session.receive(encodeFrame({ method: "initialized" }))
    expect(decodeFrames(await session.receive(encodeFrame({ id: 7, method: "http/request", params: { method: "GET", url: "http://x/", requestId: "s1", streamResponse: true } })))).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(["frame 7", "start"])
    failSend = true
    await session.receive(encodeFrame({ id: 8, method: "http/request", params: { method: "GET", url: "http://x/", requestId: "s2", streamResponse: true } }))
    expect(order).toEqual(["frame 7", "start", "cancel"])
    await session.close()
  })

  test("call sends a request in its own id space and settles on the matching response, a timeout, or close", async () => {
    const sent: any[] = []
    const session = createCcaRpcSession({
      environmentInfo: () => mockEnvironmentInfo,
      handler: createMockHandler(),
      sendFrame: async (bytes) => {
        sent.push(JSON.parse(new TextDecoder().decode(bytes)))
      },
    })
    const success = session.call("network/policyRequest", { host: "example.com" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([{ id: 1, method: "network/policyRequest", params: { host: "example.com" } }])
    expect(await session.receive(encodeFrame({ id: 999, result: { ignored: true } }))).toEqual([])
    expect(await session.receive(encodeFrame({ id: 1, result: { decision: "allow" } }))).toEqual([])
    expect(await success).toEqual({ decision: "allow" })

    const failure = session.call("network/policyRequest", {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    await session.receive(encodeFrame({ id: 2, error: { code: -32601, message: "synthetic unsupported" } }))
    await expect(failure).rejects.toMatchObject({ code: -32601, message: "synthetic unsupported" })

    const aborter = new AbortController()
    const aborted = session.call("network/policyRequest", {}, { signal: aborter.signal })
    aborter.abort()
    await expect(aborted).rejects.toThrow("executor request network/policyRequest was cancelled")
    expect(await session.receive(encodeFrame({ id: 3, result: { late: true } }))).toEqual([])

    await expect(session.call("network/policyRequest", {}, { timeoutMs: 20 })).rejects.toThrow("executor request network/policyRequest timed out")
    const pending = session.call("network/policyRequest", {})
    await session.close()
    await expect(pending).rejects.toThrow("Connection closed")
    await expect(session.call("network/policyRequest", {})).rejects.toThrow("Connection closed")
  })

  test("the session-level call reaches the connection the session is attached to, and fails while detached", async () => {
    const registry = createCcaSessionRegistry({ ttlMs: 60_000 })
    let sessionCall: CcaInitializeContext["call"] | undefined
    const open = async (): Promise<CcaSessionResources> => ({
      handler: createMockHandler({
        initialize: async (_params, ctx) => {
          sessionCall = ctx.call
          return { sessionId: "synthetic-session-call" }
        },
      }),
      environmentInfo: () => mockEnvironmentInfo,
      close: async () => {},
    })
    const attach = async (resumeSessionId?: string) => {
      const sent: any[] = []
      const connection = registry.connect(open)
      const session = createCcaRpcSession({
        environmentInfo: connection.environmentInfo,
        handler: connection.handler,
        sendFrame: async (bytes) => { sent.push(JSON.parse(new TextDecoder().decode(bytes))) },
      })
      await session.receive(encodeFrame({ id: 1, method: "initialize", params: { clientName: "synthetic", ...(resumeSessionId ? { resumeSessionId } : {}) } }))
      return { connection, session, sent }
    }
    try {
      const first = await attach()
      const answered = sessionCall!("network/policyRequest", { processId: "p1" })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(first.sent).toEqual([{ id: 1, method: "network/policyRequest", params: { processId: "p1" } }])
      await first.session.receive(encodeFrame({ id: 1, result: { decision: { type: "allow" } } }))
      expect(await answered).toEqual({ decision: { type: "allow" } })

      first.connection.detach()
      await expect(sessionCall!("network/policyRequest", {})).rejects.toThrow("Connection closed")
      await first.session.close()

      const second = await attach("synthetic-session-call")
      const resumed = sessionCall!("network/policyRequest", { processId: "p2" })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(second.sent).toEqual([{ id: 1, method: "network/policyRequest", params: { processId: "p2" } }])
      await second.session.receive(encodeFrame({ id: 1, result: { decision: { type: "deny", reason: "synthetic" } } }))
      expect(await resumed).toEqual({ decision: { type: "deny", reason: "synthetic" } })
      await second.session.close()
    } finally {
      await registry.shutdown()
    }
  })

  test("handler error messages reach the wire verbatim", async () => {
    const message = `path \`/synthetic dir/é\` ${"x".repeat(300)} (os error 2)`
    const session = await makeInitializedSession(createMockHandler({ readFile: async () => { throw Object.assign(new Error(message), { code: -32004 }) } }))
    const response = decodeFrames(await session.receive(encodeFrame({ id: 9, method: "fs/readFile", params: { path: "file:///synthetic/a.txt" } })))[0]
    expect(response.error).toEqual({ code: -32004, message })
  })
})

describe("CCA refusal wire shapes", () => {
  test("a Dots refusal reaches the JSON-RPC response untruncated for fs/writeFile and process/start", async () => {
    const { mkdtemp, realpath, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    const { createCcaExecutor, ccaRefusalText } = await import("@ycoding-ai/core/cca/executor")
    const { CcaAuthorizationDeniedError } = await import("@ycoding-ai/core/cca/authorization")
    const { CcaPolicy } = await import("@ycoding-ai/core/cca/policy")
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cca-refusal-wire-")))
    const pending = {
      kind: "permission" as const, sessionID: "ses_synthetic", itemID: "rvw_synthetic", action: "edit",
      resources: [path.join(root, "refused.txt")], hardReview: false, state: "open" as const,
    }
    const text = ccaRefusalText({ pending: [pending] })!
    const executor = createCcaExecutor({
      scopeFor: async () => ({
        sessionID: "ses_synthetic",
        roots: [root],
        authorization: {
          authorize: async (input: { readonly action: string }) => {
            if (input.action === "read") return { release: async () => {} }
            throw new CcaAuthorizationDeniedError([], { pending: [pending] })
          },
        },
        close: async () => {},
      }),
    })
    try {
      const session = await makeInitializedSession({ ...createMockHandler(), ...executor })
      const written = decodeFrames(await session.receive(encodeFrame({
        id: 2, method: "fs/writeFile", params: { path: CcaPolicy.toPathUri(path.join(root, "refused.txt")), dataBase64: "" },
      })))
      expect(written).toEqual([{ id: 2, error: { code: -32600, message: `Permission denied: ${text}` } }])
      expect(written[0].error.message.length).toBeGreaterThan(512)
      const started = decodeFrames(await session.receive(encodeFrame({
        id: 3, method: "process/start", params: { processId: "refused", argv: ["/bin/sh", "-lc", "true"], cwd: CcaPolicy.toPathUri(root), env: {} },
      })))
      expect(started).toEqual([{ id: 3, result: { processId: "refused", sandboxType: "none" } }])
      const read = decodeFrames(await session.receive(encodeFrame({ id: 4, method: "process/read", params: { processId: "refused", afterSeq: 0 } })))
      expect(read[0].result).toMatchObject({ exited: true, exitCode: 1, closed: true, sandboxDenied: false })
      expect(read[0].result.chunks).toEqual([{ seq: 1, stream: "stderr", chunk: Buffer.from(`${text}\n`).toString("base64") }])
    } finally {
      await executor.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
