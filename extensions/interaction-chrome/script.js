import { redactText } from "./redact.js"

const defaultTimeout = 10000
const maxLogs = 200
const maxLogText = 2048
const maxRawText = 4096
const maxRawError = 16384
const maxValueBytes = 65536
const maxRawValue = maxValueBytes
const levels = { log: "log", info: "info", warning: "warn", error: "error", assert: "error", debug: "debug" }
const jsonString = /"(?:[^"\\]|\\.)*"/g
const disposeCall = "function () { this() }"
const handoffs = { "Page.javascriptDialogOpening": "dialog", "Page.fileChooserOpened": "file_chooser" }
const runtimeSessions = new Map()

export async function runScript(input, cdp, worlds) {
  if (input.signal?.aborted) return { outcome: "stopped", logs: [] }
  const send = (method, params = {}) => cdp.send(input.tabId, method, params)
  const state = { settled: false, dispatched: false, truncated: false, context: undefined, world: undefined, group: `ycoding-run-${crypto.randomUUID()}`,
    start: Date.now() }
  const runtime = acquireRuntime(input.tabId, send)
  const logs = []
  const interrupted = Promise.withResolvers()
  const unsubscribe = cdp.onEvent(input.tabId, (method, params) => {
    if (state.settled) return
    if (handoffs[method]) interrupted.resolve({ outcome: "paused", reason: handoffs[method] })
    if (state.context === undefined) return
    const entry = logEntry(method, params, state.context, state.start)
    if (!entry) return
    if (logs.length >= maxLogs) {
      state.truncated = true
      return
    }
    logs.push(entry)
  })
  const timer = setTimeout(() => interrupted.resolve({ outcome: "timeout" }), input.timeoutMs ?? defaultTimeout)
  const abort = () => interrupted.resolve({ outcome: "stopped" })
  input.signal?.addEventListener("abort", abort, { once: true })
  const work = execute(input, send, worlds, state, runtime.ready)
  void work.catch(() => {})
  const settled = await Promise.race([
    work.then((result) => ({ result }), (error) => ({ error })),
    interrupted.promise.then((interruption) => ({ interruption })),
  ])
  state.settled = true
  clearTimeout(timer)
  input.signal?.removeEventListener("abort", abort)
  unsubscribe()
  releaseRuntime(input.tabId, send, runtime)
  const terminate = settled.interruption && settled.interruption.outcome !== "paused" && state.dispatched
  if (terminate) void send("Runtime.terminateExecution").catch(() => {})
  if (state.dispatched) void send("Runtime.releaseObjectGroup", { objectGroup: state.group }).catch(() => {})
  if (input.mode === "script" && state.world) void state.world.dispose()
  if (settled.error) throw settled.error
  const collected = { logs: [...logs], ...(state.truncated ? { logsTruncated: true } : {}) }
  if (settled.interruption?.outcome === "paused") return settled.interruption
  if (settled.interruption) return { ...settled.interruption, ...collected }
  return { ...settled.result, ...collected }
}

export function discardWorlds(worlds, leaseID) {
  const world = worlds.get(leaseID)
  if (!world) return
  worlds.delete(leaseID)
  void world.then((entry) => entry.dispose(), () => {})
}

function acquireRuntime(tabId, send) {
  const current = runtimeSessions.get(tabId)
  if (current) {
    current.users++
    return current
  }
  const entry = { users: 1, ready: send("Runtime.enable") }
  void entry.ready.catch(() => {})
  runtimeSessions.set(tabId, entry)
  return entry
}

function releaseRuntime(tabId, send, entry) {
  entry.users--
  if (entry.users > 0 || runtimeSessions.get(tabId) !== entry) return
  runtimeSessions.delete(tabId)
  void entry.ready.then(() => send("Runtime.disable")).catch(() => {})
}

