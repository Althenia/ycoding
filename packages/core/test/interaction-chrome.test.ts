import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { PassThrough } from "node:stream"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { chromeConnectPath, chromeExtensionID, makeChromeTransport } from "../src/interaction/chrome"
import { captureIsolatedPreview, makeChromeIsolatedDriver } from "../src/interaction/chrome-isolated"
import { connectChromePipe } from "../src/interaction/chrome-isolated-pipe"
import type { InteractionDriver, InventoryRequest } from "../src/interaction/driver"
import type { IsolatedStop } from "../src/interaction/macos"

const origin = "http://127.0.0.1:40007"
const peerInfo = { url: `${origin}${chromeConnectPath}`, origin: `chrome-extension://${chromeExtensionID}`, peerAddress: "127.0.0.1" }

function nativeStop(candidateID: Interaction.ID, properties: Partial<IsolatedStop> = {}): IsolatedStop {
  return { candidateID, signal: new AbortController().signal, bind: async () => true, close: () => {}, ...properties }
}

test("Chrome enrollment checks loopback and manifest identity and does not replace a peer on bad or reused codes", async () => {
  const manifest = await Bun.file(new URL("../../../extensions/interaction-chrome/manifest.json", import.meta.url)).json()
  const expected = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/./g, (value) => String.fromCharCode(97 + Number.parseInt(value, 16)))
  expect(chromeExtensionID).toBe(expected)
  let registrations = 0
  let disconnects = 0
  const transport = makeChromeTransport({ origin, register: () => {
    registrations++
    return { pending: () => [], onPending: () => () => {}, inventory: async () => [], approve: async () => false, reject: () => false,
      stop: () => false, disconnect: () => { disconnects++ } }
  } })
  try {
    expect(transport.admit({ ...peerInfo, url: `${peerInfo.url}?not-allowed` })).toBe(false)
    expect(transport.admit({ ...peerInfo, origin: "https://localhost" })).toBe(false)
    expect(transport.admit({ ...peerInfo, peerAddress: "10.0.0.1" })).toBe(false)
    const sent: unknown[] = []
    const socket = () => transport.connect({ ...peerInfo, send: (text) => { sent.push(JSON.parse(text)); return true }, close: () => {} })
    const first = transport.enroll()
    const frame = { type: "authenticate", version: 1, extensionID: chromeExtensionID, code: first.code }
    await socket().receive(JSON.stringify(frame))
    expect(sent).toEqual([{ type: "authenticated", version: 1 }])
    await socket().receive(JSON.stringify(frame))
    const second = transport.enroll()
    await socket().receive(JSON.stringify({ ...frame, code: "x".repeat(43) }))
    expect({ registrations, disconnects }).toEqual({ registrations: 1, disconnects: 0 })
    await socket().receive(JSON.stringify({ ...frame, code: second.code }))
    expect({ registrations, disconnects }).toEqual({ registrations: 2, disconnects: 1 })
  } finally { transport.close() }
})

test("Chrome enrollment revoke clears only its unconsumed generation and leaves authenticated peers alone", async () => {
  let registrations = 0
  let disconnects = 0
  const transport = makeChromeTransport({ origin, register: () => {
    registrations++
    return { pending: () => [], onPending: () => () => {}, inventory: async () => [], approve: async () => false, reject: () => false,
      stop: () => false, disconnect: () => { disconnects++ } }
  } })
  async function authenticate(code: string) {
    const messages: unknown[] = []
    const peer = transport.connect({ ...peerInfo, send: (text) => { messages.push(JSON.parse(text)); return true }, close: () => {} })
    await peer.receive(JSON.stringify({ type: "authenticate", version: 1, extensionID: chromeExtensionID, code }))
    return messages
  }
  try {
    const cancelled = transport.enroll()
    cancelled.revoke()
    cancelled.revoke()
    expect(await authenticate(cancelled.code)).toEqual([])
    expect(registrations).toBe(0)

    const replaced = transport.enroll()
    const current = transport.enroll()
    replaced.revoke()
    expect(await authenticate(replaced.code)).toEqual([])
    expect(await authenticate(current.code)).toEqual([{ type: "authenticated", version: 1 }])

    const next = transport.enroll()
    current.revoke()
    current.revoke()
    expect(await authenticate(current.code)).toEqual([])
    expect({ registrations, disconnects }).toEqual({ registrations: 1, disconnects: 0 })
    expect(await authenticate(next.code)).toEqual([{ type: "authenticated", version: 1 }])
    expect({ registrations, disconnects }).toEqual({ registrations: 2, disconnects: 1 })
  } finally { transport.close() }
})

