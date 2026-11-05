import { spawn, execFile } from "node:child_process"
import path from "node:path"
import type { Endpoint } from "@ycoding-ai/client/service"
import type { YCodingEvent } from "@ycoding-ai/client"
import { currentModel, modelSelection, modelSource, openedModelLocation, projectDefault, projectModels, running, sameModelLocation, sessionModelLocation, switchRequest, type ModelLocation } from "./models"
import { connectNative } from "./native-client"
import { validateSelection } from "./preferences"
import { requestReply, session } from "./requests"
import { bundledBackend } from "./resources"
import { pinRequest, projectSessionRecord, projectSessions, sessionsQuery, sessionTarget } from "./sessions"
import { DesktopError, utf8Length, type ConnectionState, type Selection } from "./contract"

type Native = Awaited<ReturnType<typeof connectNative>>
type Control = ReturnType<typeof openControl>
type Attempt = { readonly generation: number; readonly abort: AbortController; revision: number; control?: Control; native?: Native; pending?: Promise<ConnectionState> }
type Pages = { readonly revision: number; readonly cursors: string[] }
type Launch = (command: readonly [string, ...string[]]) => readonly [string, ...string[]]
type Options = {
  readonly env?: NodeJS.ProcessEnv
  readonly launch?: Launch
  readonly onEvent?: (event: YCodingEvent) => void | Promise<void>
  readonly onState?: (state: ConnectionState) => void
}

const direct: Launch = (command) => command
const unsent = "The backend connection changed before the answer was sent. Refresh requests and answer again."
const unswitched = "The backend connection changed before the model was switched. Refresh models and choose again."
const stopFirst = "Stop the running chat before switching models."
const unpaged = "The backend connection changed before more Sessions were read. Refresh Sessions."

async function catalog(api: Native["api"], signal: AbortSignal, location: ModelLocation) {
  const [list, fallback] = await Promise.all([api.model.list({ location }, { signal }), api.model.default({ location }, { signal })])
  if (!sameModelLocation(list, location) || !sameModelLocation(fallback, location))
    throw new DesktopError("The backend returned models for a different location. Refresh to retry.")
  return { models: projectModels(list.data), default: projectDefault(fallback.data) }
}

async function readTarget(api: Native["api"], signal: AbortSignal, sessionID: string) {
  const [found, active] = await Promise.all([api.session.get({ sessionID }, { signal }), api.session.active({ signal })])
  return { location: sessionModelLocation(sessionID, found), current: currentModel(found), running: running(active, sessionID) }
}

function reply(value: unknown, version: string): Endpoint {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "desktop.endpoint" ||
    !("version" in value) || value.version !== version || !("endpoint" in value) || typeof value.endpoint !== "object" || value.endpoint === null)
    throw new Error("The bundled backend returned an incompatible lease response.")
  const endpoint = value.endpoint
  if (!("url" in endpoint) || typeof endpoint.url !== "string") throw new Error("Invalid native backend endpoint.")
  const url = new URL(endpoint.url)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid native backend endpoint.")
  if (!("auth" in endpoint) || endpoint.auth === undefined) return { url: url.href }
  const auth = endpoint.auth
  if (typeof auth !== "object" || auth === null || !("type" in auth) || auth.type !== "basic" ||
    !("username" in auth) || typeof auth.username !== "string" || !("password" in auth) || typeof auth.password !== "string")
    throw new Error("Invalid native backend authentication capability.")
  return { url: url.href, auth: { type: "basic", username: auth.username, password: auth.password } }
}

