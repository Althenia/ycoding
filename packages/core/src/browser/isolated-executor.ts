export * as IsolatedBrowserExecutor from "./isolated-executor"

import { Browser } from "@ycoding-ai/schema/browser"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
import { Context, Effect, Layer, Schema } from "effect"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Readable, Writable } from "node:stream"
import { connect, type Client, type Event } from "./isolated-cdp"
import { capturePage } from "./isolated-capture"
import { makeLocationNode } from "../effect/app-node"
import { BrowserOperation } from "./operation"
import { IsolatedPageSafety } from "./isolated-page-safety"

const INSTALLED_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const CHROME =
  process.env.NODE_ENV === "test"
    ? (process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME ?? INSTALLED_CHROME)
    : INSTALLED_CHROME
const MINIMUM_CHROME_MAJOR = 152
const STARTUP_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 5_000
const TERMINATE_TIMEOUT_MS = 500
const KILL_TIMEOUT_MS = 1_000
const ACTION_SETTLE_MS = 150
const CONTROL_WORLD = "ycoding-control"
const CONTROL_STATE_POLL_MS = 500
const NETWORK_IDLE_QUIET_MS = 500
const STALE_CONTEXT = /Cannot find context|Execution context was destroyed|Inspected target navigated/

const valueRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "Date", "InputTime", "DateTime", "ColorWell"])
const inputControlRoles = new Set(["Date", "InputTime", "DateTime", "ColorWell"])
const inputControlTypes = new Set(["color", "date", "datetime-local", "month", "range", "time", "week"])

const interactiveRoles = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
])

const editableRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"])

const textRoles = new Set([
  "StaticText",
  "caption",
  "cell",
  "columnheader",
  "definition",
  "heading",
  "listitem",
  "paragraph",
  "rowheader",
  "term",
])

const namedKeys: Readonly<Record<string, { key: string; code: string; windowsVirtualKeyCode: number }>> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
}

type RefTarget = { sessionId: string; backendNodeId: number; frameId?: string; url?: string }

export class Error extends Schema.TaggedErrorClass<Error>()("IsolatedBrowser.ExecutorError", {
  message: Schema.String,
  phase: Schema.Literals(["predispatch", "postdispatch"]),
}) {}

export interface Snapshot {
  readonly title: string
  readonly url: string
  readonly documentGeneration: number
  readonly revision: number
  readonly elements: ReadonlyArray<BrowserOperation.Element>
  readonly texts?: ReadonlyArray<Browser.Text>
  readonly frames?: ReadonlyArray<Browser.Frame>
  readonly truncated: boolean
}

export interface ActionOutput {
  readonly snapshot: Omit<Snapshot, "elements" | "truncated">
  readonly capture?: Browser.CaptureOutput
  readonly rejected?: string
  readonly text?: string
  readonly logs?: ReadonlyArray<Browser.LogEntry>
  readonly data?: string
  readonly webmcpTools?: ReadonlyArray<Browser.WebMcpTool>
  readonly dialog?: Browser.DialogInfo
  readonly control?: Browser.ControlState
  readonly frame?: Browser.Page
  readonly message?: string
}

export interface Runtime {
  readonly observe: Effect.Effect<Snapshot, Error>
  readonly action: (action: Browser.Action, allowedOrigins: ReadonlyArray<string>) => Effect.Effect<ActionOutput, Error>
  readonly pause: Effect.Effect<void>
  readonly resume: Effect.Effect<void, Error>
  readonly close: Effect.Effect<void>
  readonly closed: Effect.Effect<void>
}

export interface Interface {
  readonly availability: Effect.Effect<{ readonly available: boolean; readonly reason?: string }>
  readonly launch: (input: {
    readonly instanceID: IsolatedBrowser.InstanceID
    readonly tabID: Browser.TabID
    readonly url: string
  }) => Effect.Effect<Runtime, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/IsolatedBrowserExecutor") {}

function availability() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return Effect.succeed({ available: false, reason: "Isolated browser requires macOS arm64" })
  return Effect.promise(() => chromeVersion().catch(() => undefined)).pipe(
    Effect.map((major) =>
      major !== undefined && major >= MINIMUM_CHROME_MAJOR
        ? { available: true }
        : {
            available: false,
            reason:
              major === undefined
                ? "Installed Google Chrome is unavailable"
                : `Installed Google Chrome major ${major} is unsupported; Chrome ${MINIMUM_CHROME_MAJOR} or newer is required`,
          },
    ),
  )
}

const launch: Interface["launch"] = (input) =>
  Effect.tryPromise({
    try: (signal) => launchChrome(input, signal),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error({ message: safeMessage(cause, "Failed to start isolated Chrome"), phase: "predispatch" }),
  })

