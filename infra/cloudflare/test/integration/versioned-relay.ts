import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { checkMessageActions } from "./versioned-relay-messages"
import { checkNativeRelay, checkStoredUsage, openWeb } from "./versioned-relay-native"
import {
  authorizationMatrix,
  devices,
  enrollProbe,
  startRollback,
  v4SessionList,
  wireMatrix,
} from "./versioned-relay-peers"
import { eventually, startWorker } from "./versioned-relay-worker"

const scratch = process.env.YCODING_RELAY_ACCEPTANCE_SCRATCH
assert.ok(scratch && isAbsolute(scratch), "Set YCODING_RELAY_ACCEPTANCE_SCRATCH to an absolute task directory")
const phase = process.argv[2]
assert.ok(
  phase === "boundary" || phase === "rollback" || phase === "native" || phase === "usage" || phase === "messages",
  "Select boundary, rollback, native, usage, or messages",
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
  const worker = await startWorker(join(root, "worker"))
  try {
    await worker.initializeDatabase()
    const owner = await worker.signIn("owner")
    assert.deepEqual(await devices(worker.origin, owner, "v4"), [], "The synthetic owner must start without devices")
    if (phase === "boundary") {
      const other = await worker.signIn("other")
      const probe = await enrollProbe(worker.origin, owner, "Owner boundary probe")
      const foreign = await enrollProbe(worker.origin, other, "Other owner's device")
      assert.notEqual(probe.deviceID, foreign.deviceID)
      await authorizationMatrix(worker.origin, owner, other, probe, foreign, check)
      await wireMatrix(worker.origin, owner, probe, check)
    } else if (phase === "rollback") {
      const executable = process.env.YCODING_RELAY_BUN_CLI
      assert.ok(executable, "Set YCODING_RELAY_BUN_CLI to the extracted signed Bun 0.12.0 executable")
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
