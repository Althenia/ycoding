import { createInterface } from "node:readline"
import path from "node:path"
import { BackendController } from "./backend-controller"
import { DesktopError } from "./contract"
import { readPreferences, savePreferences, validateSelection } from "./preferences"
import { externalURL } from "./rpc"

type ControllerLaunch = Pick<NonNullable<ConstructorParameters<typeof BackendController>[1]>, "env" | "launch" | "fetch">

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
  let generation = 0
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
    generation++
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
            case "browse-directory": case "browseDirectory": data = await controller.browseDirectory(input); break
            case "open-directory": case "openDirectory": data = await controller.openDirectory(input); break
            case "create-directory": case "createDirectory": data = await controller.createDirectory(input); break
            case "pick-directory": case "pickDirectory": throw new DesktopError("Native folder dialog is unavailable in headless worker mode; use Browse folders.")
            case "quit": throw new DesktopError("Quitting the native app is unavailable in headless worker mode.")
            case "notify": throw new DesktopError("Native notifications are unavailable in headless worker mode.")
            case "open-external-url": case "openExternalUrl": externalURL(input); throw new DesktopError("External browser launch is unavailable in headless worker mode.")
            case "integrations": data = await controller.integrations(input); break
            case "manage-integration": case "manageIntegration": data = await controller.manageIntegration(input); break
            case "mcp-servers": case "mcpServers": data = await controller.mcpServers(input); break
            case "manage-mcp": case "manageMcp": data = await controller.manageMcp(input); break
            case "manage-session": case "manageSession": data = await controller.manageSession(input); break
            case "vcs-diff": case "vcsDiff": data = await controller.vcsDiff(input); break
            case "system-snapshot": case "systemSnapshot": data = await controller.systemSnapshot(input); break
            case "manage-system": case "manageSystem": data = await controller.manageSystem(input); break
            case "preferences": data = await readPreferences(options.preferences); break
            case "restartBackend": data = await controller.restartBackend(input); break
            case "editorSelection": data = await controller.editorSelection(input); break
            case "editDraft": data = await controller.editDraft(input); break
            case "state": data = { ...controller.state(), ...(notice ? { notice } : {}) }; break
            case "connect": {
              if (starting) throw new DesktopError("A backend connection is pending. Cancel it before changing backend.")
              const selection = validateSelection(input)
              starting = true
              const attempt = ++generation
              try {
                notice = undefined
                try { await savePreferences(options.preferences, selection) } catch { notice = "Backend choice was not saved. This connection is for this launch only." }
                if (attempt !== generation || closing) throw new DesktopError("Backend connection was cancelled.")
                data = { ...await controller.connect(selection), ...(notice ? { notice } : {}) }
              } finally { starting = false }
              break
            }
            case "disconnect": generation++; await controller.disconnect(); data = null; break
            case "sessions": data = await controller.sessions(input); break
            case "session": data = await controller.session(input); break
            case "autonomy": data = await controller.autonomy(input); break
            case "setAutonomy": data = await controller.setAutonomy(input); break
            case "autonomyDefaults": data = await controller.autonomyDefaults(); break
            case "setAutonomyDefaults": data = await controller.setAutonomyDefaults(input); break
            case "file-changes": data = await controller.fileChanges(input); break
            case "activity": data = await controller.activity(input); break
            case "shellOutput": data = await controller.shellOutput(input); break
            case "projects": data = await controller.projects(input); break
            case "workspaceDirectories": data = await controller.workspaceDirectories(input); break
            case "settings": data = await controller.settings(); break
            case "changeSettings": data = await controller.changeSettings(input); break
            case "changeProject": data = await controller.changeProject(input); break
            case "changeWorkspace": data = await controller.changeWorkspace(input); break
            case "usage": data = await controller.usage(input); break
            case "usageDashboard": data = await controller.usageDashboard(input); break
            case "incidents": data = await controller.incidents(input); break
            case "manageIncident": data = await controller.manageIncident(input); break
            case "appendTelemetry": data = await controller.appendTelemetry(input); break
            case "telemetryConsent": data = await controller.telemetryConsent(); break
            case "revert": data = await controller.revert(input); break
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
            case "command": data = await controller.command(input); break
            case "compact": data = await controller.compact(input); break
            case "composer-catalog": data = await controller.composerCatalog(input); break
            case "find-files": data = await controller.findFiles(input); break
            case "sessionSnapshot": data = await controller.sessionSnapshot(input); break
            case "pendingInputs": data = await controller.pendingInputs(input); break
            case "sessionRecall": data = await controller.sessionRecall(input); break
            case "removePending": data = await controller.removePending(input); break
            case "steerPending": data = await controller.steerPending(input); break
            case "deleteMessage": data = await controller.deleteMessage(input); break
            case "sessionAttachment": data = await controller.sessionAttachment(input); break
            case "sessionInsights": data = await controller.sessionInsights(input); break
            case "switchAgent": data = await controller.switchAgent(input); break
            case "activateSkill": data = await controller.activateSkill(input); break
            case "runShell": data = await controller.runShell(input); break
            case "sendEditorContext": data = await controller.sendEditorContext(input); break
            case "openSideChat": data = await controller.openSideChat(input); break
            case "steerParent": data = await controller.steerParent(input); break
            case "prediction": data = await controller.prediction(input); break
            case "promptGenerate": data = await controller.promptGenerate(input); break
            case "terminals": data = await controller.terminals(input); break
            case "terminal": data = await controller.terminal(input); break
            case "terminalConnect": data = await controller.terminalConnect(input); break
            case "terminalRead": data = await controller.terminalRead(input); break
            case "terminalWrite": data = await controller.terminalWrite(input); break
            case "terminalClose": data = await controller.terminalClose(input); break
            case "terminalControl": data = await controller.terminalControl(input); break
            case "terminalResize": data = await controller.terminalResize(input); break
            case "exportSession": data = await controller.exportSession(input); break
            case "saveExportSession": throw new DesktopError("Saving exports to a folder is unavailable in this runtime. Copy the export instead.")
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
    await controller.disconnect()
    await serial.catch(() => { deliveryFailed = true })
  }
  if (deliveryFailed) throw new Error("Native desktop output closed before delivery completed.")
}
