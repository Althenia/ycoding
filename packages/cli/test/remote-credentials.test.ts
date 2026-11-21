import { describe, expect, spyOn, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { FrontendPaths } from "../src/paths"
import { deviceSignaturePayload, parsePublicKey } from "@ycoding-ai/remote"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  create,
  credentials,
  DeviceAuthorizationError,
  enroll,
  generateDeviceKey,
  read,
  signChallenge,
  update,
  Identity,
} from "../src/remote-credentials"
import { RemoteSetupError } from "../src/remote-error"
import { makeRemoteConnector } from "../src/commands/handlers/remote/connect"
import { createRemoteConnector } from "../src/commands/handlers/remote/connector"
import { createRemoteHost } from "../src/remote-host"
import { createAuthService } from "../../../infra/cloudflare/src/auth/service"
import { createMemoryAuthStore } from "../../../infra/cloudflare/test/support/memory-store"

const enrollmentIdentity = {
  deviceID: "dev_1",
  name: "workstation",
  relayURL: "https://relay.example",
  enrolledAt: 1_700_000_000_000,
}

async function withHome<A>(run: (root: string) => Promise<A>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-remote-credentials-"))
  try {
    return await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function provide(root: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          FrontendPaths.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") }),
        ),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<A, E, never>,
    )
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

async function enrolledRelay(root: string, condition: "rotated" | "unknown-credential" | "revoked-device" | "unknown-device") {
  const now = 1_700_000_000_000
  const keys = await generateDeviceKey()
  const service = createAuthService(createMemoryAuthStore(), { now: () => now })
  const enrollment = await service.createEnrollment("usr_synthetic")
  const completed = await service.completeEnrollment({ ...enrollment, name: "synthetic", publicKey: keys.publicKey })
  if (!completed.ok) throw new Error("Synthetic enrollment failed")
  const issued = await service.issueCredentials(completed.value.deviceID)
  if (!issued.ok) throw new Error("Synthetic credential issuance failed")
  const identity = Identity.make({
    ...enrollmentIdentity, ...keys, deviceID: completed.value.deviceID,
    refreshToken: condition === "unknown-credential" ? "unknown-synthetic-credential" : issued.value.refreshToken,
    refreshExpiresAt: issued.value.refreshExpiresAt,
  })
  await provide(root)(create(identity))
  if (condition === "rotated") expect((await service.refreshCredentials({ deviceID: identity.deviceID, refreshToken: issued.value.refreshToken })).ok).toBe(true)
  if (condition === "revoked-device" || condition === "unknown-device") {
    await service.revokeDevice({ deviceID: identity.deviceID, userID: "usr_synthetic" })
    if (condition === "unknown-device") await service.deleteRevokedDevices("usr_synthetic", identity.deviceID)
  }
  const calls: Array<{ operation: string; status: number }> = []
  const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const operation = new URL(String(input)).pathname.split("/").at(-1)!
    const body = JSON.parse(String(init?.body)) as { deviceID: string; refreshToken: string; challengeID: string; signature: string }
    const outcome = operation === "refresh" ? await service.refreshCredentials(body)
      : operation === "challenge" ? await service.createChallenge(body.deviceID)
      : operation === "token" ? await service.redeemChallenge(body)
      : undefined
    if (outcome === undefined) throw new Error("Unexpected device operation")
    const response = outcome.ok ? json(outcome.value) : new Response(null, { status: 401 })
    calls.push({ operation, status: response.status })
    return response
  }, { preconnect: fetch.preconnect })
  return { identity, fetcher, calls, now, service }
}

test.each(["rotated", "unknown-credential"] as const)("refresh401 recovers an active enrolled device with %s credentials through the auth service HTTP contract", async (condition) => {
  await withHome(async (root) => {
    const relay = await enrolledRelay(root, condition)
    const before = await fs.stat(path.join(root, "state", "remote-device.json"))
    const result = await provide(root)(credentials(relay.identity, { fetcher: relay.fetcher, now: () => relay.now }))
    expect(relay.calls).toEqual([{ operation: "refresh", status: 401 }, { operation: "challenge", status: 200 }, { operation: "token", status: 200 }])
    expect((await relay.service.authorizeAgentToken(result.accessToken)).ok).toBe(true)
    const stored = await provide(root)(read())
    expect(stored).toMatchObject({ ...relay.identity, refreshToken: expect.any(String), refreshExpiresAt: expect.any(Number) })
    expect(stored?.refreshToken).not.toBe(relay.identity.refreshToken)
    const after = await fs.stat(path.join(root, "state", "remote-device.json"))
    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.join(root, "state"))).toEqual(["remote-device.json"])
  })
})

