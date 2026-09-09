import { expect, test } from "bun:test"
import { Pty } from "@ycoding-ai/schema/pty"
import {
  createTerminalInspectorTransport,
  type TerminalInspectorApi,
} from "../src/component/terminal-inspector-transport"

const sessionID = "ses_transport"
const ptyID = Pty.ID.make("pty_transport")
const location = { directory: "/tmp/ycoding", workspaceID: "workspace_transport" }

test("ticketed control transport binds Session, generation, offset, and fence before forwarding frames", async () => {
  const tickets: Array<{ input: unknown; signal?: AbortSignal }> = []
  const sockets: FakeSocket[] = []
  const frames: Array<string | Uint8Array | ArrayBuffer> = []
  const api = apiWithToken(async (input: unknown, options?: { signal?: AbortSignal }) => {
    tickets.push({ input, signal: options?.signal })
    return {
      location: { directory: location.directory },
      data: { ticket: "single-use-ticket", expires_in: 10, access: "control", generation: 7, fence: 5 },
    }
  })
  const transport = createTerminalInspectorTransport({
    api,
    baseUrl: "http://127.0.0.1:4096/base",
    ptyID,
    sessionID,
    location,
    socket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })

  const dispose = transport.connect(
    { generation: 7, offset: 11, access: "control", fence: 5 },
    { frame: (frame) => frames.push(frame), close: () => {}, error: () => {} },
  )
  await drain()

  expect(tickets.map((item) => item.input)).toEqual([
    {
      ptyID,
      sessionID,
      access: "control",
      generation: 7,
      expectedFence: 5,
      location: { directory: location.directory, workspace: location.workspaceID },
      "x-ycoding-ticket": "1",
    },
  ])
  expect(sockets).toHaveLength(1)
  const socket = sockets[0]
  const url = new URL(socket.url)
  expect(url.protocol).toBe("ws:")
  expect(url.pathname).toBe(`/api/pty/${ptyID}/connect`)
  expect(Object.fromEntries(url.searchParams)).toEqual({
    "location[directory]": location.directory,
    "location[workspace]": location.workspaceID,
    sessionID,
    generation: "7",
    offset: "11",
    access: "control",
    fence: "5",
    ticket: "single-use-ticket",
  })

  transport.write(new TextEncoder().encode("too early"))
  expect(socket.sent).toHaveLength(0)
  socket.open()
  const frame = new Uint8Array([1, 2, 3])
  socket.message(frame.buffer)
  expect(frames).toEqual([frame.buffer])
  transport.write(new TextEncoder().encode("input"))
  expect(socket.sent).toHaveLength(1)

  dispose()
  expect(tickets[0].signal?.aborted).toBe(true)
  expect(socket.closed).toBe(1)
})

test("disposing a pending ticket request prevents late socket creation", async () => {
  let signal: AbortSignal | undefined
  let resolve!: (value: { data: unknown }) => void
  const ticket = new Promise<{ data: unknown }>((done) => (resolve = done))
  const sockets: FakeSocket[] = []
  const api = apiWithToken((_input: unknown, options?: { signal?: AbortSignal }) => {
    signal = options?.signal
    return ticket
  })
  const transport = createTerminalInspectorTransport({
    api,
    baseUrl: "http://127.0.0.1:4096",
    ptyID,
    sessionID,
    location,
    socket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })

  const dispose = transport.connect(
    { generation: 1, offset: 0, access: "inspect" },
    { frame: () => {}, close: () => {}, error: () => {} },
  )
  dispose()
  expect(signal?.aborted).toBe(true)
  resolve({ data: { ticket: "late-ticket", expires_in: 10, access: "inspect", generation: 1 } })
  await drain()
  expect(sockets).toHaveLength(0)
})

test("connect-token rejection reports one category-only failure without opening a socket", async () => {
  const sockets: FakeSocket[] = []
  let failures = 0
  const api = apiWithToken(async () => {
    throw new Error("private path /Users/example/secret and ticket=hidden")
  })
  const transport = createTerminalInspectorTransport({
    api,
    baseUrl: "http://127.0.0.1:4096",
    ptyID,
    sessionID,
    location,
    socket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })

  const dispose = transport.connect(
    { generation: 1, offset: 0, access: "inspect" },
    { frame: () => {}, close: () => {}, error: () => (failures += 1) },
  )
  await drain()
  expect(failures).toBe(1)
  expect(sockets).toHaveLength(0)
  dispose()
})

test("new connections resolve the current API and base URL after service reconnection", async () => {
  const calls: string[] = []
  const sockets: FakeSocket[] = []
  const createApi = (name: string) =>
    apiWithToken(async () => {
      calls.push(name)
      return {
        location: { directory: location.directory },
        data: { ticket: `${name}-ticket`, expires_in: 10, access: "inspect", generation: 1 },
      }
    })
  let api = createApi("first")
  let baseUrl = "http://127.0.0.1:4096"
  const transport = createTerminalInspectorTransport({
    api: () => api,
    baseUrl: () => baseUrl,
    ptyID,
    sessionID,
    location,
    socket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })

  const first = transport.connect(
    { generation: 1, offset: 0, access: "inspect" },
    { frame: () => {}, close: () => {}, error: () => {} },
  )
  await drain()
  first()
  api = createApi("second")
  baseUrl = "http://127.0.0.1:8192"
  transport.connect(
    { generation: 1, offset: 0, access: "inspect" },
    { frame: () => {}, close: () => {}, error: () => {} },
  )
  await drain()

  expect(calls).toEqual(["first", "second"])
  expect(sockets.map((socket) => new URL(socket.url).port)).toEqual(["4096", "8192"])
})

class FakeSocket {
  readonly url: string
  binaryType = "blob"
  readyState = 0
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = []
  closed = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  message(data: unknown) {
    this.onmessage?.({ data })
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(data)
  }

  close() {
    this.closed += 1
    this.readyState = 3
  }
}

function apiWithToken(token: TerminalInspectorApi["pty"]["connect"]["token"]): TerminalInspectorApi {
  return {
    pty: {
      connect: { token },
      control: async () => {
        throw new Error("Unexpected control request")
      },
      update: async () => {
        throw new Error("Unexpected update request")
      },
    },
  }
}

async function drain() {
  await Promise.resolve()
  await Promise.resolve()
}
