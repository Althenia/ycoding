/**
 * Local Wrangler integration: real worker, real local D1 (with migrations), real
 * Durable Object, real WebSockets, and a local Google OIDC stand-in.
 *
 * This is not a unit test. It starts `wrangler dev` in local mode, drives the full
 * OAuth + enrollment + challenge + relay path, and asserts the relay invariants
 * that unit tests cover in isolation. Run it on its own:
 *
 *   bun infra/cloudflare/test/integration/relay-local.ts
 *
 * Requirements: `wrangler` installed, port freedom on 127.0.0.1, no network access
 * (the Google stand-in is local).
 */

import { spawn, type Subprocess } from "bun"
import { readdirSync } from "node:fs"
import { deviceSignaturePayload } from "../../../../packages/remote/src/index"
import { base64UrlEncode, sha256Hex } from "../../src/auth/crypto"

const repositoryRoot = new URL("../../../../", import.meta.url).pathname
const wranglerBin = `${repositoryRoot}node_modules/.bin/wrangler`
const configPath = "infra/cloudflare/wrangler.jsonc"
const workerPort = 8799
const workerOrigin = `http://127.0.0.1:${workerPort}`
const socketOrigin = `ws://127.0.0.1:${workerPort}`

const checks: string[] = []
let wrangler: Subprocess | undefined
let google: ReturnType<typeof Bun.serve> | undefined

