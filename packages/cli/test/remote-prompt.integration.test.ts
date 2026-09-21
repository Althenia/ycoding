import { describe, expect, test } from "bun:test"
import path from "node:path"

// Integration proof for the remote enrollment prompt: a real pseudo-terminal
// runs the module exactly as the CLI does, and a real pipe covers the
// non-interactive branch. Values are synthetic; nothing here is a secret.

const fixture = path.join(import.meta.dir, "remote-prompt-pty.fixture.ts")
const cwd = path.resolve(import.meta.dir, "..")
const timeout = 15_000
const echoBit = 0x8 // POSIX ECHO; identical on Linux and Darwin, the platforms this PTY suite runs on.
const ptyTest = process.platform === "win32" ? test.skip : test

describe("remote-prompt hidden input (integration)", () => {
  ptyTest(
    "does not echo typed input and restores the terminal",
    async () => {
      const session = startPty()
      try {
        expect(session.localFlags() & echoBit).toBe(echoBit)
        await session.waitFor("Enrollment code: ")
        expect(session.localFlags() & echoBit).toBe(0)
        await Bun.sleep(150)
        session.write(`${secret("7Q4")}\r`)
        const output = await session.waitFor("TERMIOS=")
        expect(before(output, "RESULT=")).not.toContain(secret("7Q4"))
        expect(output).toContain(`RESULT=${secret("7Q4")}`)
        expect(output).toContain("TERMIOS=restored")
        expect(session.localFlags() & echoBit).toBe(echoBit)
        expect(await session.exited).toBe(0)
      } finally {
        session.close()
      }
    },
    timeout,
  )

  ptyTest(
    "deletes the previous character on backspace",
    async () => {
      const session = startPty()
      try {
        await session.waitFor("Enrollment code: ")
        await Bun.sleep(150)
        session.write("SYNTHETIC-CX\u007fODE\r")
        const output = await session.waitFor("TERMIOS=")
        expect(output).toContain("RESULT=SYNTHETIC-CODE")
        expect(output).toContain("TERMIOS=restored")
        expect(await session.exited).toBe(0)
      } finally {
        session.close()
      }
    },
    timeout,
  )

  ptyTest(
    "cancels with a Canceled error on Ctrl-C and restores the terminal",
    async () => {
      const session = startPty()
      try {
        await session.waitFor("Enrollment code: ")
        await Bun.sleep(150)
        session.write("SYNTHETIC\u0003")
        const output = await session.waitFor("TERMIOS=")
        expect(output).toContain("CANCELED=Canceled")
        expect(output).not.toContain("RESULT=")
        expect(output).toContain("TERMIOS=restored")
        expect(session.localFlags() & echoBit).toBe(echoBit)
        expect(await session.exited).toBe(0)
      } finally {
        session.close()
      }
    },
    timeout,
  )

  test(
    "reads a piped value to the end, trims it, and writes no prompt",
    async () => {
      const child = Bun.spawn([process.execPath, fixture], {
        cwd,
        stdin: new Blob(["  SYNTHETIC-CODE-9Z  \n"]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(0)
      expect(stdout).toContain("RESULT=SYNTHETIC-CODE-9Z")
      expect(stderr).toBe("")
    },
    timeout,
  )
})

const secret = (suffix: string) => `SYNTHETIC-CODE-${suffix}`

function before(output: string, marker: string) {
  const index = output.indexOf(marker)
  return index === -1 ? output : output.slice(0, index)
}

function startPty() {
  const output: string[] = []
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data(_terminal, data) {
      output.push(Buffer.from(data).toString("utf8"))
    },
  })
  const child = Bun.spawn([process.execPath, fixture], {
    cwd,
    terminal,
    env: { ...process.env, TERM: "xterm-256color" },
  })
  return {
    localFlags: () => terminal.localFlags,
    exited: child.exited,
    write: (data: string) => terminal.write(data),
    close: () => {
      child.kill()
      terminal.close()
    },
    async waitFor(marker: string) {
      const deadline = Date.now() + timeout
      while (!output.join("").includes(marker)) {
        if (Date.now() >= deadline)
          throw new Error(`timed out waiting for ${marker}; saw ${JSON.stringify(output.join(""))}`)
        await Bun.sleep(10)
      }
      return output.join("")
    },
  }
}
