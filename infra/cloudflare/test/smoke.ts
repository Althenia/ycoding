/**
 * Deployed auth-boundary smoke check. Read-only and credential-free: it proves
 * the deployed worker exposes no unauthenticated relay path.
 *
 * Usage: bun infra/cloudflare/test/smoke.ts https://ycoding-cloud.<account>.workers.dev
 */

const base = process.argv[2]
if (!base) throw new Error("usage: bun infra/cloudflare/test/smoke.ts <https://worker-host>")
const origin = new URL(base).origin
const checks: string[] = []

const health = await fetch(`${origin}/health`)
expect(health.status === 200, `/health returned ${health.status}`)
expect((await health.json()).status === "ok", "/health did not report ok")
checks.push("GET /health 200")

const landing = await fetch(`${origin}/`, { headers: { "sec-fetch-mode": "navigate" } })
expect(landing.status === 200, `/ returned ${landing.status}`)
expect(landing.headers.get("content-type")?.includes("text/html") === true, "/ is not HTML")
expect(landing.headers.get("x-frame-options") === "DENY", "/ is missing baseline security headers")
checks.push("GET / serves the built landing page with security headers")

const deepLink = await fetch(`${origin}/remote/status`, { headers: { "sec-fetch-mode": "navigate" } })
expect(deepLink.status === 200, `/remote/status returned ${deepLink.status}`)
expect(deepLink.headers.get("content-type")?.includes("text/html") === true, "SPA deep link is not HTML")
checks.push("GET /remote/status falls back to the SPA shell")

const apiNavigation = await fetch(`${origin}/api/me`, { headers: { "sec-fetch-mode": "navigate", accept: "text/html" } })
expect(apiNavigation.status === 401, `API navigation returned ${apiNavigation.status}`)
expect(
  apiNavigation.headers.get("content-type")?.includes("application/json") === true,
  "API navigation was masked by the SPA fallback",
)
checks.push("SPA fallback never masks API routes")

const me = await fetch(`${origin}/api/me`)
expect(me.status === 401, `/api/me without a session returned ${me.status}`)
checks.push("GET /api/me unauthenticated 401")

const enrollments = await fetch(`${origin}/api/devices/enrollments`, { method: "POST" })
expect(enrollments.status === 403, `/api/devices/enrollments without an Origin returned ${enrollments.status}`)
checks.push("POST /api/devices/enrollments without Origin 403")

const upgrade = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
}
const agentSocket = await fetch(`${origin}/ws/agent`, { headers: upgrade })
expect(agentSocket.status === 401, `/ws/agent without a credential returned ${agentSocket.status}`)
checks.push("GET /ws/agent without credential 401")

const clientSocket = await fetch(`${origin}/ws/client?device=dev_unknown`, { headers: upgrade })
expect(clientSocket.status === 403, `/ws/client without an Origin returned ${clientSocket.status}`)
checks.push("GET /ws/client without Origin 403")

for (const retired of ["/ws/smoke/agent", "/ws/smoke/client", "/ws"])
  expect((await fetch(`${origin}${retired}`)).status === 404, `${retired} is still routed`)
checks.push("no unauthenticated relay route")

const challenge = await fetch(`${origin}/api/devices/challenge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deviceID: "dev_unknown" }),
})
expect(challenge.status === 401, `challenge for an unknown device returned ${challenge.status}`)
checks.push("POST /api/devices/challenge unknown device 401")

for (const line of checks) console.log(`ok - ${line}`)
console.log("Authenticated relay auth-boundary smoke passed")

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Smoke check failed: ${message}`)
}
