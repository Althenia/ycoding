import { once } from "node:events"
import { watch, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import os from "node:os"
import path from "node:path"

export async function listHelperWindows(application: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-helper-test-"))
  const ready = new AbortController()
  try {
    const events = watch(directory, { signal: ready.signal })
    const published = (async () => {
      for await (const event of events) if (event.filename === "pid") return
    })()
    published.catch(() => undefined)
    const input = path.join(directory, "service.json")
    await writeFile(input, JSON.stringify({ action: "service", controlDirectory: directory, ownerPID: process.pid }), {
      mode: 0o600,
    })
    const opened = Bun.spawn(["/usr/bin/open", "-n", "-g", "-a", application, "--args", input], {
      stdout: "ignore",
      stderr: "pipe",
    })
    if ((await opened.exited) !== 0) throw new Error(await new Response(opened.stderr).text())
    const deadline = setTimeout(() => ready.abort(), 10_000)
    try {
      await published
    } finally {
      clearTimeout(deadline)
      ready.abort()
    }
    const connection = createConnection(path.join(directory, "computer-use.sock"))
    await once(connection, "connect")
    const send = (id: number, method: string, params: unknown) =>
      new Promise<Buffer>((resolve, reject) => {
        let output = Buffer.alloc(0)
        const cleanup = () => {
          clearTimeout(timeout)
          connection.off("data", data)
          connection.off("error", error)
          connection.off("close", closed)
        }
        const error = (cause: Error) => {
          cleanup()
          reject(cause)
        }
        const closed = () => error(new Error("Native helper closed before its response"))
        const data = (chunk: Buffer) => {
          output = Buffer.concat([output, chunk])
          if (output.length < 4 || output.length < output.readUInt32LE(0) + 4) return
          cleanup()
          resolve(output.subarray(4))
        }
        const timeout = setTimeout(() => error(new Error("Native helper response deadline expired")), 10_000)
        connection.on("data", data).once("error", error).once("close", closed)
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        const header = Buffer.alloc(4)
        header.writeUInt32LE(body.length)
        connection.write(Buffer.concat([header, body]))
      })
    try {
      const response = JSON.parse(
        (
          await send(1, "request", {
            request: { action: "desktop.list", owner: { sessionID: "ses_placement", callID: "call_placement" } },
            deadlineUnixMilliseconds: Date.now() + 10_000,
          })
        ).toString(),
      ) as {
        result: { status: string; action: string; apps?: { windows: { placement: string; on_screen: boolean }[] }[] }
      }
      await send(2, "shutdown", {})
      return response.result
    } finally {
      connection.destroy()
    }
  } finally {
    ready.abort()
    const pid = Number(await readFile(path.join(directory, "pid"), "utf8").catch(() => ""))
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
}
