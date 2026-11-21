import { execFile, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { promisify } from "node:util"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { Schema } from "effect"
import { pageOperation, previewFrame, safeTree, withinPreviewSize } from "../../../../extensions/interaction-chrome/page.js"
import { runScript } from "../../../../extensions/interaction-chrome/script.js"
import { cdpObject, connectChromePipe } from "./chrome-isolated-pipe"
import type { ConsentProof, InteractionDriver, InventoryRequest, ScriptRun } from "./driver"
import type { IsolatedConsentRequest, IsolatedStop } from "./macos"

const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const exec = promisify(execFile)
const decodeObservation = Schema.decodeUnknownSync(Interaction.Observation)
const decodeFrame = Schema.decodeUnknownOption(Interaction.Frame)
const decodeChromeAction = Schema.decodeUnknownSync(Interaction.ChromeAction)
const decodeRefusal = Schema.decodeUnknownSync(Interaction.Refusal)
const decodeScriptResult = Schema.decodeUnknownSync(Interaction.ScriptResult)
const previewTransitions = new Set(["Page.frameAttached", "Page.frameDetached", "Page.frameSubtreeWillBeDetached",
  "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.documentOpened", "Page.frameStartedLoading",
  "Page.frameStartedNavigating", "DOM.documentUpdated"])

async function launch(url: string, onLost: () => void, outer: AbortSignal, chromeExecutable = executable) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Isolated Chrome requires macOS arm64")
  const { stdout } = await exec(chromeExecutable, ["--version"], { signal: outer, timeout: 3000, maxBuffer: 1024 })
  const version = chromeExecutable === executable ? /^Google Chrome (\d+)\./m : /^Google Chrome for Testing (\d+)\./m
  const major = version.exec(stdout)?.[1]
  if (!major || Number(major) < 152) throw new Error("Isolated Chrome requires installed Google Chrome 152 or newer")
  outer.throwIfAborted()
  const root = await mkdtemp(join(tmpdir(), "ycoding-interaction-chrome-"))
  const processFence = new AbortController()
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  let pipe: ReturnType<typeof connectChromePipe> | undefined
  let cleanup: Promise<void> | undefined

  function close() {
    if (cleanup) return cleanup
    processFence.abort()
    pipe?.close()
    cleanup = (async () => {
      if (child && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        terminate(child.pid, "SIGTERM")
        await waitForExit(exited, 900)
        if (child.exitCode === null && child.signalCode === null) terminate(child.pid, "SIGKILL")
      }
      if (exited && !await waitForExit(exited, 900)) throw new Error("Isolated Chrome exit was not confirmed")
      await rm(root, { recursive: true, force: true })
    })()
    return cleanup
  }

  function lost() {
    if (processFence.signal.aborted) return
    onLost()
    void close().catch(() => {})
  }

  try {
    outer.throwIfAborted()
    child = spawn(chromeExecutable, ["--headless=new", `--user-data-dir=${root}`, "--remote-debugging-pipe",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "about:blank"], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    })
    exited = new Promise((resolve) => {
      child!.once("exit", resolve)
      child!.once("error", resolve)
    })
    const input = child.stdio[3]
    const output = child.stdio[4]
    if (!(input instanceof Writable) || !(output instanceof Readable)) throw new Error("Chrome private pipe unavailable")
    const transport = connectChromePipe(output, input)
    pipe = transport
    transport.signal.addEventListener("abort", lost, { once: true })
    void exited.then(lost)
    const startup = AbortSignal.any([outer, processFence.signal])
    const approved = new URL(url)
    const origin = approved.origin
    const pathname = approved.pathname
    const networkURL = (url: URL) => `${url.origin}${url.pathname}${url.search}`
    let browserContextID: string | undefined
    let bootstrap: { id: string; context: string | undefined } | undefined
    let bootstrapSessionID: string | undefined
    let creatingTarget = false
    let receivedTarget = false
    let targetID: string | undefined
    let sessionID: string | undefined
    let rootFrame: string | undefined
    let documentID: string | undefined
    let contextID: number | undefined
    let transition = true
    const targetAttached = Promise.withResolvers<{ id: string; session: string }>()
    const loaded = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const seenLoaded = new Set<string>()
    let eventFailure = 0
    let previewEpoch = 0
    const scriptListeners = new Set<(method: string, params: unknown) => void>()
    const codeWorlds = new Map<string, unknown>()

    async function issue(signal: AbortSignal, method: string, params: Record<string, unknown> = {}, target?: string) {
      const fence = AbortSignal.any([signal, processFence.signal])
      fence.throwIfAborted()
      const result = await transport.command(method, params, fence, target)
      fence.throwIfAborted()
      return result
    }

    const browser = (signal: AbortSignal, method: string, params: Record<string, unknown> = {}) => issue(signal, method, params)
    function page(signal: AbortSignal, method: string, params: Record<string, unknown> = {}) {
      if (!sessionID) throw new Error("Chrome target unavailable")
      return issue(signal, method, params, sessionID)
    }

    function background(method: string, params: Record<string, unknown>, session?: string) {
      void issue(AbortSignal.timeout(3000), method, params, session).catch(lost)
    }

    function closeTarget(id: string) {
      void browser(AbortSignal.timeout(3000), "Target.closeTarget", { targetId: id }).then((result) => {
        if (result.success !== true) lost()
      }, lost)
    }

    transport.onEvent((event) => {
      const params = cdpObject(event.params)
      if (event.method === "Target.attachedToTarget") {
        previewEpoch++
        const info = cdpObject(params.targetInfo)
        if (typeof info.targetId !== "string" || !info.targetId || typeof params.sessionId !== "string" || !params.sessionId) {
          lost()
          return
        }
        if (bootstrap?.id === info.targetId) {
          if (bootstrapSessionID !== undefined || creatingTarget || event.sessionId !== undefined || params.waitingForDebugger !== false ||
            info.type !== "page" || info.url !== "about:blank" || info.browserContextId !== bootstrap.context) {
            lost()
            return
          }
          bootstrapSessionID = params.sessionId
          return
        }
        if (params.waitingForDebugger !== true || params.sessionId === bootstrapSessionID) { lost(); return }
        if (!sessionID) {
          if (!creatingTarget || receivedTarget || event.sessionId !== undefined || info.type !== "page" || info.url !== "about:blank" ||
            info.browserContextId !== browserContextID || (targetID !== undefined && info.targetId !== targetID)) {
            lost()
            return
          }
          receivedTarget = true
          targetAttached.resolve({ id: info.targetId, session: params.sessionId })
          return
        }
        if (info.targetId === targetID || params.sessionId === sessionID) { lost(); return }
        closeTarget(info.targetId)
        return
      }
      if (event.method === "Browser.downloadWillBegin") { eventFailure++; previewEpoch++; return }
      if (event.method === "Target.detachedFromTarget" && sessionID && params.sessionId === sessionID) { lost(); return }
      if (event.sessionId !== sessionID || !sessionID) return
      for (const listener of scriptListeners) listener(String(event.method), params)
      if (event.method === "Inspector.targetCrashed") { lost(); return }
      if (event.method === "Page.fileChooserOpened" || event.method === "Page.javascriptDialogOpening") { lost(); return }
      if (typeof event.method === "string" && previewTransitions.has(event.method)) previewEpoch++
      if (event.method === "Page.lifecycleEvent" && params.name === "DOMContentLoaded" && typeof params.loaderId === "string") {
        if (seenLoaded.size >= 64) seenLoaded.clear()
        seenLoaded.add(params.loaderId)
        loaded.get(params.loaderId)?.resolve()
      }
      if (event.method === "Page.frameNavigated" && !transition && cdpObject(params.frame).id === rootFrame) lost()
      if (event.method === "Page.navigatedWithinDocument" && params.frameId === rootFrame && (!transition || !matchesPage(params.url))) lost()
      if (event.method === "Fetch.requestPaused" && typeof params.requestId === "string") {
        const raw = cdpObject(params.request).url
        const target = parseURL(raw)
        if (params.frameId === rootFrame && params.redirectedRequestId === undefined && target && networkURL(target) === networkURL(approved)) {
          background("Fetch.continueRequest", { requestId: params.requestId }, sessionID)
        } else {
          eventFailure++
          previewEpoch++
          background("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionID)
        }
      }
    })

    const context = await browser(startup, "Target.createBrowserContext", { disposeOnDetach: true })
    if (typeof context.browserContextId !== "string" || !context.browserContextId) throw new Error("Chrome context unavailable")
    browserContextID = context.browserContextId
    await browser(startup, "Browser.setDownloadBehavior", { behavior: "deny", browserContextId: browserContextID, eventsEnabled: true })
    const filter = [{ type: "page", exclude: false }, { type: "iframe", exclude: false }, { exclude: true }]
    const { targetInfos } = await browser(startup, "Target.getTargets", { filter })
    if (!Array.isArray(targetInfos) || targetInfos.length > 1) throw new Error("Unexpected private Chrome startup targets")
    if (targetInfos.length === 1) {
      const info = cdpObject(targetInfos[0])
      if (typeof info.targetId !== "string" || !info.targetId || info.type !== "page" || info.url !== "about:blank" ||
        info.attached !== false || info.openerId !== undefined || info.browserContextId === browserContextID ||
        (info.browserContextId !== undefined && typeof info.browserContextId !== "string"))
        throw new Error("Unexpected private Chrome bootstrap target")
      bootstrap = { id: info.targetId, context: info.browserContextId }
    }
    await browser(startup, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter })
    creatingTarget = true
    const created = await browser(startup, "Target.createTarget", { url: "about:blank", browserContextId: browserContextID, background: true })
    if (typeof created.targetId !== "string") throw new Error("Chrome target unavailable")
    targetID = created.targetId
    const bound = await untilAbort(targetAttached.promise, startup)
    if (bound.id !== targetID) throw new Error("Chrome target attachment mismatch")
    sessionID = bound.session
    if (bootstrap && (await browser(startup, "Target.closeTarget", { targetId: bootstrap.id })).success !== true)
      throw new Error("Chrome bootstrap target did not close")
    await page(startup, "Page.enable")
    await page(startup, "Page.setLifecycleEventsEnabled", { enabled: true })
    await page(startup, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
    const blank = await frame(startup)
    if (typeof blank.id !== "string" || blank.url !== "about:blank") throw new Error("Chrome target not isolated")
    rootFrame = blank.id
    await page(startup, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] })
    await page(startup, "Runtime.runIfWaitingForDebugger")
    await navigate(url, startup)

    async function frame(signal: AbortSignal) {
      const tree = cdpObject((await page(signal, "Page.getFrameTree")).frameTree)
      if (tree.childFrames !== undefined && (!Array.isArray(tree.childFrames) || tree.childFrames.length !== 0)) return {}
      const main = cdpObject(tree.frame)
      return main.parentId === undefined ? main : {}
    }

    function matchesPage(raw: unknown) {
      const current = parseURL(raw)
      return current?.origin === origin && current.pathname === pathname
    }

    async function verify(signal: AbortSignal) {
      const current = await frame(signal)
      if (current.id !== rootFrame || current.loaderId !== documentID || current.securityOrigin !== origin ||
        current.unreachableUrl !== undefined || !matchesPage(current.url)) {
        lost()
        throw new Error("Chrome document changed")
      }
      if (contextID !== undefined && !(await run(signal, { operation: "scope" })).verified) {
        lost()
        throw new Error("Chrome frame state unavailable")
      }
    }

    async function navigate(destination: string, signal: AbortSignal) {
      transition = true
      previewEpoch++
      try {
        const start = await page(signal, "Page.navigate", { url: destination, frameId: rootFrame })
        if (start.errorText || start.isDownload || typeof start.loaderId !== "string") throw new Error("Chrome navigation refused")
        if (!seenLoaded.has(start.loaderId)) {
          const completion = Promise.withResolvers<void>()
          loaded.set(start.loaderId, completion)
          try { await untilAbort(completion.promise, signal) } finally { loaded.delete(start.loaderId) }
        }
        const current = await frame(signal)
        const landed = parseURL(current.url)
        if (current.id !== rootFrame || current.loaderId !== start.loaderId || current.securityOrigin !== origin ||
          current.unreachableUrl !== undefined || !landed || networkURL(landed) !== networkURL(approved))
          throw new Error("Chrome navigation did not reach the approved destination")
        documentID = start.loaderId
        const world = await page(signal, "Page.createIsolatedWorld", { frameId: rootFrame, worldName: "ycoding-interaction-isolated" })
        if (typeof world.executionContextId !== "number") throw new Error("Chrome execution context unavailable")
        contextID = world.executionContextId
        await verify(signal)
      } finally {
        transition = false
      }
    }

    async function run(signal: AbortSignal, input: Record<string, unknown>) {
      const output = await page(signal, "Runtime.callFunctionOn", { executionContextId: contextID,
        functionDeclaration: pageOperation.toString(), returnByValue: true, arguments: [{ value: { ...input, origin, pathname, isolated: true } }] })
      if (output.exceptionDetails) throw new Error("Chrome action could not settle")
      return cdpObject(cdpObject(output.result).value)
    }

    return {
      alive: () => !processFence.signal.aborted,
      async script(request: ScriptRun, signal: AbortSignal) {
        await verify(signal)
        const commands = AbortSignal.timeout(request.timeoutMs + 5000)
        const result = await runScript({ tabId: 0, leaseID: "isolated", mode: request.mode, source: request.source, timeoutMs: request.timeoutMs, signal }, {
          send: async (_tab, method, params = {}) => cdpObject(await page(commands, method, params)),
          onEvent(_tab, listener) {
            scriptListeners.add(listener)
            return () => scriptListeners.delete(listener)
          },
        }, codeWorlds)
        return { result: decodeScriptResult(result), verified: await verify(AbortSignal.timeout(5000)).then(() => true, () => false) }
      },
      async observe(signal: AbortSignal) {
        await verify(signal)
        const result = await run(signal, { operation: "observe" })
        await verify(signal)
        return { elements: result.elements, pathname }
      },
      async perform(action: Interaction.ChromeAction, signal: AbortSignal, dispatch: () => void): Promise<Interaction.ActionResult> {
        await verify(signal)
        const before = eventFailure
        if (action.type === "navigate") {
          const destination = parseURL(action.url)
          if (destination?.href !== approved.href) return { outcome: "refused", reason: "policy" }
          dispatch()
          await navigate(destination.href, signal)
        } else {
          dispatch()
          const output = await run(signal, { ...action, operation: action.type })
          if (output.refusal) return { outcome: "refused", reason: decodeRefusal(output.refusal) }
          if (!output.applied) return { outcome: "uncertain" }
        }
        await verify(signal)
        signal.throwIfAborted()
        return before === eventFailure ? { outcome: "applied" } : { outcome: "uncertain" }
      },
      async preview(signal: AbortSignal) {
        const epoch = previewEpoch
        const document = documentID
        const context = contextID
        return captureIsolatedPreview({
          current: () => !signal.aborted && !processFence.signal.aborted && !transition && epoch === previewEpoch &&
            document !== undefined && document === documentID && context !== undefined && context === contextID,
          verify: () => verify(signal),
          page: (method, params) => page(signal, method, params),
          inspect: (input) => run(signal, { ...input, operation: "preview" }),
        })
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export async function captureIsolatedPreview(binding: {
  current(): boolean
  verify(): Promise<void>
  page(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  inspect(input: { ticket?: string; keep?: boolean }): Promise<Record<string, unknown>>
}): Promise<Interaction.Frame | undefined> {
  const verify = async () => {
    if (!binding.current()) return false
    await binding.verify()
    return binding.current()
  }
  const safe = async () => binding.current() &&
    safeTree((await binding.page("DOM.getDocument", { depth: 32, pierce: true })).root) && binding.current()
  if (!await verify()) return undefined
  const before = await binding.inspect({})
  if (before.safe !== true || typeof before.ticket !== "string" || !await safe()) return undefined
  const view = cdpObject((await binding.page("Page.getLayoutMetrics")).cssVisualViewport)
  const { clientWidth: width, clientHeight: height, pageX: x, pageY: y } = view
  if (!withinPreviewSize(width, height) || ![x, y].every((offset) => typeof offset === "number" && Number.isFinite(offset)) ||
    !await verify() || (await binding.inspect({ ticket: before.ticket, keep: true })).safe !== true || !binding.current()) return undefined
  const output = await binding.page("Page.captureScreenshot", { format: "jpeg", quality: 65, fromSurface: true,
    captureBeyondViewport: false, clip: { x, y, width, height, scale: 1 } })
  if (!await verify() || !await safe() || (await binding.inspect({ ticket: before.ticket })).safe !== true || !binding.current()) return undefined
  const image = previewFrame("image/jpeg", output.data)
  if (!image) return undefined
  const frame = decodeFrame(image)
  return frame._tag === "Some" ? frame.value : undefined
}

function parseURL(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 2048 || /[\s\\]/u.test(raw) || !URL.canParse(raw)) return undefined
  const url = new URL(raw)
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : undefined
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Chrome operation interrupted"))
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

function terminate(pid: number, signal: "SIGTERM" | "SIGKILL") {
  try { process.kill(-pid, signal) } catch (error) {
    if (cdpObject(error).code !== "ESRCH") throw error
  }
}

async function waitForExit(exit: Promise<unknown> | undefined, timeout: number) {
  if (!exit) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([exit.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout) })])
  } finally { clearTimeout(timer) }
}