test("only the bound Chrome peer receives the challenge and only its matching approval reaches native authority", async () => {
  const candidate: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome" } }
  const target = { kind: "chrome-tab", id: Interaction.ID.create(), label: "Test tab", origin: "https://example.test", pathname: "/form" }
  const approved: unknown[] = []
  const sent: Record<string, unknown>[] = []
  const inventoried = Promise.withResolvers<void>()
  let driver: InteractionDriver | undefined
  const transport = makeChromeTransport({ origin, register: (registered) => {
    driver = registered
    return { pending: () => [candidate], onPending: () => () => {}, inventory: async () => {
      const targets = await registered.inventory(candidate)
      inventoried.resolve()
      return targets
    },
      approve: async (proof) => { approved.push(proof); return true }, reject: () => false, stop: () => false, disconnect: () => {} }
  } })
  try {
    const peer = transport.connect({ ...peerInfo, send: (text) => { sent.push(JSON.parse(text)); return true }, close: () => {} })
    const auth = { type: "authenticate", version: 1, extensionID: chromeExtensionID, code: transport.enroll().code }
    await peer.receive(JSON.stringify(auth))
    expect(driver?.platform).toBe("chrome")
    expect(sent[1]).toEqual({ type: "pending", input: candidate })
    expect(sent[2]).toMatchObject({ type: "request", op: "inventory", input: candidate })
    await peer.receive(JSON.stringify({ type: "result", id: sent[2]?.id, result: [target] }))
    await inventoried.promise
    const proof = { candidateID: candidate.candidateID, sessionID: candidate.sessionID, targetID: target.id, authorization: "local-proof" }
    await peer.receive(JSON.stringify({ type: "approved", proof: { ...proof, sessionID: SessionID.create() } }))
    expect(approved).toEqual([])
    await peer.receive(JSON.stringify({ type: "approved", proof }))
    await peer.receive(JSON.stringify({ type: "approved", proof }))
    expect(approved).toEqual([proof])

    if (!driver) throw new Error("Chrome driver did not register")
    const signal = new AbortController().signal
    const reply = (result: unknown) => peer.receive(JSON.stringify({ type: "result", id: sent.at(-1)?.id, result }))
    const leaseID = Interaction.ID.create()
    const leasePromise = driver.attach({ ...target, kind: "chrome-tab" }, proof, signal)
    await reply({ sessionID: proof.sessionID, targetID: proof.targetID, pathname: target.pathname, leaseID, epoch: 1, revision: 1 })
    const lease = await leasePromise
    const wrongPath = driver.observe(lease, signal).catch((error: unknown) => error)
    await reply({ revision: 2, pathname: "/redirected", elements: [] })
    expect(await wrongPath).toMatchObject({ code: "stale" })
    const accepted = driver.observe(lease, signal)
    const observation = { revision: 2, pathname: target.pathname, elements: [] }
    await reply(observation)
    expect(await accepted).toEqual(observation)

    const navigating = driver.perform(lease, 2, { callID: Interaction.ID.create(),
      action: { platform: "chrome", type: "navigate", url: "https://example.test/form" } }, signal)
    await reply({ outcome: "applied" })
    expect(await navigating).toEqual({ outcome: "applied" })
    const frameCount = sent.length
    const stale = driver.perform(lease, 2, { callID: Interaction.ID.create(), action: { platform: "chrome", type: "scroll", deltaY: 1 } }, signal)
    if (sent.length !== frameCount) await reply({ outcome: "applied" })
    expect(await stale).toEqual({ outcome: "refused", reason: "stale" })
    expect(sent).toHaveLength(frameCount)
  } finally { transport.close() }
})

test("isolated Chrome binds the exact private start URL and rejects forged, expired, and cross-Session proof before launch", async () => {
  let closes = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID, {
    close: () => { closes++ },
  }) })
  const driver = isolated.driver
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/private?q=synthetic" } }
  const [target] = await driver.inventory(request)
  expect(target).toMatchObject({ kind: "chrome-isolated", origin: "https://example.test", pathname: "/private", url: "https://example.test/private?q=synthetic" })
  if (target.kind !== "chrome-isolated") throw new Error("Missing isolated target")
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const signal = new AbortController().signal
  expect(await isolated.approve({ ...identity, sessionID: SessionID.create() }, signal)).toBeUndefined()
  const proof = await isolated.approve(identity, signal)
  if (!proof) throw new Error("Missing local approval")
  expect(await isolated.approve(identity, signal)).toBeUndefined()
  expect(await driver.attach(target, { ...proof, authorization: "forged" }, signal).catch((error: unknown) => error))
    .toMatchObject({ message: "Isolated Chrome consent unavailable" })
  expect(closes).toBe(0)
  expect(await driver.attach({ ...target, pathname: "/admin" }, proof, signal).catch((error: unknown) => error))
    .toMatchObject({ message: "Isolated Chrome consent unavailable" })
  expect(closes).toBe(1)
  expect(await driver.attach(target, proof, signal).catch((error: unknown) => error)).toMatchObject({ message: "Isolated Chrome consent unavailable" })
  expect(await driver.inventory({ ...request, candidateID: Interaction.ID.create(), expiresAt: Date.now() - 1 })).toEqual([])
})