function openControl(binary: { executable: string; version: string }, selection: Selection, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal, launch: Launch) {
  const args = ["desktop-host", "--backend", binary.executable, "--mode", selection.mode]
  if (selection.mode === "shared" && selection.server) args.push("--server", selection.server)
  const [file, ...rest] = launch([binary.executable, ...args])
  const process = spawn(file, rest, { env, stdio: ["pipe", "pipe", "pipe"] })
  const ready = Promise.withResolvers<Endpoint>()
  const closed = Promise.withResolvers<void>()
  let buffer = ""
  let received = false
  let closing: Promise<void> | undefined
  const failure = () => new DesktopError(selection.mode === "own"
    ? "The private bundled backend did not start. Retry or rebuild the desktop app."
    : "The shared backend is unavailable or incompatible. Start it manually or check the endpoint and retry.")
  const timeout = setTimeout(() => { ready.reject(failure()); void close() }, 30_000)
  process.stdout.on("data", (chunk: Buffer) => {
    if (received) return
    buffer += chunk.toString("utf8")
    if (buffer.length > 65_536) { ready.reject(failure()); void close(); return }
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    received = true
    clearTimeout(timeout)
    try { ready.resolve(reply(JSON.parse(buffer.slice(0, newline)), binary.version)) }
    catch { ready.reject(failure()); void close() }
    buffer = ""
  })
  process.stderr.resume()
  process.stdin.on("error", () => ready.reject(failure()))
  process.once("error", () => ready.reject(failure()))
  process.once("close", () => { clearTimeout(timeout); ready.reject(failure()); closed.resolve() })
  const abort = () => { ready.reject(new DesktopError("Backend connection was cancelled.")); void close() }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  function close() {
    if (closing) return closing
    closing = (async () => {
      signal.removeEventListener("abort", abort)
      clearTimeout(timeout)
      process.stdin.end()
      const terminate = setTimeout(() => process.kill("SIGTERM"), 5_000)
      const force = setTimeout(() => process.kill("SIGKILL"), 8_000)
      try { await closed.promise } finally { clearTimeout(terminate); clearTimeout(force) }
    })()
    return closing
  }
  return { ready: ready.promise, closed: closed.promise, close }
}

async function checkVersion(binary: { executable: string; version: string }, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal, launch: Launch) {
  const [file, ...rest] = launch([binary.executable, "--version"])
  const version = await new Promise<string>((resolve, reject) => {
    execFile(file, rest, { env, signal, timeout: 10_000, maxBuffer: 16_384 }, (error, stdout) => {
      if (error) reject(new DesktopError("The bundled backend could not report its version. Rebuild the desktop app."))
      else resolve(stdout.trim())
    })
  })
  if (version !== `ycoding v${binary.version}`) throw new DesktopError("The bundled backend version does not match its bundle manifest. Rebuild the desktop app.")
}

export class BackendController {
  private current?: Attempt
  private generation = 0
  private revision = 0
  private pages?: Pages
  private snapshot: ConnectionState = { generation: 0, status: "idle" }

  constructor(private readonly resources: string, private readonly options: Options = {}) {}

  state() { return this.snapshot }

  private publish(state: ConnectionState) {
    if (state.revision !== this.pages?.revision) this.pages = undefined
    this.snapshot = state
    this.options.onState?.(state)
    return state
  }

