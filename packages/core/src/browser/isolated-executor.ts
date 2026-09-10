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

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const SUPPORTED_MAJOR = 152
const STARTUP_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 5_000
const TERMINATE_TIMEOUT_MS = 500
const KILL_TIMEOUT_MS = 1_000
const ACTION_SETTLE_MS = 150

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

export class Error extends Schema.TaggedErrorClass<Error>()("IsolatedBrowser.ExecutorError", {
  message: Schema.String,
  phase: Schema.Literals(["predispatch", "postdispatch"]),
}) {}

export interface Snapshot {
  readonly title: string
  readonly url: string
  readonly documentGeneration: number
  readonly revision: number
  readonly elements: ReadonlyArray<Browser.Element>
  readonly truncated: boolean
}

export interface ActionOutput {
  readonly snapshot: Omit<Snapshot, "elements" | "truncated">
  readonly capture?: Browser.CaptureOutput
  readonly rejected?: string
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

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/IsolatedBrowserExecutor") {}

function availability() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return Effect.succeed({ available: false, reason: "Isolated browser requires macOS arm64" })
  return Effect.promise(() => chromeVersion().catch(() => undefined)).pipe(
    Effect.map((major) =>
      major === SUPPORTED_MAJOR
        ? { available: true }
        : {
            available: false,
            reason:
              major === undefined
                ? "Installed Google Chrome is unavailable"
                : `Installed Google Chrome major ${major} is unsupported; major ${SUPPORTED_MAJOR} is required`,
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
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
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
    const version = record(await withTimeout(cdp.send("Browser.getVersion"), STARTUP_TIMEOUT_MS))
    if (typeof version.product !== "string" || !version.product.startsWith(`Chrome/${SUPPORTED_MAJOR}.`))
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
  const refs = new Map<string, number>()
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
    if (event.method === "Target.attachedToTarget") {
      const target = record(event.params?.targetInfo)
      if (target.targetId === targetId) return
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
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId)
        markFailure("Child frames are unsupported")
        resolveFatal()
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
    if (event.method === "Page.frameAttached" && event.sessionId === sessionId) {
      markFailure("Child frames are unsupported")
      resolveFatal()
      await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {})
      return
    }
    if (event.method === "Page.frameNavigated" && event.sessionId === sessionId) {
      const frame = record(event.params?.frame)
      if (frame.id !== mainFrameId) return
      if (initialized) documentGeneration++
      revision = 0
      refs.clear()
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
      filter: [{ type: "page", exclude: false }, { exclude: true }],
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
    const ax = record(await cdp.send("Accessibility.getFullAXTree", { depth: 12 }, sessionId, actionSignal))
    const nodes = Array.isArray(ax.nodes) ? ax.nodes.filter(isRecord) : []
    const candidates = nodes.filter(
      (node) =>
        node.ignored !== true &&
        interactiveRoles.has(stringMaybe(recordMaybe(node.role)?.value) ?? "") &&
        typeof node.backendDOMNodeId === "number",
    )
    const selected = candidates.slice(0, Browser.MAX_OBSERVATION_ELEMENTS)
    refs.clear()
    const elements = (
      await Promise.all(
        selected.map(async (node, index) => {
          const backendNodeId = number(node.backendDOMNodeId)
          const described = record(
            await cdp.send("DOM.describeNode", { backendNodeId, depth: 0 }, sessionId, actionSignal),
          )
          const dom = record(described.node)
          if (protectedInput(dom)) return undefined
          const attributes = attributesOf(dom.attributes)
          const destination = attributes.get("href")
          refs.set(`b${index + 1}`, backendNodeId)
          return {
            ref: Browser.Element.fields.ref.make(`b${index + 1}`),
            role: bounded(stringMaybe(recordMaybe(node.role)?.value) ?? "", 64),
            name: bounded(stringMaybe(recordMaybe(node.name)?.value) ?? "", Browser.MAX_NAME_LENGTH),
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
            ...(destination && safePageMaybe(new URL(destination, url).toString())
              ? { destination: safePageMaybe(new URL(destination, url).toString()) }
              : {}),
          } satisfies Browser.Element
        }),
      )
    ).filter((element) => element !== undefined)
    revision++
    return {
      title: bounded(typeof info.title === "string" ? info.title : "", Browser.MAX_TITLE_LENGTH),
      url: url.toString(),
      documentGeneration,
      revision,
      elements,
      truncated: candidates.length > Browser.MAX_OBSERVATION_ELEMENTS,
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
        const popupStart = popupRejections
        const downloadStart = downloadAttempts
        try {
          if (action.type === "navigate") {
            const destination = safeURL(action.url)
            if (!allowedOrigins.has(destination.origin)) throw new globalThis.Error("Navigation origin is not approved")
            dispatched = true
            await cdp.send("Page.navigate", { url: destination.toString() }, sessionId, actionSignal)
          }
          if (action.type === "click") {
            const backendNodeId = requireRef(refs, action.ref)
            const described = record(
              await cdp.send("DOM.describeNode", { backendNodeId, depth: 0 }, sessionId, actionSignal),
            )
            const dom = record(described.node)
            const attributes = attributesOf(dom.attributes)
            if (attributes.has("download")) throw new globalThis.Error("Downloads are unsupported")
            if (attributes.get("target") && attributes.get("target") !== "_self")
              throw new globalThis.Error("New tabs and popups are unsupported")
            const href = attributes.get("href")
            if (href && !requestAllowed(new URL(href, initialURL).toString(), true, allowedOrigins))
              throw new globalThis.Error("Link destination is not approved")
            if (protectedInput(dom)) throw new globalThis.Error("Protected inputs are unsupported")
            await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId, actionSignal)
            const quads = record(await cdp.send("DOM.getContentQuads", { backendNodeId }, sessionId, actionSignal))
            const quad = Array.isArray(quads.quads) && Array.isArray(quads.quads[0]) ? quads.quads[0] : undefined
            if (!quad || quad.length < 8 || !quad.every((value) => typeof value === "number"))
              throw new globalThis.Error("Element is not visible")
            const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
            const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
            dispatched = true
            await cdp.send(
              "Input.dispatchMouseEvent",
              { type: "mousePressed", x, y, button: "left", clickCount: 1 },
              sessionId,
              actionSignal,
            )
            await cdp.send(
              "Input.dispatchMouseEvent",
              { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
              sessionId,
              actionSignal,
            )
          }
          if (action.type === "type") {
            const backendNodeId = requireRef(refs, action.ref)
            const described = record(
              await cdp.send("DOM.describeNode", { backendNodeId, depth: 0 }, sessionId, actionSignal),
            )
            if (protectedInput(record(described.node))) throw new globalThis.Error("Protected inputs are unsupported")
            dispatched = true
            await cdp.send("DOM.focus", { backendNodeId }, sessionId, actionSignal)
            await cdp.send("Input.insertText", { text: action.text }, sessionId, actionSignal)
          }
          if (action.type === "scroll")
            await cdp.send(
              "Input.dispatchMouseEvent",
              { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: action.deltaY },
              sessionId,
              actionSignal,
            )
          const capture = action.type === "capture" ? await capturePage(cdp, sessionId, actionSignal) : undefined
          await delay(ACTION_SETTLE_MS, actionSignal)
          while (popupTasks.size > 0) await Promise.all(popupTasks)
          if (safetyFailure) throw new globalThis.Error(safetyFailure)
          if (downloadAttempts !== downloadStart) throw new globalThis.Error("A download attempt was blocked")
          const current = await snapshot(false, actionSignal)
          return {
            snapshot: current,
            capture,
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

function requireRef(refs: ReadonlyMap<string, number>, ref: string) {
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

function withTimeout<A>(promise: Promise<A>, ms: number) {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new globalThis.Error("Chrome startup timed out")
    }),
  ])
}

function onceExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => child.once("exit", () => resolve()))
}

function waitForExit(child: ReturnType<typeof spawn>, ms: number) {
  return Promise.race([onceExit(child), delay(ms)])
}

async function terminate(child: ReturnType<typeof spawn>) {
  await waitForExit(child, TERMINATE_TIMEOUT_MS)
  if (child.exitCode === null) child.kill("SIGTERM")
  await waitForExit(child, TERMINATE_TIMEOUT_MS)
  if (child.exitCode === null) child.kill("SIGKILL")
  await waitForExit(child, KILL_TIMEOUT_MS)
}

async function cleanup(root: string) {
  if (dirname(root) !== tmpdir() || !basename(root).startsWith("ycoding-isolated-browser-")) return
  await rm(root, { recursive: true, force: true })
}

export const layer = Layer.succeed(Service, Service.of({ availability: availability(), launch }))
export const node = makeLocationNode({ service: Service, layer, deps: [] })