function isStopHandle(value: unknown): value is IsolatedStop {
  const handle = cdpObject(value)
  return typeof handle.candidateID === "string" && handle.signal instanceof AbortSignal &&
    typeof handle.bind === "function" && typeof handle.close === "function"
}

export function makeChromeIsolatedDriver(options: {
  readonly lost: (leaseID: Interaction.ID, reason: "stopped" | "target_lost") => void
  readonly confirmIsolated: (request: IsolatedConsentRequest, signal: AbortSignal) => Promise<IsolatedStop | undefined>
  readonly chromeExecutable?: string
}, launchRuntime = launch) {
  interface Offered {
    readonly request: InventoryRequest
    readonly target: Interaction.Target & { readonly kind: "chrome-isolated" }
    state: "offered" | "confirming" | "approved" | "closed"
    proof?: ConsentProof
    stop?: IsolatedStop
    releaseStop?: () => void
  }
  interface Active {
    readonly runtime: Awaited<ReturnType<typeof launch>>
    readonly abort: AbortController
    readonly stop: IsolatedStop
    readonly releaseStop: () => void
    revision: number
    awaitingObservation: boolean
    refs: Set<Interaction.ID>
    calls: Set<Interaction.ID>
  }
  const offers = new Map<Interaction.ID, Offered>()
  const active = new Map<Interaction.ID, Active>()
  const closing = new Map<Interaction.ID, Promise<void>>()
  let starting = 0

  function offer(proof: Pick<ConsentProof, "candidateID" | "sessionID" | "targetID">) {
    const value = offers.get(proof.candidateID)
    if (value?.request.sessionID !== proof.sessionID || value.target.id !== proof.targetID || value.state === "closed" ||
      value.request.expiresAt <= Date.now()) return undefined
    return value
  }

  function consume(candidate: Offered) {
    const stop = candidate.stop
    candidate.state = "closed"
    candidate.proof = undefined
    candidate.stop = undefined
    candidate.releaseStop?.()
    candidate.releaseStop = undefined
    return stop
  }

  function close(id: Interaction.ID) {
    const live = active.get(id)
    if (!live) return closing.get(id) ?? Promise.resolve()
    active.delete(id)
    live.releaseStop()
    live.abort.abort()
    const done = Promise.resolve().then(async () => {
      try { live.stop.close() } finally { await live.runtime.close() }
    }).finally(() => closing.delete(id))
    closing.set(id, done)
    return done
  }

  const driver: InteractionDriver = {
    platform: "chrome",
    async inventory(request) {
      if (request.purpose !== "attach") return []
      const selection = request.selection
      if (selection.platform !== "chrome" || selection.mode !== "isolated") return []
      const url = parseURL(selection.url)
      if (!url || url.href !== selection.url) return []
      const now = Date.now()
      for (const [id, value] of offers) {
        if (value.request.expiresAt > now) continue
        offers.delete(id)
        consume(value)?.close()
      }
      const existing = offers.get(request.candidateID)
      if (existing) return existing.state !== "closed" && existing.request.sessionID === request.sessionID &&
        existing.request.expiresAt === request.expiresAt && existing.target.url === url.href ? [existing.target] : []
      const lifetime = request.expiresAt - now
      if (!Number.isSafeInteger(request.expiresAt) || lifetime <= 0 || lifetime > 60_000 || offers.size >= 64) return []
      const target = { kind: "chrome-isolated" as const, id: Interaction.ID.create(), label: "Temporary isolated Chrome", origin: url.origin,
        pathname: url.pathname, url: url.href }
      offers.set(request.candidateID, { request, target, state: "offered" })
      return [target]
    },
    async attach(target, proof, signal) {
      const candidate = offer(proof)
      if (!candidate || candidate.state !== "approved" || candidate.proof?.authorization !== proof.authorization)
        throw new Error("Isolated Chrome consent unavailable")
      const stop = consume(candidate)
      if (!stop || stop.candidateID !== proof.candidateID || stop.signal.aborted || target.kind !== "chrome-isolated" ||
        target.id !== candidate.target.id ||
        target.url !== candidate.target.url || target.origin !== candidate.target.origin || target.pathname !== candidate.target.pathname ||
        starting + active.size + closing.size >= 4) {
        stop?.close()
        throw new Error("Isolated Chrome consent unavailable")
      }
      const remaining = candidate.request.expiresAt - Date.now()
      if (remaining <= 0) {
        stop.close()
        throw new Error("Isolated Chrome consent expired")
      }
      const id = Interaction.ID.create()
      const startup = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(remaining)])
      const abort = new AbortController()
      let runtime: Awaited<ReturnType<typeof launch>> | undefined
      const interrupt = (reason: "stopped" | "target_lost") => {
        abort.abort(reason)
        if (!active.has(id)) return
        void close(id).catch(() => {})
        options.lost(id, reason)
      }
      const stopped = () => interrupt(stop.signal.reason === "stopped" ? "stopped" : "target_lost")
      const releaseStop = () => stop.signal.removeEventListener("abort", stopped)
      stop.signal.addEventListener("abort", stopped, { once: true })
      starting++
      try {
        startup.throwIfAborted()
        if (!await untilAbort(stop.bind(id, startup), startup)) throw new Error("Isolated Chrome Stop binding unavailable")
        startup.throwIfAborted()
        runtime = await launchRuntime(target.url, () => interrupt("target_lost"), startup, options.chromeExecutable)
        startup.throwIfAborted()
        abort.signal.throwIfAborted()
        if (!runtime.alive()) throw new Error("Isolated Chrome start interrupted")
        active.set(id, { runtime, abort, stop, releaseStop, revision: 0, awaitingObservation: false, refs: new Set(), calls: new Set() })
        return { id }
      } catch (error) {
        releaseStop()
        try { stop.close() } finally { await runtime?.close() }
        throw error
      } finally {
        starting--
      }
    },
    async observe(lease, signal) {
      const live = active.get(lease.id)
      if (!live) throw new Error("Chrome lease unavailable")
      const scoped = AbortSignal.any([signal, live.abort.signal, live.stop.signal])
      const observation = decodeObservation({ ...await live.runtime.observe(scoped), revision: live.revision + 1 })
      scoped.throwIfAborted()
      live.revision = observation.revision
      live.awaitingObservation = false
      live.refs = new Set(observation.elements.map((element) => element.id))
      return observation
    },
    async perform(lease, revision, command, signal) {
      const live = active.get(lease.id)
      if (!live || live.awaitingObservation || live.revision !== revision || live.calls.has(command.callID) || live.calls.size >= 512 || signal.aborted)
        return { outcome: "refused", reason: "stale" }
      const action = decodeChromeAction(command.action)
      if ("elementID" in action && !live.refs.has(action.elementID)) return { outcome: "refused", reason: "stale" }
      if (action.destructive) return { outcome: "refused", reason: "unsupported" }
      live.calls.add(command.callID)
      const scoped = AbortSignal.any([signal, live.abort.signal, live.stop.signal])
      let dispatched = false
      try {
        const result = await live.runtime.perform(action, scoped, () => {
          scoped.throwIfAborted()
          dispatched = true
          if (action.type === "navigate") live.awaitingObservation = true
        })
        scoped.throwIfAborted()
        if (result.outcome !== "refused") live.refs.clear()
        if (result.outcome === "uncertain") void close(lease.id).catch(() => {})
        return result
      } catch {
        if (!dispatched) return { outcome: "refused", reason: "target_lost" }
        void close(lease.id).catch(() => {})
        return { outcome: "uncertain" }
      }
    },
    async preview(lease, signal) {
      const live = active.get(lease.id)
      return live?.runtime.preview(AbortSignal.any([signal, live.abort.signal, live.stop.signal]))
    },
    resume: async () => false,
    async run(lease, script, signal) {
      const live = active.get(lease.id)
      if (!live || live.awaitingObservation || signal.aborted) return { outcome: "refused", reason: "stale" }
      live.awaitingObservation = true
      live.refs.clear()
      try {
        const ran = await live.runtime.script(script, AbortSignal.any([signal, live.abort.signal, live.stop.signal]))
        if (!ran.verified && active.has(lease.id)) {
          void close(lease.id).catch(() => {})
          options.lost(lease.id, "target_lost")
        }
        return ran.result
      } catch (error) {
        void close(lease.id).catch(() => {})
        throw error
      }
    },
    detach: (lease) => close(lease.id),
  }

  return {
    driver,
    async approve(input: Pick<ConsentProof, "candidateID" | "sessionID" | "targetID">, signal: AbortSignal) {
      const candidate = offer(input)
      if (!candidate || candidate.state !== "offered" || signal.aborted) return undefined
      const remaining = candidate.request.expiresAt - Date.now()
      if (remaining <= 0) return undefined
      candidate.state = "confirming"
      const scoped = AbortSignal.any([signal, AbortSignal.timeout(remaining)])
      const request = { candidateID: candidate.request.candidateID, sessionID: candidate.request.sessionID,
        url: candidate.target.url, expiresAt: candidate.request.expiresAt }
      try {
        scoped.throwIfAborted()
        const pending = options.confirmIsolated(request, scoped).then((result: unknown) => {
          if (!isStopHandle(result)) return undefined
          if (scoped.aborted || result.signal.aborted || result.candidateID !== request.candidateID || offer(input) !== candidate) {
            result.close()
            return undefined
          }
          return result
        })
        const stop = await untilAbort(pending, scoped)
        if (!stop) return undefined
        if (scoped.aborted || stop.signal.aborted || offer(input) !== candidate) {
          stop.close()
          return undefined
        }
        const proof = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: candidate.target.id,
          authorization: crypto.randomUUID() + crypto.randomUUID() }
        candidate.proof = proof
        candidate.stop = stop
        candidate.state = "approved"
        const lifetime = AbortSignal.any([scoped, stop.signal])
        const revoke = () => { consume(candidate)?.close() }
        candidate.releaseStop = () => lifetime.removeEventListener("abort", revoke)
        lifetime.addEventListener("abort", revoke, { once: true })
        return proof
      } catch {
        return undefined
      } finally {
        if (candidate.state === "confirming") consume(candidate)?.close()
      }
    },
  }
}