  async connect(input: unknown): Promise<ConnectionState> {
    const selection = validateSelection(input)
    const previous = this.current
    previous?.abort.abort()
    const attempt: Attempt = { generation: ++this.generation, abort: new AbortController(), revision: 0 }
    this.current = attempt
    this.publish({ generation: attempt.generation, mode: selection.mode, status: "connecting" })
    attempt.pending = (async () => {
      try {
        await this.retire(previous)
        if (this.current !== attempt) throw new DesktopError("Backend connection was cancelled.")
        const binary = await bundledBackend(this.resources)
        const launch = this.options.launch ?? direct
        await checkVersion(binary, this.options.env, attempt.abort.signal, launch)
        attempt.abort.signal.throwIfAborted()
        attempt.control = openControl(binary, selection, this.options.env, attempt.abort.signal, launch)
        const endpoint = await attempt.control.ready
        attempt.abort.signal.throwIfAborted()
        if (selection.mode === "own" && endpoint.auth === undefined) throw new DesktopError("The private backend did not provide its authentication capability.")
        const native = await connectNative(endpoint, {
          signal: attempt.abort.signal,
          version: selection.mode === "own" ? binary.version : undefined,
          onEvent: (event) => this.current === attempt ? this.options.onEvent?.(event) : undefined,
          onStatus: (status) => {
            if (this.current !== attempt || this.snapshot.status === "connecting") return
            if (status.status !== "connected") { this.publish({ ...this.snapshot, status: "reconnecting" }); return }
            attempt.revision = ++this.revision
            this.publish({ generation: attempt.generation, mode: selection.mode, status: "connected", revision: attempt.revision, version: status.health.version, backendPID: status.health.pid })
          },
          reconnect: selection.mode === "shared" && !selection.server ? async (signal) => {
            await attempt.control?.close()
            signal.throwIfAborted()
            attempt.control = openControl(binary, selection, this.options.env, signal, launch)
            return attempt.control.ready
          } : undefined,
        })
        attempt.native = native
        if (this.current !== attempt || attempt.abort.signal.aborted) { await native.close(); throw new DesktopError("Backend connection was cancelled.") }
        attempt.revision = ++this.revision
        const connected = this.publish({ generation: attempt.generation, mode: selection.mode, status: "connected", revision: attempt.revision, version: native.health.version, backendPID: native.health.pid })
        if (selection.mode === "own") void attempt.control.closed.then(() => this.stopped(attempt))
        return connected
      } catch (error) {
        const failure = error instanceof DesktopError ? error : new DesktopError(attempt.abort.signal.aborted ? "Backend connection was cancelled." : "Backend connection failed. Retry.")
        attempt.abort.abort()
        await attempt.native?.close()
        await attempt.control?.close()
        if (this.current === attempt) this.publish({ generation: attempt.generation, mode: selection.mode, status: "error", error: failure.message })
        throw failure
      }
    })()
    return attempt.pending
  }

  async disconnect() {
    const previous = this.current
    this.current = undefined
    const generation = ++this.generation
    await this.retire(previous)
    if (this.generation === generation) this.publish({ generation, status: "idle" })
  }

  private async stopped(attempt: Attempt) {
    if (this.current !== attempt || attempt.abort.signal.aborted) return
    attempt.abort.abort()
    await attempt.native?.close()
    if (this.current === attempt)
      this.publish({ generation: attempt.generation, mode: "own", status: "error", error: "The private backend stopped unexpectedly. Start my own backend to restart it, or connect to a shared backend." })
  }

  private async retire(previous: Attempt | undefined) {
    if (!previous) return
    previous.abort.abort()
    await previous.native?.close()
    await previous.control?.close()
    await previous.pending?.catch(() => undefined)
  }

  private async use<T>(failure: string, run: (api: Native["api"], signal: AbortSignal, revision: number) => Promise<T>, fence: { readonly revision?: number; readonly unsent?: string; readonly changed?: string } = {}) {
    const current = this.current
    if (!current?.native || this.snapshot.status !== "connected") throw new DesktopError("Connect to a backend before using Sessions.")
    const revision = current.revision
    if (fence.revision !== undefined && fence.revision !== revision) throw new DesktopError(fence.unsent ?? unsent)
    let value: T
    try { value = await run(current.native.api, current.abort.signal, revision) }
    catch (error) { throw error instanceof DesktopError ? error : new DesktopError(failure) }
    if (this.current !== current || current.revision !== revision) throw new DesktopError(fence.changed ?? "The backend connection changed.")
    return value
  }