async function execute(input, send, worlds, state, runtimeReady) {
  const guard = () => {
    if (state.settled) throw new Error("The script run already settled")
  }
  await runtimeReady
  const frame = (await send("Page.getFrameTree")).frameTree?.frame
  if (typeof frame?.id !== "string") throw new Error("The granted tab has no top-level frame")
  const world = input.mode === "code" ? await codeWorld(send, frame, worlds, input.leaseID) : await createWorld(send, frame)
  if (input.mode === "script") {
    state.world = world
    if (state.settled) void world.dispose()
  }
  guard()
  state.context = world.contextId
  state.dispatched = true
  const common = { awaitPromise: true, returnByValue: false, userGesture: false, objectGroup: state.group }
  const ran = input.mode === "code" ?
    await send("Runtime.evaluate", { ...common, expression: input.source, contextId: world.contextId, replMode: true }) :
    await send("Runtime.callFunctionOn", { ...common, functionDeclaration: `async function () {\n${input.source}\n}`, executionContextId: world.contextId })
  guard()
  if (ran.exceptionDetails) return { outcome: "error", error: await describeError(send, ran.exceptionDetails) }
  if (!ran.result?.objectId) return { outcome: "completed", ...deliver(JSON.stringify(primitiveValue(ran.result))) }
  const serialized = await send("Runtime.callFunctionOn", { objectId: ran.result.objectId, functionDeclaration: serializeValue.toString(),
    arguments: [{ value: maxRawValue }], returnByValue: true, userGesture: false })
  guard()
  if (serialized.exceptionDetails) return { outcome: "error", error: await describeError(send, serialized.exceptionDetails) }
  const delivered = deliver(serialized.result?.value)
  if (delivered) return { outcome: "completed", ...delivered }
  return { outcome: "error", error: { name: "TypeError", message: "The script returned a value that cannot be serialized as JSON" } }
}

async function codeWorld(send, frame, worlds, leaseID) {
  const stored = worlds.get(leaseID)
  const current = await stored?.catch(() => undefined)
  if (current && current.frameId === frame.id && current.loaderId === frame.loaderId) return current
  if (stored && worlds.get(leaseID) === stored) discardWorlds(worlds, leaseID)
  const created = createWorld(send, frame)
  worlds.set(leaseID, created)
  void created.catch(() => {
    if (worlds.get(leaseID) === created) worlds.delete(leaseID)
  })
  return created
}

async function createWorld(send, frame) {
  const worldName = `ycoding-script-${crypto.randomUUID()}`
  const source = `(${hardenWorld.toString()})()`
  const script = await send("Page.addScriptToEvaluateOnNewDocument", { source, worldName })
  const release = async (objectId) => {
    await Promise.allSettled([
      objectId ? send("Runtime.callFunctionOn", { objectId, functionDeclaration: disposeCall, userGesture: false }) : undefined,
      send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script.identifier }),
    ])
    await send("Runtime.releaseObjectGroup", { objectGroup: worldName }).catch(() => {})
  }
  const prepared = await prepareWorld(send, frame, worldName, source).catch(async (error) => {
    await release()
    throw error
  })
  return { frameId: frame.id, loaderId: frame.loaderId, contextId: prepared.contextId, dispose: () => release(prepared.dispose) }
}

async function prepareWorld(send, frame, worldName, source) {
  const world = await send("Page.createIsolatedWorld", { frameId: frame.id, worldName, grantUniveralAccess: false })
  if (!Number.isSafeInteger(world?.executionContextId)) throw new Error("The isolated world has no execution context")
  const hardened = await send("Runtime.evaluate", { expression: source, contextId: world.executionContextId, objectGroup: worldName,
    returnByValue: false, userGesture: false })
  if (hardened.exceptionDetails || hardened.result?.type !== "function" || !hardened.result.objectId)
    throw new Error("The isolated world could not be hardened")
  return { contextId: world.executionContextId, dispose: hardened.result.objectId }
}

function logEntry(method, params, contextId, start) {
  if (typeof params?.timestamp === "number" && params.timestamp < start) return undefined
  if (method === "Runtime.consoleAPICalled" && params?.executionContextId === contextId)
    return { level: levels[params.type] ?? "log", text: bounded((params.args ?? []).map(argumentText).join(" "), maxLogText) }
  const details = params?.exceptionDetails
  if (method === "Runtime.exceptionThrown" && details?.executionContextId === contextId)
    return { level: "error", text: bounded(details.exception?.description ?? details.text ?? "", maxLogText) }
  return undefined
}