test("isolated Chrome cannot mint a proof when the native confirmation denies the exact launch", async () => {
  const confirmed: unknown[] = []
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async (request) => {
    confirmed.push(request)
    return undefined
  } })
  const url = "https://example.test/private?scope=one#details"
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url } }
  const [target] = await isolated.driver.inventory(request)
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const signal = new AbortController().signal
  expect(await isolated.approve(identity, signal)).toBeUndefined()
  expect(await isolated.approve(identity, signal)).toBeUndefined()
  expect(confirmed).toEqual([{ candidateID: request.candidateID, sessionID: request.sessionID, expiresAt: request.expiresAt, url }])
})

test("isolation discards an approval after cancellation and never substitutes the launch prompt for action consent", async () => {
  const controller = new AbortController()
  const decision = Promise.withResolvers<IsolatedStop>()
  const closed = Promise.withResolvers<void>()
  let confirmations = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async () => {
    confirmations++
    return decision.promise
  } })
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
  const [target] = await isolated.driver.inventory(request)
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const approval = isolated.approve(identity, controller.signal)
  expect(await isolated.approve(identity, new AbortController().signal)).toBeUndefined()
  expect(confirmations).toBe(1)
  controller.abort()
  expect(await approval).toBeUndefined()
  decision.resolve(nativeStop(request.candidateID, { close: () => closed.resolve() }))
  await closed.promise
  expect(await isolated.driver.inventory(request)).toEqual([])
  expect(await isolated.driver.inventory({ candidateID: Interaction.ID.create(), sessionID: request.sessionID, targetID: target.id,
    expiresAt: request.expiresAt, purpose: "confirm", revision: 1,
    action: { platform: "chrome", type: "click", elementID: Interaction.ID.create(), destructive: true } })).toEqual([])
  expect(confirmations).toBe(1)
})

test("isolated Chrome refuses a destructive action before dispatch even with its valid launch proof", async () => {
  const elementID = Interaction.ID.create()
  const url = "https://example.test/one"
  const dispatched: Interaction.ChromeAction[] = []
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID) },
    async (destination) => ({
      alive: () => true,
      observe: async () => ({ pathname: new URL(destination).pathname, elements: [{ id: elementID, role: "button", label: "Open", editable: false }] }),
      perform: async (action, _signal, dispatch) => {
        dispatch()
        dispatched.push(action)
        return { outcome: "applied" }
      },
      preview: async () => undefined,
      close: async () => {},
    }))
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url } }
  const [target] = await isolated.driver.inventory(request)
  const signal = new AbortController().signal
  const launchProof = await isolated.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }, signal)
  if (!launchProof) throw new Error("Missing signed native approval")
  const lease = await isolated.driver.attach(target, launchProof, signal)
  try {
    const observed = await isolated.driver.observe(lease, signal)
    const action = { platform: "chrome", type: "click", elementID } as const
    const destructive = { ...action, destructive: true } as const
    expect(await isolated.driver.inventory({ candidateID: Interaction.ID.create(), sessionID: request.sessionID, targetID: target.id,
      expiresAt: request.expiresAt, purpose: "confirm", revision: observed.revision, action: destructive })).toEqual([])
    expect(await isolated.driver.perform(lease, observed.revision, { callID: Interaction.ID.create(), action: destructive, consent: launchProof }, signal))
      .toEqual({ outcome: "refused", reason: "unsupported" })
    expect(dispatched).toEqual([])
    expect(await isolated.driver.perform(lease, observed.revision, { callID: Interaction.ID.create(), action }, signal)).toEqual({ outcome: "applied" })
    expect(dispatched).toEqual([action])
  } finally {
    await isolated.driver.detach(lease, "stopped")
  }
})

test("isolated Chrome closes a mismatched or already stopped handle without binding a lease", async () => {
  let closes = 0
  for (const stale of [false, true]) {
    const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(
      stale ? candidateID : Interaction.ID.create(), { signal: stale ? AbortSignal.abort() : new AbortController().signal,
        close: () => { closes++ } },
    ) })
    const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
      purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
    const [target] = await isolated.driver.inventory(request)
    const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
    expect(await isolated.approve(identity, new AbortController().signal)).toBeUndefined()
    expect(await isolated.driver.inventory(request)).toEqual([])
  }
  expect(closes).toBe(2)
})

