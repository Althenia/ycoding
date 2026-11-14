import { afterEach, describe, expect, test } from "bun:test"
import { startCcaDurableClient, type CcaDurableClient, type CcaDurableReply, type CcaDurableSocket } from "../src/remote-control/cca-durable-host"

type Listener = (...args: unknown[]) => void

function fakeSocket(resumeReply: (count: number) => Record<string, unknown>) {
  const listeners = new Map<string, Listener[]>()
  const sent: Record<string, unknown>[] = []
  let resumes = 0
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const socket: CcaDurableSocket = {
    readyState: 1,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as Listener])
    },
    send(data, callback) {
      const message = JSON.parse(data) as Record<string, unknown>
      sent.push(message)
      callback?.()
      if (typeof message.id !== "string") return
      if (message.method === "initialize") {
        queueMicrotask(() => emit("message", JSON.stringify({ id: message.id, result: {} })))
        return
      }
      if (message.method === "thread/resume") {
        resumes += 1
        const reply = resumeReply(resumes)
        queueMicrotask(() => emit("message", JSON.stringify({ id: message.id, ...reply })))
      }
    },
    ping() {},
    close() {},
    terminate() {},
  }
  return {
    socket,
    notify: (method: string, params: unknown) => emit("message", JSON.stringify({ method, params })),
    open: () => emit("open"),
    resumeCount: () => sent.filter((message) => message.method === "thread/resume").length,
  }
}

let client: CcaDurableClient | undefined

async function connectedClient(resumeReply: (count: number) => Record<string, unknown>) {
  const fake = fakeSocket(resumeReply)
  client = startCcaDurableClient({
    credential: async () => ({ access: "synthetic-access", accountID: "synthetic-account" }),
    connect: () => {
      queueMicrotask(fake.open)
      return fake.socket
    },
    wait: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  })
  for (let attempts = 0; attempts < 200 && !client.connected(); attempts++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(client.connected()).toBe(true)
  return { client, fake }
}

const resumed = () => ({ result: { thread: { id: "thread-1" } } })

afterEach(async () => {
  await client?.close()
  client = undefined
})

describe("durable client thread/resume subscription cache", () => {
  test("watch caches a successful resume and force dispatches a fresh resume", async () => {
    const { client, fake } = await connectedClient(resumed)

    const first = await client.watch("thread-1")
    const cached = await client.watch("thread-1")
    expect(first.kind).toBe("result")
    expect(cached.kind).toBe("result")
    expect(fake.resumeCount()).toBe(1)

    const forced = await client.watch("thread-1", { force: true })
    expect(forced.kind).toBe("result")
    expect(fake.resumeCount()).toBe(2)

    await client.watch("thread-1")
    expect(fake.resumeCount()).toBe(2)
  })

  test("a thread/archived notification evicts the cached subscription", async () => {
    const { client, fake } = await connectedClient(resumed)

    await client.watch("thread-1")
    await client.watch("thread-2")
    expect(fake.resumeCount()).toBe(2)

    fake.notify("thread/archived", { threadId: "thread-1" })

    await client.watch("thread-1")
    expect(fake.resumeCount()).toBe(3)
    await client.watch("thread-2")
    expect(fake.resumeCount()).toBe(3)
  })

  test("a failed resume is not cached", async () => {
    const { client, fake } = await connectedClient((count) =>
      count === 1 ? { error: { code: -32000, message: "archived", data: { errorType: "thread_archived" } } } : resumed(),
    )

    const failed: CcaDurableReply = await client.watch("thread-1")
    expect(failed).toEqual({ kind: "error", code: -32000, message: "archived", errorType: "thread_archived" })
    expect(fake.resumeCount()).toBe(1)

    const retried = await client.watch("thread-1")
    expect(retried.kind).toBe("result")
    expect(fake.resumeCount()).toBe(2)
  })
})