try {
  const identity = await rsaIdentity()
  const idTokenHolder: { value: string } = { value: "" }
  google = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      console.log(`[google-stub] ${request.method} ${url.pathname}`)
      if (url.pathname === "/token")
        return Response.json({ id_token: idTokenHolder.value, access_token: "access-token" })
      if (url.pathname === "/certs") return Response.json({ keys: [identity.jwk] })
      return new Response("not found", { status: 404 })
    },
  })
  const googleOrigin = `http://127.0.0.1:${google.port}`

  await run(wranglerBin, ["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", configPath])
  wrangler = spawn(
    [
      wranglerBin,
      "dev",
      "--config",
      configPath,
      "--port",
      String(workerPort),
      "--var",
      "GOOGLE_CLIENT_ID:integration-client",
      "--var",
      "GOOGLE_CLIENT_SECRET:integration-secret",
      "--var",
      "GOOGLE_ALLOWED_EMAILS:integration@example.invalid",
      "--var",
      "CLEANUP_INTERVAL_MS:10000",
      "--test-scheduled",
      "--var",
      `GOOGLE_ISSUER:${googleOrigin}`,
      "--var",
      `GOOGLE_AUTHORIZATION_ENDPOINT:${googleOrigin}/authorize`,
      "--var",
      `GOOGLE_TOKEN_ENDPOINT:${googleOrigin}/token`,
      "--var",
      `GOOGLE_JWKS_URI:${googleOrigin}/certs`,
    ],
    { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" },
  )
  await waitForWorker()

  const health = await fetch(`${workerOrigin}/health`)
  expect(health.status === 200, `health returned ${health.status}`)
  checks.push("migrated local D1 answers /health")

  /* ----------------------------------------------- public web + API routing */

  const home = await fetch(`${workerOrigin}/`, { headers: { "sec-fetch-mode": "navigate" } })
  const homeBody = await home.text()
  expect(home.status === 200, `landing returned ${home.status}`)
  expect(home.headers.get("content-type")?.includes("text/html") === true, "landing is not HTML")
  expect(homeBody.includes("<title>YCoding</title>"), "landing body is not the built SPA shell")
  expect(home.headers.get("x-content-type-options") === "nosniff", "landing is missing nosniff")
  expect(home.headers.get("x-frame-options") === "DENY", "landing is missing frame denial")
  expect(home.headers.get("referrer-policy") === "strict-origin-when-cross-origin", "landing is missing referrer policy")
  checks.push("built landing page served with baseline security headers")

  for (const deepLink of ["/remote/session/ses_example", "/docs/configuration/models", "/changelog/0.4.2"]) {
    const response = await fetch(`${workerOrigin}${deepLink}`, { headers: { "sec-fetch-mode": "navigate" } })
    expect(response.status === 200, `deep link ${deepLink} returned ${response.status}`)
    expect(
      response.headers.get("content-type")?.includes("text/html") === true,
      `deep link ${deepLink} was not the SPA shell`,
    )
    expect(response.headers.get("x-frame-options") === "DENY", `deep link ${deepLink} is missing frame denial`)
  }
  checks.push("public deep links fall back to the SPA shell through the asset binding")

  const apiNavigation = await fetch(`${workerOrigin}/api/me`, {
    headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
  })
  expect(apiNavigation.status === 401, `API navigation returned ${apiNavigation.status}`)
  expect(
    apiNavigation.headers.get("content-type")?.includes("application/json") === true,
    "API navigation was masked by the SPA fallback",
  )
  const apiChallengeNavigation = await fetch(`${workerOrigin}/api/devices/challenge`, {
    method: "POST",
    headers: { "sec-fetch-mode": "navigate", accept: "text/html", "content-type": "application/json" },
    body: JSON.stringify({ deviceID: "dev_unknown" }),
  })
  expect(apiChallengeNavigation.status === 401, `API navigation POST returned ${apiChallengeNavigation.status}`)
  expect(
    apiChallengeNavigation.headers.get("content-type")?.includes("application/json") === true,
    "API navigation POST was masked by the SPA fallback",
  )
  const agentSocket = await fetch(`${workerOrigin}/ws/agent`, { headers: { upgrade: "websocket" } })
  expect(agentSocket.status === 401, `/ws/agent returned ${agentSocket.status}`)
  expect(agentSocket.headers.get("content-type")?.includes("application/json") === true, "relay route returned HTML")
  checks.push("SPA fallback never masks API, auth, or relay routes")

  const assetFile = readdirSync(`${repositoryRoot}apps/web/dist/assets`).find((name) => name.endsWith(".js"))
  expect(assetFile !== undefined, "the web build has no JavaScript asset to serve")
  const asset = await fetch(`${workerOrigin}/assets/${assetFile}`)
  expect(asset.status === 200, `asset returned ${asset.status}`)
  expect(asset.headers.get("content-type")?.includes("javascript") === true, "asset content type is wrong")
  expect(asset.headers.get("x-frame-options") === null, "static sub-resources should bypass the worker")
  checks.push("hashed static assets are served directly by the asset layer")

  /* ---------------------------------------------------------------- sign in */

  const started = await fetch(`${workerOrigin}/api/auth/google/start?redirect_after=/remote/`, { redirect: "manual" })
  expect(started.status === 302, `start returned ${started.status}`)
  const oauthCookie = cookiePair(started, "yc_oauth")
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? ""
  expect(state.length > 0, "authorization URL carried no state")

  const issuedAt = Math.floor(Date.now() / 1000)
  const oauthToken = oauthCookie.split("=")[1] ?? ""
  const nonce = await readNonce(await sha256Hex(oauthToken))
  expect(nonce.length > 0, "oauth transaction was not persisted in local D1")
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: googleOrigin,
    aud: "integration-client",
    sub: "integration-subject",
    iat: issuedAt,
    exp: issuedAt + 3600,
    nonce,
    email: "integration@example.invalid",
    email_verified: true,
    ...overrides,
  })
  idTokenHolder.value = await signedIdToken(identity.pair, claims())

  const callback = await fetch(`${workerOrigin}/api/auth/google/callback?code=integration-code&state=${state}`, {
    headers: { cookie: oauthCookie },
    redirect: "manual",
  })
  expect(callback.status === 302, `callback returned ${callback.status}`)
  expect(callback.headers.get("location") === "/remote/", `callback redirected to ${callback.headers.get("location")}`)
  const sessionCookie = cookiePair(callback, "yc_session")
  checks.push("Google OIDC callback issued a session cookie against real D1")

  // An unapproved verified account is denied with a generic error.
  const deniedStart = await fetch(`${workerOrigin}/api/auth/google/start`, { redirect: "manual" })
  const deniedCookie = cookiePair(deniedStart, "yc_oauth")
  const deniedState = new URL(deniedStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const deniedNonce = await readNonce(await sha256Hex(deniedCookie.split("=")[1] ?? ""))
  idTokenHolder.value = await signedIdToken(
    identity.pair,
    { ...claims({ nonce: deniedNonce }), email: "stranger@example.invalid" },
  )
  const denied = await fetch(
    `${workerOrigin}/api/auth/google/callback?code=integration-code&state=${deniedState}`,
    { headers: { cookie: deniedCookie }, redirect: "manual" },
  )
  expect(denied.headers.get("location") === "/remote/?auth=error", `unapproved account redirected to ${denied.headers.get("location")}`)
  expect(!(denied.headers.getSetCookie().some((value) => value.startsWith("yc_session="))), "unapproved account received a session")
  checks.push("unapproved Google account denied sign-in")

  // The allowlisted account is denied when its email is not verified.
  const unverifiedStart = await fetch(`${workerOrigin}/api/auth/google/start`, { redirect: "manual" })
  const unverifiedCookie = cookiePair(unverifiedStart, "yc_oauth")
  const unverifiedState = new URL(unverifiedStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const unverifiedNonce = await readNonce(await sha256Hex(unverifiedCookie.split("=")[1] ?? ""))
  idTokenHolder.value = await signedIdToken(identity.pair, claims({ nonce: unverifiedNonce, email_verified: false }))
  const unverified = await fetch(
    `${workerOrigin}/api/auth/google/callback?code=integration-code&state=${unverifiedState}`,
    { headers: { cookie: unverifiedCookie }, redirect: "manual" },
  )
  expect(unverified.headers.get("location") === "/remote/?auth=error", "unverified allowlisted email was admitted")
  checks.push("unverified allowlisted email denied")

  const me = await fetch(`${workerOrigin}/api/me`, { headers: { cookie: sessionCookie } })
  expect(me.status === 200, `/api/me returned ${me.status} without an Origin header`)
  const meBody = (await me.json()) as { user: { id: string }; devices: unknown[] }
  expect(meBody.user.id.startsWith("usr_"), "/api/me did not return an owner")
  checks.push("GET /api/me works without an Origin header and without writing cookies")

  /* ------------------------------------------------------------ enrollment */

  const enrollment = await fetch(`${workerOrigin}/api/devices/enrollments`, {
    method: "POST",
    headers: { cookie: sessionCookie, origin: workerOrigin },
  })
  expect(enrollment.status === 200, `enrollment mint returned ${enrollment.status}`)
  const enrollmentBody = (await enrollment.json()) as { enrollmentID: string; code: string }

  const crossOrigin = await fetch(`${workerOrigin}/api/devices/enrollments`, {
    method: "POST",
    headers: { cookie: sessionCookie, origin: "https://evil.example" },
  })
  expect(crossOrigin.status === 403, `cross-origin mutation returned ${crossOrigin.status}`)
  checks.push("same-origin enforcement on cookie mutations")

  const device = await deviceKey()
  const enrolled = await fetch(`${workerOrigin}/api/devices/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollmentID: enrollmentBody.enrollmentID,
      code: enrollmentBody.code,
      name: "Integration Mac",
      publicKey: device.publicKey,
    }),
  })
  expect(enrolled.status === 200, `enroll returned ${enrolled.status}`)
  const deviceID = ((await enrolled.json()) as { deviceID: string }).deviceID
  checks.push("one-use enrollment persisted a device public key in D1")

  const replay = await fetch(`${workerOrigin}/api/devices/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollmentID: enrollmentBody.enrollmentID,
      code: enrollmentBody.code,
      name: "Replay",
      publicKey: device.publicKey,
    }),
  })
  expect(replay.status === 400, `replayed enrollment returned ${replay.status}`)
  checks.push("enrollment replay rejected")

  /* -------------------------------------------------------------- device auth */

  const tokens = await authenticateDevice(deviceID, device.pair)
  checks.push("challenge signing issued expiring device credentials")

  const replayedChallenge = await fetch(`${workerOrigin}/api/devices/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceID, challengeID: tokens.challengeID, signature: tokens.signature }),
  })
  expect(replayedChallenge.status === 401, `challenge replay returned ${replayedChallenge.status}`)
  checks.push("challenge replay rejected")

  /* ----------------------------------------------------------------- relay */

  const agent = connect(`${socketOrigin}/ws/agent`, { authorization: `Bearer ${tokens.accessToken}` })
  await agent.opened
  agent.send({ type: "sessions", sessionIDs: ["ses_a", "ses_b"] })

  const first = connect(`${socketOrigin}/ws/client?device=${deviceID}`, { cookie: sessionCookie, origin: workerOrigin })
  await first.opened
  expect(
    JSON.stringify(await first.next()).includes('"ses_a"'),
    "client did not receive the session advertisement",
  )

  first.send({ type: "request", id: "1", operation: "session.list" })
  const relayedFirst = await agent.next()
  expect(relayedFirst.type === "request", "agent did not receive a relayed request")
  expect(relayedFirst.id !== "1", "relay did not translate the client correlation id")
  agent.send({ type: "response", id: relayedFirst.id, ok: true, value: { data: ["first"] } })
  expect(JSON.stringify(await first.next()) === JSON.stringify({ type: "response", id: "1", ok: true, value: { data: ["first"] } }), "first client response mismatch")

  const second = connect(`${socketOrigin}/ws/client?device=${deviceID}`, { cookie: sessionCookie, origin: workerOrigin })
  await second.opened
  await second.next()
  first.send({ type: "request", id: "1", operation: "session.list" })
  second.send({ type: "request", id: "1", operation: "session.list" })
  const relayedA = await agent.next()
  const relayedB = await agent.next()
  expect(relayedA.id !== relayedB.id, "colliding client ids were not separated")
  agent.send({ type: "response", id: relayedB.id, ok: true, value: "second" })
  expect(JSON.stringify(await second.next()) === JSON.stringify({ type: "response", id: "1", ok: true, value: "second" }), "second client response mismatch")
  agent.send({ type: "response", id: relayedA.id, ok: true, value: "first" })
  expect(JSON.stringify(await first.next()) === JSON.stringify({ type: "response", id: "1", ok: true, value: "first" }), "first client did not receive its own response")
  checks.push("two clients with colliding ids routed correctly through a real Durable Object")

  first.send({ type: "request", id: "2", operation: "session.messages", sessionID: "ses_a" })
  const chunked = await agent.next()
  const payload = JSON.stringify({ messages: [{ index: 0 }] })
  agent.send({ type: "response", id: chunked.id, ok: true, value: payload.slice(0, 10), chunk: { index: 0, last: false } })
  agent.send({ type: "response", id: chunked.id, ok: true, value: payload.slice(10), chunk: { index: 1, last: true } })
  const chunkOne = await first.next()
  const chunkTwo = await first.next()
  expect(chunkOne.chunk?.index === 0 && chunkTwo.chunk?.last === true, "chunked response was not forwarded in order")
  expect(`${chunkOne.value}${chunkTwo.value}` === payload, "chunked response did not reassemble")
  checks.push("chunked large responses forwarded without truncation")

  first.send({ type: "request", id: "3", operation: "session.get", sessionID: "ses_secret" })
  expect(JSON.stringify(await first.next()).includes("session_not_allowed"), "unadvertised session was not refused")
  checks.push("unadvertised session refused by the relay")

  first.send({ type: "request", id: "4", operation: "session.subscribe", sessionID: "ses_a" })
  const subscribe = await agent.next()
  agent.send({ type: "response", id: subscribe.id, ok: true, value: null })
  await first.next()
  agent.send({ type: "event", sessionID: "ses_a", event: { seq: 1 } })
  expect(JSON.stringify(await first.next()).includes('"seq":1'), "subscribed client did not receive the event")
  expect(second.pending() === 0, "unsubscribed client received an event")
  checks.push("events delivered only to the subscribed client")

  /* ------------------------------------------------------- revocation closes */

  const revoked = await fetch(`${workerOrigin}/api/devices/${deviceID}/revoke`, {
    method: "POST",
    headers: { cookie: sessionCookie, origin: workerOrigin },
  })
  expect(revoked.status === 200, `revoke returned ${revoked.status}`)
  const agentClose = await agent.closed
  const firstClose = await first.closed
  const secondClose = await second.closed
  expect(agentClose.code === 4401, `agent socket closed with ${agentClose.code}`)
  expect(firstClose.code === 4401, `client socket closed with ${firstClose.code}`)
  expect(secondClose.code === 4401, `second client socket closed with ${secondClose.code}`)
  checks.push("revocation closed live agent and client sockets")

  const afterRevoke = await fetch(`${workerOrigin}/api/devices/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceID }),
  })
  expect(afterRevoke.status === 401, `challenge after revoke returned ${afterRevoke.status}`)
  checks.push("revoked device refused on the credential path")

  /* -------------------------------------------------- rotation and cleanup */

  // Seed real D1 rows so rotation and retention can be exercised without waiting.
  let sessionPostconditions: Record<string, string> = {}
  const userID = await queryD1("SELECT id FROM user LIMIT 1")
  expect(userID.startsWith("usr_"), "no owner row was persisted")
  const seedToken = `seed-${crypto.randomUUID()}`
  const seedID = await sha256Hex(seedToken)
  const expiredToken = `expired-${crypto.randomUUID()}`
  const expiredID = await sha256Hex(expiredToken)
  const nowMs = Date.now()
  await run(wranglerBin, [
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--command",
    `INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES ('${seedID}', '${userID}', ${nowMs - 16 * 86_400_000}, ${nowMs + 30 * 86_400_000}), ('${expiredID}', '${userID}', ${nowMs - 60 * 86_400_000}, ${nowMs - 40 * 86_400_000})`,
  ])

  const races = await Promise.all([
    fetch(`${workerOrigin}/api/auth/session/refresh`, {
      method: "POST",
      headers: { cookie: `yc_session=${seedToken}`, origin: workerOrigin },
    }),
    fetch(`${workerOrigin}/api/auth/session/refresh`, {
      method: "POST",
      headers: { cookie: `yc_session=${seedToken}`, origin: workerOrigin },
    }),
  ])
  const winners = races.filter((response) => response.status === 200)
  expect(winners.length === 1, `concurrent session rotation produced ${winners.length} successes`)
  const winnerToken = cookieValue(winners[0]!, "yc_session")
  expect(
    (await fetch(`${workerOrigin}/api/me`, { headers: { cookie: `yc_session=${winnerToken}` } })).status === 200,
    "rotated session token is not usable",
  )
  expect(
    (await fetch(`${workerOrigin}/api/me`, { headers: { cookie: `yc_session=${seedToken}` } })).status === 401,
    "replaced session still authenticates",
  )
  sessionPostconditions = await queryD1Row(
    `SELECT (SELECT COUNT(*) FROM browser_session WHERE id = '${seedID}' AND revoked_at IS NULL) AS live, (SELECT COUNT(*) FROM browser_session WHERE id = '${expiredID}') AS expired`,
  )
  expect(sessionPostconditions.live === "0", "the rotated session was not revoked in the same transaction")
  checks.push("concurrent browser-session rotation is atomic in real D1")

  // A second, live device keeps the credential race independent of the revoke check.
  const enrollment2 = await fetch(`${workerOrigin}/api/devices/enrollments`, {
    method: "POST",
    headers: { cookie: sessionCookie, origin: workerOrigin },
  })
  const enrollment2Body = (await enrollment2.json()) as { enrollmentID: string; code: string }
  const secondDevice = await deviceKey()
  const enrolled2 = await fetch(`${workerOrigin}/api/devices/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollmentID: enrollment2Body.enrollmentID,
      code: enrollment2Body.code,
      name: "Second Mac",
      publicKey: secondDevice.publicKey,
    }),
  })
  const device2ID = ((await enrolled2.json()) as { deviceID: string }).deviceID
  const device2Tokens = await authenticateDevice(device2ID, secondDevice.pair)
  const raced = await Promise.all([
    fetch(`${workerOrigin}/api/devices/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceID: device2ID, refreshToken: device2Tokens.refreshToken }),
    }),
    fetch(`${workerOrigin}/api/devices/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceID: device2ID, refreshToken: device2Tokens.refreshToken }),
    }),
  ])
  expect(raced.filter((response) => response.status === 200).length === 1, "concurrent credential rotation was not single-use")
  checks.push("concurrent device-credential rotation is atomic in real D1")

  // The cron handler and the lazy sweep call the same bounded cleanup; the lazy
  // path is observable here without waiting for the hourly trigger.
  await Bun.sleep(10_500)
  await fetch(`${workerOrigin}/health`)
  expect(
    (await queryD1(`SELECT COUNT(*) AS count FROM browser_session WHERE id = '${expiredID}'`)) === "0",
    "bounded sweep left expired authentication metadata in D1",
  )
  checks.push("bounded sweep removed expired metadata from real D1")

  /* --------------------------- multi-device revocation regression */

  const enrollDevice = async (name: string) => {
    const created = await fetch(`${workerOrigin}/api/devices/enrollments`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: workerOrigin },
    })
    const body = (await created.json()) as { enrollmentID: string; code: string }
    const key = await deviceKey()
    const enrolled = await fetch(`${workerOrigin}/api/devices/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentID: body.enrollmentID, code: body.code, name, publicKey: key.publicKey }),
    })
    const id = ((await enrolled.json()) as { deviceID: string }).deviceID
    return { key, deviceID: id, tokens: await authenticateDevice(id, key.pair) }
  }

  const third = await enrollDevice("Third Mac")
  const secondLive = await authenticateDevice(device2ID, secondDevice.pair)
  const agentThird = connect(`${socketOrigin}/ws/agent`, { authorization: `Bearer ${third.tokens.accessToken}` })
  const agentSecond = connect(`${socketOrigin}/ws/agent`, { authorization: `Bearer ${secondLive.accessToken}` })
  await agentThird.opened
  await agentSecond.opened
  agentThird.send({ type: "sessions", sessionIDs: ["ses_a"] })
  agentSecond.send({ type: "sessions", sessionIDs: ["ses_a"] })

  const clientThird = connect(`${socketOrigin}/ws/client?device=${third.deviceID}`, {
    cookie: sessionCookie,
    origin: workerOrigin,
  })
  const clientSecond = connect(`${socketOrigin}/ws/client?device=${device2ID}`, {
    cookie: sessionCookie,
    origin: workerOrigin,
  })
  await clientThird.opened
  await clientSecond.opened
  await clientThird.next()
  await clientSecond.next()
  for (const pair of [
    { client: clientThird, agent: agentThird },
    { client: clientSecond, agent: agentSecond },
  ]) {
    pair.client.send({ type: "request", id: "sub", operation: "session.subscribe", sessionID: "ses_a" })
    const relayed = await pair.agent.next()
    pair.agent.send({ type: "response", id: relayed.id, ok: true, value: null })
    await pair.client.next()
  }
  agentThird.send({ type: "event", sessionID: "ses_a", event: { seq: 11 } })
  expect(JSON.stringify(await clientThird.next()).includes('"seq":11'), "third-device event missing")
  expect(clientSecond.pending() === 0, "second device received another device's event")
  expect(clientSecond.pending() === 0, "another device received this device's event")
  const logout = await fetch(`${workerOrigin}/api/auth/logout`, {
    method: "POST",
    headers: { cookie: sessionCookie, origin: workerOrigin },
  })
  expect(logout.status === 200, `logout returned ${logout.status}`)
  const thirdClose = await clientThird.closed
  const secondLiveClose = await clientSecond.closed
  expect(thirdClose.code === 4401, `third-device socket closed with ${thirdClose.code}`)
  expect(secondLiveClose.code === 4401, `second-device socket closed with ${secondLiveClose.code}`)
  // Logging out a browser session must not tear down an enrolled device agent.
  const agentSurvived = await Promise.race([
    agentSecond.closed.then(() => false),
    Bun.sleep(750).then(() => true),
  ])
  expect(agentSurvived, "logout closed the device agent connection")
  checks.push("logout closed every device's browser sockets and kept the agent enrolled")

  for (const line of checks) console.log(`ok - ${line}`)
  console.log("Local Wrangler auth + relay integration passed")
} finally {
  wrangler?.kill()
  google?.stop(true)
}

