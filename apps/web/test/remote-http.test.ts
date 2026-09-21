import { describe, expect, test } from "bun:test"
import { createRemoteHttp, signInURL } from "../src/remote/http"
import { startRelayDouble } from "./relay-double"

describe("signInURL", () => {
  test("targets the same-origin sign-in entry point with a /remote return path", () => {
    expect(signInURL("/remote/activity")).toBe("/api/auth/google/start?redirect_after=%2Fremote%2Factivity")
  })

  test("falls back to /remote for a return path outside the remote workspace", () => {
    expect(signInURL("https://evil.example/steal")).toBe("/api/auth/google/start?redirect_after=%2Fremote")
  })

  test("supports an explicit base for cross-host development", () => {
    expect(signInURL("/remote", "https://ycoding.althenia.app")).toBe(
      "https://ycoding.althenia.app/api/auth/google/start?redirect_after=%2Fremote",
    )
  })
})

describe("remote HTTP integration", () => {
  test("reads owner, session expiry, and devices from /api/me", async () => {
    const relay = await startRelayDouble()
    try {
      const http = createRemoteHttp({ baseURL: relay.httpURL })
      const me = await http.me()
      expect(me.ok).toBe(true)
      if (!me.ok) return
      expect(me.value.user.id).toBe("user_1")
      expect(me.value.session.expiresAt).toBeGreaterThan(0)
      expect(me.value.devices).toEqual([
        { id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active" },
      ])
    } finally {
      await relay.stop()
    }
  })

  test("reports an unauthenticated browser session without throwing", async () => {
    const relay = await startRelayDouble({
      meStatus: 401,
      me: { error: { code: "unauthorized", message: "Sign in required" } },
    })
    try {
      const http = createRemoteHttp({ baseURL: relay.httpURL })
      const me = await http.me()
      expect(me).toEqual({ ok: false, status: 401, message: "Sign in required", kind: "http" })
    } finally {
      await relay.stop()
    }
  })

  test("reads the pinned { devices } list shape", async () => {
    const relay = await startRelayDouble({
      devices: [{ id: "dev_2", name: "Laptop", createdAt: 3, status: "active" }],
    })
    try {
      const devices = await createRemoteHttp({ baseURL: relay.httpURL }).devices()
      expect(devices.ok && devices.value.map((device) => device.id)).toEqual(["dev_2"])
    } finally {
      await relay.stop()
    }
  })

  test("rejects a 200 response that omits the pinned devices key", async () => {
    const relay = await startRelayDouble({ devicesRaw: { data: [{ id: "dev_9", name: "Mini", status: "active" }] } })
    try {
      const devices = await createRemoteHttp({ baseURL: relay.httpURL }).devices()
      expect(devices.ok).toBe(false)
    } finally {
      await relay.stop()
    }
  })

  test("distinguishes a deployment without API routes from a real failure", async () => {
    const relay = await startRelayDouble({ me: "<!doctype html><html></html>", meStatus: 200 })
    try {
      const me = await createRemoteHttp({ baseURL: relay.httpURL }).me()
      expect(me.ok).toBe(false)
      if (me.ok) return
      expect(me.kind).toBe("unexpected-body")
      expect(me.status).toBe(200)
    } finally {
      await relay.stop()
    }
  })

  test("drops malformed device entries instead of trusting them", async () => {
    const relay = await startRelayDouble({
      devices: [
        { id: "dev_ok", name: "Studio Mac", createdAt: 1, status: "active" },
        { id: "dev_missing_status", name: "Broken", createdAt: 1 },
        { name: "No id", createdAt: 1, status: "active" },
      ],
    })
    try {
      const devices = await createRemoteHttp({ baseURL: relay.httpURL }).devices()
      expect(devices.ok && devices.value.map((device) => device.id)).toEqual(["dev_ok"])
    } finally {
      await relay.stop()
    }
  })

  test("mints a one-use enrollment code", async () => {
    const relay = await startRelayDouble()
    try {
      const enrollment = await createRemoteHttp({ baseURL: relay.httpURL }).createEnrollment()
      expect(enrollment.ok).toBe(true)
      if (!enrollment.ok) return
      expect(enrollment.value.code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/)
      expect(enrollment.value.enrollmentID).toBe("enr_1")
    } finally {
      await relay.stop()
    }
  })

  test("surfaces the server error message for a refused enrollment", async () => {
    const relay = await startRelayDouble({ enrollmentStatus: 403 })
    try {
      const enrollment = await createRemoteHttp({ baseURL: relay.httpURL }).createEnrollment()
      expect(enrollment).toEqual({ ok: false, status: 403, message: "cannot enroll", kind: "http" })
    } finally {
      await relay.stop()
    }
  })

  test("revokes a device and logs out with no response body", async () => {
    const relay = await startRelayDouble()
    try {
      const http = createRemoteHttp({ baseURL: relay.httpURL })
      expect(await http.revokeDevice("dev_1")).toEqual({ ok: true, value: undefined })
      expect(await http.logout()).toEqual({ ok: true, value: undefined })
    } finally {
      await relay.stop()
    }
  })
})