  async sessions(input: unknown) {
    const query = sessionsQuery(input)
    const page = query.cursor === undefined
      ? await this.use("Sessions could not be read. Refresh to retry.", async (api, signal, revision) =>
        projectSessions(await api.session.list({ limit: 40, ...(query.search === undefined ? {} : { search: query.search }) }, { signal }), revision))
      : await this.use("More Sessions could not be read. Refresh to retry.", async (api, signal, revision) => {
        const pages = this.pages
        if (pages?.revision !== revision || !pages.cursors.includes(query.cursor)) throw new DesktopError("Load more Sessions only from the current list. Refresh Sessions and try again.")
        return projectSessions(await api.session.list({ limit: 40, cursor: query.cursor }, { signal }), revision)
      }, { revision: query.revision, unsent: unpaged, changed: unpaged })
    if (page.next !== undefined && page.revision === this.current?.revision) {
      const pages: Pages = this.pages?.revision === page.revision ? this.pages : { revision: page.revision, cursors: [] }
      this.pages = pages
      const known = pages.cursors.indexOf(page.next)
      if (known >= 0) pages.cursors.splice(known, 1)
      pages.cursors.push(page.next)
      if (pages.cursors.length > 64) pages.cursors.shift()
    }
    return page
  }

  async session(input: unknown) {
    const sessionID = sessionTarget(input)
    return this.use("The Session could not be read. Refresh to retry.", async (api, signal, revision) =>
      ({ revision, item: projectSessionRecord(sessionID, await api.session.get({ sessionID }, { signal })) }),
    { changed: "The backend connection changed while the Session was read. Refresh to retry." })
  }

  async pin(input: unknown) {
    const request = pinRequest(input)
    await this.use("The pin change was not confirmed. Refresh Sessions to see whether it changed.", async (api, signal) => {
      if (request.pinned) await api.session.pin({ sessionID: request.sessionID }, { signal })
      else await api.session.unpin({ sessionID: request.sessionID }, { signal })
    }, { revision: request.revision, unsent: "The backend connection changed before the pin was changed. Refresh Sessions and try again.",
      changed: "The pin change was not confirmed before the connection changed. Refresh Sessions to see whether it changed." })
    return null
  }

  async workspaces() {
    return this.use("Previously opened repositories could not be read. Refresh to retry.", async (api, signal) =>
      (await api.project.inventory({ limit: 50 }, { signal })).data
        .filter((entry) => entry.available)
        .map((entry) => ({ directory: entry.directory, ...(entry.projectName ? { name: entry.projectName } : {}) })))
  }

  async messages(input: unknown) {
    const sessionID = session(input)
    return this.use("The transcript could not be read. Refresh to retry.", (api, signal) => api.message.list({ sessionID }, { signal }))
  }

