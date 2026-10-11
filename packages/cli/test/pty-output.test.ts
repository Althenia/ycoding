import { expect, test } from "bun:test"
import { ptyOutput } from "./pty-output"

test("resolves pending and new markers from PTY output delivered after process exit", async () => {
  const output = ptyOutput()
  output.data(Buffer.from("READY\r\n"))
  const pending = output.waitFor("TERMIOS=")
  const exited = Promise.withResolvers<number>()
  exited.resolve(0)
  expect(await exited.promise).toBe(0)
  const afterExit = output.waitFor("CANCELED=")
  output.data(Buffer.from("CANCELED=Canceled\r\nTERMIOS=restored\r\n"))
  output.exit(0)
  expect(await pending).toBe("READY\r\nCANCELED=Canceled\r\nTERMIOS=restored\r\n")
  expect(await afterExit).toContain("CANCELED=Canceled")
  expect(await output.waitFor("TERMIOS=")).toContain("TERMIOS=restored")
})

test.each([0, 1])("rejects missing markers only when the PTY stream ends with status %i", async (status) => {
  const output = ptyOutput()
  output.data(Buffer.from("READY\r\n"))
  const pending = output.waitFor("TERMIOS=")
  let settled = false
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Promise.resolve()
  expect(settled).toBe(false)
  output.exit(status)
  expect(pending).rejects.toThrow(`PTY ended ${status} waiting for TERMIOS=; saw "READY\\r\\n"`)
  expect(output.waitFor("CANCELED=")).rejects.toThrow(`PTY ended ${status} waiting for CANCELED=`)
})

test("rejects pending and new markers when explicitly closed", () => {
  const output = ptyOutput()
  const pending = output.waitFor("TERMIOS=")
  output.close()
  expect(pending).rejects.toThrow("terminal closed")
  expect(output.waitFor("TERMIOS=")).rejects.toThrow("terminal closed")
})
