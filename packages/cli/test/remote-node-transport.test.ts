import { expect, test } from "bun:test"
import path from "node:path"

// The published CLI also runs on the Node runtime, whose DOM `WebSocket` cannot
// send upgrade headers. This check drives the production transport in a real
// Node subprocess against a real loopback WebSocket server.

test("carries the device bearer header on the Node runtime", async () => {
  const script = path.join(import.meta.dir, "remote-node-transport.ts")
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn(["node", "--experimental-transform-types", script], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    throw new Error("The Node runtime is required to verify the release transport", { cause: error })
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0 && stdout.trim() === "")
    throw new Error(`The Node transport check did not report a result: ${stderr.trim()}`)
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    authorization: string | null
    runtime: string
    failure: string | null
  }
  expect(result.failure, stderr).toBeNull()
  expect(result.authorization).toBe("Bearer node-device-token")
  expect(result.runtime).toStartWith("v")
  expect(exitCode, stderr).toBe(0)
}, 60_000)
