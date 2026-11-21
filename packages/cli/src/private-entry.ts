import { spawn } from "node:child_process"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Socket } from "node:net"
import { runtimeEnvironment, runtimeExecutable } from "./runtime-executable"

export async function runPrivateEntry() {
  const args = process.argv.slice(2)
  if (args[0] === "plugin-host") {
    const { run } = await import("./plugin-host/main")
    await run()
    return true
  }
  if (args[0] !== "-e") return false
  process.exitCode = await runRegexWorker(args)
  return true
}

export async function runRegexWorker(args: ReadonlyArray<string>) {
  const token = randomBytes(32).toString("hex")
  const sockets = new Set<Socket>()
  let admitted = false
  const owner = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    let frame = Buffer.alloc(0)
    const receive = (bytes: Buffer) => {
      frame = Buffer.concat([frame, bytes])
      if (frame.length > 65) return socket.destroy()
      if (!frame.includes(10)) return
      if (admitted || frame.length !== 65 || frame[64] !== 10 ||
          !timingSafeEqual(frame.subarray(0, 64), Buffer.from(token))) return socket.destroy()
      admitted = true
      socket.off("data", receive)
      socket.write("ok\n")
    }
    socket.on("data", receive)
  })
  owner.maxConnections = 8
  const failures: unknown[] = []
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> | undefined
  const signal = (name: NodeJS.Signals) => { child?.kill(name) }
  const interrupt = () => signal("SIGINT")
  const terminate = () => signal("SIGTERM")
  try {
    await new Promise<void>((resolve, reject) => {
      owner.once("error", reject)
      owner.listen(0, "127.0.0.1", () => { owner.off("error", reject); resolve() })
    })
    const address = owner.address()
    if (!address || typeof address === "string") throw new Error("The regex owner lease has no loopback address")
    const executable = await runtimeExecutable()
    child = spawn(executable, [...args], {
      env: { ...runtimeEnvironment(), YCODING_REGEX_OWNER: `127.0.0.1:${address.port}`, YCODING_REGEX_TOKEN: token },
      stdio: "inherit", shell: false, windowsHide: true,
    })
    let spawnError: Error | undefined
    child.once("error", (cause) => { spawnError = cause })
    closed = new Promise((resolve) => child!.once("close", (code, signal) => resolve({ code, signal, error: spawnError })))
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    const failed = new Promise<never>((_resolve, reject) => owner.once("error", reject))
    const result = await Promise.race([closed, failed])
    if (result.error) throw result.error
    if (result.signal) throw new Error(`Native regex worker terminated by ${result.signal}`)
    if (result.code === null) throw new Error("Native regex worker did not report an exit status")
    return result.code
  } catch (cause) {
    failures.push(cause)
    return 1
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
    for (const socket of sockets) socket.destroy()
    try {
      if (owner.listening) await new Promise<void>((resolve, reject) => owner.close((cause) => cause ? reject(cause) : resolve()))
    } catch (cause) { failures.push(cause) }
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      if (closed) await closed
    } catch (cause) { failures.push(cause) }
    if (failures.length) throw new AggregateError(failures, "Native regex worker failed")
  }
}
