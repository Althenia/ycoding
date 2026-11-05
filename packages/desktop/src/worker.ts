import { createInterface } from "node:readline"
import path from "node:path"
import { BackendController } from "./backend-controller"
import { DesktopError } from "./contract"
import { readPreferences, savePreferences, validateSelection } from "./preferences"

type ControllerLaunch = Pick<NonNullable<ConstructorParameters<typeof BackendController>[1]>, "env" | "launch">

export async function runDesktopWorker(options: {
  resources: string
  preferences: string
  controller?: ControllerLaunch
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}) {
  const source = options.input ?? process.stdin
  const sink = options.output ?? process.stdout
  if (!path.isAbsolute(options.resources) || !path.isAbsolute(options.preferences)) throw new Error("Native resource and preference paths must be absolute.")
  let closing = false
  let deliveryFailed = false
  let starting = false
  let notice: string | undefined
  let serial = Promise.resolve()
  const writes = new Set<(error: Error) => void>()
  const input = createInterface({ input: source, terminal: false, crlfDelay: Infinity })
  const send = (value: unknown) => {
    const pending = serial.then(() => new Promise<void>((resolve, reject) => {
      if (closing) { reject(new Error("Native output closed before delivery.")); return }
      let settled = false
      const failed = (error: Error) => { if (settled) return; settled = true; writes.delete(failed); reject(error) }
      writes.add(failed)
      sink.write(JSON.stringify(value) + "\n", (error) => {
        if (settled) return
        settled = true
        writes.delete(failed)
        if (error) reject(new Error("Native output delivery failed.")); else resolve()
      })
    }))
    serial = pending
    return pending
  }
  const failDelivery = () => { deliveryFailed = true; input.close() }
  const controller = new BackendController(options.resources, {
    ...options.controller,
    onState: (state) => { if (!closing) void send({ type: "state", data: { ...state, ...(notice ? { notice } : {}) } }).catch(failDelivery) },
    onEvent: (event) => closing ? undefined : send({ type: "event", data: event }),
  })
  const pending = new Set<Promise<void>>()
  const close = () => {
    if (writes.size) deliveryFailed = true
    closing = true
    for (const reject of [...writes]) reject(new Error("Native output closed before delivery."))
  }
  source.once("end", close)
  try {
    for await (const line of input) {
      if (closing) break
      if (line.length > 8 * 1024 * 1024) throw new Error("Native request exceeds its input limit.")
      const request: unknown = JSON.parse(line)
      if (typeof request !== "object" || request === null || !("id" in request) || !Number.isSafeInteger(request.id) ||
        !("operation" in request) || typeof request.operation !== "string" || Object.keys(request).some((key) => !["id", "operation", "input"].includes(key)))
        throw new Error("Invalid native desktop request.")
      const task = (async () => {
        try {
          let data: unknown
          const input = "input" in request ? request.input : undefined
          switch (request.operation) {
            case "preferences": data = await readPreferences(options.preferences); break
            case "state": data = { ...controller.state(), ...(notice ? { notice } : {}) }; break
            case "connect": {
              if (starting) throw new DesktopError("A backend connection is pending. Cancel it before changing backend.")
              const selection = validateSelection(input)
              starting = true
              try {
                notice = undefined
                try { await savePreferences(options.preferences, selection) } catch { notice = "Backend choice was not saved. This connection is for this launch only." }
                data = { ...await controller.connect(selection), ...(notice ? { notice } : {}) }
              } finally { starting = false }
              break
            }
            case "disconnect": await controller.disconnect(); data = null; break
            case "sessions": data = await controller.sessions(input); break
            case "session": data = await controller.session(input); break
            case "pin": data = await controller.pin(input); break
            case "workspaces": data = await controller.workspaces(); break
            case "messages": data = await controller.messages(input); break
            case "create-session": data = await controller.createSession(input); break
            case "prompt": data = await controller.prompt(input); break
            case "interrupt": data = await controller.interrupt(input); break
            case "requests": data = await controller.requests(input); break
            case "reply": data = await controller.reply(input); break
            case "models": data = await controller.models(input); break
            case "switch-model": data = await controller.switchModel(input); break
            default: throw new DesktopError("Unsupported native desktop operation.")
          }
          if (!closing) await send({ type: "reply", id: request.id, data })
        } catch (error) {
          if (!closing) await send({ type: "reply", id: request.id, error: error instanceof DesktopError ? error.message : "Native desktop request failed." })
        }
      })()
      pending.add(task)
      void task.catch(failDelivery).finally(() => pending.delete(task))
    }
  } finally {
    close()
    source.off("end", close)
    input.close()
    await controller.disconnect()
    await Promise.allSettled(pending)
    await serial.catch(() => { deliveryFailed = true })
  }
  if (deliveryFailed) throw new Error("Native desktop output closed before delivery completed.")
}
