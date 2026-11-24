import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { checkMessageActions } from "./versioned-relay-messages"
import { checkNativeRelay, checkStoredUsage, openWeb } from "./versioned-relay-native"
import {
  authorizationMatrix,
  browserHeaders,
  devices,
  enrollProbe,
  socketURL,
  startRollback,
  v4SessionList,
  wireMatrix,
} from "./versioned-relay-peers"
import { eventually, startWorker } from "./versioned-relay-worker"

const scratch = process.env.YCODING_RELAY_ACCEPTANCE_SCRATCH
assert.ok(scratch && isAbsolute(scratch), "Set YCODING_RELAY_ACCEPTANCE_SCRATCH to an absolute task directory")
const assetsDirectory = process.env.YCODING_RELAY_ACCEPTANCE_ASSETS
assert.ok(
  assetsDirectory === undefined || isAbsolute(assetsDirectory),
  "Bind only an absolute fixture assets directory",
)
const phase = process.argv[2]
assert.ok(
  phase === "boundary" ||
    phase === "editions" ||
    phase === "rollback" ||
    phase === "native" ||
    phase === "usage" ||
    phase === "messages",
  "Select boundary, editions, rollback, native, usage, or messages",
)
const root = await mkdtemp(join(scratch, "versioned-relay-"))
let passed = 0
let failed = 0

