import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { v5Server } from "./fixture/v5-server"

test("the Node frontend authenticates the binary local socket and releases it after settlement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-node-v5-"))
  const server = v5Server(() => ({
    data: { healthy: true, pid: process.pid, version: "fixture", sourceEpoch: "source-1" },
  }))
  try {
    const bundle = await Bun.build({
      entrypoints: [path.join(import.meta.dirname, "fixture/client-node.ts")],
      target: "node",
      format: "esm",
      outdir: directory,
    })
    expect(bundle.success, bundle.logs.map(String).join("\n")).toBe(true)
    const child = Bun.spawn(["node", bundle.outputs[0].path, server.url], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ healthy: true, pid: process.pid, version: "fixture" })
    expect(server.authorizations).toEqual([
      `Basic ${Buffer.from("node-owner:synthetic-node-secret").toString("base64")}`,
    ])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
