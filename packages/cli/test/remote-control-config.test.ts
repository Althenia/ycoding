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
    attachTransport: () => () => {},
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
    config = { enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1, accessRevision: 1 }
    for (const listener of listeners) listener()
    await flush()
    expect(profiles).toEqual(["Pinned"])
    expect(attached[0]).toMatchObject({ profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1, accessRevision: 1, environmentID: "env" })
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
    config = { enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 3, accessRevision: 3 }
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
  expect(pins[0]).toMatchObject({ profile: "fixture", credentialID: "credential", accountGeneration: 1, accessRevision: 1 })
  await host.stop()
})

test.each(["opening", "attached"] as const)("global Off then On retires the prior %s lifetime even when notifications coalesce", async (stage) => {
  let config: NativeDots.Configuration = { enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1, accessRevision: 1 }
  const listeners = new Set<() => void>()
  const pins: NativeDots.Pins[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const sockets: Array<{ message: (text: string) => void; closed: boolean; sent: string[] }> = []
  const host = createRemoteControlHost({
    native: {
      configuration: async () => config,
      credential: async () => ({ access: "synthetic", key: "key", profile: "Pinned", accountID: "account", accountGeneration: 1, credentialID: "credential" }),
      subscribeConfiguration: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      attachTransport: () => () => {},
      attach: async (input) => { pins.push(input); return { channel: () => { throw Error("Unexpected channel") }, retire: () => {} } },
    },
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      const index = sockets.length
      let close = () => {}
      const socket = { message: (_text: string) => {}, closed: false, sent: [] as string[] }
      sockets.push(socket)
      entered.resolve()
      if (stage === "opening" && index === 0) await release.promise
      return { send: (text) => socket.sent.push(text), close: () => { socket.closed = true; close() }, onClose: (handler) => { close = handler }, onMessage: (handler) => { socket.message = handler }, onError: () => {} }
    },
  })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  try {
    await host.start()
    await entered.promise
    await flush()
    config = { enabled: false }
    for (const listener of listeners) listener()
    expect(pins[0]?.isCurrent() ?? false).toBe(false)
    config = { enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1, accessRevision: 3 }
    for (const listener of listeners) listener()
    await flush()
    release.resolve()
    await flush()
    expect(pins.map((input) => input.accessRevision)).toEqual(stage === "opening" ? [3] : [1, 3])
    expect(pins.at(-1)?.isCurrent()).toBe(true)
    expect(sockets[0].closed).toBe(true)
    sockets[0].message(JSON.stringify({ type: "ping", client_id: "client", stream_id: "stream", seq_id: 1 }))
    expect(sockets[0].sent).toEqual([])
  } finally { release.resolve(); await host.stop() }
})

test.each([
  { phase: "configuration", problem: "configuration" },
  { phase: "authentication", problem: "authentication" },
  { phase: "enrollment", problem: "enrollment" },
  { phase: "enrollment-authentication", problem: "authentication" },
  { phase: "connection", problem: "connection" },
  { phase: "attachment", problem: "configuration" },
] as const)("reports a sanitized failure category without internal details: %j", async (input) => {
  const base = nativeHost({ ...requestBackend, createThread: async () => { throw Error("Unused") }, getThread: async () => undefined,
    listThreads: async () => [], prompt: async () => ({ messageID: "message" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined })
  const host = createRemoteControlHost({
    native: {
      ...base,
      configuration: async () => { if (input.phase === "configuration") throw Error("synthetic-private-configuration"); return base.configuration() },
      credential: async (profile) => input.phase === "authentication" ? undefined : base.credential(profile),
      attach: async (pins) => { if (input.phase === "attachment") throw Error("synthetic-private-attachment"); return base.attach(pins) },
    },
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", hostname: () => "fixture.local",
    fetchFn: async () => input.phase.startsWith("enrollment") ? new Response("synthetic-private-enrollment", { status: input.phase === "enrollment" ? 503 : 401 }) : Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      if (input.phase === "connection") throw Error("synthetic-private-connection")
      return { send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} }
    },
  })
  try {
    await host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await host.status()).toEqual({ state: "error", problem: input.problem, serverName: "fixture.local" })
  } finally { await host.stop() }
})

test.each(["close", "error"] as const)("an established socket %s reports a sanitized connection error", async (event) => {
  const base = nativeHost({ ...requestBackend, createThread: async () => { throw Error("Unused") }, getThread: async () => undefined,
    listThreads: async () => [], prompt: async () => ({ messageID: "message" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined })
  let close = () => {}
  let error = (_error: unknown) => {}
  const host = createRemoteControlHost({
    native: base,
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", hostname: () => "fixture.local",
    fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => ({ send: () => {}, close: () => close(), onMessage: () => {}, onClose: (handler) => { close = handler }, onError: (handler) => { error = handler } }),
  })
  try {
    await host.connectOnce()
    expect((await host.status()).state).toBe("on")
    if (event === "close") close()
    if (event === "error") error(Error("synthetic-private-connection"))
    expect(await host.status()).toEqual({ state: "error", problem: "connection", serverName: "fixture.local" })
  } finally { await host.stop() }
})

test("shutdown during configuration discovery cannot start a new connection", async () => {
  const configuration = Promise.withResolvers<NativeDots.Configuration>()
  const entered = Promise.withResolvers<void>()
  let reads = 0
  const host = createRemoteControlHost({
    native: {
      configuration: () => { entered.resolve(); return configuration.promise },
      credential: async () => { reads++; return undefined },
      subscribeConfiguration: () => () => {}, attachTransport: () => () => {},
      attach: async () => { throw Error("Unexpected attachment") },
    },
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", connect: async () => { throw Error("Unexpected socket") },
  })
  const starting = host.start()
  await entered.promise
  const stopping = host.stop()
  configuration.resolve({ enabled: true, profile: "Pinned", credentialID: "credential", accountID: "account", accountGeneration: 1, accessRevision: 1 })
  await Promise.all([starting, stopping])
  expect(reads).toBe(0)
})

test("an enrollment error still retries and reaches the connected state", async () => {
  const base = nativeHost({ ...requestBackend, createThread: async () => { throw Error("Unused") }, getThread: async () => undefined,
    listThreads: async () => [], prompt: async () => ({ messageID: "message" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined })
  const attached = Promise.withResolvers<void>()
  let requests = 0
  const host = createRemoteControlHost({
    native: { ...base, attach: async (pins) => { const connection = await base.attach(pins); attached.resolve(); return connection } },
    store: { load: async () => ({ installationID: "install", enrollments: {} }), enrollment: async () => undefined, saveEnrollment: async () => ({ installationID: "install", enrollments: {} }), deleteEnrollment: async () => ({ installationID: "install", enrollments: {} }) },
    codexHome: "/synthetic", hostname: () => "fixture.local",
    fetchFn: async () => ++requests === 1 ? new Response("Unavailable", { status: 503, headers: { "retry-after": "0" } }) : Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => ({ send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} }),
  })
  try {
    await host.start()
    await attached.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(requests).toBe(2)
    expect(await host.status()).toMatchObject({ state: "on", serverName: "fixture.local" })
  } finally { await host.stop() }
})