async function check(label: string, run: () => Promise<void>) {
  try {
    await run()
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}:`, error)
  }
}

try {
  const worker = await startWorker(join(root, "worker"), assetsDirectory)
  try {
    await worker.initializeDatabase()
    const owner = await worker.signIn("owner", "/remote/")
    assert.deepEqual(await devices(worker.origin, owner, "v4"), [], "The synthetic owner must start without devices")
    if (phase === "boundary") {
      const other = await worker.signIn("other")
      const probe = await enrollProbe(worker.origin, owner, "Owner boundary probe")
      const foreign = await enrollProbe(worker.origin, other, "Other owner's device")
      assert.notEqual(probe.deviceID, foreign.deviceID)
      await authorizationMatrix(worker.origin, owner, other, probe, foreign, check)
      await wireMatrix(worker.origin, owner, probe, check)
      await check("revocation denies both client and agent upgrades on v4 and v5", async () => {
        const revoke = await fetch(`${worker.origin}/api/devices/${probe.deviceID}/revoke`, {
          method: "POST",
          headers: browserHeaders(worker.origin, owner),
        })
        assert.equal(revoke.status, 200)
        for (const version of ["v4", "v5"] as const) {
          const client = await fetch(socketURL(worker.origin, version, probe.deviceID).replace(/^ws:/, "http:"), {
            headers: { ...browserHeaders(worker.origin, owner), upgrade: "websocket" },
          })
          assert.equal(client.status, 401, `${version} revoked device client`)
          const agent = await fetch(socketURL(worker.origin, version).replace(/^ws:/, "http:"), {
            headers: { authorization: `Bearer ${probe.accessToken}`, upgrade: "websocket" },
          })
          assert.equal(agent.status, 401, `${version} revoked device agent`)
        }
      })
    } else if (phase === "editions") {
      const html = await readFile(join(worker.assetsDirectory, "index.html"), "utf8")
      const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" }
      await check("Web paths serve the exact built shell and entry assets", async () => {
        for (const path of ["/remote", "/remote/", "/remote/session?session_id=ses_rust", "/remote/rusty"]) {
          const response = await fetch(`${worker.origin}${path}`, { headers: navigate, redirect: "manual" })
          assert.equal(response.status, 200, path)
          assert.match(response.headers.get("content-type") ?? "", /^text\/html/)
          assert.equal(response.headers.get("x-frame-options"), "DENY")
          assert.match(response.headers.get("cache-control") ?? "", /must-revalidate/)
          assert.equal((await response.text()) === html, true, `${path} served a different Web shell`)
        }
        const entries = [
          ...new Set(
            [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].flatMap(([, path]) =>
              path ? [path] : [],
            ),
          ),
        ]
        assert.ok(
          entries.some((path) => path.endsWith(".js")),
          "No hashed JavaScript entry found",
        )
        for (const path of entries) {
          const entry = await fetch(`${worker.origin}${path}`)
          assert.equal(entry.status, 200, path)
          assert.notEqual(entry.headers.get("content-type")?.startsWith("text/html"), true)
          assert.match(entry.headers.get("cache-control") ?? "", /immutable/)
          const expected = await readFile(join(worker.assetsDirectory, path))
          assert.equal(
            expected.equals(Buffer.from(await entry.arrayBuffer())),
            true,
            `${path} differs from the asset tree`,
          )
        }
      })
      await check("legacy Rust bookmarks redirect to the same workspace path with their query", async () => {
        for (const [oldPath, path] of [
          ["/remote/rust", "/remote"],
          ["/remote/rust/session?session_id=ses_rust&device_id=dev_rust", "/remote/session?session_id=ses_rust&device_id=dev_rust"],
        ]) {
          const response = await fetch(`${worker.origin}${oldPath}`, { headers: navigate, redirect: "manual" })
          assert.equal(response.status, 308)
          assert.equal(response.headers.get("location"), path)
        }
      })
      await check("unauthenticated relay APIs cannot return a Web shell", async () => {
        const anonymous = await fetch(`${worker.origin}/api/me`, { headers: navigate })
        assert.equal(anonymous.status, 401)
        assert.match(anonymous.headers.get("content-type") ?? "", /^application\/json/)
      })
      await check("local OAuth returns to Web and issues an authorized session cookie", async () => {
        for (const path of [
          "/remote/",
          "/remote/session?session_id=ses_rust&device_id=dev_rust",
        ]) {
          const cookie = await worker.signIn("owner", path)
          const shell = await fetch(`${worker.origin}${path}`, { headers: { ...navigate, cookie }, redirect: "manual" })
          assert.equal(shell.status, 200, path)
          assert.equal((await shell.text()) === html, true, path)
          assert.equal((await fetch(`${worker.origin}/api/me`, { headers: { cookie } })).status, 200)
        }
      })
    } else if (phase === "rollback") {
      const executable = process.env.YCODING_RELAY_BUN_CLI
      assert.ok(executable, "Set YCODING_RELAY_BUN_CLI to the extracted signed Bun 0.12.0 or 0.12.1 executable")
      const rollback = await startRollback(executable, join(root, "rollback"), worker.origin, owner)
      try {
        await check("v4 packaged Bun enrollment and live text client return the rollback Session", async () => {
          const response = await v4SessionList(worker.origin, owner, rollback.deviceID)
          assert.equal(response.ok, true, response.error?.code)
          assert.match(JSON.stringify(response.value), /"id":"ses_bun_rollback"/)
          assert.match(JSON.stringify(response.value), /Signed Bun rollback session/)
        })
        await check("v5 client with a valid cookie cannot read a live v4 agent", async () => {
          assert.equal(
            (await devices(worker.origin, owner, "v5")).find((device) => device.id === rollback.deviceID)?.online,
            false,
          )
          const wrong = openWeb(worker.origin, owner, rollback.deviceID)
          try {
            await eventually("isolated v5 Web Ready", () => (wrong.status().kind === "open" ? true : undefined))
            const outcome = await wrong.request("session.list")
            assert.ok(
              outcome.status === "failed" || outcome.status === "unknown",
              "A transmitted cross-prefix request must not return Session content",
            )
            assert.equal("value" in outcome, false)
            assert.equal((await v4SessionList(worker.origin, owner, rollback.deviceID)).ok, true)
          } finally {
            wrong.close()
          }
        })
      } finally {
        await rollback.close()
      }
    } else if (phase === "native") await checkNativeRelay(join(root, "rust"), worker.origin, owner, check)
    else if (phase === "usage") await checkStoredUsage(join(root, "usage"), worker.origin, owner, check)
    else await checkMessageActions(join(root, "messages"), worker.origin, owner, check)
  } finally {
    await worker.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`Versioned relay acceptance: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
