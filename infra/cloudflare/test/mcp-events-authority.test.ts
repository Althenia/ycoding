import { expect, test } from "bun:test"
import { ReservationBudget } from "../../../packages/protocol/src/v5/connection"
import { createMemoryMcpStore } from "../src/auth/mcp/memory-store"
import type { McpDeviceRow, McpGrantRow, McpStore } from "../src/auth/mcp/store"
import { createMcpAuthority, createMcpRelay } from "../src/relay/mcp"

const principal = { ownerID: "owner", deviceID: "device", clientID: "client" }
const trusted = { ownerID: "owner", deviceID: "device", resource: "https://relay.test/api/mcp/devices/device" }
const grant = {
  grantID: "grant-original",
  epoch: "epoch-1",
  resource: trusted.resource,
  accessExpiresAt: 9_000,
  principal,
}
const response = { status: 200, contentType: "application/json", body: "{}" }

async function seed(store: McpStore, id: string) {
  await store.insertAuthorization({
    id: `tx-${id}`,
    clientID: principal.clientID,
    deviceID: principal.deviceID,
    ownerID: principal.ownerID,
    resource: trusted.resource,
    scope: "ycoding:remote",
    redirectUri: "https://client.test/callback",
    codeChallenge: "challenge",
    stage: "consent",
    csrfHash: "csrf",
    epoch: grant.epoch,
    createdAt: 1,
    expiresAt: 100_000,
  })
  expect(
    await store.allowConsent({
      id: `tx-${id}`,
      csrfHash: "csrf",
      now: 2,
      grant: {
        id,
        ...principal,
        resource: trusted.resource,
        scope: "ycoding:remote",
        epoch: grant.epoch,
        consentedAt: 2,
        expiresAt: 20_000,
      },
      code: {
        hash: `code-${id}`,
        grantID: id,
        redirectUri: "https://client.test/callback",
        codeChallenge: "challenge",
        createdAt: 2,
        expiresAt: 100_000,
      },
    }),
  ).toBe(true)
}

async function world() {
  let now = 1_000
  const store = createMemoryMcpStore()
  await store.setDevice({ deviceID: principal.deviceID, enabled: true, epoch: grant.epoch, now })
  await seed(store, grant.grantID)
  await seed(store, "grant-replacement")
  const state = {
    row: {} as Partial<McpGrantRow>,
    device: {} as Partial<McpDeviceRow>,
    ownerID: principal.ownerID,
    deviceAllowed: true,
    fail: false,
  }
  const blocked = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>(), enabled: false }
  const authority = createMcpAuthority({
    store: {
      ...store,
      getDevice: async (id) => {
        const device = await store.getDevice(id)
        return device === undefined ? undefined : { ...device, ...state.device }
      },
      findGrant: async (id) => {
        if (blocked.enabled) {
          blocked.entered.resolve()
          await blocked.released.promise
        }
        if (state.fail) throw new Error("synthetic-private-store-detail")
        const row = await store.findGrant(id)
        return row === undefined ? undefined : { ...row, ...state.row }
      },
    },
    authorizeDevice: async () =>
      state.deviceAllowed
        ? { ok: true, value: { userID: state.ownerID } }
        : { ok: false, reason: "synthetic-private-device-detail" },
    now: () => now,
  })
  const reservation = new ReservationBudget(32 * 1024 * 1024)
  const relay = createMcpRelay({ ...authority, reservation, now: () => now })
  const dispatched = Promise.withResolvers<void>()
  const cancelled: string[] = []
  relay.setAgent(
    { agentID: "connection-1", ownerID: principal.ownerID, deviceID: principal.deviceID },
    {
      request: () => {
        dispatched.resolve()
        return "17"
      },
      cancel: (id) => {
        cancelled.push(id)
        return "unknown"
      },
      acknowledge: () => {},
    },
  )
  expect(await relay.handleState("connection-1", { id: "state-1", enabled: true, epoch: grant.epoch })).toBe(
    "acknowledged",
  )
  const signal = new AbortController()
  const pending = relay
    .request({ grant, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: {}, signal: signal.signal })
    .then(
      (value) => value,
      (error: unknown) => error,
    )
  await dispatched.promise
  return {
    relay,
    store,
    state,
    blocked,
    cancelled,
    signal,
    pending,
    reservation,
    at: (value: number) => {
      now = value
    },
    close: async () => {
      relay.clearAgent("connection-1")
      relay.clearAgent("connection-2")
      await pending
      expect(reservation.used).toBe(0)
    },
  }
}