test.each(["revoked-device", "unknown-device"] as const)("refresh401 fails closed for %s without host retries or changing identity", async (condition) => {
  await withHome(async (root) => {
    const relay = await enrolledRelay(root, condition)
    const before = await fs.readFile(path.join(root, "state", "remote-device.json"), "utf8")
    let failure: unknown
    let retries = 0
    const failed = Promise.withResolvers<void>()
    const host = await createRemoteHost({
      file: path.join(root, "remote.json"), scheduleRetry: () => { retries++; return () => {} },
      create: async () => {
        const connector = createRemoteConnector({ directory: root, notice: "Synthetic owner access", makeBridge: () => ({
          connect: async () => {
            try { await provide(root)(credentials(relay.identity, { fetcher: relay.fetcher, now: () => relay.now })) }
            catch (error) { failure = error; throw error }
          }, close: async () => {},
        }) })
        connector.subscribe((status) => { if (status.state === "error") failed.resolve() })
        return connector
      },
    })
    try {
      await host.set(true)
      await failed.promise
      expect(failure).toBeInstanceOf(DeviceAuthorizationError)
      expect(failure).toMatchObject({ status: 401, operation: "challenge" })
      expect(await host.status()).toMatchObject({ state: "error" })
      expect(retries).toBe(0)
      expect(relay.calls).toEqual([{ operation: "refresh", status: 401 }, { operation: "challenge", status: 401 }])
      expect(await fs.readFile(path.join(root, "state", "remote-device.json"), "utf8")).toBe(before)
    } finally { await host.shutdown() }
  })
})

test.each([
  ["refresh", 403], ["refresh", 410],
  ["challenge", 401], ["challenge", 403], ["challenge", 410],
  ["token", 401], ["token", 403], ["token", 410],
] as const)("credential rejection at %s with %s is terminal and preserves identity", async (operation, status) => {
  await withHome(async (root) => {
    const identity = Identity.make({ ...enrollmentIdentity, ...await generateDeviceKey(), refreshToken: "refresh_old", refreshExpiresAt: 9_000 })
    await provide(root)(create(identity))
    const calls: string[] = []
    const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
      const stage = new URL(String(input)).pathname.split("/").at(-1)!
      calls.push(stage)
      if (stage === operation) return new Response("synthetic-secret-body", { status })
      if (stage === "refresh") return new Response(null, { status: 401 })
      return json({ challengeID: "chal_1", nonce: "nonce_1" })
    }, { preconnect: fetch.preconnect })
    const failure = await provide(root)(credentials(identity, { fetcher, now: () => 1_000 })).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeviceAuthorizationError)
    expect(failure).toMatchObject({ status, operation })
    expect(String(failure)).not.toContain("synthetic-secret-body")
    expect(calls).toEqual(operation === "refresh" ? ["refresh"] : operation === "challenge" ? ["refresh", "challenge"] : ["refresh", "challenge", "token"])
    expect(await provide(root)(read())).toEqual(identity)
  })
})

test.each(["disable", "deadline"] as const)("%s cancellation fences every recovery boundary", async (boundary) => {
  await withHome(async (root) => {
    const identity = Identity.make({ ...enrollmentIdentity, ...await generateDeviceKey(), refreshToken: "refresh_old", refreshExpiresAt: 9_000 })
    await provide(root)(create(identity))
    for (const cancelAt of ["before", "refresh", "challenge", "token"] as const) {
      const controller = new AbortController()
      const deadline = new AbortController()
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal)
      const calls: string[] = []
      const cancel = () => (boundary === "disable" ? controller : deadline).abort()
      const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
        const operation = new URL(String(input)).pathname.split("/").at(-1)!
        calls.push(operation)
        if (operation === cancelAt) cancel()
        if (operation === "refresh") return new Response(null, { status: 401 })
        if (operation === "challenge") return json({ challengeID: "chal_1", nonce: "nonce_1" })
        return json({ accessToken: "access_new", accessExpiresAt: 5_000, refreshToken: "refresh_new", refreshExpiresAt: 20_000 })
      }, { preconnect: fetch.preconnect })
      try {
        if (cancelAt === "before") cancel()
        const failure = await provide(root)(credentials(identity, { fetcher, now: () => 1_000, signal: controller.signal })).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(calls).toEqual(cancelAt === "before" ? [] : cancelAt === "refresh" ? ["refresh"] : cancelAt === "challenge" ? ["refresh", "challenge"] : ["refresh", "challenge", "token"])
        expect(await provide(root)(read())).toEqual(identity)
      } finally { timeout.mockRestore() }
    }
  })
})

