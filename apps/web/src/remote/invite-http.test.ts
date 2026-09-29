import { expect, test } from "bun:test"
import { createInviteHttp } from "./http"

test("invite HTTP sends the token only in a same-origin POST body and reads the one-time key", async () => {
  const requests: Request[] = []
  const credentials: RequestCredentials[] = []
  const http = createInviteHttp({ fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://relay.test"), init))
    if (init?.credentials) credentials.push(init.credentials)
    return Response.json({ accessKey: "0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ" }, { status: 201 })
  }, { preconnect: () => undefined }) })
  expect(await http.redeem("fragment-secret")).toEqual({ ok: true, value: { accessKey: "0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ" } })
  expect(new URL(requests[0]?.url ?? "https://relay.test").pathname).toBe("/api/auth/invite")
  expect(requests[0]?.method).toBe("POST")
  expect(await requests[0]?.json()).toEqual({ token: "fragment-secret" })
  expect(credentials).toEqual(["same-origin"])
})

test("access-key HTTP distinguishes invalid, limited, and network failures without echoing a key", async () => {
  const invalid = createInviteHttp({ fetch: Object.assign(async () => Response.json({ error: { message: "Access key is not valid" } }, { status: 401 }), { preconnect: () => undefined }) })
  expect(await invalid.signIn("bad")).toMatchObject({ ok: false, status: 401, kind: "http" })
  const limited = createInviteHttp({ fetch: Object.assign(async () => Response.json({ error: { message: "Too many attempts" } }, { status: 429 }), { preconnect: () => undefined }) })
  expect(await limited.signIn("bad")).toMatchObject({ ok: false, status: 429, kind: "http" })
  const offline = createInviteHttp({ fetch: Object.assign(async () => { throw new Error("Connection failed") }, { preconnect: () => undefined }) })
  expect(await offline.signIn("bad")).toMatchObject({ ok: false, status: 0, kind: "network" })
  const accepted = createInviteHttp({ fetch: Object.assign(async () => new Response(null, { status: 204 }), { preconnect: () => undefined }) })
  expect(await accepted.signIn("valid")).toEqual({ ok: true, value: undefined })
})