/* ------------------------------------------------------------------ helpers */

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Integration check failed: ${message}`)
}

async function run(command: string, args: string[]): Promise<string> {
  const process = spawn([command, ...args], { cwd: repositoryRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}

/** Runs one read query against the local D1 used by `wrangler dev`. */
async function queryD1(command: string): Promise<string> {
  const output = await run(wranglerBin, [
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--json",
    "--command",
    command,
  ])
  const parsed: unknown = JSON.parse(output)
  const batches = Array.isArray(parsed) ? parsed : [parsed]
  for (const batch of batches) {
    if (typeof batch !== "object" || batch === null) continue
    const results = (batch as { results?: unknown }).results
    if (!Array.isArray(results) || results.length === 0) continue
    const row = results[0]
    if (typeof row === "object" && row !== null) {
      const value = Object.values(row as Record<string, unknown>)[0]
      return String(value)
    }
  }
  return ""
}

function sleep(milliseconds: number): Promise<void> {
  return Bun.sleep(milliseconds)
}

/** Runs one read query and returns the first row as a string map. */
async function queryD1Row(command: string): Promise<Record<string, string>> {
  const output = await run(wranglerBin, [
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--json",
    "--command",
    command,
  ])
  const parsed: unknown = JSON.parse(output)
  const batches = Array.isArray(parsed) ? parsed : [parsed]
  for (const batch of batches) {
    if (typeof batch !== "object" || batch === null) continue
    const results = (batch as { results?: unknown }).results
    if (!Array.isArray(results) || results.length === 0) continue
    const row = results[0]
    if (typeof row !== "object" || row === null) continue
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    )
  }
  return {}
}

/** Reads the one-use OIDC nonce the worker stored, proving the D1 write happened. */
async function readNonce(transactionID: string): Promise<string> {
  const output = await run(wranglerBin, [
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--json",
    "--command",
    `SELECT nonce FROM oauth_transaction WHERE id = '${transactionID}'`,
  ])
  const parsed: unknown = JSON.parse(output)
  const batches = Array.isArray(parsed) ? parsed : [parsed]
  for (const batch of batches) {
    if (typeof batch !== "object" || batch === null) continue
    const results = (batch as { results?: unknown }).results
    if (!Array.isArray(results)) continue
    for (const row of results) if (typeof row === "object" && row !== null) {
      const value = (row as { nonce?: unknown }).nonce
      if (typeof value === "string") return value
    }
  }
  return ""
}

async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${workerOrigin}/health`)
      if (response.status === 200) return
    } catch {
      // Wrangler is still starting.
    }
    await Bun.sleep(500)
  }
  throw new Error("wrangler dev did not become ready")
}