const resolve = { action: "resolve" as const, requestID: "17", principal, epoch: grant.epoch }
const check = { action: "check" as const, grantID: grant.grantID, principal, epoch: grant.epoch }

test("Events capabilities and exact pending request resolution preserve the admitted grant", async () => {
  const value = await world()
  try {
    expect(await value.relay.authorizeEvent(trusted, { action: "capabilities" })).toEqual({
      action: "capabilities",
      supported: true,
    })
    expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({
      action: "resolve",
      authorized: true,
      grantID: grant.grantID,
      expiresAt: 20_000,
    })
    expect(await value.relay.authorizeEvent(trusted, check)).toEqual({
      action: "check",
      authorized: true,
      grantID: grant.grantID,
      expiresAt: 20_000,
    })
  } finally {
    await value.close()
  }
})

test("Events resolution never substitutes a replacement grant after revocation", async () => {
  const value = await world()
  try {
    await value.store.revokeGrant(grant.grantID, 1_001)
    expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({
      action: "resolve",
      authorized: false,
      reason: "unauthorized",
    })
    expect(await value.relay.authorizeEvent(trusted, check)).toEqual({
      action: "check",
      authorized: false,
      reason: "unauthorized",
    })
    expect(await value.relay.authorizeEvent(trusted, { ...check, grantID: "grant-replacement" })).toEqual({
      action: "check",
      authorized: true,
      grantID: "grant-replacement",
      expiresAt: 20_000,
    })
  } finally {
    await value.close()
  }
})

test.each(["1", "18"])("Events resolution rejects non-forwarded request identity %s", async (requestID) => {
  const value = await world()
  try {
    expect(await value.relay.authorizeEvent(trusted, { ...resolve, requestID })).toEqual({
      action: "resolve",
      authorized: false,
      reason: "not_found",
    })
  } finally {
    await value.close()
  }
})

test("Events resolution preserves unknown and disabled connection gates", async () => {
  const value = await world()
  try {
    value.relay.setAgent(
      { agentID: "connection-2", ownerID: principal.ownerID, deviceID: principal.deviceID },
      {
        request: () => "17",
        cancel: () => "unknown",
        acknowledge: () => {},
      },
    )
    expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({
      action: "resolve",
      authorized: false,
      reason: "unavailable",
    })
    await value.relay.handleState("connection-2", { id: "state-off", enabled: false, epoch: grant.epoch })
    expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({
      action: "resolve",
      authorized: false,
      reason: "forbidden",
    })
    expect(await value.relay.authorizeEvent(trusted, check)).toEqual({
      action: "check",
      authorized: false,
      reason: "not_found",
    })
  } finally {
    await value.close()
  }
})

test.each([
  ["owner", { ...principal, ownerID: "other" }],
  ["device", { ...principal, deviceID: "other" }],
  ["client", { ...principal, clientID: "other" }],
] as const)("Events resolution rejects a spoofed %s principal", async (_name, forged) => {
  const value = await world()
  try {
    expect(await value.relay.authorizeEvent(trusted, { ...resolve, principal: forged })).toEqual({
      action: "resolve",
      authorized: false,
      reason: "forbidden",
    })
    expect(await value.relay.authorizeEvent(trusted, { ...check, principal: forged })).toEqual({
      action: "check",
      authorized: false,
      reason: "forbidden",
    })
  } finally {
    await value.close()
  }
})

test.each([
  ["resource", { ...trusted, resource: "https://other.test/api/mcp/devices/device" }, grant.epoch],
  ["epoch", trusted, "epoch-other"],
] as const)("Events authorization rejects the wrong %s context", async (_name, context, epoch) => {
  const value = await world()
  try {
    expect(await value.relay.authorizeEvent(context, { ...resolve, epoch })).toEqual({
      action: "resolve",
      authorized: false,
      reason: "unauthorized",
    })
    expect(await value.relay.authorizeEvent(context, { ...check, epoch })).toEqual({
      action: "check",
      authorized: false,
      reason: "unauthorized",
    })
  } finally {
    await value.close()
  }
})