function argumentText(argument) {
  if (argument?.type === "undefined") return "undefined"
  if (argument?.type === "string") return argument.value.slice(0, maxRawText)
  if (argument && "value" in argument) return String(argument.value)
  return argument?.unserializableValue ?? argument?.description ?? argument?.type ?? ""
}

function bounded(text, limit, raw = maxRawText) {
  return redactText(text.slice(0, raw)).slice(0, limit)
}

async function describeError(send, details) {
  const exception = details.exception
  if (!exception?.objectId) {
    const message = exception && "value" in exception ? String(exception.value) : exception?.unserializableValue ?? exception?.description ?? details.text
    return boundedError({ name: "Error", message })
  }
  const described = await send("Runtime.callFunctionOn", { objectId: exception.objectId, functionDeclaration: errorFields.toString(),
    returnByValue: true, userGesture: false })
  const fields = described.exceptionDetails ? {} : described.result?.value ?? {}
  return boundedError({
    name: typeof fields.name === "string" && fields.name ? fields.name : exception.className ?? "Error",
    message: typeof fields.message === "string" ? fields.message : exception.description ?? "",
    stack: typeof fields.stack === "string" ? fields.stack : undefined,
  })
}

function boundedError(error) {
  return {
    name: bounded(error.name ?? "Error", 128),
    message: bounded(error.message ?? "", 2048, maxRawError),
    ...(error.stack === undefined ? {} : { stack: bounded(error.stack, 8192, maxRawError) }),
  }
}

function primitiveValue(remote) {
  if (!remote || remote.type === "undefined") return null
  if ("value" in remote) return remote.value
  const special = remote.unserializableValue
  if (typeof special === "string" && special.endsWith("n")) return special.slice(0, -1)
  if (special === "-0") return 0
  return null
}

function deliver(text) {
  if (text === false || (typeof text === "string" && text.length > maxRawValue)) return { valueTruncated: true }
  if (typeof text !== "string" || !parses(text)) return undefined
  const redacted = text.replace(jsonString, (literal) => JSON.stringify(redactText(JSON.parse(literal))))
  if (new TextEncoder().encode(redacted).byteLength > maxValueBytes) return { valueTruncated: true }
  return { value: JSON.parse(redacted) }
}

