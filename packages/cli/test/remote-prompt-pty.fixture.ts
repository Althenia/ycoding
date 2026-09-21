import { readHidden } from "../src/remote-prompt"

// Interactive driver for the remote enrollment prompt. The integration test
// spawns this under a real pseudo-terminal (or a pipe) so `readHidden` runs
// exactly as it does for a user, then reports what the terminal observed.
const termios = () =>
  Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()

if (process.stdin.isTTY) {
  const before = termios()
  try {
    process.stdout.write(`\nRESULT=${await readHidden("Enrollment code: ")}\n`)
  } catch (error) {
    process.stdout.write(`\nCANCELED=${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.stdout.write(`TERMIOS=${before === termios() ? "restored" : "changed"}\n`)
} else {
  process.stdout.write(`RESULT=${await readHidden("Enrollment code: ")}\n`)
}