test("isolation binds the exact new lease to the signed Stop handle before launch and closes a failed bind", async () => {
  const seen: string[] = []
  const stop = new AbortController()
  let closes = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async (request) => ({
    candidateID: request.candidateID,
    signal: stop.signal,
    bind: async (id: Interaction.ID) => { seen.push(id); return false },
    close: () => { closes++ },
  }) })
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
  const [target] = await isolated.driver.inventory(request)
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const signal = new AbortController().signal
  const approved = await isolated.approve(identity, signal)
  expect(approved).toMatchObject(identity)
  if (!approved) throw new Error("Missing signed native approval")
  expect(await isolated.driver.attach(target, approved, signal).catch((error: unknown) => error))
    .toMatchObject({ message: "Isolated Chrome Stop binding unavailable" })
  expect(seen).toHaveLength(1)
  expect(seen[0]).not.toBe(identity.targetID)
  expect(closes).toBe(1)
})

test("signed Stop aborts an in-flight lease bind and closes once before Chrome can launch", async () => {
  const stop = new AbortController()
  const binding = Promise.withResolvers<boolean>()
  const dispatch = Promise.withResolvers<AbortSignal>()
  let closes = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID, {
    signal: stop.signal,
    bind: (_, signal) => { dispatch.resolve(signal); return binding.promise },
    close: () => { closes++ },
  }) })
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
  const [target] = await isolated.driver.inventory(request)
  const signal = new AbortController().signal
  const approved = await isolated.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }, signal)
  if (!approved) throw new Error("Missing signed native approval")
  const attaching = isolated.driver.attach(target, approved, signal).catch((error: unknown) => error)
  const attachingSignal = await dispatch.promise
  stop.abort("stopped")
  expect(attachingSignal.aborted).toBe(true)
  expect(await attaching).toMatchObject({ message: "Chrome operation interrupted" })
  binding.resolve(true)
  expect(await isolated.driver.inventory(request)).toEqual([])
  expect(closes).toBe(1)
})

test("isolated preview only returns a frame from an unchanged, inspected CDP target", async () => {
  const data = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, ...Array<number>(9).fill(0), 255, 217]).toString("base64")
  const tree = { nodeName: "#document", nodeType: 9, childNodeCount: 1, children: [{ nodeName: "HTML", nodeType: 1, childNodeCount: 0 }] }
  for (const state of ["steady", "permission-before", "frame-during", "uninspected-after"]) {
    const checks: string[] = []
    let valid = true
    let captured = false
    const frame = await captureIsolatedPreview({
      current: () => valid,
      verify: async () => { checks.push("scope") },
      inspect: async (input) => {
        checks.push(input.keep ? "protect" : input.ticket ? "settle" : "inspect")
        if (input.ticket) expect(input.ticket).toBe("private-document")
        return { safe: true, ticket: "private-document" }
      },
      page: async (method) => {
        checks.push(method)
        if (method === "DOM.getDocument") return { root: captured && state === "uninspected-after" ? { ...tree, children: undefined } : tree }
        if (method === "Page.getLayoutMetrics") {
          if (state === "permission-before") valid = false
          return { cssVisualViewport: { clientWidth: 1, clientHeight: 1, pageX: 0, pageY: 0 } }
        }
        expect(method).toBe("Page.captureScreenshot")
        captured = true
        if (state === "frame-during") valid = false
        return { data }
      },
    })
    if (state === "steady") {
      expect(frame).toEqual({ mimeType: "image/jpeg", base64: data, width: 1, height: 1 })
      expect(checks).toEqual(["scope", "inspect", "DOM.getDocument", "Page.getLayoutMetrics", "scope", "protect", "Page.captureScreenshot",
        "scope", "DOM.getDocument", "settle"])
    } else {
      expect(frame).toBeUndefined()
      expect(captured).toBe(state !== "permission-before")
      expect(checks).not.toContain("settle")
    }
  }
})

test("private Chrome pipe correlates fragmented replies and rejects pending work on transport loss without replay", async () => {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const frames: string[] = []
  outbound.on("data", (data: Buffer) => frames.push(data.toString()))
  const pipe = connectChromePipe(inbound, outbound)
  const signal = new AbortController().signal
  const first = pipe.command("Browser.getVersion", {}, signal)
  inbound.write(Buffer.from('{"id":1,"res'))
  inbound.write(Buffer.from('ult":{"product":"fixture"}}\0'))
  expect(await first).toEqual({ product: "fixture" })
  const second = pipe.command("Browser.getVersion", {}, signal)
  pipe.close()
  expect(await second.catch((error: unknown) => error)).toMatchObject({ message: "Chrome pipe closed" })
  inbound.write(Buffer.from('{"id":2,"result":{}}\0'))
  expect(await pipe.command("Browser.getVersion", {}, signal).catch((error: unknown) => error)).toMatchObject({ message: "Chrome pipe unavailable" })
  expect(frames).toHaveLength(2)
  expect(frames.every((frame) => frame.endsWith("\0"))).toBe(true)
})