describe("device key material", () => {
  test("generates a P-256 public key the shared contract accepts and signs the exact challenge payload", async () => {
    const { privateKey, publicKey } = await generateDeviceKey()
    expect(parsePublicKey(publicKey)).toEqual({ ok: true, value: publicKey })

    const sig = await signChallenge(privateKey, "chal_1", "nonce_1")
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(sig, "base64url")).toHaveLength(64)

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(deviceSignaturePayload("chal_1", "nonce_1")),
    )
    expect(verified).toBe(true)
    const otherPayload = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(deviceSignaturePayload("chal_2", "nonce_1")),
    )
    expect(otherPayload).toBe(false)
  })
})

describe("device identity persistence", () => {
  test("stores the private key outside the repository with private permissions and never overwrites silently", async () => {
    await withHome(async (root) => {
      const { privateKey, publicKey } = await generateDeviceKey()
      const identity = { ...enrollmentIdentity, publicKey, privateKey }
      await provide(root)(create(identity))

      const file = path.join(root, "state", "remote-device.json")
      const stored = await fs.readFile(file, "utf8")
      expect(stored).not.toContain(root)
      const stat = await fs.stat(file)
      expect(stat.mode & 0o777).toBe(0o600)
      expect(await fs.readdir(path.dirname(file))).toEqual(["remote-device.json"])
      expect(await provide(root)(read())).toMatchObject({ deviceID: "dev_1", name: "workstation", publicKey, privateKey })

      await expect(provide(root)(create(identity))).rejects.toThrow(/already enrolled/)
    })
  })

  test("refuses to read or write through a symlinked credentials path", async () => {
    await withHome(async (root) => {
      const state = path.join(root, "state")
      await fs.mkdir(state, { recursive: true })
      const target = path.join(root, "outside.json")
      await fs.writeFile(target, JSON.stringify(enrollmentIdentity))
      await fs.symlink(target, path.join(state, "remote-device.json"))

      expect(await provide(root)(read()).catch((error: unknown) => error)).toBeInstanceOf(RemoteSetupError)
      await expect(provide(root)(read())).rejects.toThrow(/symbolic link/)
      const { privateKey, publicKey } = await generateDeviceKey()
      await expect(provide(root)(update({ ...enrollmentIdentity, publicKey, privateKey }))).rejects.toThrow(/symbolic link/)
      expect(await fs.readFile(target, "utf8")).toBe(JSON.stringify(enrollmentIdentity))
    })
  })

  test("persists atomic replacements without leaving temporary files", async () => {
    await withHome(async (root) => {
      const { privateKey, publicKey } = await generateDeviceKey()
      const identity = { ...enrollmentIdentity, publicKey, privateKey }
      await provide(root)(create(identity))
      await provide(root)(update({ ...identity, refreshToken: "refresh_1", refreshExpiresAt: 10 }))
      expect(await provide(root)(read())).toMatchObject({ refreshToken: "refresh_1", refreshExpiresAt: 10 })
      expect(await fs.readdir(path.join(root, "state"))).toEqual(["remote-device.json"])
    })
  })

  test("temporary credential filesystem failures remain recoverable instead of becoming missing enrollment", async () => {
    await withHome(async (root) => {
      const failure = Object.assign(new Error("temporary filesystem failure"), { code: "EMFILE" })
      const stat = spyOn(fs, "lstat").mockImplementation(async () => { throw failure })
      try {
        expect(await provide(root)(read()).catch((error: unknown) => error)).toBe(failure)
      } finally {
        stat.mockRestore()
      }
    })
  })

  test("connector setup classifies missing and malformed identity as terminal without contacting a relay", async () => {
    await withHome(async (root) => {
      expect(await provide(root)(makeRemoteConnector({ endpoint: { url: "http://127.0.0.1:1" } })).catch((error: unknown) => error))
        .toBeInstanceOf(RemoteSetupError)
      await fs.mkdir(path.join(root, "state"), { recursive: true })
      await fs.writeFile(path.join(root, "state", "remote-device.json"), "{not-json")
      expect(await provide(root)(makeRemoteConnector({ endpoint: { url: "http://127.0.0.1:1" } })).catch((error: unknown) => error))
        .toBeInstanceOf(RemoteSetupError)
      expect(await fs.readFile(path.join(root, "state", "remote-device.json"), "utf8")).toBe("{not-json")
    })
  })

  test("connector setup rejects a non-loopback backend and an invalid stored relay origin as terminal", async () => {
    await withHome(async (root) => {
      const keys = await generateDeviceKey()
      await provide(root)(create({ ...enrollmentIdentity, ...keys }))
      expect(await provide(root)(makeRemoteConnector({ endpoint: { url: "http://192.0.2.1:4096" } })).catch((error: unknown) => error))
        .toBeInstanceOf(RemoteSetupError)
      await provide(root)(update({ ...enrollmentIdentity, ...keys, relayURL: "http://192.0.2.1" }))
      expect(await provide(root)(makeRemoteConnector({ endpoint: { url: "http://127.0.0.1:1" } })).catch((error: unknown) => error))
        .toBeInstanceOf(RemoteSetupError)
    })
  })
})

