import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

const cli = path.resolve(import.meta.dir, "../src/tui.ts")
const cwd = path.resolve(import.meta.dir, "..")

test("ycoding meeting starts the runtime, arms a meeting, serves the live view and finalizes an active recording on interrupt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-cli-"))
  const project = path.join(root, "project")
  const data = path.join(root, "data")
  const config = path.join(root, "config")
  await Promise.all([mkdir(project), mkdir(data), mkdir(config)])
  const env = { ...process.env, XDG_DATA_HOME: data, YCODING_CONFIG_DIR: config, YCODING_DISABLE_MODELS_FETCH: "1" }
  const { meetingDirectory } = await import("@ycoding-ai/meeting/discovery")
  const meeting = await withEnv({ XDG_DATA_HOME: data }, () => meetingDirectory(project))
  await mkdir(meeting, { recursive: true, mode: 0o700 })
  const worker = path.join(root, "worker")
  await writeFile(worker, protocolWorker, { mode: 0o700 })
  await writeFile(path.join(meeting, "settings.json"), JSON.stringify({ transcription: { pythonExecutable: worker } }))
  const first = run(["meeting", project, "--no-open"], env)
  try {
    const url = await line(
      first,
      (text) => /^Live page: (http:\/\/127\.0\.0\.1:\d+\/view#key=[0-9a-f]{64})$/.exec(text)?.[1],
    )
    const view = new URL(url)
    const key = view.hash.slice("#key=".length)
    const state = await fetch(new URL("/view/state", view), { headers: { authorization: `Bearer ${key}` } })
    expect(state.status).toBe(200)
    const body = (await state.json()) as {
      meeting?: { id?: string; status?: string }
      health?: { status?: string }
      pairing?: { code?: string }
    }
    expect(body.meeting?.status).toBe("ready")
    expect(body.health?.status).toBe("ready")
    expect((await fetch(new URL("/view/state", view))).status).toBe(401)

    const origin = `chrome-extension://${"a".repeat(32)}`
    const capture = (route: string, payload: unknown, token?: string) =>
      fetch(new URL(route, view), {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      })
    const paired = await capture("/pair", { code: body.pairing?.code })
    expect(paired.status).toBe(200)
    const token = ((await paired.json()) as { token: string }).token
    const started = await capture(
      "/capture",
      { type: "start", captureID: "cli-test", tabID: 1, microphone: false, consent: true },
      token,
    )
    expect(started.status).toBe(200)
    const recording = await fetch(new URL("/view/state", view), { headers: { authorization: `Bearer ${key}` } })
    expect(((await recording.json()) as { meeting?: { status?: string } }).meeting?.status).toBe("recording")

    const second = run(["meeting", project, "--no-open"], env)
    const attached = await line(second, (text) =>
      text.startsWith("Using the meeting runtime already running") ? text : undefined,
    )
    expect(attached).toContain(project)
    expect(await exit(second)).toBe(0)

    first.kill("SIGINT")
    expect(await exit(first)).toBe(130)
    await expect(stat(path.join(meeting, "bridge.json"))).rejects.toMatchObject({ code: "ENOENT" })
    const store = new Database(path.join(meeting, "meetings.sqlite"), { readonly: true })
    const stored = store.query("select data from meetings where id = ?").get(body.meeting?.id ?? "") as { data: string }
    store.close()
    expect(JSON.parse(stored.data).status).toBe("stopped")
  } finally {
    if (first.exitCode === null) first.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

const protocolWorker = `#!/usr/bin/env node
const readline = require("node:readline")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  const response = request.op === "initialize" ? { metrics: { device: "cpu" } } : request.op === "health" ? { healthy: true } : request.op === "transcribe" ? { results: [] } : {}
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, ...response }) + "\\n")
})
`

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--conditions=browser", cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
}

function line<T>(child: ChildProcessWithoutNullStreams, match: (text: string) => T | undefined) {
  const errors: string[] = []
  child.stderr.on("data", (chunk) => errors.push(String(chunk)))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No matching output within 60 s\n${errors.join("")}`)), 60_000)
    createInterface({ input: child.stdout }).on("line", (text) => {
      const value = match(text)
      if (value === undefined) return
      clearTimeout(timer)
      resolve(value)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`ycoding exited with ${code} before the expected output\n${errors.join("")}`))
    })
  })
}

function exit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
}

async function withEnv<T>(values: Record<string, string>, use: () => Promise<T>) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
  Object.assign(process.env, values)
  try {
    return await use()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
