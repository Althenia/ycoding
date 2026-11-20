import { expect, test } from "bun:test"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { makeMacOSInteraction } from "../src/interaction/macos"
import { bindChromeEnrollment } from "../src/interaction/macos-enrollment"

test.skipIf(process.platform !== "darwin")("macOS attach refuses a fabricated proof before touching the helper", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  const target = { kind: "macos-window", id: Interaction.ID.create(), label: "Synthetic", bundleID: "local.synthetic.Example" } as const
  try {
    const result = await adapter.driver.attach(target, {
      candidateID: Interaction.ID.create(), sessionID: SessionID.make("ses_mac_fixture"), targetID: target.id,
      authorization: crypto.randomUUID(),
    }, new AbortController().signal).catch((error: unknown) => error)
    expect(result).toMatchObject({ code: "notAuthorized" })
  } finally { adapter.close() }
})

test.skipIf(process.platform !== "darwin")("Chrome enrollment cannot request an offer without a signed native menu", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  const origin = "http://127.0.0.1:5314"
  let requests = 0
  const offer = () => { requests++; return undefined }
  const lifetime = new AbortController().signal
  try {
    expect(await adapter.startChromeEnrollmentMenu("https://example.test", offer, lifetime)).toBe(false)
    expect(await adapter.startChromeEnrollmentMenu(origin, offer, AbortSignal.abort())).toBe(false)
    expect(await adapter.startChromeEnrollmentMenu(origin, offer, lifetime)).toBe(false)
  } finally { adapter.close() }
  expect(requests).toBe(0)
})

test.skipIf(process.platform !== "darwin")("isolated Chrome cannot obtain a Stop handle without a current signed presenter", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  const request = { candidateID: Interaction.ID.create(), sessionID: SessionID.make("ses_isolated_fixture"),
    url: "https://example.test/", expiresAt: Date.now() + 30_000 }
  const signal = new AbortController().signal
  try {
    expect(await adapter.confirmIsolated({ ...request, expiresAt: 1 }, signal)).toBeUndefined()
    expect(await adapter.confirmIsolated(request, AbortSignal.abort())).toBeUndefined()
    expect(await adapter.confirmIsolated(request, signal)).toBeUndefined()
  } finally { adapter.close() }
})

test("native enrollment ignores expired intents and revokes only the matching replay", async () => {
  const first = Interaction.ID.create()
  const second = Interaction.ID.create()
  const issued: Interaction.ID[] = []
  const revoked: Interaction.ID[] = []
  const dismissed: Interaction.ID[] = []
  const delivery = bindChromeEnrollment({
    signal: new AbortController().signal,
    offer: (intent) => {
      issued.push(intent.id)
      return { code: "A".repeat(43), expiresAt: Date.now() + 30_000, revoke: () => { revoked.push(intent.id) } }
    },
    send: async (id, offer) => { if (!offer) dismissed.push(id); return Boolean(offer) },
  })
  try {
    expect(issued).toEqual([])
    const expired = Interaction.ID.create()
    await delivery.receive({ state: "chromeEnrollmentIntent", id: expired, expiresAt: Date.now() })
    expect(issued).toEqual([])
    const intent = { state: "chromeEnrollmentIntent" as const, id: first, expiresAt: Date.now() + 5_000 }
    await delivery.receive(intent)
    await delivery.receive({ state: "chromeEnrollmentEnded", id: second })
    expect(revoked).toEqual([])
    await delivery.receive(intent)
    expect(issued).toEqual([first])
    expect(revoked).toEqual([first])

    await delivery.receive({ ...intent, id: second })
    await delivery.receive(intent)
    await delivery.receive({ state: "chromeEnrollmentEnded", id: first })
    expect(issued).toEqual([first, second])
    expect(revoked).toEqual([first])
    expect(dismissed).toEqual([expired, first, first])
  } finally { delivery.disconnect() }
  expect(revoked).toEqual([first, second])
})

test.each(["panel dismissal", "lifetime cancellation", "stdio disconnect", "native denial"] as const)(
  "native enrollment revokes its exact offer once on %s", async (reason) => {
    const lifetime = new AbortController()
    const id = Interaction.ID.create()
    const revoked: Interaction.ID[] = []
    const delivery = bindChromeEnrollment({
      signal: lifetime.signal,
      offer: (intent) => ({ code: "A".repeat(43), expiresAt: Date.now() + 30_000, revoke: () => { revoked.push(intent.id) } }),
      send: async () => reason !== "native denial",
    })
    try {
      await delivery.receive({ state: "chromeEnrollmentIntent", id, expiresAt: Date.now() + 5_000 })
      if (reason === "panel dismissal") await delivery.receive({ state: "chromeEnrollmentEnded", id })
      if (reason === "lifetime cancellation") lifetime.abort()
      if (reason === "stdio disconnect") delivery.disconnect()
      expect(revoked).toEqual([id])
      await delivery.receive({ state: "chromeEnrollmentEnded", id })
    } finally { delivery.disconnect() }
    expect(revoked).toEqual([id])
  },
)

test("native enrollment revokes and dismisses the exact expiring offer", async () => {
  const id = Interaction.ID.create()
  const revoked = Promise.withResolvers<Interaction.ID>()
  const dismissed = Promise.withResolvers<Interaction.ID>()
  const delivery = bindChromeEnrollment({
    signal: new AbortController().signal,
    offer: (intent) => ({ code: "A".repeat(43), expiresAt: Date.now() + 150, revoke: () => revoked.resolve(intent.id) }),
    send: async (target, offer) => { if (!offer) dismissed.resolve(target); return Boolean(offer) },
  })
  try {
    await delivery.receive({ state: "chromeEnrollmentIntent", id, expiresAt: Date.now() + 5_000 })
    expect(await Promise.all([revoked.promise, dismissed.promise])).toEqual([id, id])
  } finally { delivery.disconnect() }
})