test.each(["disable", "deadline"] as const)("device authentication handles %s without replacing stored credentials", async (boundary) => {
  await withHome(async (root) => {
    const keys = await generateDeviceKey()
    const identity = Identity.make({ ...enrollmentIdentity, ...keys, refreshToken: "refresh_old", refreshExpiresAt: 9_000 })
    await provide(root)(create(identity))
    const controller = new AbortController()
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal)
    const entered = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<Response>()
    let signal: AbortSignal | null | undefined
    const fetcher: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal
      signal?.addEventListener("abort", () => pending.reject(signal?.reason), { once: true })
      entered.resolve()
      return pending.promise
    }, { preconnect: fetch.preconnect })
    const authenticating = provide(root)(credentials(identity, { fetcher, now: () => 1_000, signal: controller.signal })).catch((error: unknown) => error)
    try {
      await entered.promise
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(timeout).toHaveBeenCalledWith(30_000)
      if (boundary === "disable") controller.abort()
      if (boundary === "deadline") deadline.abort()
      expect(await authenticating).toBeInstanceOf(Error)
      expect(signal?.aborted).toBe(true)
      expect(await provide(root)(read())).toMatchObject({ refreshToken: "refresh_old" })
    } finally {
      pending.reject(new Error("test cleanup"))
      await authenticating
      timeout.mockRestore()
    }
  })
})

describe("device enrollment", () => {
  test("sends the enrollment code in the request body and stores the returned device identity", async () => {
    const { privateKey, publicKey } = await generateDeviceKey()
    const calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return json({ deviceID: "dev_42" })
    }) as unknown as typeof fetch

    const response = await enroll({
      relayURL: "https://relay.example",
      enrollmentID: "enr_1",
      code: "ABCD-EFGH-IJKL-MNOP-QRST",
      name: "workstation",
      privateKey,
      publicKey,
      fetcher,
    })
    expect(response).toEqual({ deviceID: "dev_42" })
    expect(calls).toEqual([
      {
        url: "https://relay.example/api/devices/enroll",
        method: "POST",
        body: { enrollmentID: "enr_1", code: "ABCD-EFGH-IJKL-MNOP-QRST", name: "workstation", publicKey },
        authorization: null,
      },
    ])
  })

  test("rejects a malformed enrollment code before contacting the relay", async () => {
    const { privateKey, publicKey } = await generateDeviceKey()
    let called = false
    const fetcher = (async () => {
      called = true
      return json({ deviceID: "dev_42" })
    }) as unknown as typeof fetch
    await expect(
      enroll({
        relayURL: "https://relay.example",
        enrollmentID: "enr_1",
        code: "not-a-code",
        name: "workstation",
        privateKey,
        publicKey,
        fetcher,
      }),
    ).rejects.toThrow(/enrollment code/i)
    expect(called).toBe(false)
  })

  test("classifies a revoked device as terminal and never reads or echoes the relay body", async () => {
    const { privateKey, publicKey } = await generateDeviceKey()
    const seen: Array<RequestInit | undefined> = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init)
      return new Response(JSON.stringify({ error: { message: "secret-body-marker" } }), { status: 401 })
    }) as unknown as typeof fetch

    const failure = await enroll({
      relayURL: "https://relay.example",
      enrollmentID: "enr_1",
      code: "ABCD-EFGH-IJKL-MNOP-QRST",
      name: "workstation",
      privateKey,
      publicKey,
      fetcher,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DeviceAuthorizationError)
    expect(String(failure)).not.toContain("secret-body-marker")
    expect(seen[0]?.redirect).toBe("error")
  })
})

