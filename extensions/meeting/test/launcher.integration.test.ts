import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { launchEnvironment } from "../script/dev"

const root = path.resolve(import.meta.dir, "../../..")

test("the source launcher's private server starts from an ordinary project directory", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-project-"))
  const data = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-data-"))
  const launch = await launchEnvironment()
  const server = spawn(
    process.execPath,
    [path.join(root, "packages/cli/src/index.ts"), "serve", "--stdio", "--port", "0"],
    {
      cwd: project,
      env: { ...launch.env, XDG_DATA_HOME: data, YCODING_PASSWORD: "launcher-test" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  )
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      createInterface({ input: server.stdout }).once("line", resolve)
      server.once("exit", () => reject(new Error("Standalone server exited before reporting readiness")))
    })
    expect(JSON.parse(ready)).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) })
  } finally {
    server.stdin.end()
    const timer = setTimeout(() => server.kill("SIGKILL"), 10000)
    await exited
    clearTimeout(timer)
    await Promise.all(
      [project, data, launch.directory].map((directory) => rm(directory, { recursive: true, force: true })),
    )
  }
}, 60000)