  async createSession(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).sort().join() !== "directory,sessionID" || !("directory" in input) || !("sessionID" in input))
      throw new DesktopError("Choose a previously opened repository.")
    const id = session(input.sessionID)
    const directory = input.directory
    if (typeof directory !== "string" || utf8Length(directory) > 4096 || !path.isAbsolute(directory)) throw new DesktopError("Choose a previously opened repository.")
    return this.use("The chat could not be created in this repository. Check it and retry.", async (api, signal) => {
      const listed = await api.project.inventory({ limit: 50, search: directory }, { signal })
      if (!listed.data.some((entry) => entry.available && entry.directory === directory))
        throw new DesktopError("Choose an available, previously opened repository for the new chat.")
      const created = await api.session.create({ id, location: { directory } }, { signal })
      if (created.id !== id || created.location.directory !== directory || created.scope === "standalone")
        throw new DesktopError("The backend returned a different Session placement. Check Sessions before retrying.")
      return created
    })
  }

  async prompt(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).sort().join() !== "promptID,sessionID,text" ||
      !("sessionID" in input) || !("promptID" in input) || !("text" in input)) throw new DesktopError("Invalid message.")
    const sessionID = session(input.sessionID)
    const id = input.promptID
    if (typeof id !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(id)) throw new DesktopError("Invalid message.")
    const text = input.text
    if (typeof text !== "string" || !text.trim()) throw new DesktopError("Enter a message before sending.")
    if (text.length > 200_000) throw new DesktopError("The message is too long to send.")
    return this.use("The message was not confirmed. Retry sends the same message once; check the Session first.", async (api, signal) => {
      const admitted = await api.session.prompt({ id, sessionID, text }, { signal })
      if (admitted.id !== id || admitted.sessionID !== sessionID) throw new DesktopError("The backend confirmed a different message. Check the Session before sending again.")
      return admitted
    })
  }

  async interrupt(input: unknown) {
    const sessionID = session(input)
    await this.use("Stopping the chat was not confirmed. Check the Session before retrying.", (api, signal) => api.session.interrupt({ sessionID }, { signal }),
      { changed: "Stopping the chat was not confirmed before the connection changed. Check the Session before retrying." })
    return null
  }

  async requests(input: unknown) {
    const sessionID = session(input)
    return this.use("Pending requests could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [permissions, forms] = await Promise.all([api.permission.list({ sessionID }, { signal }), api.form.list({ sessionID }, { signal })])
      return { sessionID, revision, permissions, forms }
    })
  }

  async reply(input: unknown) {
    const answer = requestReply(input)
    const stale = "This request is no longer pending. Refresh requests."
    const target = await this.use("Pending requests could not be read. Refresh to retry.", async (api, signal) => {
      if (answer.kind === "permission") {
        const request = (await api.permission.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.requestID)
        if (!request) throw new DesktopError(stale)
        return { sessionID: request.sessionID, id: request.id }
      }
      const form = (await api.form.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.formID)
      if (!form) throw new DesktopError(stale)
      return { sessionID: form.sessionID, id: form.id }
    }, { revision: answer.revision, changed: unsent })
    await this.use("The answer was not confirmed. Refresh requests to see whether it was applied.", async (api, signal) => {
      if (answer.kind === "permission")
        await api.permission.reply({ sessionID: target.sessionID, requestID: target.id, reply: answer.reply, ...(answer.message === undefined ? {} : { message: answer.message }) }, { signal })
      else if (answer.kind === "form") await api.form.reply({ sessionID: target.sessionID, formID: target.id, answer: answer.answer }, { signal })
      else await api.form.cancel({ sessionID: target.sessionID, formID: target.id }, { signal })
    }, { revision: answer.revision, changed: "The answer was not confirmed before the connection changed. Refresh requests to see whether it was applied." })
    return null
  }

  async models(input: unknown) {
    const source = modelSource(input)
    return this.use("Models could not be read. Refresh to retry.", async (api, signal, revision) => {
      if ("directory" in source) {
        const listed = await api.project.inventory({ limit: 50, search: source.directory }, { signal })
        return { revision, source, ...(await catalog(api, signal, openedModelLocation(source.directory, listed.data))) }
      }
      const target = await readTarget(api, signal, source.sessionID)
      return { revision, source, current: target.current, running: target.running, ...(await catalog(api, signal, target.location)) }
    })
  }

  async switchModel(input: unknown) {
    const request = switchRequest(input)
    const model = await this.use("Models could not be read. Refresh models and choose again.", async (api, signal) => {
      const target = await readTarget(api, signal, request.sessionID)
      if (target.running) throw new DesktopError(stopFirst)
      return modelSelection(request.model, (await catalog(api, signal, target.location)).models)
    }, { revision: request.revision, unsent: unswitched, changed: unswitched })
    await this.use("The model switch was not confirmed. Refresh models to see whether it changed.", async (api, signal) => {
      if (running(await api.session.active({ signal }), request.sessionID)) throw new DesktopError(stopFirst)
      await api.session.switchModel({ sessionID: request.sessionID, model }, { signal })
    }, { revision: request.revision, unsent: unswitched, changed: "The model switch was not confirmed before the connection changed. Refresh models to see whether it changed." })
    return null
  }
}
