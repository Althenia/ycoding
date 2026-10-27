import { expect, test } from "bun:test"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createRemoteControlHost, type RemoteControlSocket } from "../src/remote-control/host"
import { nativeHost, requestBackend } from "./remote-control-fixture"

test("global native configuration alone starts and retires private connections with exact credential pins", async () => {
  let config: NativeDots.Configuration = { enabled: false }
  const listeners = new Set<() => void>()
  const attached: NativeDots.Pins[] = []
  const retired: string[] = []
  const profiles: string[] = []
  const sockets: Array<{ send: (text: string) => void; sent: unknown[] }> = []
  let credentialGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const native: NativeDots.Host = {
    configuration: async () => config,
    credential: async (profile) => {
      profiles.push(profile)
      await credentialGate?.promise
      if (!config.enabled) return undefined
      return { access: "synthetic", key: "key", profile, accountID: config.accountID, accountGeneration: config.accountGeneration, credentialID: config.credentialID }
    },
    subscribeConfiguration: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    attach: async (pins) => {
      attached.push(pins)
      return { channel: () => { throw Error("No requests") }, retire: () => { retired.push(pins.connectionID) } }
    },
  }
  const host = createRemoteControlHost({
    native, store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      let message = (_text: string) => {}
      let close = () => {}
      const sent: unknown[] = []
      sockets.push({ send: (text) => message(text), sent })
      return { send: (text) => sent.push(JSON.parse(text)), onMessage: (fn) => { message = fn }, onClose: (fn) => { close = fn }, onError: () => {}, close: () => close() } satisfies RemoteControlSocket
    },
  })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  try {
    await host.start()
    expect(sockets).toEqual([])
    config = { enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1 }
    for (const listener of listeners) listener()
    await flush()
    expect(profiles).toEqual(["Pinned"])
    expect(attached[0]).toMatchObject({ profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1, environmentID: "env" })
    expect(attached[0]!.isCurrent()).toBe(true)
    config = { ...config, accountGeneration: 2 }
    for (const listener of listeners) listener()
    await flush()
    expect(attached[0]!.isCurrent()).toBe(false)
    expect(retired).toContain(attached[0]!.connectionID)
    expect(attached[1]!.accountGeneration).toBe(2)
    config = { enabled: false }
    for (const listener of listeners) listener()
    await flush()
    expect((await host.status()).state).toBe("off")
    expect(attached[1]!.isCurrent()).toBe(false)
    credentialGate = Promise.withResolvers<void>()
    config = { enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 3 }
    for (const listener of listeners) listener()
    await flush()
    await host.stop()
    credentialGate.resolve()
    await flush()
    expect(attached).toHaveLength(2)
  } finally { credentialGate?.resolve(); await host.stop() }
  expect(listeners.size).toBe(0)
  expect("set" in host).toBe(false)
})

test.each([false, true])("frames wait for private attachment and shutdown suppresses late attachment: %s", async (shutdown) => {
  const base = nativeHost({ ...requestBackend, createThread: async () => { throw Error("Unused") }, getThread: async () => undefined,
    listThreads: async () => [], prompt: async () => ({ messageID: "message" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const sent: Record<string, unknown>[] = []
  let onMessage = (_text: string) => {}
  let onClose = () => {}
  let retired = 0
  const host = createRemoteControlHost({
    native: { ...base, attach: async (pins) => { entered.resolve(); await release.promise; return { ...await base.attach(pins), retire: () => { retired++ } } } },
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => ({ send: (text) => sent.push(JSON.parse(text)), close: () => onClose(), onMessage: (handler) => { onMessage = handler }, onClose: (handler) => { onClose = handler }, onError: () => {} }),
  })
  const connecting = host.connectOnce()
  await entered.promise
  onMessage(JSON.stringify({ type: "client_message", client_id: "client", stream_id: "stream", env_id: "env", seq_id: 1, message: { id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } } }))
  if (shutdown) await host.stop()
  release.resolve()
  await connecting
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(sent.filter((frame) => frame.type === "server_message")).toHaveLength(shutdown ? 0 : 1)
  await host.stop()
  expect(retired).toBe(1)
})

test("socket authentication refresh stays on the pinned profile and account generation", async () => {
  const profiles: unknown[] = []
  const pins: NativeDots.Pins[] = []
  const base = nativeHost({ ...requestBackend, createThread: async () => { throw Error("Unused") }, getThread: async () => undefined,
    listThreads: async () => [], prompt: async () => ({ messageID: "message" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined })
  let attempts = 0
  let enrollment: Parameters<import("../src/remote-control/state").RemoteControlStateStore["saveEnrollment"]>[0]["enrollment"] | undefined
  const host = createRemoteControlHost({
    native: { ...base, credential: async (profile, rejected) => { profiles.push([profile, rejected]); return { ...await base.credential(profile), access: rejected ? "rotated" : "synthetic" } as NonNullable<Awaited<ReturnType<NativeDots.Host["credential"]>>> }, attach: async (input) => { pins.push(input); return base.attach(input) } },
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => enrollment, saveEnrollment: async (input) => { enrollment = input.enrollment; return { installationID: "install", enrollments: {} } }, deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      if (!attempts++) throw Object.assign(Error("Rejected"), { status: 401 })
      return { send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} }
    },
  })
  await host.connectOnce()
  expect(profiles).toEqual([["fixture", undefined], ["fixture", "synthetic"]])
  expect(pins).toHaveLength(1)
  expect(pins[0]).toMatchObject({ profile: "fixture", credentialID: "credential", accountGeneration: 1 })
  await host.stop()
})
