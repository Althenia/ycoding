import { expect, test } from "bun:test"
import { setClamshellSleepDisabled } from "../src/util/clamshell-sleep-ffi.bun"

test("macOS real lid control arms and restores in a finalizer", async () => {
  expect(process.platform).toBe("darwin")
  const read = async () => {
    const child = Bun.spawn(["/usr/sbin/ioreg", "-r", "-k", "AppleClamshellCausesSleep", "-d", "1"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    const value = output.match(/"AppleClamshellCausesSleep"\s*=\s*(Yes|No)/)?.[1]
    expect(value).toBeDefined()
    return value
  }
  const before = await read()
  try {
    const armed = setClamshellSleepDisabled(true)
    console.log(`arm: ${JSON.stringify(armed)}`)
    expect(armed.ok).toBe(true)
    const during = await read()
    console.log(`AppleClamshellCausesSleep: before=${before}, armed=${during}`)
    if (before === during)
      console.log("No observable flip; lid polarity and physical lid-close behavior remain unverified.")
  } finally {
    const restored = setClamshellSleepDisabled(false)
    console.log(`disarm: ${JSON.stringify(restored)}`)
    expect(restored.ok).toBe(true)
    console.log(`AppleClamshellCausesSleep: restored=${await read()}`)
  }
}, 30_000)
