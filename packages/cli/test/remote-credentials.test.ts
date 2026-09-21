import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
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
          Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") }),
        ),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<A, E, never>,
    )
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

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
      expect(await provide(root)(read())).toMatchObject({ refreshToken: "refresh_old", refreshExpiresAt: 9_000 })
    })
  })
})
