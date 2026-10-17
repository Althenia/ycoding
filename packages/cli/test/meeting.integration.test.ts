import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { meetingDirectory } from "../src/services/meeting"

const cli = path.resolve(import.meta.dir, "../src/tui.ts")
const cwd = path.resolve(import.meta.dir, "..")

test("ycoding meeting starts the runtime, arms a meeting, serves the live view and finalizes an active recording on interrupt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-cli-"))
  const project = path.join(root, "project")
  const data = path.join(root, "data")
  const config = path.join(root, "config")
  await Promise.all([mkdir(project), mkdir(data), mkdir(config)])
  const env = { ...process.env, XDG_DATA_HOME: data, YCODING_CONFIG_DIR: config, YCODING_DISABLE_MODELS_FETCH: "1" }
  const meeting = await meetingDirectory(project, data)
  await mkdir(meeting, { recursive: true, mode: 0o700 })
  const worker = path.join(root, "worker.cjs")
  await writeFile(worker, protocolWorker, { mode: 0o700 })
  await writeFile(path.join(meeting, "settings.json"), JSON.stringify({ transcription: { pythonExecutable: worker } }))
  const first = run(["meeting", project, "--no-open"], env)
  try {
    const links: { view?: string; owner?: string; warned?: boolean } = {}
    await line(first, (text) => {
      const view = /^Live page: (http:\/\/127\.0\.0\.1:\d+\/view#key=[0-9a-f]{64})$/.exec(text)?.[1]
      const owner = /^Owner settings: (http:\/\/127\.0\.0\.1:\d+\/view#key=[0-9a-f]{64}&owner=[0-9a-f]{64})$/.exec(
        text,
      )?.[1]
      if (view) links.view = view
      if (owner) links.owner = owner
      if (text.startsWith("Keep the owner settings link private")) links.warned = true
      return text.startsWith("Start recording from the live page") ? true : undefined
    })
    expect(links.view).toBeDefined()
    expect(links.owner).toBeDefined()
    expect(links.warned).toBe(true)
    const view = new URL(links.view!)
    const owner = new URL(links.owner!)
    const key = new URLSearchParams(view.hash.slice(1)).get("key")!
    const ownerKey = new URLSearchParams(owner.hash.slice(1)).get("owner")!
    expect(owner.origin).toBe(view.origin)
    expect(new URLSearchParams(owner.hash.slice(1)).get("key")).toBe(key)
    expect(new URLSearchParams(view.hash.slice(1)).has("owner")).toBe(false)
    expect(ownerKey).not.toBe(key)
    const settings = (credential: string) =>
      fetch(new URL("/view/owner/settings", view), {
        headers: { origin: view.origin, authorization: `Bearer ${credential}` },
      })
    expect((await settings(key)).status).toBe(401)
    expect((await settings(ownerKey)).status).toBe(200)
    const state = await fetch(new URL("/view/state", view), { headers: { authorization: `Bearer ${key}` } })
    expect(state.status).toBe(200)
    const body = (await state.json()) as {
      meeting?: { id?: string; status?: string }
      health?: { status?: string }
    }
    expect(body.meeting?.status).toBe("ready")
    expect(body.health?.status).toBe("ready")
    expect(body).not.toHaveProperty("pairing")
    expect(JSON.stringify(body)).not.toContain(ownerKey)
    expect((await fetch(new URL("/view/state", view))).status).toBe(401)

    const capture = (payload: unknown) =>
      fetch(new URL("/view/capture", view), {
        method: "POST",
        headers: { origin: view.origin, "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      })
    const started = await capture({ type: "start", captureID: "cli-test", microphone: false, consent: true })
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
    expect((await stat(path.join(meeting, "meetings.redb"))).isFile()).toBe(true)
    const restarted = run(["meeting", project, "--no-open"], env)
    try {
      const address = new URL(
        await line(
          restarted,
          (text) => /^Live page: (http:\/\/127\.0\.0\.1:\d+\/view#key=[0-9a-f]{64})$/.exec(text)?.[1],
        ),
      )
      const restored = await fetch(new URL("/view/state", address), {
        headers: { authorization: `Bearer ${address.hash.slice("#key=".length)}` },
      })
      expect(restored.status).toBe(200)
      const state = (await restored.json()) as { meetings: { id: string; status: string }[] }
      expect(state.meetings.find((meeting) => meeting.id === body.meeting?.id)?.status).toBe("stopped")
      restarted.kill("SIGINT")
      expect(await exit(restarted)).toBe(130)
    } finally {
      if (restarted.exitCode === null) restarted.kill("SIGKILL")
    }
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