describe("device credentials", () => {
  test("redeems a challenge with a signature and persists the rotated refresh credential", async () => {
    await withHome(async (root) => {
      const { privateKey, publicKey } = await generateDeviceKey()
      const identity = Identity.make({ ...enrollmentIdentity, publicKey, privateKey })
      const calls: Array<{ url: string; body: unknown; authorization: string | null }> = []
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({
          url,
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization"),
        })
        if (url.endsWith("/api/devices/challenge")) return json({ challengeID: "chal_1", nonce: "nonce_1", expiresAt: 99 })
        return json({
          accessToken: "access_1",
          accessExpiresAt: 2_000,
          refreshToken: "refresh_1",
          refreshExpiresAt: 9_000,
        })
      }) as unknown as typeof fetch

      await provide(root)(create(identity))
      const result = await provide(root)(credentials(identity, { fetcher, now: () => 1_000 }))
      expect(result).toEqual({ accessToken: "access_1", accessExpiresAt: 2_000 })
      expect(calls.map((call) => call.url)).toEqual([
        "https://relay.example/api/devices/challenge",
        "https://relay.example/api/devices/token",
      ])
      expect(calls[0].authorization).toBeNull()
      expect(calls[1].body).toMatchObject({ deviceID: "dev_1", challengeID: "chal_1" })
      const signature = (calls[1].body as { signature: string }).signature
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      )
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          Buffer.from(signature, "base64url"),
          new TextEncoder().encode(deviceSignaturePayload("chal_1", "nonce_1")),
        ),
      ).toBe(true)
      expect(await provide(root)(read())).toMatchObject({ refreshToken: "refresh_1", refreshExpiresAt: 9_000 })
    })
  })

  test("rotates a live refresh credential without minting a new challenge", async () => {
    await withHome(async (root) => {
      const { privateKey, publicKey } = await generateDeviceKey()
      const identity = Identity.make({
        ...enrollmentIdentity,
        publicKey,
        privateKey,
        refreshToken: "refresh_old",
        refreshExpiresAt: 9_000,
      })
      const calls: string[] = []
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input))
        expect(JSON.parse(String(init?.body))).toEqual({ deviceID: "dev_1", refreshToken: "refresh_old" })
        return json({
          accessToken: "access_2",
          accessExpiresAt: 5_000,
          refreshToken: "refresh_new",
          refreshExpiresAt: 20_000,
        })
      }) as unknown as typeof fetch

      await provide(root)(create(identity))
      expect(await provide(root)(credentials(identity, { fetcher, now: () => 1_000 }))).toEqual({
        accessToken: "access_2",
        accessExpiresAt: 5_000,
      })
      expect(calls).toEqual(["https://relay.example/api/devices/refresh"])
      expect(await provide(root)(read())).toMatchObject({ refreshToken: "refresh_new", refreshExpiresAt: 20_000 })
    })
  })

  test("fails explicitly on a malformed credential response instead of trusting it", async () => {
    await withHome(async (root) => {
      const { privateKey, publicKey } = await generateDeviceKey()
      const identity = Identity.make({
        ...enrollmentIdentity,
        publicKey,
        privateKey,
        refreshToken: "refresh_old",
        refreshExpiresAt: 9_000,
      })
      const fetcher = (async () => json({ accessToken: "access" })) as unknown as typeof fetch
      await provide(root)(create(identity))
      await expect(provide(root)(credentials(identity, { fetcher, now: () => 1_000 }))).rejects.toThrow(
        /credential/i,
      )
    })
  })

  test("treats an expired refresh credential as terminal and keeps the stored credential intact", async () => {
    await withHome(async (root) => {
      const { privateKey, publicKey } = await generateDeviceKey()
      const identity = Identity.make({
        ...enrollmentIdentity,
        publicKey,
        privateKey,
        refreshToken: "refresh_old",
        refreshExpiresAt: 9_000,
      })
      const fetcher = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch
      await provide(root)(create(identity))

      const failure = await provide(root)(credentials(identity, { fetcher, now: () => 1_000 })).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(DeviceAuthorizationError)
      expect(failure).toMatchObject({ status: 403, operation: "refresh" })
      expect(await provide(root)(read())).toMatchObject({ refreshToken: "refresh_old", refreshExpiresAt: 9_000 })
    })
  })
})