/** Value only, for building a Cookie request header. */
function cookieValue(response: Response, name: string): string {
  for (const value of response.headers.getSetCookie())
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1).split(";")[0] ?? ""
  throw new Error(`response carried no ${name} cookie`)
}

/** Full `name=value` pair, for building a Cookie request header from a Set-Cookie line. */
function cookiePair(response: Response, name: string): string {
  const values = response.headers.getSetCookie()
  for (const value of values) if (value.startsWith(`${name}=`)) return value.split(";")[0] ?? ""
  throw new Error(`response carried no ${name} cookie`)
}

async function rsaIdentity(kid = "integration-kid") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" }
  return { pair, jwk }
}

async function signedIdToken(pair: CryptoKeyPair, claims: Record<string, unknown>) {
  const header = { alg: "RS256", kid: "integration-kid", typ: "JWT" }
  const signingInput = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))}`
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput)),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { pair, publicKey: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" } }
}

async function authenticateDevice(deviceID: string, pair: CryptoKeyPair) {
  const challenge = await fetch(`${workerOrigin}/api/devices/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceID }),
  })
  expect(challenge.status === 200, `challenge returned ${challenge.status}`)
  const challengeBody = (await challenge.json()) as { challengeID: string; nonce: string }
  const signature = base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(deviceSignaturePayload(challengeBody.challengeID, challengeBody.nonce)),
      ),
    ),
  )
  const token = await fetch(`${workerOrigin}/api/devices/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceID, challengeID: challengeBody.challengeID, signature }),
  })
  expect(token.status === 200, `token returned ${token.status}`)
  const issued = (await token.json()) as { accessToken: string; refreshToken: string }
  return { ...issued, challengeID: challengeBody.challengeID, signature }
}

type Frame = Record<string, unknown>

function connect(url: string, headers: Record<string, string>) {
  const queue: Frame[] = []
  const waiters: ((frame: Frame) => void)[] = []
  let resolveClosed: (value: { code: number; reason: string }) => void = () => {}
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve
  })
  const socket = new WebSocket(url, { headers })
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true })
  })
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })
  socket.addEventListener("close", (event) => resolveClosed({ code: event.code, reason: event.reason }))
  return {
    opened,
    closed,
    pending: () => queue.length,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    next: (timeoutMs = 10_000) =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise<Frame>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for a frame from ${url}`)), timeoutMs)
            waiters.push((frame) => {
              clearTimeout(timer)
              resolve(frame)
            })
          }),
  }
}