async function launchChrome(
  input: { readonly instanceID: IsolatedBrowser.InstanceID; readonly tabID: Browser.TabID; readonly url: string },
  signal: AbortSignal,
): Promise<Runtime> {
  const available = await Effect.runPromise(availability())
  if (!available.available)
    throw new Error({ message: available.reason ?? "Isolated Chrome is unavailable", phase: "predispatch" })
  const root = await mkdtemp(join(tmpdir(), "ycoding-isolated-browser-"))
  const downloads = join(root, "downloads")
  await mkdir(downloads, { mode: 0o700 }).catch(async (cause) => {
    await cleanup(root)
    throw cause
  })
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--user-data-dir=${join(root, "profile")}`,
      "--remote-debugging-pipe",
      // A temporary profile needs no login keychain; without this macOS may prompt to store "Chrome Safe Storage".
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-breakpad",
      "--disable-external-intent-requests",
      "--disable-popup-blocking",
      "--deny-permission-prompts",
      "--renderer-process-limit=1",
      "--metrics-recording-only",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  )
  const readable = child.stdio[4]
  const writable = child.stdio[3]
  if (!(readable instanceof Readable) || !(writable instanceof Writable)) {
    await terminate(child)
    await cleanup(root)
    throw new Error({ message: "Chrome did not expose its private control pipe", phase: "predispatch" })
  }
  const cdp = connect(readable, writable)
  const abort = () => child.kill("SIGTERM")
  signal.addEventListener("abort", abort, { once: true })
  try {
    const version = record(await cdp.send("Browser.getVersion", {}, undefined, signal, STARTUP_TIMEOUT_MS))
    const major = typeof version.product === "string" ? /^Chrome\/(\d+)\./.exec(version.product)?.[1] : undefined
    if (major === undefined || Number(major) < MINIMUM_CHROME_MAJOR)
      throw new Error({ message: "Installed Chrome changed during startup", phase: "predispatch" })
    return await configureRuntime(cdp, child, root, input, signal)
  } catch (cause) {
    cdp.close()
    await terminate(child)
    await cleanup(root)
    throw cause instanceof Error
      ? cause
      : new Error({ message: safeMessage(cause, "Failed to configure isolated Chrome"), phase: "predispatch" })
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

async function configureRuntime(
  cdp: Client,
  child: ReturnType<typeof spawn>,
  root: string,
  input: { readonly instanceID: IsolatedBrowser.InstanceID; readonly tabID: Browser.TabID; readonly url: string },
  signal: AbortSignal,
): Promise<Runtime> {
  const initialURL = safeURL(input.url)
  const context = record(await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }, undefined, signal))
  const browserContextId = string(context.browserContextId)
  await cdp.send(
    "Browser.setDownloadBehavior",
    { behavior: "deny", browserContextId, downloadPath: join(root, "downloads"), eventsEnabled: true },
    undefined,
    signal,
  )
  await denyClipboard(cdp, browserContextId, initialURL.origin, signal)
  const created = record(
    await cdp.send("Target.createTarget", { url: "about:blank", browserContextId }, undefined, signal),
  )
  const targetId = string(created.targetId)
  const attached = record(await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, signal))
  const sessionId = string(attached.sessionId)
  const heldPopupSessions = new Set<string>()
  const heldPopupRequests = new Map<string, () => void>()
  const destroyedTargets = new Map<string, () => void>()
  const popupTasks = new Set<Promise<void>>()
  const refs = new Map<string, RefTarget>()
  const frameSessions = new Map<string, { targetId: string; url: string; ready?: Promise<void>; failed?: boolean }>()
  const observedFrameOrigins = new Set<string>()
  const worlds = new Map<string, number>()
  const networkIdle = IsolatedPageSafety.createNetworkIdleTracker()
  const logs: Browser.LogEntry[] = []
  let openDialog: (Browser.DialogInfo & { readonly sessionId?: string }) | undefined
  const pushLog = (entry: Browser.LogEntry) => {
    logs.push(entry)
    if (logs.length > Browser.MAX_LOG_ENTRIES) logs.splice(0, logs.length - Browser.MAX_LOG_ENTRIES)
  }
  const consoleValue = (arg: unknown): string => {
    const value = recordMaybe(arg)
    if (!value) {
      if (arg === null || arg === undefined) return ""
      if (typeof arg === "string") return arg
      if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") return arg.toString()
      return typeof arg === "object" ? (JSON.stringify(arg) ?? "") : ""
    }
    if (value.value !== undefined) return typeof value.value === "string" ? value.value : (JSON.stringify(value.value) ?? "")
    return typeof value.description === "string" ? value.description : typeof value.type === "string" ? value.type : ""
  }
  const framePage = (eventSessionId?: string) =>
    eventSessionId && eventSessionId !== sessionId ? safePageMaybe(frameSessions.get(eventSessionId)?.url ?? "") : undefined
  let allowedOrigins = new Set([initialURL.origin])
  let mainFrameId = ""
  let documentGeneration = 1
  let revision = 0
  let initialized = false
  let paused = false
  let closing = false
  let safetyFailure: string | undefined
  let popupRejections = 0
  let downloadAttempts = 0
  let resolveFatal = () => {}
  const fatal = new Promise<void>((resolve) => {
    resolveFatal = resolve
  })

  const markFailure = (message: string) => {
    safetyFailure = safetyFailure ?? message
    paused = true
  }
  const closeTargetExactly = async (closedTargetId: string) => {
    const destroyed = new Promise<void>((resolve) => destroyedTargets.set(closedTargetId, resolve))
    try {
      await cdp.send("Target.closeTarget", { targetId: closedTargetId })
      await Promise.race([
        destroyed,
        delay(2_000).then(() => {
          throw new globalThis.Error("Target destruction was not confirmed")
        }),
      ])
    } finally {
      destroyedTargets.delete(closedTargetId)
    }
  }
  const handlePopup = async (event: Event, target: Readonly<Record<string, unknown>>) => {
    const popupSessionId = string(event.params?.sessionId)
    const popupTargetId = string(target.targetId)
    heldPopupSessions.add(popupSessionId)
    try {
      await cdp.send("Emulation.setScriptExecutionDisabled", { value: true }, popupSessionId)
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, popupSessionId)
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, popupSessionId)
      await Promise.race([new Promise<void>((resolve) => heldPopupRequests.set(popupSessionId, resolve)), delay(500)])
      await closeTargetExactly(popupTargetId)
      popupRejections++
    } catch {
      markFailure("An unexpected browser target could not be contained")
      resolveFatal()
      await closeTargetExactly(popupTargetId).catch(() => {})
    } finally {
      heldPopupSessions.delete(popupSessionId)
      heldPopupRequests.delete(popupSessionId)
    }
  }
  const handleEvent = async (event: Event) => {
    if (closing) return
    if (event.method.startsWith("Network.")) {
      if (event.sessionId) networkIdle.onEvent(event.sessionId, event.method, event.params)
      return
    }
    if (event.method === "Page.javascriptDialogOpening") {
      const kind = typeof event.params?.type === "string" ? event.params.type : "alert"
      openDialog = {
        kind: (["alert", "confirm", "prompt", "beforeunload"].includes(kind) ? kind : "alert") as Browser.DialogInfo["kind"],
        message: bounded(typeof event.params?.message === "string" ? event.params.message : "", Browser.MAX_NAME_LENGTH),
        ...(typeof event.params?.defaultPrompt === "string" && event.params.defaultPrompt
          ? { defaultPrompt: bounded(event.params.defaultPrompt, Browser.MAX_NAME_LENGTH) }
          : {}),
        sessionId: event.sessionId,
      }
      return
    }
    if (event.method === "Page.javascriptDialogClosed") {
      openDialog = undefined
      return
    }
    if (event.method === "Target.targetDestroyed") {
      const target = typeof event.params?.targetId === "string" ? event.params.targetId : undefined
      if (target) destroyedTargets.get(target)?.()
      return
    }
    if (
      (event.method === "Inspector.targetCrashed" && event.sessionId === sessionId) ||
      (event.method === "Target.targetCrashed" && event.params?.targetId === targetId)
    ) {
      markFailure("The controllable browser target crashed")
      resolveFatal()
      return
    }
    if (event.method === "Target.detachedFromTarget") {
      const detached = typeof event.params?.sessionId === "string" ? event.params.sessionId : undefined
      if (detached) {
        frameSessions.delete(detached)
        networkIdle.dropSession(detached)
        for (const key of worlds.keys()) if (key.startsWith(`${detached}|`)) worlds.delete(key)
        for (const [ref, target] of refs) if (target.sessionId === detached) refs.delete(ref)
      }
      return
    }
    if (event.method === "Target.targetInfoChanged") {
      const info = record(event.params?.targetInfo)
      for (const entry of frameSessions.values())
        if (entry.targetId === info.targetId && typeof info.url === "string") entry.url = info.url
      return
    }
    if (event.method === "Target.attachedToTarget") {
      const target = record(event.params?.targetInfo)
      if (target.targetId === targetId) return
      if (target.type === "iframe") {
        const childSessionId = string(event.params?.sessionId)
        const entry = {
          targetId: string(target.targetId),
          url: typeof target.url === "string" ? target.url : "",
          ready: undefined as Promise<void> | undefined,
          failed: false,
        }
        frameSessions.set(childSessionId, entry)
        entry.ready = (async () => {
          await Promise.all([
            cdp.send("Page.enable", {}, childSessionId),
            cdp.send("DOM.enable", {}, childSessionId),
            cdp.send("Accessibility.enable", {}, childSessionId),
            cdp.send("Runtime.enable", {}, childSessionId),
            cdp.send("Network.enable", {}, childSessionId),
          ])
          await cdp.send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] },
            childSessionId,
          ).catch(() => {})
          if (event.params?.waitingForDebugger === true) await cdp.send("Runtime.runIfWaitingForDebugger", {}, childSessionId)
        })().catch(() => {
          entry.failed = true
        })
        await entry.ready
        return
      }
      if (
        target.browserContextId === browserContextId &&
        target.type === "page" &&
        target.openerId === targetId &&
        event.params?.waitingForDebugger === true
      ) {
        await handlePopup(event, target)
        return
      }
      const unexpectedTargetId = typeof target.targetId === "string" ? target.targetId : undefined
      if (!unexpectedTargetId) {
        markFailure("An unexpected browser target could not be identified")
        resolveFatal()
        return
      }
      await closeTargetExactly(unexpectedTargetId)
      return
    }
    if (event.method === "Runtime.consoleAPICalled") {
      const frame = framePage(event.sessionId)
      pushLog({
        level: bounded(typeof event.params?.type === "string" ? event.params.type : "log", 16),
        text: bounded((Array.isArray(event.params?.args) ? event.params.args : []).map(consoleValue).join(" "), Browser.MAX_NAME_LENGTH),
        ...(frame ? { frame } : {}),
      })
      return
    }
    if (event.method === "Runtime.exceptionThrown") {
      const details = record(event.params?.exceptionDetails)
      const exception = recordMaybe(details.exception)
      const frame = framePage(event.sessionId)
      pushLog({
        level: "error",
        text: bounded([details.text, exception?.description].filter(Boolean).join(" ") || "Uncaught exception", Browser.MAX_NAME_LENGTH),
        ...(frame ? { frame } : {}),
      })
      return
    }
    if (event.method === "Fetch.requestPaused") {
      const requestId = string(event.params?.requestId)
      if (event.sessionId && heldPopupSessions.has(event.sessionId)) {
        heldPopupRequests.get(event.sessionId)?.()
        return
      }
      if (event.sessionId !== sessionId) return
      const request = record(event.params?.request)
      const url = typeof request.url === "string" ? request.url : ""
      const resourceType = event.params?.resourceType
      const frameId = event.params?.frameId
      if (resourceType === "Document" && frameId !== mainFrameId) {
        if (requestAllowed(url, false, allowedOrigins))
          await cdp.send("Fetch.continueRequest", { requestId }, sessionId)
        else await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId)
        return
      }
      const allowed = requestAllowed(url, resourceType === "Document" && frameId === mainFrameId, allowedOrigins)
      if (!allowed) {
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId)
        markFailure("A disallowed navigation or external protocol was blocked")
        return
      }
      await cdp.send("Fetch.continueRequest", { requestId }, sessionId)
      return
    }
    if (event.method === "Page.frameNavigated") {
      const frame = record(event.params?.frame)
      if (event.sessionId !== sessionId) {
        const entry = event.sessionId ? frameSessions.get(event.sessionId) : undefined
        if (entry && typeof frame.url === "string" && !frame.parentId) entry.url = frame.url
        worlds.delete(`${event.sessionId}|${stringMaybe(frame.id)}`)
        for (const [ref, target] of refs)
          if (target.sessionId === event.sessionId && (!frame.id || target.frameId === frame.id)) refs.delete(ref)
        return
      }
      if (frame.id !== mainFrameId) {
        worlds.delete(`${sessionId}|${stringMaybe(frame.id)}`)
        for (const [ref, target] of refs) if (target.frameId === frame.id) refs.delete(ref)
        return
      }
      worlds.clear()
      if (initialized) documentGeneration++
      revision = 0
      refs.clear()
      frameSessions.clear()
      logs.length = 0
      return
    }
    if (event.method === "Page.frameRequestedNavigation" && event.sessionId === sessionId) {
      const url = typeof event.params?.url === "string" ? event.params.url : ""
      if (!requestAllowed(url, true, allowedOrigins)) {
        markFailure("A disallowed navigation or external protocol was blocked")
        await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {})
      }
      return
    }
    if (event.method === "Page.fileChooserOpened" && event.sessionId === sessionId) {
      markFailure("File selection is unsupported")
      return
    }
    if (event.method === "Browser.downloadWillBegin") downloadAttempts++
  }
  const unsubscribe = cdp.subscribe((event) => {
    const task = handleEvent(event).catch(() => {
      markFailure("A browser safety guard failed")
      resolveFatal()
    })
    if (event.method !== "Target.attachedToTarget") return
    popupTasks.add(task)
    void task.finally(() => popupTasks.delete(task))
  })

  await Promise.all([
    cdp.send("Page.enable", {}, sessionId, signal),
    cdp.send("DOM.enable", {}, sessionId, signal),
    cdp.send("Accessibility.enable", {}, sessionId, signal),
    cdp.send("Runtime.enable", {}, sessionId, signal),
    cdp.send("Network.enable", {}, sessionId, signal),
    cdp.send("Inspector.enable", {}, sessionId, signal),
    cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId, signal),
    cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId, signal),
  ])
  const tree = record(await cdp.send("Page.getFrameTree", {}, sessionId, signal))
  mainFrameId = string(record(tree.frameTree).frame && record(record(tree.frameTree).frame).id)
  await cdp.send("Target.setDiscoverTargets", { discover: true }, undefined, signal)
  await cdp.send(
    "Target.setAutoAttach",
    {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page", exclude: false }, { type: "iframe", exclude: false }, { exclude: true }],
    },
    undefined,
    signal,
  )
  await cdp.send("Page.navigate", { url: initialURL.toString() }, sessionId, signal)
  await waitForDocument(cdp, sessionId, initialURL.origin, () => safetyFailure, signal)
  await delay(ACTION_SETTLE_MS, signal)
  initialized = true
  if (safetyFailure) throw new Error({ message: safetyFailure, phase: "predispatch" })

  const snapshot = async (includeElements: boolean, actionSignal?: AbortSignal): Promise<Snapshot> => {
    if (paused)
      throw new Error({ message: safetyFailure ?? "Isolated browser control is paused", phase: "predispatch" })
    const target = record(await cdp.send("Target.getTargetInfo", { targetId }, undefined, actionSignal))
    const info = record(target.targetInfo)
    const url = safeURL(string(info.url))
    if (!allowedOrigins.has(url.origin))
      throw new Error({ message: "The browser crossed its approved origin boundary", phase: "postdispatch" })
    if (!includeElements) {
      refs.clear()
      revision = 0
      return {
        title: bounded(typeof info.title === "string" ? info.title : "", Browser.MAX_TITLE_LENGTH),
        url: url.toString(),
        documentGeneration,
        revision,
        elements: [],
        truncated: false,
      }
    }
    const allowed = new Set([...allowedOrigins, ...observedFrameOrigins])
    const sessions = [
      { id: sessionId, url: url.toString(), failed: false, ready: undefined as Promise<void> | undefined },
      ...[...frameSessions.entries()].map(([id, entry]) => ({ id, url: entry.url, failed: entry.failed === true, ready: entry.ready })),
    ]
    await Promise.all(sessions.map((session) => session.ready).filter(Boolean))
    refs.clear()
    const elements: BrowserOperation.Element[] = []
    const texts: Browser.Text[] = []
    const frames: Browser.Frame[] = []
    const seen = new Set<string>()
    let candidateCount = 0
    let textCount = 0
    const collect = (node: Readonly<Record<string, unknown>>, output: { id?: string; url?: string }[]) => {
      const frame = recordMaybe(node.frame)
      if (!frame) return
      output.push({ id: stringMaybe(frame.id), url: stringMaybe(frame.url) })
      if (Array.isArray(node.childFrames)) for (const child of node.childFrames.filter(isRecord)) collect(child, output)
    }
    for (const session of sessions) {
      const main = session.id === sessionId
      let frameList: { id?: string; url?: string }[] = []
      try {
        const tree = record(await cdp.send("Page.getFrameTree", {}, session.id, actionSignal))
        collect(record(tree.frameTree), frameList)
      } catch (cause) {
        if (main) throw cause
        const page = safePageMaybe(session.url)
        if (page) frames.push({ page, observed: false })
        continue
      }
      for (const [index, frame] of frameList.entries()) {
        const top = main && index === 0
        const frameURL = frame.url || (top ? url.toString() : session.url)
        const page = safePageMaybe(frameURL)
        if (page) observedFrameOrigins.add(page.origin)
        if (!top && (!page || !allowed.has(page.origin) || session.failed)) {
          if (page) frames.push({ page, observed: false })
          continue
        }
        let ax: Readonly<Record<string, unknown>>
        try {
          ax = record(
            await cdp.send(
              "Accessibility.getFullAXTree",
              { depth: Browser.MAX_AX_DEPTH, ...(frame.id ? { frameId: frame.id } : {}) },
              session.id,
              actionSignal,
            ),
          )
        } catch (cause) {
          if (top) throw cause
          if (page) frames.push({ page, observed: false })
          continue
        }
        if (!top && page) frames.push({ page, observed: true })
        const nodes = Array.isArray(ax.nodes) ? ax.nodes.filter(isRecord) : []
        const byId = new Map(nodes.flatMap((item) => {
          const id = stringMaybe(item.nodeId)
          return id ? [[id, item] as const] : []
        }))
        const editableAncestor = (start: Readonly<Record<string, unknown>>) => {
          const seen = new Set<string>()
          let parentId = stringMaybe(start.parentId)
          while (parentId && !seen.has(parentId)) {
            seen.add(parentId)
            const parent = byId.get(parentId)
            if (!parent) return false
            if (editableRoles.has(stringMaybe(recordMaybe(parent.role)?.value) ?? "")) return true
            parentId = stringMaybe(parent.parentId)
          }
          return false
        }
        for (const node of nodes) {
          if (node.ignored === true) continue
          const role = stringMaybe(recordMaybe(node.role)?.value) ?? ""
          if (textRoles.has(role) && !editableAncestor(node)) {
            const name = (stringMaybe(recordMaybe(node.name)?.value) ?? "").trim()
            if (name) {
              textCount++
              if (texts.length < Browser.MAX_OBSERVATION_TEXTS)
                texts.push({
                  role: bounded(role, 64),
                  name: bounded(name, Browser.MAX_NAME_LENGTH),
                  ...(top || !page ? {} : { frame: page }),
                })
            }
          }
          const inputControl = inputControlRoles.has(role)
          if ((!interactiveRoles.has(role) && !inputControl) || typeof node.backendDOMNodeId !== "number") continue
          const backendNodeId = number(node.backendDOMNodeId)
          const key = `${session.id}\0${backendNodeId}`
          if (seen.has(key)) continue
          seen.add(key)
          candidateCount++
          if (elements.length >= Browser.MAX_OBSERVATION_ELEMENTS) continue
          let dom: Readonly<Record<string, unknown>>
          try {
            dom = record(record(await cdp.send("DOM.describeNode", { backendNodeId, depth: 0 }, session.id, actionSignal)).node)
          } catch {
            continue
          }
          if (fileInput(dom)) continue
          const attributes = attributesOf(dom.attributes)
          if (inputControl && !(String(dom.nodeName).toLowerCase() === "input" && inputControlTypes.has((attributes.get("type") ?? "").toLowerCase()))) {
            candidateCount--
            continue
          }
          const destination = attributes.get("href")
          const ref = `b${elements.length + 1}`
          refs.set(ref, { sessionId: session.id, backendNodeId, frameId: frame.id, url: frameURL })
          const elementName = bounded(stringMaybe(recordMaybe(node.name)?.value) ?? "", Browser.MAX_NAME_LENGTH)
          const sensitive = IsolatedPageSafety.isSensitiveAttributes(
            String(dom.nodeName),
            attributes,
            stringMaybe(recordMaybe(node.name)?.value) ?? "",
          )
          const locatorBase = BrowserOperation.makeLocator({ role: bounded(role, 64), name: elementName })
          const duplicates = elements.filter((candidate) => candidate.locator?.startsWith(locatorBase)).length
          const element = {
            ref: Browser.Element.fields.ref.make(ref),
            locator: duplicates ? BrowserOperation.makeLocator({ role: bounded(role, 64), name: elementName }, duplicates) : locatorBase,
            role: bounded(role, 64),
            name: elementName,
            ...(boundedMaybe(stringMaybe(recordMaybe(node.description)?.value), Browser.MAX_NAME_LENGTH)
              ? {
                  description: boundedMaybe(stringMaybe(recordMaybe(node.description)?.value), Browser.MAX_NAME_LENGTH),
                }
              : {}),
            ...(Array.isArray(node.properties) &&
            node.properties
              .filter(isRecord)
              .some((property) => property.name === "disabled" && recordMaybe(property.value)?.value === true)
              ? { disabled: true }
              : {}),
            ...(destination && safePageMaybe(new URL(destination, frameURL).toString())
              ? { destination: safePageMaybe(new URL(destination, frameURL).toString()) }
              : {}),
            ...axState(node, role, sensitive),
            ...(sensitive ? { sensitive: true as const } : {}),
            ...(top || !page ? {} : { frame: page }),
          } satisfies Browser.Element
          elements.push({
            ...element,
            identity: BrowserOperation.elementIdentity(frameURL, element, destination ? new URL(destination, frameURL).toString() : undefined),
          })
        }
      }
    }
    revision++
    return {
      title: bounded(typeof info.title === "string" ? info.title : "", Browser.MAX_TITLE_LENGTH),
      url: url.toString(),
      documentGeneration,
      revision,
      elements,
      texts,
      frames: frames.slice(0, Browser.MAX_OBSERVATION_FRAMES),
      truncated:
        candidateCount > Browser.MAX_OBSERVATION_ELEMENTS ||
        textCount > Browser.MAX_OBSERVATION_TEXTS ||
        frames.length > Browser.MAX_OBSERVATION_FRAMES,
    }
  }

  const mainPoint = async (target: RefTarget, quad: number[], signal: AbortSignal) => {
    const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    if (target.sessionId === sessionId) return { x: cx, y: cy }
    const owner = record(await cdp.send("DOM.getFrameOwner", { frameId: target.frameId }, sessionId, signal))
    const ownerQuads = record(
      await cdp.send("DOM.getContentQuads", { backendNodeId: number(owner.backendNodeId) }, sessionId, signal),
    )
    const frameQuad = Array.isArray(ownerQuads.quads) && Array.isArray(ownerQuads.quads[0]) ? ownerQuads.quads[0] : undefined
    if (!frameQuad || frameQuad.length < 8 || !frameQuad.every((value) => typeof value === "number"))
      throw new globalThis.Error("Element is not visible")
    const metrics = record(await cdp.send("Page.getLayoutMetrics", {}, target.sessionId, signal))
    const viewport = record(metrics.layoutViewport)
    const width = Math.max(frameQuad[2], frameQuad[4]) - Math.min(frameQuad[0], frameQuad[6])
    const height = Math.max(frameQuad[5], frameQuad[7]) - Math.min(frameQuad[1], frameQuad[3])
    const scaleX = typeof viewport.clientWidth === "number" && viewport.clientWidth > 0 ? width / viewport.clientWidth : 1
    const scaleY = typeof viewport.clientHeight === "number" && viewport.clientHeight > 0 ? height / viewport.clientHeight : 1
    return { x: Math.min(frameQuad[0], frameQuad[6]) + cx * scaleX, y: Math.min(frameQuad[1], frameQuad[3]) + cy * scaleY }
  }

  const mainWorldEvaluate = async (expression: string, signal: AbortSignal) =>
    unwrapEvaluation(
      record(await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, signal)),
    )
  const modelContextExpression = (body: string) =>
    `(async () => { const mc = (typeof document !== "undefined" && document.modelContext) || (typeof navigator !== "undefined" && navigator.modelContext) || undefined; if (!mc) return { supported: false }; ${body} })()`
  const webmcpList = async (signal: AbortSignal): Promise<Browser.WebMcpTool[]> => {
    const value = recordMaybe(
      await mainWorldEvaluate(
        modelContextExpression(
          "const tools = typeof mc.getTools === 'function' ? await mc.getTools() : (mc.tools ?? []); return { supported: true, tools: [...tools].map((tool) => ({ name: String(tool?.name ?? ''), description: String(tool?.description ?? '') })) };",
        ),
        signal,
      ),
    )
    if (!value || value.supported !== true) throw new globalThis.Error("WebMCP is not available on this page")
    return (Array.isArray(value.tools) ? value.tools.filter(isRecord) : [])
      .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
      .slice(0, Browser.MAX_LOG_ENTRIES)
      .map((tool) => ({
        name: bounded(String(tool.name), 128),
        ...(typeof tool.description === "string" && tool.description
          ? { description: bounded(tool.description, Browser.MAX_NAME_LENGTH) }
          : {}),
      }))
  }

  const frameIdOf = async (target: RefTarget, signal: AbortSignal) => {
    if (target.frameId) return target.frameId
    if (target.sessionId === sessionId) return mainFrameId
    const tree = record(await cdp.send("Page.getFrameTree", {}, target.sessionId, signal))
    return string(record(record(tree.frameTree).frame).id)
  }
  const inControlWorld = async (worldSessionId: string, frameId: string, signal: AbortSignal, run: (contextId: number) => Promise<unknown>) => {
    const key = `${worldSessionId}|${frameId}`
    for (let attempt = 0; ; attempt++) {
      let contextId = worlds.get(key)
      if (contextId === undefined) {
        const created = record(
          await cdp.send("Page.createIsolatedWorld", { frameId, worldName: CONTROL_WORLD }, worldSessionId, signal),
        )
        contextId = number(created.executionContextId)
        worlds.set(key, contextId)
      }
      try {
        return await run(contextId)
      } catch (cause) {
        if (!isStaleContext(cause)) throw cause
        worlds.delete(key)
        if (attempt > 0) throw cause
      }
    }
  }
  const callElement = async (target: RefTarget, declaration: string, args: ReadonlyArray<unknown>, signal: AbortSignal) =>
    inControlWorld(target.sessionId, await frameIdOf(target, signal), signal, async (executionContextId) => {
      const resolved = record(
        await cdp.send(
          "DOM.resolveNode",
          { backendNodeId: target.backendNodeId, executionContextId, objectGroup: CONTROL_WORLD },
          target.sessionId,
          signal,
        ),
      )
      try {
        return unwrapEvaluation(
          record(
            await cdp.send(
              "Runtime.callFunctionOn",
              {
                functionDeclaration: declaration,
                objectId: string(record(resolved.object).objectId),
                arguments: args.map((value) => ({ value })),
                returnByValue: true,
              },
              target.sessionId,
              signal,
            ),
          ),
        )
      } finally {
        await cdp.send("Runtime.releaseObjectGroup", { objectGroup: CONTROL_WORLD }, target.sessionId).catch(() => {})
      }
    })
  const callDocument = (worldSessionId: string, frameId: string, declaration: string, args: ReadonlyArray<unknown>, signal: AbortSignal) =>
    inControlWorld(worldSessionId, frameId, signal, async (executionContextId) =>
      unwrapEvaluation(
        record(
          await cdp.send(
            "Runtime.callFunctionOn",
            { functionDeclaration: declaration, executionContextId, arguments: args.map((value) => ({ value })), returnByValue: true },
            worldSessionId,
            signal,
          ),
        ),
      ),
    )
  const controlState = async (target: RefTarget, signal: AbortSignal) =>
    controlStateOf(await callElement(target, IsolatedPageSafety.F_CONTROL_STATE, [], signal))
  const describeTarget = async (target: RefTarget, signal: AbortSignal) => {
    const dom = record(
      record(await cdp.send("DOM.describeNode", { backendNodeId: target.backendNodeId, depth: 0 }, target.sessionId, signal)).node,
    )
    return { dom, attributes: attributesOf(dom.attributes) }
  }
  const axNodeOf = async (target: RefTarget, signal: AbortSignal) => {
    const response = record(
      await cdp.send(
        "Accessibility.getPartialAXTree",
        { backendNodeId: target.backendNodeId, fetchRelatives: false },
        target.sessionId,
        signal,
      ),
    )
    const nodes = Array.isArray(response.nodes) ? response.nodes.filter(isRecord) : []
    const node = nodes.find((candidate) => candidate.backendDOMNodeId === target.backendNodeId) ?? nodes[0]
    if (!node) throw new globalThis.Error("Element has no accessibility node")
    return node
  }
  const assertEditable = async (target: RefTarget, signal: AbortSignal) => {
    const { dom, attributes } = await describeTarget(target, signal)
    if (fileInput(dom)) throw new globalThis.Error("Protected inputs are unsupported")
    const name = stringMaybe(recordMaybe((await axNodeOf(target, signal)).name)?.value) ?? ""
    if (IsolatedPageSafety.isSensitiveAttributes(String(dom.nodeName), attributes, name))
      throw new globalThis.Error("Sensitive fields cannot be filled")
  }
  const elementPoint = async (target: RefTarget, signal: AbortSignal) => {
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, target.sessionId, signal)
    const quads = record(await cdp.send("DOM.getContentQuads", { backendNodeId: target.backendNodeId }, target.sessionId, signal))
    const quad = Array.isArray(quads.quads) && Array.isArray(quads.quads[0]) ? quads.quads[0] : undefined
    if (!quad || quad.length < 8 || !quad.every((value) => typeof value === "number"))
      throw new globalThis.Error("Element is not visible")
    return mainPoint(target, quad, signal)
  }
  const clickTarget = async (target: RefTarget, signal: AbortSignal, onDispatch: () => void) => {
    const { dom, attributes } = await describeTarget(target, signal)
    if (attributes.has("download")) throw new globalThis.Error("Downloads are unsupported")
    if (attributes.get("target") && attributes.get("target") !== "_self")
      throw new globalThis.Error("New tabs and popups are unsupported")
    const href = attributes.get("href")
    if (href && !requestAllowed(new URL(href, target.url ?? initialURL).toString(), true, allowedOrigins))
      throw new globalThis.Error("Link destination is not approved")
    if (protectedInput(dom)) throw new globalThis.Error("Protected inputs are unsupported")
    const { x, y } = await elementPoint(target, signal)
    onDispatch()
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId, signal)
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId, signal)
  }
  const focusedFieldRefused = async (signal: AbortSignal) => {
    const roots = [{ sessionId, frameId: mainFrameId }]
    for (const [childSessionId, entry] of frameSessions) {
      await entry.ready
      if (entry.failed) throw new globalThis.Error("A frame could not be inspected for sensitive fields")
      const tree = record(await cdp.send("Page.getFrameTree", {}, childSessionId, signal))
      roots.push({ sessionId: childSessionId, frameId: string(record(record(tree.frameTree).frame).id) })
    }
    for (const root of roots) {
      const refused = await inControlWorld(root.sessionId, root.frameId, signal, async (executionContextId) => {
        const response = record(
          await cdp.send(
            "Runtime.callFunctionOn",
            {
              functionDeclaration: IsolatedPageSafety.F_ACTIVE_ELEMENT,
              executionContextId,
              objectGroup: CONTROL_WORLD,
              returnByValue: false,
            },
            root.sessionId,
            signal,
          ),
        )
        unwrapEvaluation(response)
        const objectId = stringMaybe(record(response.result).objectId)
        if (!objectId) return true
        try {
          const callOnLeaf = async (functionDeclaration: string) =>
            unwrapEvaluation(
              record(await cdp.send("Runtime.callFunctionOn", { functionDeclaration, objectId, returnByValue: true }, root.sessionId, signal)),
            )
          const dom = record(
            record(await cdp.send("DOM.describeNode", { objectId, depth: 0, pierce: true }, root.sessionId, signal)).node,
          )
          if (
            dom.nodeType !== 1 ||
            typeof dom.nodeName !== "string" ||
            !dom.nodeName ||
            typeof dom.backendNodeId !== "number" ||
            !Array.isArray(dom.attributes) ||
            dom.attributes.length % 2 !== 0 ||
            !dom.attributes.every((attribute) => typeof attribute === "string") ||
            (dom.shadowRoots !== undefined && !Array.isArray(dom.shadowRoots)) ||
            (await callOnLeaf(IsolatedPageSafety.F_CONNECTED)) !== true
          )
            return true
          if (
            Array.isArray(dom.shadowRoots) &&
            dom.shadowRoots.some((shadowRoot) =>
              !isRecord(shadowRoot) || !["closed", "open", "user-agent"].includes(String(shadowRoot.shadowRootType)),
            )
          )
            return true
          const closedShadowRoot = (Array.isArray(dom.shadowRoots) ? dom.shadowRoots.filter(isRecord) : []).some(
            (shadowRoot) => shadowRoot.shadowRootType === "closed",
          )
          let unreachableFrame: IsolatedPageSafety.FocusedLeaf["unreachableFrame"]
          const frameUnreachable = await callOnLeaf(IsolatedPageSafety.F_FRAME_UNREACHABLE)
          if (typeof frameUnreachable !== "boolean") return true
          if (frameUnreachable) {
            const owned =
              typeof dom.frameId === "string"
                ? roots.find((candidate) => candidate.frameId === dom.frameId && candidate.sessionId !== root.sessionId)
                : undefined
            const page = owned ? safePageMaybe(frameSessions.get(owned.sessionId)?.url ?? "") : undefined
            unreachableFrame = { inspected: page !== undefined && allowedOrigins.has(page.origin) }
            return IsolatedPageSafety.refusesEditingKey({ sensitive: false, closedShadowRoot, unreachableFrame })
          }
          const fieldRefused = await callOnLeaf(IsolatedPageSafety.F_REFUSE_FIELD)
          if (fieldRefused !== false) return true
          const tree = record(
            await cdp.send("Accessibility.getPartialAXTree", { objectId, fetchRelatives: false }, root.sessionId, signal),
          )
          const node = Array.isArray(tree.nodes)
            ? tree.nodes.filter(isRecord).find((candidate) => candidate.backendDOMNodeId === dom.backendNodeId)
            : undefined
          const accessibleName = recordMaybe(node?.name)?.value
          if (typeof accessibleName !== "string") return true
          const sensitive =
            fileInput(dom) ||
            IsolatedPageSafety.isSensitiveAttributes(
              dom.nodeName,
              attributesOf(dom.attributes),
              accessibleName,
            )
          return IsolatedPageSafety.refusesEditingKey({ sensitive, closedShadowRoot })
        } finally {
          await cdp.send("Runtime.releaseObjectGroup", { objectGroup: CONTROL_WORLD }, root.sessionId).catch(() => {})
        }
      })
      if (refused !== false) return true
    }
    return false
  }
  const settled = async (signal: AbortSignal, met: () => Promise<boolean>) => {
    const deadline = Date.now() + CONTROL_STATE_POLL_MS
    for (;;) {
      if (await met()) return true
      if (Date.now() >= deadline) return false
      await delay(50, signal)
    }
  }

  const fillTarget = async (
    target: RefTarget,
    text: string,
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<Pick<ActionOutput, "control" | "message">> => {
    await assertEditable(target, signal)
    const plan = record(await callElement(target, IsolatedPageSafety.F_FILL, [text, false], signal))
    if (typeof plan.error === "string") throw new globalThis.Error(bounded(plan.error, 128))
    onDispatch()
    const applied = record(await callElement(target, IsolatedPageSafety.F_FILL, [text, true], signal))
    if (typeof applied.error === "string") throw new globalThis.Error(bounded(applied.error, 128))
    if (applied.kind === "insert") {
      if (text === "") {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...namedKeys.Delete, modifiers: 0 }, target.sessionId, signal)
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...namedKeys.Delete, modifiers: 0 }, target.sessionId, signal)
      } else await cdp.send("Input.insertText", { text }, target.sessionId, signal)
    }
    const control = await controlState(target, signal)
    return {
      control,
      ...(control.value !== undefined && control.value !== bounded(text, Browser.MAX_NAME_LENGTH)
        ? { message: "The field value differs from the requested text" }
        : {}),
    }
  }

  const selectNative = async (
    target: RefTarget,
    criteria: { values?: ReadonlyArray<string>; labels?: ReadonlyArray<string>; indexes?: ReadonlyArray<number> },
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<Pick<ActionOutput, "control">> => {
    const plan = record(await callElement(target, IsolatedPageSafety.F_SELECT, [criteria, false], signal))
    if (typeof plan.error === "string") throw new globalThis.Error(bounded(plan.error, 128))
    onDispatch()
    const applied = record(await callElement(target, IsolatedPageSafety.F_SELECT, [criteria, true], signal))
    if (typeof applied.error === "string") throw new globalThis.Error(bounded(applied.error, 128))
    return { control: await controlState(target, signal) }
  }

  const selectListboxOption = async (
    target: RefTarget,
    criteria: { values?: ReadonlyArray<string>; labels?: ReadonlyArray<string>; indexes?: ReadonlyArray<number> },
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<Pick<ActionOutput, "control">> => {
    const node = await axNodeOf(target, signal)
    const role = stringMaybe(recordMaybe(node.role)?.value)
    let listbox = target.backendNodeId
    if (role === "combobox") {
      if (axBoolean(node, "expanded") !== true)
        throw new globalThis.Error("The combobox is collapsed. Open the list first, observe, then select")
      const related = recordMaybe(axProperty(node, "controls")?.value)?.relatedNodes
      let found: number | undefined
      for (const entry of Array.isArray(related) ? related.filter(isRecord) : []) {
        if (typeof entry.backendDOMNodeId !== "number") continue
        const candidate = await axNodeOf({ ...target, backendNodeId: entry.backendDOMNodeId }, signal)
        if (stringMaybe(recordMaybe(candidate.role)?.value) === "listbox") {
          found = entry.backendDOMNodeId
          break
        }
      }
      if (found === undefined) throw new globalThis.Error("The combobox does not expose its list")
      listbox = found
    } else if (role !== "listbox") throw new globalThis.Error("Element is not a select or listbox")
    if (criteria.values) throw new globalThis.Error("Option values apply only to native selects; use labels or indexes")
    if ((criteria.labels?.length ?? criteria.indexes?.length) !== 1)
      throw new globalThis.Error("Select exactly one option of a listbox")
    const queried = record(
      await cdp.send("Accessibility.queryAXTree", { backendNodeId: listbox, role: "option" }, target.sessionId, signal),
    )
    const options = (Array.isArray(queried.nodes) ? queried.nodes.filter(isRecord) : [])
      .flatMap((candidate) =>
        candidate.ignored !== true && typeof candidate.backendDOMNodeId === "number"
          ? [{ node: candidate, backendNodeId: candidate.backendDOMNodeId }]
          : [],
      )
      .map((option, index) => ({
        ...option,
        index,
        label: bounded(normalizeSpace(stringMaybe(recordMaybe(option.node.name)?.value) ?? ""), Browser.MAX_NAME_LENGTH),
      }))
    const wanted = criteria.labels
      ? options.find((option) => option.label === normalizeSpace(criteria.labels?.[0] ?? ""))
      : options[criteria.indexes?.[0] ?? -1]
    if (!wanted) throw new globalThis.Error("Option not found")
    if (axBoolean(wanted.node, "disabled") === true) throw new globalThis.Error("Option is disabled")
    const selectedState = (selected: boolean) => ({ control: { selected: selected ? [{ label: wanted.label, index: wanted.index }] : [] } })
    if (axBoolean(wanted.node, "selected") === true) return selectedState(true)
    const optionTarget = { ...target, backendNodeId: wanted.backendNodeId }
    await clickTarget(optionTarget, signal, onDispatch)
    let selected = false
    await settled(signal, async () => {
      selected = axBoolean(await axNodeOf(optionTarget, signal), "selected") === true
      return selected
    })
    return selectedState(selected)
  }

  const checkTarget = async (
    target: RefTarget,
    checked: boolean,
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<Pick<ActionOutput, "control" | "message">> => {
    const node = await axNodeOf(target, signal)
    const role = stringMaybe(recordMaybe(node.role)?.value)
    const current = axTristate(node, "checked")
    if (current === undefined) throw new globalThis.Error("Element does not expose a checked state")
    if (current === checked) return { control: { checked: current } }
    if (!checked && (role === "radio" || role === "menuitemradio"))
      throw new globalThis.Error("A radio button cannot be unchecked")
    await clickTarget(target, signal, onDispatch)
    let observed = current
    await settled(signal, async () => {
      observed = axTristate(await axNodeOf(target, signal), "checked") ?? observed
      return observed === checked
    })
    return {
      control: { checked: observed },
      ...(observed === checked ? {} : { message: "The control did not change state" }),
    }
  }

  const approvedFrames = async (signal: AbortSignal) => {
    const info = record(record(await cdp.send("Target.getTargetInfo", { targetId }, undefined, signal)).targetInfo)
    const current = safeURL(string(info.url))
    const allowed = new Set([...allowedOrigins, ...observedFrameOrigins])
    const sessions = [
      { id: sessionId, url: current.toString(), failed: false, ready: undefined as Promise<void> | undefined },
      ...[...frameSessions.entries()].map(([id, entry]) => ({ id, url: entry.url, failed: entry.failed === true, ready: entry.ready })),
    ]
    await Promise.all(sessions.flatMap((session) => (session.ready ? [session.ready] : [])))
    const frames: Array<{ sessionId: string; frameId: string; top: boolean; page?: Browser.Page }> = []
    for (const session of sessions) {
      const main = session.id === sessionId
      const list: { id?: string; url?: string }[] = []
      try {
        collectFrames(record(record(await cdp.send("Page.getFrameTree", {}, session.id, signal)).frameTree), list)
      } catch (cause) {
        if (main) throw cause
        continue
      }
      for (const [index, frame] of list.entries()) {
        const top = main && index === 0
        const page = safePageMaybe(frame.url || (top ? current.toString() : session.url))
        if (!frame.id || (!top && (!page || !allowed.has(page.origin) || session.failed))) continue
        frames.push({ sessionId: session.id, frameId: frame.id, top, page })
      }
    }
    return frames
  }
  const hasArea = (quads: unknown) =>
    Array.isArray(quads) &&
    quads.some((quad) => {
      if (!Array.isArray(quad) || quad.length < 8 || !quad.every((value) => typeof value === "number")) return false
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      return Math.max(...xs) - Math.min(...xs) > 0 && Math.max(...ys) - Math.min(...ys) > 0
    })
  const targetVisible = (target: RefTarget, signal: AbortSignal) =>
    cdp.send("DOM.getContentQuads", { backendNodeId: target.backendNodeId }, target.sessionId, signal).then(
      (response) => hasArea(record(response).quads),
      () => false,
    )
  const tolerateStale = async <A>(run: () => Promise<A>): Promise<A | undefined> => {
    try {
      return await run()
    } catch (cause) {
      if (isStaleContext(cause)) return undefined
      throw cause
    }
  }

  type WaitMatch = { readonly frame?: Browser.Page }
  const waitCheck = (wait: Extract<Browser.Action, { type: "wait" }>, started: number, signal: AbortSignal) => {
    if (wait.ref !== undefined || wait.locator !== undefined) {
      const parsed = wait.ref === undefined ? BrowserOperation.parseLocator(wait.locator ?? "") : undefined
      if (wait.ref === undefined && !parsed) throw new globalThis.Error("Locator is malformed")
      const state = wait.state ?? (wait.ref === undefined ? "visible" : "attached")
      const check = async (): Promise<WaitMatch | undefined> => {
        let target: RefTarget | undefined
        let page: Browser.Page | undefined
        if (wait.ref !== undefined) {
          target = refs.get(wait.ref)
          if (
            target &&
            !(await callElement(target, IsolatedPageSafety.F_CONNECTED, [], signal).then((connected) => connected === true, () => false))
          )
            target = undefined
          if (target && (target.sessionId !== sessionId || target.frameId !== mainFrameId)) page = safePageMaybe(target.url ?? "")
        } else if (parsed) {
          const seen = new Set<string>()
          let matched = 0
          for (const frame of await approvedFrames(signal)) {
            const ax = record(
              await cdp
                .send("Accessibility.getFullAXTree", { depth: Browser.MAX_AX_DEPTH, frameId: frame.frameId }, frame.sessionId, signal)
                .catch(() => ({})),
            )
            for (const node of Array.isArray(ax.nodes) ? ax.nodes.filter(isRecord) : []) {
              if (node.ignored === true || typeof node.backendDOMNodeId !== "number") continue
              if (stringMaybe(recordMaybe(node.role)?.value) !== parsed.role) continue
              if (!BrowserOperation.locatorNameMatches(parsed.name, stringMaybe(recordMaybe(node.name)?.value) ?? "")) continue
              const key = `${frame.sessionId}\0${node.backendDOMNodeId}`
              if (seen.has(key)) continue
              seen.add(key)
              if (matched++ !== parsed.nth) continue
              target = { sessionId: frame.sessionId, backendNodeId: node.backendDOMNodeId, frameId: frame.frameId }
              page = frame.top ? undefined : frame.page
            }
          }
        }
        const attached = target !== undefined
        const visible = target !== undefined && (await targetVisible(target, signal))
        const met = state === "attached" ? attached : state === "visible" ? visible : state === "hidden" ? !visible : !attached
        if (!met) return undefined
        return state === "attached" || state === "visible" ? { frame: page } : {}
      }
      return { check, interval: 250 }
    }
    if (wait.url !== undefined) {
      const pattern = wait.url
      return {
        interval: 100,
        check: async (): Promise<WaitMatch | undefined> => {
          const info = record(record(await cdp.send("Target.getTargetInfo", { targetId }, undefined, signal)).targetInfo)
          const current = safeURL(string(info.url))
          if (!allowedOrigins.has(current.origin))
            throw new globalThis.Error("The browser crossed its approved origin boundary")
          return IsolatedPageSafety.globMatch(pattern, `${current.origin}${current.pathname}`) ? {} : undefined
        },
      }
    }
    if (wait.text !== undefined) {
      const needle = wait.text
      return {
        interval: 250,
        check: async (): Promise<WaitMatch | undefined> => {
          for (const frame of await approvedFrames(signal)) {
            const present = await tolerateStale(() =>
              callDocument(frame.sessionId, frame.frameId, IsolatedPageSafety.F_TEXT_PRESENT, [needle], signal),
            )
            if (present === true) return { frame: frame.top ? undefined : frame.page }
          }
          return undefined
        },
      }
    }
    const load = wait.load ?? "load"
    return {
      interval: 100,
      check: async (): Promise<WaitMatch | undefined> => {
        if (load === "networkidle") return networkIdle.idleFor(NETWORK_IDLE_QUIET_MS, started) ? {} : undefined
        const readyState = await tolerateStale(() =>
          callDocument(sessionId, mainFrameId, IsolatedPageSafety.F_READY, [], signal),
        )
        return readyState === "complete" || (load === "domcontentloaded" && readyState === "interactive") ? {} : undefined
      },
    }
  }
  const runWait = async (wait: Extract<Browser.Action, { type: "wait" }>, signal: AbortSignal): Promise<WaitMatch> => {
    const started = Date.now()
    const deadline = started + Math.min(Math.max(wait.timeoutMs ?? 5000, 0), Browser.MAX_WAIT_MS)
    const { check, interval } = waitCheck(wait, started, signal)
    for (;;) {
      const match = await check()
      if (match) return match
      if (Date.now() >= deadline) throw new globalThis.Error("Timed out waiting for the page")
      await delay(interval, signal)
    }
  }

  const action = (action: Browser.Action, origins: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async (actionSignal) => {
        if (paused)
          throw new Error({ message: safetyFailure ?? "Isolated browser control is paused", phase: "predispatch" })
        allowedOrigins = new Set(origins)
        await Promise.all(
          [...allowedOrigins].map((origin) => denyClipboard(cdp, browserContextId, origin, actionSignal)),
        )
        let dispatched = false
        let peripheral: Pick<ActionOutput, "text" | "logs" | "data" | "webmcpTools" | "dialog" | "control" | "frame" | "message"> = {}
        const onDispatch = () => {
          dispatched = true
        }
        const popupStart = popupRejections
        const downloadStart = downloadAttempts
        try {
          if (["clipboard_read", "clipboard_write", "upload", "download", "group", "ungroup"].includes(action.type))
            throw new globalThis.Error(`${action.type} is unavailable in isolated mode`)
          if (action.type === "navigate") {
            const destination = safeURL(action.url)
            if (!allowedOrigins.has(destination.origin)) throw new globalThis.Error("Navigation origin is not approved")
            dispatched = true
            await cdp.send("Page.navigate", { url: destination.toString() }, sessionId, actionSignal)
          }
          if (action.type === "click") await clickTarget(requireRef(refs, action.ref ?? ""), actionSignal, onDispatch)
          if (action.type === "type") {
            const target = requireRef(refs, action.ref ?? "")
            await assertEditable(target, actionSignal)
            dispatched = true
            await cdp.send("DOM.focus", { backendNodeId: target.backendNodeId }, target.sessionId, actionSignal)
            await cdp.send("Input.insertText", { text: action.text }, target.sessionId, actionSignal)
          }
          if (action.type === "fill")
            peripheral = await fillTarget(requireRef(refs, action.ref ?? ""), action.text, actionSignal, onDispatch)
          if (action.type === "select") {
            const target = requireRef(refs, action.ref ?? "")
            const criteria = { values: action.values, labels: action.labels, indexes: action.indexes }
            peripheral = String((await describeTarget(target, actionSignal)).dom.nodeName).toLowerCase() === "select"
              ? await selectNative(target, criteria, actionSignal, onDispatch)
              : await selectListboxOption(target, criteria, actionSignal, onDispatch)
          }
          if (action.type === "check")
            peripheral = await checkTarget(requireRef(refs, action.ref ?? ""), action.checked, actionSignal, onDispatch)
          if (action.type === "hover") {
            const { x, y } = await elementPoint(requireRef(refs, action.ref ?? ""), actionSignal)
            dispatched = true
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId, actionSignal)
          }
          if (action.type === "scroll")
            await cdp.send(
              "Input.dispatchMouseEvent",
              { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: action.deltaY },
              sessionId,
              actionSignal,
            )
          if (action.type === "back" || action.type === "forward") {
            const nav = record(await cdp.send("Page.getNavigationHistory", {}, sessionId, actionSignal))
            const entries = Array.isArray(nav.entries) ? nav.entries.filter(isRecord) : []
            const entry = entries[number(nav.currentIndex) + (action.type === "back" ? -1 : 1)]
            if (!entry) throw new globalThis.Error(action.type === "back" ? "No earlier page in history" : "No later page in history")
            const entryURL = safeURL(string(entry.url))
            if (!allowedOrigins.has(entryURL.origin)) throw new globalThis.Error("History target is not approved")
            dispatched = true
            await cdp.send("Page.navigateToHistoryEntry", { entryId: number(entry.id) }, sessionId, actionSignal)
          }
          if (action.type === "reload") {
            dispatched = true
            await cdp.send("Page.reload", {}, sessionId, actionSignal)
          }
          if (action.type === "key") {
            const modifiers =
              (action.modifiers?.includes("Alt") ? 1 : 0) |
              (action.modifiers?.includes("Control") ? 2 : 0) |
              (action.modifiers?.includes("Meta") ? 4 : 0) |
              (action.modifiers?.includes("Shift") ? 8 : 0)
            const named = namedKeys[action.key]
            const single = action.key.length === 1
            if (!named && !single) throw new globalThis.Error(`Unsupported key: ${action.key.slice(0, 32)}`)
            if (!IsolatedPageSafety.isSafeNavigationKey(action.key, action.modifiers) && (await focusedFieldRefused(actionSignal)))
              throw new globalThis.Error("The focused element cannot be proven free of sensitive fields; keyboard text input is refused")
            const base = named ?? { key: action.key, code: "", windowsVirtualKeyCode: 0 }
            dispatched = true
            await cdp.send(
              "Input.dispatchKeyEvent",
              { type: "keyDown", ...base, modifiers, ...(single && !named && !modifiers ? { text: action.key } : {}) },
              sessionId,
              actionSignal,
            )
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, modifiers }, sessionId, actionSignal)
          }
          if (action.type === "wait") peripheral = await runWait(action, actionSignal)
          if (action.type === "dialog") {
            if (action.accept === undefined) {
              if (!openDialog) throw new globalThis.Error("No JavaScript dialog is open on this tab")
              const { sessionId: _dialogSession, ...dialog } = openDialog
              peripheral = { dialog }
            } else if (openDialog) {
              dispatched = true
              await cdp.send("Page.handleJavaScriptDialog", {
                accept: action.accept,
                ...(action.text === undefined ? {} : { promptText: action.text }),
              }, openDialog.sessionId ?? sessionId, actionSignal)
              openDialog = undefined
            }
          }
          if (action.type === "logs") {
            const limit = Math.min(Math.max(action.limit ?? Browser.MAX_LOG_ENTRIES, 1), Browser.MAX_LOG_ENTRIES)
            peripheral = { logs: logs.slice(-limit) }
          }
          if (action.type === "export") {
            const snapshotResult = record(await cdp.send("Page.captureSnapshot", { format: "mhtml" }, sessionId, actionSignal))
            const data = string(snapshotResult.data)
            if (Buffer.byteLength(data, "utf8") > Browser.MAX_EXPORT_BYTES) throw new globalThis.Error("Export exceeds the 8 MiB limit")
            peripheral = { data }
          }
          if (action.type === "webmcp_list") peripheral = { webmcpTools: await webmcpList(actionSignal) }
          if (action.type === "webmcp_invoke") {
            const tools = await webmcpList(actionSignal)
            if (!tools.some((tool) => tool.name === action.name)) throw new globalThis.Error("WebMCP tool is no longer available on this page")
            dispatched = true
            const value = recordMaybe(
              await mainWorldEvaluate(
                modelContextExpression(
                  `if (typeof mc.executeTool === 'function') return { supported: true, result: await mc.executeTool(${JSON.stringify(action.name)}, ${JSON.stringify(action.arguments ?? {})}) }; if (typeof mc.callTool === 'function') return { supported: true, result: await mc.callTool(${JSON.stringify(action.name)}, ${JSON.stringify(action.arguments ?? {})}) }; return { supported: true, unsupportedInvoke: true };`,
                ),
                actionSignal,
              ),
            )
            if (!value || value.supported !== true) throw new globalThis.Error("WebMCP is not available on this page")
            if (value.unsupportedInvoke) throw new globalThis.Error("WebMCP invocation is not supported on this page")
            const text = typeof value.result === "string" ? value.result : (JSON.stringify(value.result) ?? "")
            if (Buffer.byteLength(text, "utf8") > Browser.MAX_CLIPBOARD_BYTES) throw new globalThis.Error("WebMCP result exceeds the 64 KiB limit")
            peripheral = { text }
          }
          let captureClip = action.type === "capture" ? action.clip : undefined
          if (action.type === "capture" && action.ref) {
            const target = refs.get(action.ref)
            if (!target) throw new globalThis.Error("Semantic element reference is stale")
            await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, target.sessionId, actionSignal)
            const quads = record(await cdp.send("DOM.getContentQuads", { backendNodeId: target.backendNodeId }, target.sessionId, actionSignal)).quads
            const quad = Array.isArray(quads) ? quads[0] : undefined
            if (!Array.isArray(quad) || quad.length < 8 || quad.some((value) => typeof value !== "number"))
              throw new globalThis.Error("Capture target has no visible bounds")
            const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
            const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
            captureClip = {
              x: Math.max(0, Math.floor(Math.min(...xs))),
              y: Math.max(0, Math.floor(Math.min(...ys))),
              width: Math.max(1, Math.ceil(Math.max(...xs) - Math.min(...xs))),
              height: Math.max(1, Math.ceil(Math.max(...ys) - Math.min(...ys))),
            }
          }
          const capture =
            action.type === "capture"
              ? await capturePage(cdp, sessionId, actionSignal, [...frameSessions.keys()], { clip: captureClip, fullPage: action.fullPage })
              : undefined
          await delay(ACTION_SETTLE_MS, actionSignal)
          while (popupTasks.size > 0) await Promise.all(popupTasks)
          if (safetyFailure) throw new globalThis.Error(safetyFailure)
          if (downloadAttempts !== downloadStart) throw new globalThis.Error("A download attempt was blocked")
          const current = await snapshot(false, actionSignal)
          return {
            snapshot: current,
            capture,
            ...peripheral,
            rejected: popupRejections !== popupStart ? "A popup was safely blocked" : undefined,
          }
        } catch (cause) {
          if (cause instanceof Error) throw cause
          throw new Error({
            message: safeMessage(cause, "Isolated browser action failed"),
            phase: dispatched ? "postdispatch" : "predispatch",
          })
        }
      },
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error({ message: safeMessage(cause, "Isolated browser action failed"), phase: "predispatch" }),
    })

  let closePromise: Promise<void> | undefined
  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      closing = true
      worlds.clear()
      networkIdle.clear()
      unsubscribe()
      await Promise.race([
        cdp
          .send("Target.disposeBrowserContext", { browserContextId })
          .catch(() => {})
          .then(() => cdp.send("Browser.close").catch(() => {})),
        delay(CLOSE_TIMEOUT_MS),
      ])
      cdp.close()
      await terminate(child)
      await cleanup(root)
    })()
    return closePromise
  }
  const closed = Promise.race([cdp.closed, onceExit(child), fatal]).then(close)

  return {
    observe: Effect.tryPromise({
      try: (observeSignal) => snapshot(true, observeSignal),
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error({ message: safeMessage(cause, "Isolated browser observation failed"), phase: "predispatch" }),
    }),
    action,
    pause: Effect.sync(() => {
      paused = true
    }),
    resume: Effect.gen(function* () {
      if (safetyFailure) return yield* new Error({ message: safetyFailure, phase: "predispatch" })
      paused = false
      refs.clear()
      revision = 0
      return undefined
    }),
    close: Effect.promise(close),
    closed: Effect.promise(() => closed),
  }
}

async function denyClipboard(cdp: Client, browserContextId: string, origin: string, signal?: AbortSignal) {
  await Promise.all(
    ["clipboard-read", "clipboard-write"].map((name) =>
      cdp.send(
        "Browser.setPermission",
        { permission: { name }, setting: "denied", origin, browserContextId },
        undefined,
        signal,
      ),
    ),
  )
}

async function waitForDocument(
  cdp: Client,
  sessionId: string,
  origin: string,
  failure: () => string | undefined,
  signal: AbortSignal,
) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (failure()) throw new globalThis.Error(failure())
    const tree = record(await cdp.send("Page.getFrameTree", {}, sessionId, signal))
    const frame = record(record(tree.frameTree).frame)
    if (typeof frame.url === "string" && safeURL(frame.url).origin === origin) return
    await delay(25, signal)
  }
  throw new globalThis.Error("Initial page did not become ready")
}

function requestAllowed(input: string, topLevel: boolean, allowedOrigins: ReadonlySet<string>) {
  try {
    const url = new URL(input)
    if (url.protocol === "about:" && url.href === "about:blank") return true
    if (!["http:", "https:"].includes(url.protocol)) return !topLevel && ["blob:", "data:"].includes(url.protocol)
    return !topLevel || allowedOrigins.has(url.origin)
  } catch {
    return false
  }
}

function safeURL(input: string) {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new globalThis.Error("Only credential-free HTTP and HTTPS pages are supported")
  return url
}

function safePageMaybe(input: string): Browser.Page | undefined {
  try {
    const url = safeURL(input)
    return { origin: url.origin, path: url.pathname || "/" }
  } catch {
    return undefined
  }
}

function fileInput(node: Readonly<Record<string, unknown>>) {
  return String(node.nodeName).toLowerCase() === "input" && (attributesOf(node.attributes).get("type") ?? "text").toLowerCase() === "file"
}

function isStaleContext(cause: unknown) {
  return cause instanceof globalThis.Error && STALE_CONTEXT.test(cause.message)
}

function normalizeSpace(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function collectFrames(node: Readonly<Record<string, unknown>>, output: { id?: string; url?: string }[]) {
  const frame = recordMaybe(node.frame)
  if (!frame) return
  output.push({ id: stringMaybe(frame.id), url: stringMaybe(frame.url) })
  if (Array.isArray(node.childFrames)) for (const child of node.childFrames.filter(isRecord)) collectFrames(child, output)
}

function unwrapEvaluation(response: Readonly<Record<string, unknown>>) {
  if (response.exceptionDetails) {
    const details = record(response.exceptionDetails)
    const exception = recordMaybe(details.exception)
    throw new globalThis.Error(
      bounded(
        typeof exception?.description === "string"
          ? exception.description
          : typeof details.text === "string"
            ? details.text
            : "Page evaluation failed",
        1024,
      ),
    )
  }
  return record(response.result).value
}

function axProperty(node: Readonly<Record<string, unknown>>, name: string) {
  return (Array.isArray(node.properties) ? node.properties.filter(isRecord) : []).find((property) => property.name === name)
}

function axTristate(node: Readonly<Record<string, unknown>>, name: string): boolean | "mixed" | undefined {
  const value = recordMaybe(axProperty(node, name)?.value)?.value
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return value === "mixed" ? "mixed" : undefined
}

function axBoolean(node: Readonly<Record<string, unknown>>, name: string) {
  const value = recordMaybe(axProperty(node, name)?.value)?.value
  return typeof value === "boolean" ? value : undefined
}

function axState(node: Readonly<Record<string, unknown>>, role: string, sensitive: boolean) {
  const checked = axTristate(node, "checked")
  const pressed = axTristate(node, "pressed")
  const expanded = axBoolean(node, "expanded")
  const selected = axBoolean(node, "selected")
  const raw = recordMaybe(node.value)?.value
  const value =
    !sensitive && valueRoles.has(role) && (typeof raw === "string" || typeof raw === "number")
      ? bounded(String(raw), Browser.MAX_NAME_LENGTH)
      : undefined
  return {
    ...(checked !== undefined ? { checked } : {}),
    ...(pressed !== undefined ? { pressed } : {}),
    ...(expanded !== undefined ? { expanded } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(value !== undefined ? { value } : {}),
  }
}

function controlStateOf(input: unknown): Browser.ControlState {
  const value = recordMaybe(input) ?? {}
  if (value.sensitive === true) return { sensitive: true }
  const selected = Array.isArray(value.selected)
    ? value.selected
        .filter(isRecord)
        .slice(0, Browser.MAX_SELECT_OPTIONS)
        .flatMap((option) =>
          typeof option.label === "string" && typeof option.index === "number" && Number.isSafeInteger(option.index) && option.index >= 0
            ? [
                {
                  ...(typeof option.value === "string" ? { value: bounded(option.value, Browser.MAX_NAME_LENGTH) } : {}),
                  label: bounded(option.label, Browser.MAX_NAME_LENGTH),
                  index: option.index,
                },
              ]
            : [],
        )
    : undefined
  return {
    ...(value.checked === true || value.checked === false || value.checked === "mixed" ? { checked: value.checked } : {}),
    ...(typeof value.value === "string" ? { value: bounded(value.value, Browser.MAX_NAME_LENGTH) } : {}),
    ...(selected ? { selected } : {}),
  }
}

function protectedInput(node: Readonly<Record<string, unknown>>) {
  if (String(node.nodeName).toLowerCase() !== "input") return false
  return ["file", "password"].includes((attributesOf(node.attributes).get("type") ?? "text").toLowerCase())
}

function attributesOf(input: unknown) {
  const values = Array.isArray(input) ? input : []
  const entries = Array.from({ length: Math.floor(values.length / 2) }, (_, index) => {
    const name = values[index * 2]
    const value = values[index * 2 + 1]
    return [typeof name === "string" ? name : "", typeof value === "string" ? value : ""] as const
  })
  return new Map(entries.filter(([name]) => name.length > 0))
}

function requireRef(refs: ReadonlyMap<string, RefTarget>, ref: string) {
  const value = refs.get(ref)
  if (value === undefined) throw new globalThis.Error("Semantic element reference is stale")
  return value
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new globalThis.Error("Chrome returned an invalid response")
  return value
}

function recordMaybe(value: unknown) {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
}

function string(value: unknown) {
  if (typeof value !== "string" || value.length === 0) throw new globalThis.Error("Chrome omitted an identifier")
  return value
}

function stringMaybe(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new globalThis.Error("Chrome omitted a number")
  return value
}

function bounded(input: string, length: number) {
  return input.length <= length ? input : input.slice(0, length)
}

function boundedMaybe(input: string | undefined, length: number) {
  return input ? bounded(input, length) : undefined
}

function safeMessage(cause: unknown, fallback: string) {
  if (cause instanceof globalThis.Error && cause.name === "AbortError") return "Isolated browser operation was canceled"
  return cause instanceof globalThis.Error && cause.message ? bounded(cause.message, 1024) : fallback
}

function chromeVersion() {
  return new Promise<number | undefined>((resolve, reject) => {
    execFile(CHROME, ["--version"], { timeout: 3_000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      const match = /Google Chrome (\d+)\./.exec(stdout)
      resolve(match ? Number(match[1]) : undefined)
    })
  })
}

function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Canceled", "AbortError"))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
    if (!signal) return
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Canceled", "AbortError"))
      },
      { once: true },
    )
  })
}

function onceExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => child.once("exit", () => resolve()))
}

function waitForExit(child: ReturnType<typeof spawn>, ms: number) {
  return Promise.race([onceExit(child), delay(ms)])
}

async function terminate(child: ReturnType<typeof spawn>) {
  await waitForExit(child, TERMINATE_TIMEOUT_MS)
  signalProcessGroup(child, "SIGTERM")
  await waitForExit(child, TERMINATE_TIMEOUT_MS)
  signalProcessGroup(child, "SIGKILL")
  await waitForExit(child, KILL_TIMEOUT_MS)
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (child.pid === undefined) {
    child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (cause) {
    if (!isProcessGroupGone(cause)) throw cause
  }
}

function isProcessGroupGone(cause: unknown) {
  return (
    cause instanceof globalThis.Error &&
    "code" in cause &&
    (cause.code === "ESRCH" || (process.platform === "darwin" && cause.code === "EPERM"))
  )
}

async function cleanup(root: string) {
  if (dirname(root) !== tmpdir() || !basename(root).startsWith("ycoding-isolated-browser-")) return
  await rm(root, { recursive: true, force: true })
}

export const layer = Layer.succeed(Service, Service.of({ availability: availability(), launch }))
export const node = makeLocationNode({ service: Service, layer, deps: [] })
