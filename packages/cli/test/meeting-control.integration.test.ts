import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { connectControl, meetingDirectory } from "../src/services/meeting"

test.each(["local", "beta"])("Meeting discovery defaults to the compiled installation channel %s", async (channel) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-meeting-channel-"))
  try {
    const entrypoint = path.join(root, "entry.ts")
    await writeFile(
      entrypoint,
      `import { meetingDirectory } from ${JSON.stringify(path.resolve(import.meta.dirname, "../src/services/meeting.ts"))}; console.log(await meetingDirectory(${JSON.stringify(root)}, ${JSON.stringify(path.join(root, "data"))}));`,
    )
    const build = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      define: { YCODING_CHANNEL: JSON.stringify(channel) },
    })
    expect(build.success).toBe(true)
    const executable = path.join(root, "discovery.mjs")
    await Bun.write(executable, build.outputs[0])
    const output = Bun.spawnSync([process.execPath, executable], {
      env: { ...process.env, YCODING_CHANNEL: channel === "beta" ? "local" : "beta" },
    })
    expect(output.exitCode, output.stderr.toString()).toBe(0)
    expect(path.dirname(output.stdout.toString().trim())).toBe(
      path.join(root, "data", channel === "beta" ? "ycoding-beta" : "ycoding", "meeting"),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["local", "beta"])(
  "Meeting frontend discovers the private Rust bridge for %s and sends authenticated control",
  async (channel) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-meeting-control-"))
    const requests: { authorization: string | null; payload: unknown }[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        requests.push({ authorization: request.headers.get("authorization"), payload: await request.json() })
        return Response.json({ meeting: { status: "ready" } })
      },
    })
    try {
      const directory = await meetingDirectory(root, path.join(root, "data"), channel)
      expect(path.dirname(directory)).toBe(
        path.join(root, "data", channel === "beta" ? "ycoding-beta" : "ycoding", "meeting"),
      )
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(
        path.join(directory, "bridge.json"),
        JSON.stringify({ url: `http://127.0.0.1:${server.port}/`, token: "a".repeat(64), pid: process.pid }),
        { mode: 0o600 },
      )
      const control = await connectControl(root, path.join(root, "data"), channel)
      expect(await control({ action: "status" })).toEqual({ meeting: { status: "ready" } })
      expect(requests).toEqual([{ authorization: `Bearer ${"a".repeat(64)}`, payload: { action: "status" } }])
      await expect(control(undefined)).rejects.toThrow("Invalid control payload")
      await expect(control("x".repeat(1_048_576))).rejects.toThrow("Invalid control payload")
      expect(requests).toHaveLength(1)
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

for (const patch of [
  { url: "https://127.0.0.1:9000/" },
  { url: "http://localhost:9000/" },
  { url: "http://127.0.0.1:9000/control" },
  { url: "http://127.0.0.1:9000/?key=invalid" },
  { url: "http://user@127.0.0.1:9000/" },
  { token: "a".repeat(63) },
  { pid: 0 },
  { extra: true },
])
  test(`Meeting frontend rejects an invalid bridge descriptor ${JSON.stringify(patch)}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-meeting-descriptor-"))
    try {
      const directory = await meetingDirectory(root, path.join(root, "data"))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(
        path.join(directory, "bridge.json"),
        JSON.stringify({ url: "http://127.0.0.1:9000/", token: "a".repeat(64), pid: process.pid, ...patch }),
        { mode: 0o600 },
      )
      await expect(connectControl(root, path.join(root, "data"))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

test("Meeting frontend rejects symlinked, oversized and publicly readable bridge descriptors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-meeting-private-"))
  try {
    const directory = await meetingDirectory(root, path.join(root, "data"))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = path.join(root, "target.json")
    await writeFile(
      target,
      JSON.stringify({ url: "http://127.0.0.1:9000/", token: "a".repeat(64), pid: process.pid }),
      { mode: 0o600 },
    )
    const file = path.join(directory, "bridge.json")
    await symlink(target, file)
    await expect(connectControl(root, path.join(root, "data"))).rejects.toThrow("Unsafe meeting bridge descriptor")
    await rm(file)
    await writeFile(file, "x".repeat(4097), { mode: 0o600 })
    await expect(connectControl(root, path.join(root, "data"))).rejects.toThrow("Unsafe meeting bridge descriptor")
    if (process.platform !== "win32") {
      await writeFile(file, await Bun.file(target).text())
      await chmod(file, 0o644)
      await expect(connectControl(root, path.join(root, "data"))).rejects.toThrow("Unsafe meeting bridge descriptor")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Meeting frontend propagates rejected control and rejects malformed responses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-meeting-rejection-"))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const input = (await request.json()) as { action: string }
      return input.action === "status" ? new Response("rejected", { status: 403 }) : new Response("not json")
    },
  })
  try {
    const directory = await meetingDirectory(root, path.join(root, "data"))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(directory, "bridge.json"),
      JSON.stringify({ url: `http://127.0.0.1:${server.port}/`, token: "a".repeat(64), pid: process.pid }),
      { mode: 0o600 },
    )
    const control = await connectControl(root, path.join(root, "data"))
    await expect(control({ action: "status" })).rejects.toThrow("Bridge control rejected (403)")
    await expect(control({ action: "view" })).rejects.toThrow("Invalid bridge response; outcome unknown")
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
