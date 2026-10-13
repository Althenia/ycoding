import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { validateDescriptor } from "../src/discovery"

test("native meeting discovery refuses public hosts and malformed credentials", () => {
  expect(() => validateDescriptor({ url: "http://example.org:9000", token: "x".repeat(64), pid: 12 })).toThrow()
  expect(() => validateDescriptor({ url: "http://127.0.0.1:9000", token: "short", pid: 12 })).toThrow()
  expect(validateDescriptor({ url: "http://127.0.0.1:9000", token: "a".repeat(64), pid: 12 }).pid).toBe(12)
})

test("Meeting discovery isolates beta while keeping the canonical Location key and stable layout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-discovery-"))
  const project = path.join(directory, "project")
  const alias = path.join(directory, "alias")
  await mkdir(project)
  await symlink(project, alias)
  try {
    const values = [
      { channel: "local", location: project, data: path.join(directory, "data"), namespace: "ycoding" },
      { channel: "beta", location: project, data: path.join(directory, "data"), namespace: "ycoding-beta" },
      { channel: "latest", location: alias, data: path.join(directory, "data"), namespace: "ycoding" },
      { channel: "beta", location: alias, data: undefined, namespace: "ycoding-beta" },
    ].map((input) => {
      const env = { ...process.env, HOME: directory, YCODING_CHANNEL: input.channel, XDG_DATA_HOME: input.data }
      if (input.data === undefined) delete env.XDG_DATA_HOME
      const output = spawnSync(
        process.execPath,
        [
          "-e",
          `const { meetingDirectory } = await import(${JSON.stringify(import.meta.resolve("../src/discovery"))}); console.log(await meetingDirectory(${JSON.stringify(input.location)}))`,
        ],
        { env, encoding: "utf8", timeout: 10_000 },
      )
      expect(output.error).toBeUndefined()
      expect(output.status).toBe(0)
      const value = output.stdout.trim()
      expect(path.dirname(value)).toBe(
        path.join(input.data ?? path.join(directory, ".local", "share"), input.namespace, "meeting"),
      )
      expect(path.basename(value)).toMatch(/^[a-f0-9]{32}$/)
      return value
    })
    expect(new Set(values.map((value) => path.basename(value))).size).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
