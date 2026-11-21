import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ClientProvider, useClient } from "../src/context/client"
import { LogProvider } from "../src/context/log"

test("disposing the client context closes its owned native transport", async () => {
  const connected = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  let closeCount = 0
  const api = {
    event: {
      async *subscribe() {
        yield { type: "server.connected", created: 0, data: {} }
        connected.resolve()
        await closed.promise
      },
    },
    transport: {
      close() {
        closeCount++
        closed.resolve()
      },
    },
  }
  function Content() {
    const client = useClient()
    return <text>{client.connection.status()}</text>
  }
  const app = await testRender(() => <LogProvider log={() => {}}><ClientProvider api={api as never}><Content /></ClientProvider></LogProvider>, { width: 60, height: 10 })
  app.renderer.start()
  await connected.promise
  app.renderer.destroy()
  expect(closeCount).toBe(1)
})

test("replacing a disconnected client closes the old transport and retains the new owner until disposal", async () => {
  const disconnected = Promise.withResolvers<void>()
  const firstReady = Promise.withResolvers<void>()
  const secondReady = Promise.withResolvers<void>()
  const secondDone = Promise.withResolvers<void>()
  const calls: string[] = []
  const first = {
    event: { async *subscribe() { yield { type: "server.connected", created: 0, data: {} }; firstReady.resolve(); await disconnected.promise; throw new Error("disconnected") } },
    transport: { close() { calls.push("first") } },
  }
  const second = {
    event: { async *subscribe() { yield { type: "server.connected", created: 0, data: {} }; secondReady.resolve(); await secondDone.promise } },
    transport: { close() { calls.push("second"); secondDone.resolve() } },
  }
  const service = { reconnect: async () => ({ api: second }), restart: async () => {} }
  function Content() {
    const client = useClient()
    return <text>{client.connection.status()}</text>
  }
  const app = await testRender(() => <LogProvider log={() => {}}><ClientProvider api={first as never} service={service as never}><Content /></ClientProvider></LogProvider>, { width: 60, height: 10 })
  app.renderer.start()
  try {
    await firstReady.promise
    disconnected.resolve()
    await secondReady.promise
    expect(calls).toEqual(["first"])
  } finally {
    app.renderer.destroy()
  }
  expect(calls).toEqual(["first", "second"])
})

test("a client resolved after disposal is closed without becoming the owner", async () => {
  const disconnected = Promise.withResolvers<void>()
  const firstReady = Promise.withResolvers<void>()
  const reconnecting = Promise.withResolvers<void>()
  const late = Promise.withResolvers<{ api: { transport: { close: () => void } } }>()
  const lateClosed = Promise.withResolvers<void>()
  const calls: string[] = []
  const first = {
    event: { async *subscribe() { yield { type: "server.connected", created: 0, data: {} }; firstReady.resolve(); await disconnected.promise; throw new Error("disconnected") } },
    transport: { close() { calls.push("first") } },
  }
  const service = { reconnect: () => { reconnecting.resolve(); return late.promise }, restart: async () => {} }
  function Content() {
    const client = useClient()
    return <text>{client.connection.status()}</text>
  }
  const app = await testRender(() => <LogProvider log={() => {}}><ClientProvider api={first as never} service={service as never}><Content /></ClientProvider></LogProvider>, { width: 60, height: 10 })
  app.renderer.start()
  await firstReady.promise
  disconnected.resolve()
  await reconnecting.promise
  app.renderer.destroy()
  late.resolve({ api: { transport: { close() { calls.push("late"); lateClosed.resolve() } } } })
  await lateClosed.promise
  expect(calls).toEqual(["first", "late"])
})