function parses(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function serializeValue(limit) {
  const seen = new WeakSet()
  const text = JSON.stringify(this, (key, value) => {
    if (typeof value === "bigint") return `${value}`
    if (typeof value !== "object" || value === null) return value
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    return value
  })
  if (typeof text !== "string") return "null"
  return text.length > limit ? false : text
}

function errorFields() {
  const limit = 16384
  const read = (key) => {
    try {
      const value = this[key]
      return typeof value === "string" ? value.slice(0, limit) : undefined
    } catch {
      return undefined
    }
  }
  return { name: read("name"), message: read("message"), stack: read("stack") }
}

function hardenWorld() {
  const apply = Reflect.apply
  const construct = Reflect.construct
  const property = Reflect.get
  const define = Object.defineProperty
  const describe = Object.getOwnPropertyDescriptor
  const toText = String
  const exec = property(RegExp.prototype, "exec")
  const addEntry = property(Set.prototype, "add")
  const eachEntry = property(Set.prototype, "forEach")
  const clearEntries = property(Set.prototype, "clear")
  const Exception = DOMException
  const SafeProxy = Proxy
  const deny = () => {
    throw new Exception("YCoding withholds this data from page scripts", "SecurityError")
  }
  const getter = (prototype, name) => property(describe(prototype, name) ?? {}, "get")
  const read = (target, get) => apply(get, target, [])
  const attributeOf = property(Element.prototype, "getAttribute")
  const attributeNSOf = property(Element.prototype, "getAttributeNS")
  const hasAttribute = property(Element.prototype, "hasAttribute")
  const localName = getter(Element.prototype, "localName")
  const textContent = getter(Node.prototype, "textContent")
  const listLength = getter(NodeList.prototype, "length")
  const listItem = property(NodeList.prototype, "item")
  const labels = { input: getter(HTMLInputElement.prototype, "labels"), textarea: getter(HTMLTextAreaElement.prototype, "labels") }
  const attrName = getter(Attr.prototype, "name")
  const attrOwner = getter(Attr.prototype, "ownerElement")
  const formElements = getter(HTMLFormElement.prototype, "elements")
  const collectionLength = getter(HTMLCollection.prototype, "length")
  const collectionItem = property(HTMLCollection.prototype, "item")
  const sensitive = /pass(?:word|code|phrase)|one[ _-]*time|verification[ _-]*code|security[ _-]*code|card[ _-]*(?:number|no)|cvv|cvc|secret|\botp\b|\bpin\b/iu
  const secretType = /^(?:password|file|hidden)$/iu
  const secretToken = /(?:^|\s)(?:cc-\S*|current-password|new-password|one-time-code)(?:\s|$)/iu
  const valueName = /^value$/iu
  const matches = (pattern, text) => apply(exec, pattern, [text]) !== null
  const labelText = (list, index, count) => index >= count ? "" :
    `${toText(read(apply(listItem, list, [index]), textContent) ?? "")} ${labelText(list, index + 1, count)}`
  const protectedField = (element) => {
    if (element === null || element === undefined) return false
    const kind = read(element, localName)
    if (kind !== "input" && kind !== "textarea") return false
    const attribute = (name) => toText(apply(attributeOf, element, [name]) ?? "")
    if (apply(hasAttribute, element, ["data-sensitive"]) || apply(hasAttribute, element, ["data-private"])) return true
    if (kind === "input" && matches(secretType, attribute("type"))) return true
    if (matches(secretToken, attribute("autocomplete"))) return true
    const list = read(element, labels[kind])
    const names = `${attribute("id")} ${attribute("name")} ${attribute("title")} ${attribute("aria-label")} ${attribute("placeholder")} ${attribute("src")} ${attribute("autocomplete")} ${attribute("class")}`
    return matches(sensitive, `${names} ${list ? labelText(list, 0, read(list, listLength)) : ""}`)
  }
  const shield = (prototype, name, conceal, guard) => {
    const original = describe(prototype, name)
    const read = original && property(original, "get")
    if (!read) return
    const write = property(original, "set")
    define(prototype, name, {
      configurable: false,
      enumerable: original.enumerable,
      get() {
        return conceal(this) ? "" : apply(read, this, [])
      },
      set: write && guard ? function (value) {
        const text = toText(value)
        guard(this, text)
        apply(write, this, [text])
      } : write,
    })
  }
  for (const prototype of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    shield(prototype, "value", protectedField)
    shield(prototype, "defaultValue", protectedField)
  }
  const lower = property(String.prototype, "toLowerCase")
  const slice = property(String.prototype, "slice")
  const lastIndex = property(String.prototype, "lastIndexOf")
  const hasEntry = property(Set.prototype, "has")
  const nodeTypeOf = getter(Node.prototype, "nodeType")
  const firstChildOf = getter(Node.prototype, "firstChild")
  const nextSiblingOf = getter(Node.prototype, "nextSibling")
  const parentOf = getter(Node.prototype, "parentNode")
  const documentOf = getter(Node.prototype, "ownerDocument")
  const attributeNames = property(Element.prototype, "getAttributeNames")
  const findFirst = property(Document.prototype, "querySelector")
  const eventType = getter(Event.prototype, "type")
  const labelControl = getter(HTMLLabelElement.prototype, "control")
  const shadowHost = typeof ShadowRoot === "function" ? getter(ShadowRoot.prototype, "host") : undefined
  const attrValue = getter(Attr.prototype, "value")
  const rangeStart = typeof Range === "function" ? getter(Range.prototype, "startContainer") : undefined
  const formOf = { button: typeof HTMLButtonElement === "function" ? getter(HTMLButtonElement.prototype, "form") : undefined,
    input: getter(HTMLInputElement.prototype, "form") }
  const blockedTags = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "portal", "fencedframe",
    "animate", "set", "animatemotion", "animatetransform"])
  const urlAttributes = new Set(["href", "src", "action", "formaction", "data", "codebase", "background", "poster", "ping", "cite", "srcdoc"])
  const tabTargets = new Set(["", "_self", "_parent", "_top"])
  const scriptURL = /^[\u0000-\u0020]*j[\t\n\r]*a[\t\n\r]*v[\t\n\r]*a[\t\n\r]*s[\t\n\r]*c[\t\n\r]*r[\t\n\r]*i[\t\n\r]*p[\t\n\r]*t[\t\n\r]*:/iu
  const scriptScheme = /^[\u0000-\u0020]*javascript:?$/iu
  const xlink = "http://www.w3.org/1999/xlink"
  const refuse = (condition) => {
    if (condition) deny()
  }
  const kind = (node) => {
    if ((typeof node !== "object" && typeof node !== "function") || node === null) return 0
    try {
      return read(node, nodeTypeOf)
    } catch {
      return 0
    }
  }
  const nameOf = (text) => apply(lower, toText(text), [])
  const localPart = (qualified) => apply(slice, nameOf(qualified), [apply(lastIndex, nameOf(qualified), [":"]) + 1])
  const tagOf = (node) => kind(node) === 1 ? nameOf(read(node, localName) ?? "") : ""
  const blockedTag = (node) => apply(hasEntry, blockedTags, [tagOf(node)])
  const unsafeAttribute = (name, value) => {
    const local = localPart(name)
    return apply(slice, local, [0, 2]) === "on" || (apply(hasEntry, urlAttributes, [local]) && matches(scriptURL, toText(value ?? "")))
  }
  const unsafeElement = (element) => {
    if (blockedTag(element)) return true
    const names = apply(attributeNames, element, [])
    for (let index = 0; index < names.length; index++)
      if (unsafeAttribute(names[index], apply(attributeOf, element, [names[index]]))) return true
    return false
  }
  const unsafeTree = (node) => {
    const type = kind(node)
    if (type === 1 && unsafeElement(node)) return true
    if (type !== 1 && type !== 9 && type !== 11) return false
    for (let child = read(node, firstChildOf); child !== null; child = read(child, nextSiblingOf))
      if (unsafeTree(child)) return true
    return false
  }
  const insertion = (parent, nodes) => {
    refuse(blockedTag(parent))
    for (let index = 0; index < nodes.length; index++) refuse(unsafeTree(nodes[index]))
  }
  const parentNode = (node) => kind(node) === 0 ? null : read(node, parentOf)
  const adjacentParent = (element, position) => {
    const where = nameOf(position)
    return where === "beforebegin" || where === "afterend" ? parentNode(element) : element
  }
  const contained = (node) => refuse(blockedTag(node) || blockedTag(parentNode(node)))
  const attributeWrite = (attr, value) => {
    if (kind(attr) !== 2) return contained(attr)
    refuse(blockedTag(read(attr, attrOwner)) || unsafeAttribute(read(attr, attrName), value))
  }
  const stays = (target) => apply(hasEntry, tabTargets, [nameOf(target ?? "")])
  const baseTarget = (node) => {
    const base = apply(findFirst, read(node, documentOf), ["base[target]"])
    return base ? apply(attributeOf, base, ["target"]) : ""
  }
  const chosen = (element, name) => apply(attributeOf, element, [name])
  const linkLeaves = (link) => {
    const href = chosen(link, "href") ?? apply(attributeNSOf, link, [xlink, "href"])
    if (href === null) return false
    const target = chosen(link, "target")
    return matches(scriptURL, href) || !stays(target === null || target === "" ? baseTarget(link) : target)
  }
  const formLeaves = (form, submitter) => {
    const action = submitter && apply(hasAttribute, submitter, ["formaction"]) ? chosen(submitter, "formaction") : chosen(form, "action")
    const named = submitter && apply(hasAttribute, submitter, ["formtarget"]) ? chosen(submitter, "formtarget") : chosen(form, "target")
    return matches(scriptURL, action ?? "") || !stays(named === null || named === "" ? baseTarget(form) : named)
  }
  const submitterLeaves = (element) => {
    const tag = tagOf(element)
    const type = nameOf(chosen(element, "type") ?? "")
    const submits = tag === "input" ? type === "submit" || type === "image" : tag === "button" && type !== "button" && type !== "reset"
    const form = submits ? read(element, formOf[tag]) : null
    return form ? formLeaves(form, element) : false
  }
  const activates = (element) => {
    const tag = tagOf(element)
    if (tag === "a" || tag === "area") return linkLeaves(element)
    if (tag === "label") {
      const control = read(element, labelControl)
      return control ? submitterLeaves(control) : false
    }
    return submitterLeaves(element)
  }
  const hostOf = (node) => {
    if (!shadowHost || kind(node) !== 11) return null
    try {
      return read(node, shadowHost)
    } catch {
      return null
    }
  }
  const leavesTab = (node) => {
    for (let current = node; current !== null && current !== undefined;) {
      if (kind(current) === 1 && activates(current)) return true
      current = parentNode(current) ?? hostOf(current)
    }
    return false
  }
  const isWindow = (value) => {
    if (typeof value !== "object" || value === null) return false
    try {
      return value.window === value
    } catch {
      return true
    }
  }
  const ownWindow = (target) => {
    if (target === undefined || target === null || target === globalThis) return true
    try {
      return target.top === globalThis.top
    } catch {
      return false
    }
  }
  const replace = (owner, name, check) => {
    const original = owner && describe(owner, name)
    const native = original && property(original, "value")
    if (typeof native !== "function") return
    define(owner, name, {
      value: function (...args) {
        return apply(native, this, check(this, args) ?? args)
      },
      writable: false, configurable: false, enumerable: original.enumerable,
    })
  }
  const guardSetter = (owner, name, check) => {
    const original = owner && describe(owner, name)
    const write = original && property(original, "set")
    if (typeof write !== "function") return
    define(owner, name, {
      get: property(original, "get"),
      set(value) {
        const text = toText(value)
        check(this, text)
        apply(write, this, [text])
      },
      configurable: false, enumerable: original.enumerable,
    })
  }
  const prototypeOf = (name) => typeof globalThis[name] === "function" ? globalThis[name].prototype : undefined
  const denied = () => deny()
  for (const name of ["createElement", "createElementNS"])
    replace(Document.prototype, name, (_, args) => {
      const tag = toText(args[name === "createElement" ? 0 : 1])
      refuse(apply(hasEntry, blockedTags, [localPart(tag)]))
      return name === "createElement" ? [tag, args[1]] : [args[0], tag, args[2]]
    })
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) replace(Node.prototype, name, (target, args) => insertion(target, [args[0]]))
  for (const owner of [Element.prototype, Document.prototype, prototypeOf("DocumentFragment")]) {
    for (const name of ["append", "prepend", "replaceChildren"]) replace(owner, name, insertion)
    replace(owner, "moveBefore", (target, args) => insertion(target, [args[0]]))
  }
  for (const owner of [Element.prototype, prototypeOf("CharacterData"), prototypeOf("DocumentType")])
    for (const name of ["before", "after", "replaceWith"]) replace(owner, name, (target, args) => insertion(parentNode(target), args))
  replace(Element.prototype, "insertAdjacentElement", (target, args) => insertion(adjacentParent(target, args[0]), [args[1]]))
  replace(Element.prototype, "insertAdjacentText", (target, args) => refuse(blockedTag(adjacentParent(target, args[0]))))
  const rangeCheck = (range, node) => {
    const start = rangeStart ? read(range, rangeStart) : null
    refuse(blockedTag(start) || blockedTag(parentNode(start)) || unsafeTree(node))
  }
  replace(prototypeOf("Range"), "insertNode", (range, args) => rangeCheck(range, args[0]))
  replace(prototypeOf("Range"), "surroundContents", (range, args) => rangeCheck(range, args[0]))
  guardSetter(Node.prototype, "textContent", attributeWrite)
  guardSetter(Node.prototype, "nodeValue", attributeWrite)
  for (const name of ["innerText", "outerText"]) guardSetter(HTMLElement.prototype, name, (target) => contained(target))
  guardSetter(prototypeOf("CharacterData"), "data", (target) => contained(target))
  for (const name of ["appendData", "insertData", "replaceData"]) replace(prototypeOf("CharacterData"), name, (target) => contained(target))
  replace(Element.prototype, "setAttribute", (target, args) => {
    const name = toText(args[0])
    const value = toText(args[1])
    refuse(blockedTag(target) || unsafeAttribute(name, value))
    return [name, value]
  })
  replace(Element.prototype, "setAttributeNS", (target, args) => {
    const name = toText(args[1])
    const value = toText(args[2])
    refuse(blockedTag(target) || unsafeAttribute(name, value))
    return [args[0], name, value]
  })
  replace(Element.prototype, "toggleAttribute", (target, args) => {
    const name = toText(args[0])
    refuse(blockedTag(target) || unsafeAttribute(name, ""))
    return args.length > 1 ? [name, args[1]] : [name]
  })
  for (const name of ["removeAttribute", "removeAttributeNS", "removeAttributeNode"]) replace(Element.prototype, name, (target) => refuse(blockedTag(target)))
  for (const name of ["setAttributeNode", "setAttributeNodeNS"])
    replace(Element.prototype, name, (target, args) => refuse(blockedTag(target) || kind(args[0]) !== 2 ||
      unsafeAttribute(read(args[0], attrName), read(args[0], attrValue))))
  for (const name of ["setNamedItem", "setNamedItemNS"]) replace(prototypeOf("NamedNodeMap"), name, denied)
  for (const [owner, name] of [["HTMLAnchorElement", "href"], ["HTMLAreaElement", "href"], ["HTMLFormElement", "action"],
    ["HTMLButtonElement", "formAction"], ["HTMLInputElement", "formAction"], ["SVGAnimatedString", "baseVal"]])
    guardSetter(prototypeOf(owner), name, (_, value) => refuse(matches(scriptURL, value)))
  for (const owner of ["HTMLAnchorElement", "HTMLAreaElement"])
    guardSetter(prototypeOf(owner), "protocol", (_, value) => refuse(matches(scriptScheme, value)))
  for (const owner of ["HTMLScriptElement", "HTMLIFrameElement", "HTMLFrameElement", "HTMLFrameSetElement", "HTMLObjectElement", "HTMLEmbedElement",
    "HTMLBaseElement", "HTMLMetaElement", "HTMLLinkElement", "HTMLPortalElement", "HTMLFencedFrameElement", "SVGScriptElement",
    "SVGAnimationElement", "SVGAnimateElement", "SVGSetElement", "SVGAnimateMotionElement", "SVGAnimateTransformElement"]) {
    const prototype = prototypeOf(owner)
    if (!prototype) continue
    const names = Reflect.ownKeys(prototype)
    for (let index = 0; index < names.length; index++) {
      const original = describe(prototype, names[index])
      if (!original || !property(original, "set")) continue
      define(prototype, names[index], { get: property(original, "get"), set: denied, configurable: false, enumerable: original.enumerable })
    }
  }
  for (const owner of [Element.prototype, prototypeOf("ShadowRoot")]) {
    guardSetter(owner, "innerHTML", denied)
    replace(owner, "setHTMLUnsafe", denied)
  }
  guardSetter(Element.prototype, "outerHTML", denied)
  replace(Element.prototype, "insertAdjacentHTML", denied)
  for (const name of ["write", "writeln", "execCommand"]) replace(Document.prototype, name, denied)
  replace(Document, "parseHTMLUnsafe", denied)
  replace(prototypeOf("Range"), "createContextualFragment", denied)
  replace(prototypeOf("DOMParser"), "parseFromString", denied)
  if (typeof DOMParser === "function")
    define(globalThis, "DOMParser", { value: function Blocked() { deny() }, writable: false, configurable: false, enumerable: false })
  replace(URL, "createObjectURL", denied)
  replace(HTMLElement.prototype, "click", (target) => refuse(leavesTab(target)))
  replace(EventTarget.prototype, "dispatchEvent", (target, args) => {
    const type = nameOf(read(args[0], eventType))
    refuse((type === "click" || type === "domactivate") && leavesTab(target))
  })
  replace(HTMLFormElement.prototype, "submit", (form) => refuse(formLeaves(form, null)))
  replace(HTMLFormElement.prototype, "requestSubmit", (form, args) => refuse(formLeaves(form, args[0] ?? null)))
  define(globalThis, "opener", { get: deny, set: deny, configurable: false, enumerable: true })
  const post = property(globalThis, "postMessage")
  if (typeof post === "function")
    define(globalThis, "postMessage", {
      value: function postMessage(...args) {
        refuse(!ownWindow(this))
        return apply(post, this ?? globalThis, args)
      },
      writable: false, configurable: false, enumerable: true,
    })
  const messageSource = typeof MessageEvent === "function" ? describe(MessageEvent.prototype, "source") : undefined
  if (messageSource && property(messageSource, "get"))
    define(MessageEvent.prototype, "source", {
      get() {
        const source = apply(property(messageSource, "get"), this, [])
        refuse(isWindow(source) && !ownWindow(source))
        return source
      },
      configurable: false, enumerable: messageSource.enumerable,
    })
  shield(Attr.prototype, "value", (attr) => matches(valueName, read(attr, attrName)) && protectedField(read(attr, attrOwner)), attributeWrite)
  Element.prototype.getAttribute = function getAttribute(name) {
    const value = apply(attributeOf, this, [name])
    return value !== null && matches(valueName, toText(name)) && protectedField(this) ? "" : value
  }
  Element.prototype.getAttributeNS = function getAttributeNS(namespace, name) {
    const value = apply(attributeNSOf, this, [namespace, name])
    return value !== null && matches(valueName, toText(name)) && protectedField(this) ? "" : value
  }
  const NativeFormData = FormData
  const setFormValue = property(FormData.prototype, "set")
  const SafeFormData = new SafeProxy(NativeFormData, {
    construct(target, args, newTarget) {
      const data = construct(target, args, newTarget)
      const controls = args[0] ? read(args[0], formElements) : undefined
      const count = controls ? read(controls, collectionLength) : 0
      for (let index = 0; index < count; index++) {
        const control = apply(collectionItem, controls, [index])
        const name = control ? apply(attributeOf, control, ["name"]) : null
        if (name && protectedField(control)) apply(setFormValue, data, [name, ""])
      }
      return data
    },
  })
  define(NativeFormData.prototype, "constructor", { value: SafeFormData, writable: true, configurable: true, enumerable: false })
  globalThis.FormData = SafeFormData
  define(Document.prototype, "cookie", { get: deny, set: deny, configurable: false, enumerable: true })
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "cookieStore", "caches"])
    define(globalThis, name, { get: deny, set: deny, configurable: false, enumerable: true })
  for (const name of ["serviceWorker", "locks", "storage"]) define(Navigator.prototype, name, { get: deny, configurable: false, enumerable: true })
  for (const name of ["Worker", "SharedWorker", "BroadcastChannel"])
    define(globalThis, name, { value: function Blocked() { deny() }, writable: false, configurable: false, enumerable: false })
  define(globalThis, "open", { value: function open() { return null }, writable: false, configurable: false, enumerable: true })
  const openDocument = property(Document.prototype, "open")
  define(Document.prototype, "open", {
    value: function open(...args) {
      return args.length > 2 ? null : apply(openDocument, this, args)
    },
    writable: false, configurable: false, enumerable: true,
  })
  const cleanups = new Set()
  const track = (cleanup) => {
    apply(addEntry, cleanups, [cleanup])
  }
  for (const [start, stop] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"],
    ["requestAnimationFrame", "cancelAnimationFrame"], ["requestIdleCallback", "cancelIdleCallback"]]) {
    const begin = globalThis[start]
    const cancel = globalThis[stop]
    if (typeof begin !== "function" || typeof cancel !== "function") continue
    globalThis[start] = function (...args) {
      const id = apply(begin, globalThis, args)
      track(() => apply(cancel, globalThis, [id]))
      return id
    }
  }
  const addListener = property(EventTarget.prototype, "addEventListener")
  const removeListener = property(EventTarget.prototype, "removeEventListener")
  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    apply(addListener, this, [type, listener, options])
    track(() => apply(removeListener, this, [type, listener, options]))
  }
  for (const name of ["MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver"]) {
    const Native = globalThis[name]
    if (typeof Native !== "function") continue
    const disconnect = property(Native.prototype, "disconnect")
    const Tracked = new SafeProxy(Native, {
      construct(target, args, newTarget) {
        const observer = construct(target, args, newTarget)
        track(() => apply(disconnect, observer, []))
        return observer
      },
    })
    define(Native.prototype, "constructor", { value: Tracked, writable: true, configurable: true, enumerable: false })
    globalThis[name] = Tracked
  }
  return () => {
    apply(eachEntry, cleanups, [(cleanup) => cleanup()])
    apply(clearEntries, cleanups, [])
  }
}