test.each([
  ["owner", { ownerID: "other" }, "forbidden"],
  ["device", { deviceID: "other" }, "forbidden"],
  ["client", { clientID: "other" }, "forbidden"],
  ["resource", { resource: "https://other.test/api/mcp/devices/device" }, "unauthorized"],
  ["scope", { scope: "other" }, "unauthorized"],
  ["epoch", { epoch: "epoch-other" }, "unauthorized"],
  ["expiry", { expiresAt: 1_000 }, "unauthorized"],
  ["revocation", { revokedAt: 999 }, "unauthorized"],
] as const)("Events revalidation freshly checks the stored %s", async (_name, change, reason) => {
  const value = await world()
  try {
    value.state.row = change
    expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({ action: "resolve", authorized: false, reason })
    expect(await value.relay.authorizeEvent(trusted, check)).toEqual({ action: "check", authorized: false, reason })
  } finally {
    await value.close()
  }
})

test.each(["owner", "revoked", "disabled", "epoch", "expired"] as const)(
  "Events checks freshly reject a device/grant becoming %s",
  async (change) => {
    const value = await world()
    try {
      expect(await value.relay.authorizeEvent(trusted, check)).toMatchObject({ authorized: true })
      if (change === "owner") value.state.ownerID = "other"
      if (change === "revoked") value.state.deviceAllowed = false
      if (change === "disabled") value.state.device = { enabled: false }
      if (change === "epoch") value.state.device = { epoch: "epoch-other" }
      if (change === "expired") value.at(20_000)
      expect(await value.relay.authorizeEvent(trusted, check)).toEqual({
        action: "check",
        authorized: false,
        reason: change === "epoch" || change === "expired" ? "unauthorized" : "forbidden",
      })
    } finally {
      await value.close()
    }
  },
)

test.each(["disabled", "epoch"] as const)(
  "Events checks reject a grant retired by persisted device %s",
  async (change) => {
    const value = await world()
    try {
      expect(await value.relay.authorizeEvent(trusted, check)).toMatchObject({ authorized: true })
      await value.store.setDevice({
        deviceID: principal.deviceID,
        enabled: change !== "disabled",
        epoch: change === "epoch" ? "epoch-other" : grant.epoch,
        now: 1_001,
      })
      expect(await value.store.findGrant(grant.grantID)).toBeUndefined()
      expect(await value.relay.authorizeEvent(trusted, check)).toEqual({
        action: "check",
        authorized: false,
        reason: "not_found",
      })
    } finally {
      await value.close()
    }
  },
)

test.each(["settled", "cancelled", "replaced"] as const)(
  "Events resolution rejects a %s request identity",
  async (transition) => {
    const value = await world()
    try {
      if (transition === "settled") value.relay.complete("connection-1", "17", { type: "response", response })
      if (transition === "cancelled") value.signal.abort()
      if (transition === "replaced") {
        value.relay.setAgent(
          { agentID: "connection-2", ownerID: principal.ownerID, deviceID: principal.deviceID },
          {
            request: () => "17",
            cancel: () => "unknown",
            acknowledge: () => {},
          },
        )
        await value.relay.handleState("connection-2", { id: "state-2", enabled: true, epoch: grant.epoch })
      }
      expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({
        action: "resolve",
        authorized: false,
        reason: "not_found",
      })
    } finally {
      await value.close()
    }
  },
)

test.each(["settled", "cancelled", "replaced"] as const)(
  "Events resolution cannot succeed across awaited %s",
  async (transition) => {
    const value = await world()
    try {
      value.blocked.enabled = true
      const authorizing = value.relay.authorizeEvent(trusted, resolve)
      await value.blocked.entered.promise
      if (transition === "settled") value.relay.complete("connection-1", "17", { type: "response", response })
      if (transition === "cancelled") value.signal.abort()
      if (transition === "replaced")
        value.relay.setAgent(
          { agentID: "connection-2", ownerID: principal.ownerID, deviceID: principal.deviceID },
          {
            request: () => "17",
            cancel: () => "unknown",
            acknowledge: () => {},
          },
        )
      value.blocked.released.resolve()
      expect(await authorizing).toMatchObject({ action: "resolve", authorized: false })
    } finally {
      value.blocked.released.resolve()
      await value.close()
    }
  },
)

test("Events authorization failures expose only a bounded unavailable reason", async () => {
  const value = await world()
  try {
    value.state.fail = true
    expect(await value.relay.authorizeEvent(trusted, resolve)).toEqual({
      action: "resolve",
      authorized: false,
      reason: "unavailable",
    })
    expect(await value.relay.authorizeEvent(trusted, check)).toEqual({
      action: "check",
      authorized: false,
      reason: "unavailable",
    })
  } finally {
    await value.close()
  }
})
