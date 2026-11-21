import { expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { discardWorlds, runScript } from "../script.js"

const tabId = 7
const forbidden = new Set(["Page.bringToFront", "Target.activateTarget", "Target.attachToTarget", "Target.createTarget", "DOM.focus",
  "Input.dispatchKeyEvent", "Input.dispatchMouseEvent"])

function installDOM() {
  const slot = Symbol("slot")
  const listeners = []
  const opened = []
  const mutations = []
  const observers = new Set()
  const record = (name) => mutations.push(name)
  const kids = (node) => node[slot].children ?? (node[slot].children = [])
  const attach = (parent, child) => {
    const node = typeof child === "object" && child !== null ? child : makeText(String(child))
    const old = node[slot].parent
    if (old) kids(old).splice(kids(old).indexOf(node), 1)
    node[slot].parent = parent
    kids(parent).push(node)
    return node
  }
  class EventTarget {
    addEventListener(type, listener) { listeners.push({ target: this, type, listener }) }
    removeEventListener(type, listener) {
      const index = listeners.findIndex((entry) => entry.target === this && entry.type === type && entry.listener === listener)
      if (index >= 0) listeners.splice(index, 1)
    }
    dispatchEvent() {
      record("dispatchEvent")
      return true
    }
  }
  class Event {
    constructor(type, init = {}) { this[slot] = { type, source: init.source ?? null } }
    get type() { return this[slot].type }
  }
  class MouseEvent extends Event {}
  class MessageEvent extends Event { get source() { return this[slot].source } }
  class Node extends EventTarget {
    get nodeType() { return this[slot].nodeType ?? 1 }
    get textContent() { return this[slot].text ?? "" }
    set textContent(value) { record("textContent") }
    get nodeValue() { return this[slot].text ?? null }
    set nodeValue(value) { record("nodeValue") }
    get parentNode() { return this[slot].parent ?? null }
    get ownerDocument() { return document }
    get firstChild() { return kids(this)[0] ?? null }
    get nextSibling() {
      const parent = this[slot].parent
      return parent ? kids(parent)[kids(parent).indexOf(this) + 1] ?? null : null
    }
    appendChild(child) {
      record("appendChild")
      return attach(this, child)
    }
    insertBefore(child) {
      record("insertBefore")
      return attach(this, child)
    }
    replaceChild(child, old) {
      record("replaceChild")
      attach(this, child)
      return old
    }
    cloneNode() {
      const copy = Object.create(Object.getPrototypeOf(this))
      copy[slot] = { ...this[slot], attributes: { ...this[slot].attributes }, children: [], parent: null }
      return copy
    }
  }
  class CharacterData extends Node {
    get data() { return this[slot].text }
    set data(value) { record("data") }
    appendData() { record("appendData") }
    insertData() { record("insertData") }
    replaceData() { record("replaceData") }
    before() { record("before") }
    after() { record("after") }
    replaceWith() { record("replaceWith") }
  }
  class Text extends CharacterData {}
  class DocumentType extends Node {}
  class DocumentFragment extends Node {
    append(...nodes) {
      record("append")
      for (const node of nodes) attach(this, node)
    }
    prepend() { record("prepend") }
    replaceChildren() { record("replaceChildren") }
  }
  class ShadowRoot extends DocumentFragment {
    get host() { return this[slot].host }
    get innerHTML() { return "" }
    set innerHTML(value) { record("shadow.innerHTML") }
    setHTMLUnsafe() { record("shadow.setHTMLUnsafe") }
  }
  class NamedNodeMap {
    constructor(owner) { this[slot] = owner }
    getNamedItem(name) { return this[slot].getAttributeNode(name) }
    setNamedItem() { record("setNamedItem") }
    setNamedItemNS() { record("setNamedItemNS") }
  }
  class Element extends Node {
    get localName() { return this[slot].tag }
    getAttribute(name) { return this[slot].attributes[name] ?? null }
    getAttributeNS(namespace, name) { return this[slot].attributes[name] ?? null }
    getAttributeNames() { return Object.keys(this[slot].attributes) }
    hasAttribute(name) { return name in this[slot].attributes }
    getAttributeNode(name) { return name in this[slot].attributes ? new Attr(this, name) : null }
    get attributes() { return new NamedNodeMap(this) }
    setAttribute(name, value) {
      record("setAttribute")
      this[slot].attributes[name] = value
    }
    setAttributeNS(namespace, name, value) {
      record("setAttributeNS")
      this[slot].attributes[name] = value
    }
    toggleAttribute(name) {
      record("toggleAttribute")
      this[slot].attributes[name] = ""
      return true
    }
    removeAttribute() { record("removeAttribute") }
    removeAttributeNS() { record("removeAttributeNS") }
    removeAttributeNode() { record("removeAttributeNode") }
    setAttributeNode() { record("setAttributeNode") }
    setAttributeNodeNS() { record("setAttributeNodeNS") }
    append(...nodes) {
      record("append")
      for (const node of nodes) attach(this, node)
    }
    prepend() { record("prepend") }
    replaceChildren() { record("replaceChildren") }
    before() { record("before") }
    after() { record("after") }
    replaceWith() { record("replaceWith") }
    insertAdjacentElement(position, element) {
      record("insertAdjacentElement")
      return element
    }
    insertAdjacentText() { record("insertAdjacentText") }
    insertAdjacentHTML() { record("insertAdjacentHTML") }
    get innerHTML() { return "" }
    set innerHTML(value) { record("innerHTML") }
    get outerHTML() { return "" }
    set outerHTML(value) { record("outerHTML") }
    setHTMLUnsafe() { record("setHTMLUnsafe") }
    attachShadow() {
      const root = new ShadowRoot()
      root[slot] = { nodeType: 11, host: this, children: [] }
      return root
    }
  }
  class HTMLElement extends Element {
    click() { record("click") }
    get innerText() { return this[slot].text ?? "" }
    set innerText(value) { record("innerText") }
    get outerText() { return this[slot].text ?? "" }
    set outerText(value) { record("outerText") }
  }
  class HTMLAnchorElement extends HTMLElement {
    get href() { return this[slot].attributes.href ?? "" }
    set href(value) { record("href") }
    get protocol() { return "http:" }
    set protocol(value) { record("protocol") }
  }
  class HTMLAreaElement extends HTMLAnchorElement {}
  class HTMLButtonElement extends HTMLElement {
    get form() { return this[slot].form ?? null }
    get formAction() { return "" }
    set formAction(value) { record("button.formAction") }
  }
  class HTMLScriptElement extends HTMLElement {
    get src() { return "" }
    set src(value) { record("script.src") }
    get text() { return "" }
    set text(value) { record("script.text") }
  }
  class HTMLIFrameElement extends HTMLElement {
    get src() { return "" }
    set src(value) { record("iframe.src") }
    get srcdoc() { return "" }
    set srcdoc(value) { record("iframe.srcdoc") }
  }
  class SVGAnimatedString {
    get baseVal() { return "" }
    set baseVal(value) { record("baseVal") }
  }
  class Range {
    get startContainer() { return this[slot]?.start ?? document.body }
    setStart(node) { this[slot] = { start: node } }
    insertNode() { record("insertNode") }
    surroundContents() { record("surroundContents") }
    createContextualFragment() { record("createContextualFragment") }
  }
  class DOMParser { parseFromString() { record("parseFromString") } }
  const URL = {
    createObjectURL() {
      record("createObjectURL")
      return "blob:fake"
    },
  }
  class NodeList {
    constructor(items) { this[slot] = items }
    get length() { return this[slot].length }
    item(index) { return this[slot][index] ?? null }
  }
  class HTMLCollection {
    constructor(items) { this[slot] = items }
    get length() { return this[slot].length }
    item(index) { return this[slot][index] ?? null }
  }
  class Attr extends Node {
    constructor(owner, name) {
      super()
      this[slot] = { owner, name, nodeType: 2 }
    }
    get name() { return this[slot].name }
    get ownerElement() { return this[slot].owner ?? null }
    get value() { return this[slot].owner ? this[slot].owner[slot].attributes[this[slot].name] : this[slot].value ?? "" }
    set value(value) { record("attr.value") }
  }
  class HTMLInputElement extends HTMLElement {
    get value() { return this[slot].value }
    set value(value) { this[slot].value = `${value}` }
    get defaultValue() { return this[slot].attributes.value ?? "" }
    get labels() { return new NodeList(this[slot].labels) }
    get form() { return this[slot].form ?? null }
    get formAction() { return "" }
    set formAction(value) { record("input.formAction") }
  }
  class HTMLTextAreaElement extends HTMLElement {
    get value() { return this[slot].value }
    get defaultValue() { return this[slot].text ?? "" }
    get labels() { return new NodeList(this[slot].labels) }
  }
  class HTMLLabelElement extends HTMLElement { get control() { return this[slot].control ?? null } }
  class HTMLFormElement extends HTMLElement {
    get elements() { return new HTMLCollection(this[slot].controls ?? []) }
    get action() { return "" }
    set action(value) { record("form.action") }
    submit() { record("submit") }
    requestSubmit() { record("requestSubmit") }
  }
  class FormData {
    constructor(form) {
      this[slot] = form ? form[slot].controls.filter((control) => control[slot].attributes.name)
        .map((control) => [control[slot].attributes.name, control[slot].value]) : []
    }
    get(name) { return this[slot].find((entry) => entry[0] === name)?.[1] ?? null }
    set(name, value) { this[slot] = [...this[slot].filter((entry) => entry[0] !== name), [name, `${value}`]] }
  }
  class Document extends Node {
    static parseHTMLUnsafe() { record("parseHTMLUnsafe") }
    get nodeType() { return 9 }
    get body() { return this[slot].body }
    createElement(tag) { return element(types[tag] ?? HTMLElement, tag, {}) }
    createElementNS(namespace, tag) { return element(types[tag] ?? Element, tag, {}) }
    createTextNode(text) { return makeText(text) }
    createAttribute(name) {
      const attr = new Attr(null, name)
      attr[slot].value = ""
      return attr
    }
    createDocumentFragment() {
      const fragment = new DocumentFragment()
      fragment[slot] = { nodeType: 11, children: [] }
      return fragment
    }
    createRange() { return new Range() }
    querySelector(selector) { return selector === "base[target]" ? this[slot].base ?? null : null }
    append(...nodes) {
      record("document.append")
      for (const node of nodes) attach(this, node)
    }
    write() { record("write") }
    writeln() { record("writeln") }
    execCommand() { record("execCommand") }
    get cookie() { return this[slot].cookie }
    set cookie(value) { this[slot].cookie = value }
    getElementById(id) { return this[slot].elements[id] ?? null }
    open(...args) {
      opened.push(["document", ...args])
      return args.length > 2 ? {} : this
    }
  }
  class Navigator {
    get serviceWorker() { return { register: () => undefined } }
    get locks() { return { query: () => undefined } }
    get storage() { return { getDirectory: () => undefined } }
  }
  class BroadcastChannel { postMessage() { return undefined } }
  class Worker { terminate() { return undefined } }
  class SharedWorker { get port() { return undefined } }
  class MutationObserver {
    observe() { observers.add(this) }
    disconnect() { observers.delete(this) }
  }
  const types = { a: HTMLAnchorElement, area: HTMLAreaElement, form: HTMLFormElement, button: HTMLButtonElement, input: HTMLInputElement,
    label: HTMLLabelElement, script: HTMLScriptElement, iframe: HTMLIFrameElement }
  const element = (Type, tag, attributes, value, labels = []) => {
    const node = new Type()
    node[slot] = { tag, attributes, value, labels, children: [], parent: null }
    return node
  }
  const makeText = (text) => {
    const node = new Text()
    node[slot] = { nodeType: 3, text, parent: null }
    return node
  }
  const label = new HTMLLabelElement()
  label[slot] = { tag: "label", attributes: {}, text: "Your PIN" }
  const controls = [
    element(HTMLInputElement, "input", { id: "password", type: "password", name: "password", value: "attr-hunter" }, "live-hunter"),
    element(HTMLInputElement, "input", { id: "otp", name: "c1", autocomplete: "one-time-code" }, "otp-981"),
    element(HTMLInputElement, "input", { id: "card", name: "c2", autocomplete: "billing cc-number" }, "card-4111"),
    element(HTMLInputElement, "input", { id: "marked", name: "c3", "data-sensitive": "" }, "marked-value"),
    element(HTMLInputElement, "input", { id: "pin", name: "c4" }, "pin-9876", [label]),
    element(HTMLInputElement, "input", { id: "hidden", type: "hidden", name: "csrf", value: "csrf-value" }, "csrf-value"),
    element(HTMLTextAreaElement, "textarea", { id: "note", name: "recovery-secret" }, "note-value"),
    element(HTMLInputElement, "input", { id: "plain", name: "q", value: "visible text" }, "visible text"),
  ]
  const form = element(HTMLFormElement, "form", { id: "form" })
  form[slot].controls = controls
  const fixtures = [
    element(HTMLElement, "div", { id: "marker" }),
    element(HTMLElement, "button", { id: "handler", onclick: "page()" }),
    element(HTMLAnchorElement, "a", { id: "blank", href: "/opened", target: "_blank" }),
    element(HTMLAnchorElement, "a", { id: "named", href: "/opened", target: "other-tab" }),
    element(HTMLAnchorElement, "a", { id: "upper", href: "/opened", target: "_BLANK" }),
    element(HTMLAnchorElement, "a", { id: "jslink", href: "javascript:page()" }),
    element(HTMLAnchorElement, "a", { id: "self", href: "/next", target: "_self" }),
    element(HTMLAnchorElement, "a", { id: "top", href: "/next", target: "_TOP" }),
    element(HTMLAnchorElement, "a", { id: "plainlink", href: "/next" }),
    element(HTMLAreaElement, "area", { id: "area", href: "/opened", target: "_blank" }),
    element(HTMLElement, "span", { id: "inner" }),
    element(HTMLFormElement, "form", { id: "blankform", target: "_blank", action: "/submitted" }),
    element(HTMLFormElement, "form", { id: "selfform", action: "/submitted" }),
    element(HTMLFormElement, "form", { id: "jsform", action: "javascript:page()" }),
    element(HTMLButtonElement, "button", { id: "go" }),
    element(HTMLButtonElement, "button", { id: "go2", formtarget: "_blank" }),
    element(HTMLButtonElement, "button", { id: "plainbutton", type: "button" }),
    element(HTMLButtonElement, "button", { id: "staybutton" }),
    element(HTMLInputElement, "input", { id: "image", type: "image", formtarget: "other" }),
    element(HTMLLabelElement, "label", { id: "lab" }),
    element(HTMLScriptElement, "script", { id: "script" }),
    element(HTMLIFrameElement, "iframe", { id: "frame", src: "/frame" }),
  ]
  const byID = Object.fromEntries([...controls, form, ...fixtures].map((node) => [node[slot].attributes.id, node]))
  attach(byID.script, makeText("page()"))
  byID.go[slot].form = byID.blankform
  byID.go2[slot].form = byID.selfform
  byID.image[slot].form = byID.selfform
  byID.staybutton[slot].form = byID.selfform
  byID.lab[slot].control = byID.go2
  const body = element(HTMLElement, "body", {})
  const document = new Document()
  document[slot] = { cookie: "sid=main-cookie", elements: byID, body }
  for (const node of fixtures) attach(body, node)
  attach(byID.blank, byID.inner)
  const storage = { getItem: () => "stored-value" }
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "cookieStore", "caches"])
    Object.defineProperty(globalThis, name, { get: () => storage, configurable: true, enumerable: true })
  const other = {}
  other.window = other
  other.top = other
  Object.defineProperty(globalThis, "opener", { get: () => other, configurable: true, enumerable: true })
  Object.assign(globalThis, {
    window: globalThis, top: globalThis, document, navigator: new Navigator(), EventTarget, Node, Element, HTMLElement, NodeList, HTMLCollection, Attr,
    HTMLInputElement, HTMLTextAreaElement, HTMLLabelElement, HTMLFormElement, FormData, Document, Navigator, Worker, SharedWorker, BroadcastChannel,
    Event, MouseEvent, MessageEvent, CharacterData, Text, DocumentType, DocumentFragment, ShadowRoot, NamedNodeMap, HTMLAnchorElement, HTMLAreaElement,
    HTMLButtonElement, HTMLScriptElement, HTMLIFrameElement, SVGAnimatedString, Range, DOMParser, URL, otherWindow: other, svgHref: new SVGAnimatedString(),
    setBaseTarget: (target) => { document[slot].base = element(HTMLElement, "base", { target }) },
    postMessage: () => record("postMessage"),
    MutationObserver, open: (...args) => {
      opened.push(["window", ...args])
      return {}
    }, requestAnimationFrame: (callback) => setTimeout(() => callback(0), 16), cancelAnimationFrame: (id) => clearTimeout(id),
  })
  return { listeners, observers, opened, mutations }
}

function browser() {
  const calls = []
  const subscriptions = []
  const listeners = new Set()
  const realms = new Map()
  const objects = new Map()
  const waiting = []
  const gate = Promise.withResolvers()
  const state = { frame: { id: "top-frame", loaderId: "document-1" }, next: 10, fail: new Set() }
  const emit = (method, params) => {
    for (const listener of listeners) listener(method, params)
  }
  const remote = (value, realm) => {
    if (value === undefined) return { type: "undefined" }
    if (typeof value === "bigint") return { type: "bigint", unserializableValue: `${value}n` }
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return { type: typeof value, value }
    const objectId = `object-${state.next++}`
    objects.set(objectId, { value, realm })
    if (Object.prototype.toString.call(value) !== "[object Error]") return { type: typeof value, objectId }
    return { type: "object", subtype: "error", className: value.constructor.name, description: value.stack, objectId }
  }
  const settle = async (realm, run, returnByValue) => {
    try {
      const value = await run()
      if (!returnByValue) return { result: remote(value, realm) }
      return { result: { type: typeof value, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } }
    } catch (error) {
      const exception = remote(error, realm)
      return { result: exception, exceptionDetails: { text: "Uncaught", exception } }
    }
  }
  const createRealm = () => {
    const contextId = state.next++
    const context = createContext({ DOMException, setTimeout, clearTimeout, setInterval, clearInterval })
    const realm = { context, contextId, dom: runInContext(`(${installDOM.toString()})()`, context) }
    const logger = (type) => (...args) => {
      emit("Runtime.consoleAPICalled", { type, args: args.map((arg) => remote(arg, realm)), executionContextId: contextId, timestamp: Date.now() })
      const text = args.join(" ")
      for (const entry of waiting.filter((item) => text.includes(item.text))) entry.resolve()
    }
    context.console = { log: logger("log"), info: logger("info"), warn: logger("warning"), error: logger("error"), debug: logger("debug"), table: logger("table") }
    context.emitForeign = () => {
      for (const executionContextId of [1, 999])
        emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `foreign-${executionContextId}` }], executionContextId, timestamp: Date.now() })
      emit("Runtime.exceptionThrown", { timestamp: Date.now(), exceptionDetails: { executionContextId: 1, text: "Uncaught", exception: { type: "object", subtype: "error", description: "Error: foreign-main" } } })
    }
    context.openHandoff = (method) => emit(method, method === "Page.javascriptDialogOpening" ?
      { url: "http://127.0.0.1/", message: "confirm?", type: "confirm" } : { frameId: "top-frame", mode: "selectSingle" })
    context.waitGate = () => gate.promise
    context.replayStale = (text) => emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: text }], executionContextId: contextId, timestamp: 0 })
    context.throwLater = (message) => emit("Runtime.exceptionThrown", { timestamp: Date.now(), exceptionDetails: {
      executionContextId: contextId, text: "Uncaught", exception: { type: "object", subtype: "error", description: `Error: ${message}` } } })
    realms.set(contextId, realm)
    return realm
  }
  const handlers = {
    "Runtime.enable": () => ({}),
    "Runtime.disable": () => ({}),
    "Runtime.terminateExecution": () => ({}),
    "Runtime.releaseObjectGroup": () => ({}),
    "Page.getFrameTree": () => ({ frameTree: { frame: { ...state.frame } } }),
    "Page.addScriptToEvaluateOnNewDocument": () => ({ identifier: `script-${state.next++}` }),
    "Page.removeScriptToEvaluateOnNewDocument": () => ({}),
    "Page.createIsolatedWorld": () => ({ executionContextId: createRealm().contextId }),
    "Runtime.evaluate": (params) => {
      const realm = realms.get(params.contextId)
      return settle(realm, () => runInContext(params.expression, realm.context), params.returnByValue)
    },
    "Runtime.callFunctionOn": (params) => {
      const owner = params.objectId ? objects.get(params.objectId) : { realm: realms.get(params.executionContextId), value: undefined }
      const call = runInContext(`(${params.functionDeclaration})`, owner.realm.context)
      return settle(owner.realm, () => Reflect.apply(call, owner.value, (params.arguments ?? []).map((argument) => argument.value)), params.returnByValue)
    },
  }
  const cdp = {
    async send(target, method, params = {}) {
      calls.push({ tabId: target, method, params })
      if (state.fail.has(method)) throw new Error("Debugger is not attached to the tab")
      if (!handlers[method]) throw new Error(`unexpected ${method}`)
      return handlers[method](params)
    },
    onEvent(target, listener) {
      subscriptions.push(target)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const logged = (text) => new Promise((resolve) => waiting.push({ text, resolve }))
  return { cdp, calls, subscriptions, listeners, realms, state, emit, logged, gate, method: (name) => calls.filter((call) => call.method === name) }
}

function contained(fake) {
  expect(fake.calls.length).toBeGreaterThan(0)
  expect(fake.calls.filter((call) => call.tabId !== tabId)).toEqual([])
  expect(fake.subscriptions.filter((id) => id !== tabId)).toEqual([])
  expect(fake.calls.filter((call) => forbidden.has(call.method) || call.method.startsWith("Emulation."))).toEqual([])
  expect(fake.calls.filter((call) => call.params.userGesture === true)).toEqual([])
  const runs = fake.calls.filter((call) => (call.method === "Runtime.callFunctionOn" && call.params.executionContextId !== undefined) ||
    (call.method === "Runtime.evaluate" && call.params.replMode === true))
  expect(runs.length).toBeGreaterThan(0)
  expect(runs.every((call) => call.params.userGesture === false)).toBe(true)
  expect(fake.listeners.size).toBe(0)
}

const run = (fake, input, worlds = new Map()) =>
  runScript({ tabId, leaseID: "lease-1", mode: "script", timeoutMs: 10000, ...input }, fake.cdp, worlds)

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test("a script runs once in a fresh hardened isolated world of the granted tab and returns its value", async () => {
  const fake = browser()
  const first = await run(fake, { source: "console.log(\"hello\", 2)\nglobalThis.leftover = 1\nreturn { title: document.getElementById(\"plain\").value, n: 3 }" })
  expect(first).toEqual({ outcome: "completed", value: { title: "visible text", n: 3 }, logs: [{ level: "log", text: "hello 2" }] })
  expect(await run(fake, { source: "return typeof globalThis.leftover" })).toEqual({ outcome: "completed", value: "undefined", logs: [] })
  const worlds = fake.method("Page.createIsolatedWorld")
  expect(worlds).toHaveLength(2)
  expect(worlds.map((call) => call.params.frameId)).toEqual(["top-frame", "top-frame"])
  expect(worlds.every((call) => call.params.grantUniveralAccess === false)).toBe(true)
  expect(new Set(worlds.map((call) => call.params.worldName)).size).toBe(2)
  const children = fake.method("Page.addScriptToEvaluateOnNewDocument")
  expect(children.map((call) => call.params.worldName)).toEqual(worlds.map((call) => call.params.worldName))
  await tick()
  expect(fake.method("Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(2)
  contained(fake)
})

test("the world reads sensitive input values as empty and blocks cookies, storage, workers and same-origin channels even after tampering", async () => {
  const fake = browser()
  const source = `
    const blocked = (read) => { try { read(); return "readable" } catch (error) { return error.name } }
    RegExp.prototype.exec = () => null
    RegExp.prototype.test = () => false
    Reflect.apply = () => "tampered"
    Function.prototype.call = function () { return "tampered" }
    Element.prototype.hasAttribute = () => false
    const byID = (id) => document.getElementById(id)
    const form = () => new FormData(byID("form"))
    return {
      values: ["password", "otp", "card", "marked", "pin", "hidden", "note", "plain"].map((id) => byID(id).value),
      defaults: [byID("password").defaultValue, byID("note").defaultValue, byID("plain").defaultValue],
      attributes: [byID("password").getAttribute("value"), byID("password").getAttributeNS(null, "value"), byID("password").getAttributeNode("value").value,
        byID("plain").getAttribute("value"), byID("password").getAttribute("type")],
      form: [form().get("password"), form().get("csrf"), form().get("c4"), form().get("q")],
      blocked: [() => document.cookie, () => { document.cookie = "a=b" }, () => localStorage, () => sessionStorage, () => indexedDB, () => cookieStore,
        () => caches, () => new Worker("w.js"), () => new SharedWorker("w.js"), () => new BroadcastChannel("private"), () => navigator.serviceWorker,
        () => navigator.locks, () => navigator.storage].map(blocked),
      redefine: blocked(() => Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "x" })),
    }`
  const result = await run(fake, { source })
  expect(result).toEqual({
    outcome: "completed",
    logs: [],
    value: {
      values: ["", "", "", "", "", "", "", "visible text"],
      defaults: ["", "", "visible text"],
      attributes: ["", "", "", "visible text", "password"],
      form: ["", "", "", "visible text"],
      blocked: Array(13).fill("SecurityError"),
      redefine: "TypeError",
    },
  })
  contained(fake)
})

test("window.open and three-argument document.open return null and open nothing in the world", async () => {
  const fake = browser()
  const source = `
    const self = document.open()
    return [window.open("https://elsewhere.test/"), open("https://elsewhere.test/", "named"), document.open("https://elsewhere.test/", "named", ""),
      self === document, (() => { try { window.open = () => "replaced"; return window.open("x") } catch (error) { return error.name } })()]`
  expect(await run(fake, { source })).toEqual({ outcome: "completed", value: [null, null, null, true, null], logs: [] })
  expect([...fake.realms.values()][0].dom.opened).toEqual([["document"]])
  contained(fake)
})

const attempt = async (fake, body) => {
  const result = await run(fake, { source: `try { const value = (() => { ${body} })(); return value === undefined ? "no-error" : value } catch (error) { return error.name }` })
  return { result: result.value, mutations: [...[...fake.realms.values()].at(-1).dom.mutations] }
}

const outcomes = async (cases) => {
  const fake = browser()
  const settled = {}
  for (const [name, body] of Object.entries(cases)) settled[name] = await attempt(fake, body)
  contained(fake)
  return settled
}

test("every capability that reaches another tab fails closed in the world", async () => {
  const blocked = {
    "window.opener": "return opener",
    "postMessage to another window": "Reflect.apply(postMessage, otherWindow, ['x', '*'])",
    "MessageEvent.source of another window": "return new MessageEvent('message', { source: otherWindow }).source",
    "URL.createObjectURL": "return URL.createObjectURL({})",
    "BroadcastChannel": "new BroadcastChannel('shared')",
    "Worker": "new Worker('w.js')",
    "SharedWorker": "new SharedWorker('w.js')",
    "navigator.serviceWorker": "return navigator.serviceWorker",
    "localStorage": "return localStorage",
    "sessionStorage": "return sessionStorage",
    "indexedDB": "return indexedDB",
    "document.cookie": "return document.cookie",
    "cookieStore": "return cookieStore",
    "navigator.locks": "return navigator.locks",
    "caches": "return caches",
  }
  const settled = await outcomes(blocked)
  expect(Object.fromEntries(Object.entries(settled).map(([name, value]) => [name, value.result])))
    .toEqual(Object.fromEntries(Object.keys(blocked).map((name) => [name, "SecurityError"])))
  expect(Object.values(settled).flatMap((value) => value.mutations)).toEqual([])
  expect(await outcomes({
    "window.open": "return String(window.open('https://elsewhere.test/'))",
    "own postMessage": "postMessage('x', '*'); return 'posted'",
    "own MessageEvent.source": "return new MessageEvent('message', { source: window }).source === window",
  })).toEqual({
    "window.open": { result: "null", mutations: [] },
    "own postMessage": { result: "posted", mutations: ["postMessage"] },
    "own MessageEvent.source": { result: true, mutations: [] },
  })
})

test("every DOM write that could run code in the page's main world throws SecurityError before it reaches the page", async () => {
  const byID = (id) => `document.getElementById("${id}")`
  const blocked = {
    ...Object.fromEntries(["script", "iframe", "frame", "object", "embed", "base", "meta", "link", "portal", "SCRIPT"]
      .map((tag) => [`createElement ${tag}`, `document.createElement("${tag}")`])),
    "createElementNS svg script": "document.createElementNS('http://www.w3.org/2000/svg', 'svg:script')",
    "createElementNS svg animate": "document.createElementNS('http://www.w3.org/2000/svg', 'animate')",
    "appendChild cloned script": `document.body.appendChild(${byID("script")}.cloneNode(true))`,
    "insertBefore element with on* attribute": `document.body.insertBefore(${byID("handler")}.cloneNode(true), null)`,
    "replaceChild with on* attribute": `document.body.replaceChild(${byID("handler")}.cloneNode(true), ${byID("marker")})`,
    "append fragment holding a script": `const fragment = document.createDocumentFragment(); fragment.append(${byID("script")}.cloneNode()); document.body.append(fragment)`,
    "prepend javascript: link": `const link = ${byID("plainlink")}.cloneNode(); link.setAttribute.call; document.body.prepend(${byID("jslink")}.cloneNode())`,
    "replaceChildren with on* attribute": `document.body.replaceChildren(${byID("handler")}.cloneNode())`,
    "before with on* attribute": `${byID("marker")}.before(${byID("handler")}.cloneNode())`,
    "after with on* attribute": `${byID("marker")}.after(${byID("handler")}.cloneNode())`,
    "replaceWith with on* attribute": `${byID("marker")}.replaceWith(${byID("handler")}.cloneNode())`,
    "insertAdjacentElement script": `${byID("marker")}.insertAdjacentElement("beforeend", ${byID("script")}.cloneNode())`,
    "insertAdjacentText into script": `${byID("script")}.insertAdjacentText("beforeend", "page()")`,
    "Range.insertNode with on* attribute": `document.createRange().insertNode(${byID("handler")}.cloneNode())`,
    "Range.surroundContents with script": `document.createRange().surroundContents(${byID("script")}.cloneNode())`,
    "shadow root append script": `${byID("marker")}.attachShadow({ mode: "open" }).append(${byID("script")}.cloneNode())`,
    "setAttribute onerror": `${byID("marker")}.setAttribute("onerror", "page()")`,
    "setAttribute ONCLICK": `${byID("marker")}.setAttribute("ONCLICK", "page()")`,
    "setAttributeNS onclick": `${byID("marker")}.setAttributeNS(null, "onclick", "page()")`,
    "toggleAttribute onclick": `${byID("marker")}.toggleAttribute("onclick")`,
    "setAttributeNode onclick": `const attr = document.createAttribute("onclick"); ${byID("marker")}.setAttributeNode(attr)`,
    "setAttributeNodeNS onclick": `${byID("marker")}.setAttributeNodeNS(${byID("handler")}.getAttributeNode("onclick"))`,
    "Attr.value on onclick": `${byID("handler")}.getAttributeNode("onclick").value = "page()"`,
    "Attr.nodeValue on onclick": `${byID("handler")}.getAttributeNode("onclick").nodeValue = "page()"`,
    "Attr.textContent on onclick": `${byID("handler")}.getAttributeNode("onclick").textContent = "page()"`,
    "NamedNodeMap.setNamedItem": `${byID("marker")}.attributes.setNamedItem(document.createAttribute("title"))`,
    "NamedNodeMap.setNamedItemNS": `${byID("marker")}.attributes.setNamedItemNS(document.createAttribute("title"))`,
    "setAttribute href javascript:": `${byID("plainlink")}.setAttribute("href", "javascript:page()")`,
    "setAttribute src with obfuscated javascript:": `${byID("marker")}.setAttribute("src", " \\u0001JAVA\\tSCRIPT:page()")`,
    "setAttribute action javascript:": `${byID("selfform")}.setAttribute("action", "javascript:page()")`,
    "setAttribute formaction javascript:": `${byID("go")}.setAttribute("formaction", "javascript:page()")`,
    "setAttributeNS xlink:href javascript:": `${byID("marker")}.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "javascript:page()")`,
    "a.href javascript:": `${byID("plainlink")}.href = "javascript:page()"`,
    "a.href toString javascript:": `${byID("plainlink")}.href = { toString: () => "javascript:page()" }`,
    "area.href javascript:": `${byID("area")}.href = "javascript:page()"`,
    "a.protocol javascript": `${byID("plainlink")}.protocol = "javascript"`,
    "form.action javascript:": `${byID("selfform")}.action = "javascript:page()"`,
    "button.formAction javascript:": `${byID("go")}.formAction = "javascript:page()"`,
    "input.formAction javascript:": `${byID("image")}.formAction = "javascript:page()"`,
    "SVG href baseVal javascript:": `svgHref.baseVal = "javascript:page()"`,
    "innerHTML": `${byID("marker")}.innerHTML = "<img src=x onerror=page()>"`,
    "outerHTML": `${byID("marker")}.outerHTML = "<b>x</b>"`,
    "insertAdjacentHTML": `${byID("marker")}.insertAdjacentHTML("beforeend", "<b>x</b>")`,
    "setHTMLUnsafe": `${byID("marker")}.setHTMLUnsafe("<b>x</b>")`,
    "ShadowRoot.innerHTML": `${byID("marker")}.attachShadow({ mode: "open" }).innerHTML = "<b>x</b>"`,
    "ShadowRoot.setHTMLUnsafe": `${byID("marker")}.attachShadow({ mode: "open" }).setHTMLUnsafe("<b>x</b>")`,
    "document.write": `document.write("<b>x</b>")`,
    "document.writeln": `document.writeln("<b>x</b>")`,
    "document.execCommand": `document.execCommand("insertHTML", false, "<b>x</b>")`,
    "Document.parseHTMLUnsafe": `Document.parseHTMLUnsafe("<b>x</b>")`,
    "Range.createContextualFragment": `document.createRange().createContextualFragment("<b>x</b>")`,
    "new DOMParser": `new DOMParser()`,
    "iframe.srcdoc": `${byID("frame")}.srcdoc = "<script>page()<\\/script>"`,
    "iframe.src": `${byID("frame")}.src = "/elsewhere"`,
    "script.src": `${byID("script")}.src = "/payload.js"`,
    "script.text": `${byID("script")}.text = "page()"`,
    "script.textContent": `${byID("script")}.textContent = "page()"`,
    "script.innerText": `${byID("script")}.innerText = "page()"`,
    "script setAttribute": `${byID("script")}.setAttribute("src", "/payload.js")`,
    "script removeAttribute": `${byID("script")}.removeAttribute("type")`,
    "script appendChild text": `${byID("script")}.appendChild(document.createTextNode("page()"))`,
    "script child data": `${byID("script")}.firstChild.data = "page()"`,
    "script child appendData": `${byID("script")}.firstChild.appendData("page()")`,
    "script child nodeValue": `${byID("script")}.firstChild.nodeValue = "page()"`,
    "click _blank link": `${byID("blank")}.click()`,
    "click _BLANK link": `${byID("upper")}.click()`,
    "click named-target link": `${byID("named")}.click()`,
    "click javascript: link": `${byID("jslink")}.click()`,
    "click _blank area": `${byID("area")}.click()`,
    "click inside a _blank link": `${byID("inner")}.click()`,
    "dispatch click on a _blank link": `${byID("blank")}.dispatchEvent(new MouseEvent("click"))`,
    "dispatch DOMActivate on a _blank link": `${byID("blank")}.dispatchEvent(new Event("DOMActivate"))`,
    "click link with a base target": `setBaseTarget("elsewhere"); ${byID("plainlink")}.click()`,
    "form.submit to _blank": `${byID("blankform")}.submit()`,
    "form.submit javascript: action": `${byID("jsform")}.submit()`,
    "form.submit with a base target": `setBaseTarget("_blank"); ${byID("selfform")}.submit()`,
    "form.requestSubmit to _blank": `${byID("blankform")}.requestSubmit()`,
    "form.requestSubmit with formtarget submitter": `${byID("selfform")}.requestSubmit(${byID("go2")})`,
    "click submit button of a _blank form": `${byID("go")}.click()`,
    "click formtarget _blank button": `${byID("go2")}.click()`,
    "click input image with named formtarget": `${byID("image")}.click()`,
    "click label of a formtarget button": `${byID("lab")}.click()`,
  }
  const settled = await outcomes(blocked)
  expect(Object.fromEntries(Object.entries(settled).map(([name, value]) => [name, value.result])))
    .toEqual(Object.fromEntries(Object.keys(blocked).map((name) => [name, "SecurityError"])))
  expect(Object.entries(settled).filter(([, value]) => value.mutations.length > 0)).toEqual([])

  expect(await outcomes({
    "create and append a div": `const div = document.createElement("div"); div.setAttribute("title", "safe"); div.setAttribute("href", "/ok"); document.body.append(div, "text"); return "ok"`,
    "edit ordinary text": `${byID("marker")}.textContent = "x"; return "ok"`,
    "javascript text in a non-URL attribute": `${byID("marker")}.setAttribute("title", "javascript: guide"); return "ok"`,
    "safe href": `${byID("plainlink")}.href = "/next"; return "ok"`,
    "click same-tab link": `${byID("self")}.click(); ${byID("top")}.click(); ${byID("plainlink")}.click(); return "ok"`,
    "click plain button": `${byID("plainbutton")}.click(); ${byID("staybutton")}.click(); return "ok"`,
    "dispatch non-click event on a _blank link": `${byID("blank")}.dispatchEvent(new Event("focus")); return "ok"`,
    "submit a same-tab form": `${byID("selfform")}.submit(); return "ok"`,
  })).toEqual({
    "create and append a div": { result: "ok", mutations: ["setAttribute", "setAttribute", "append"] },
    "edit ordinary text": { result: "ok", mutations: ["textContent"] },
    "javascript text in a non-URL attribute": { result: "ok", mutations: ["setAttribute"] },
    "safe href": { result: "ok", mutations: ["href"] },
    "click same-tab link": { result: "ok", mutations: ["click", "click", "click"] },
    "click plain button": { result: "ok", mutations: ["click", "click"] },
    "dispatch non-click event on a _blank link": { result: "ok", mutations: ["dispatchEvent"] },
    "submit a same-tab form": { result: "ok", mutations: ["submit"] },
  })
})

test("a finished script world drops its timers, listeners and observers", async () => {
  const fake = browser()
  const source = `
    globalThis.ticks = 0
    setInterval(() => { globalThis.ticks++ }, 1)
    requestAnimationFrame(() => { globalThis.ticks += 1000 })
    document.addEventListener("keydown", () => {})
    new MutationObserver(() => {}).observe(document)
    return document.getElementById("plain").value`
  expect(await run(fake, { source })).toEqual({ outcome: "completed", value: "visible text", logs: [] })
  await tick()
  const realm = [...fake.realms.values()][0]
  const ticks = realm.context.ticks
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(realm.context.ticks).toBe(ticks)
  expect(ticks).toBeLessThan(1000)
  expect(realm.dom.listeners).toHaveLength(0)
  expect(realm.dom.observers.size).toBe(0)
  contained(fake)
})

test("code runs share one world per lease until it is discarded or the document changes", async () => {
  const fake = browser()
  const worlds = new Map()
  const code = (source, leaseID = "lease-1") => run(fake, { mode: "code", source, leaseID }, worlds)
  expect(await code("var total = 5; total")).toEqual({ outcome: "completed", value: 5, logs: [] })
  expect(await code("total + 1")).toEqual({ outcome: "completed", value: 6, logs: [] })
  expect(await code("typeof total", "lease-2")).toEqual({ outcome: "completed", value: "undefined", logs: [] })
  expect(fake.method("Page.createIsolatedWorld")).toHaveLength(2)
  const evaluations = fake.method("Runtime.evaluate").filter((call) => call.params.replMode === true)
  expect(evaluations.map((call) => call.params.contextId)).toEqual([evaluations[0].params.contextId, evaluations[0].params.contextId,
    evaluations[2].params.contextId])
  expect(evaluations[2].params.contextId).not.toBe(evaluations[0].params.contextId)
  expect(fake.method("Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(0)

  discardWorlds(worlds, "lease-1")
  await tick()
  expect(fake.method("Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1)
  expect(await code("typeof total")).toEqual({ outcome: "completed", value: "undefined", logs: [] })
  expect(await code("var kept = 1; kept")).toEqual({ outcome: "completed", value: 1, logs: [] })
  fake.state.frame = { id: "top-frame", loaderId: "document-2" }
  expect(await code("typeof kept")).toEqual({ outcome: "completed", value: "undefined", logs: [] })
  expect(fake.method("Page.createIsolatedWorld")).toHaveLength(4)
  expect(worlds.size).toBe(2)
  discardWorlds(worlds, "lease-1")
  discardWorlds(worlds, "lease-2")
  discardWorlds(worlds, "unknown")
  expect(worlds.size).toBe(0)
  contained(fake)
})

test("logs come only from the run's own world between start and settlement", async () => {
  const fake = browser()
  fake.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "before" }], executionContextId: 10, timestamp: 0 })
  const source = `
    console.log("first", 1, true, null, undefined, 10n)
    emitForeign()
    console.warn("second")
    console.error("third")
    console.info("info")
    console.debug("debug")
    console.table("table")
    throwLater("async boom")
    return 1`
  const result = await run(fake, { source })
  expect(result).toEqual({
    outcome: "completed",
    value: 1,
    logs: [
      { level: "log", text: "first 1 true null undefined 10n" },
      { level: "warn", text: "second" },
      { level: "error", text: "third" },
      { level: "info", text: "info" },
      { level: "debug", text: "debug" },
      { level: "log", text: "table" },
      { level: "error", text: "Error: async boom" },
    ],
  })
  const contextId = fake.method("Page.createIsolatedWorld").length && [...fake.realms.keys()][0]
  fake.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "late" }], executionContextId: contextId, timestamp: 0 })
  expect(result.logs).toHaveLength(7)
  expect(JSON.stringify(result)).not.toContain("foreign")
  contained(fake)
})

test("logs are capped and console text, errors and values are redacted", async () => {
  const fake = browser()
  const logged = await run(fake, { source: `
    console.log("token=abc123value mail alice@example.test")
    console.log("x".repeat(5000))
    for (let index = 0; index < 250; index++) console.log("line", index)
    return { "alice@example.test": "Bearer abcdefghijklmnopqrstuvwxyz0123456789", list: ["sk-proj-AbCdEfGhIjKlMnOpQrStUvWx", "plain words"] }` })
  expect(logged.outcome).toBe("completed")
  expect(logged.logs).toHaveLength(200)
  expect(logged.logsTruncated).toBe(true)
  expect(logged.logs[0]).toEqual({ level: "log", text: "token=[redacted] mail [redacted]" })
  expect(logged.logs[1].text).toHaveLength(2048)
  expect(logged.logs[199]).toEqual({ level: "log", text: "line 197" })
  expect(logged.value).toEqual({ "[redacted]": "[redacted]", list: ["[redacted]", "plain words"] })

  const failed = await run(fake, { source: "console.log(\"ok\")\nthrow new TypeError(\"password=hunter2 for alice@example.test\")" })
  expect(failed.outcome).toBe("error")
  expect(failed.logs).toEqual([{ level: "log", text: "ok" }])
  expect(failed.error.name).toBe("TypeError")
  expect(failed.error.message).toBe("password=[redacted] for [redacted]")
  expect(failed.error.stack).toContain("TypeError: password=[redacted] for [redacted]")
  expect(JSON.stringify(failed)).not.toContain("hunter2")
  expect(JSON.stringify(failed)).not.toContain("alice@")

  const long = await run(fake, { source: "const error = new Error(\"m\".repeat(5000))\nerror.name = \"N\".repeat(500)\nerror.stack = \"s\".repeat(20000)\nthrow error" })
  expect(long.error.name).toHaveLength(128)
  expect(long.error.message).toHaveLength(2048)
  expect(long.error.stack).toHaveLength(8192)

  expect(await run(fake, { source: "throw \"plain failure\"" })).toEqual({ outcome: "error", error: { name: "Error", message: "plain failure" }, logs: [] })
  expect(fake.method("Runtime.evaluate").some((call) => call.params.expression?.includes("hunter2"))).toBe(false)
  contained(fake)
})

test("values over 65536 serialized bytes are withheld and others serialize as JSON", async () => {
  const fake = browser()
  expect(await run(fake, { source: "return \"é\".repeat(40000)" })).toEqual({ outcome: "completed", valueTruncated: true, logs: [] })
  expect(await run(fake, { source: "return \"a\".repeat(65534)" })).toEqual({ outcome: "completed", value: "a".repeat(65534), logs: [] })
  expect(await run(fake, { source: "return \"a\".repeat(65535)" })).toEqual({ outcome: "completed", valueTruncated: true, logs: [] })
  expect(await run(fake, { source: "return Array.from({ length: 50000 }, (_, index) => index)" }))
    .toEqual({ outcome: "completed", valueTruncated: true, logs: [] })
  expect(await run(fake, { source: "const value = { n: 1 }\nvalue.self = value\nreturn value" }))
    .toEqual({ outcome: "completed", value: { n: 1, self: "[Circular]" }, logs: [] })
  expect(await run(fake, { source: "return undefined" })).toEqual({ outcome: "completed", value: null, logs: [] })
  expect(await run(fake, { source: "return 10n" })).toEqual({ outcome: "completed", value: "10", logs: [] })
  expect(await run(fake, { source: "return { big: 10n, missing: undefined, list: [NaN] }" }))
    .toEqual({ outcome: "completed", value: { big: "10", list: [null] }, logs: [] })
  contained(fake)
})

test("a timeout terminates execution and settles promptly with the logs so far", async () => {
  const fake = browser()
  const started = performance.now()
  const result = await run(fake, { source: "console.log(\"waiting\")\nawait new Promise(() => {})", timeoutMs: 100 })
  expect(performance.now() - started).toBeLessThan(1000)
  expect(result).toEqual({ outcome: "timeout", logs: [{ level: "log", text: "waiting" }] })
  expect(fake.method("Runtime.terminateExecution")).toHaveLength(1)
  await tick()
  expect(fake.method("Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1)
  contained(fake)
})

test("Stop aborts a pending run immediately and never dispatches after an earlier abort", async () => {
  const fake = browser()
  const controller = new AbortController()
  const running = run(fake, { source: "console.log(\"started\")\nawait new Promise(() => {})", signal: controller.signal })
  await fake.logged("started")
  controller.abort()
  const settled = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("late"), 50))])
  expect(settled).toEqual({ outcome: "stopped", logs: [{ level: "log", text: "started" }] })
  expect(fake.method("Runtime.terminateExecution")).toHaveLength(1)
  contained(fake)

  const idle = browser()
  const aborted = new AbortController()
  aborted.abort()
  expect(await run(idle, { source: "return 1", signal: aborted.signal })).toEqual({ outcome: "stopped", logs: [] })
  expect(idle.calls).toEqual([])
  expect(idle.listeners.size).toBe(0)
})

test("Stop during world setup settles stopped without running the source", async () => {
  const fake = browser()
  const controller = new AbortController()
  const gate = Promise.withResolvers()
  const send = fake.cdp.send.bind(fake.cdp)
  fake.cdp.send = async (target, method, params) => {
    if (method === "Page.createIsolatedWorld") await gate.promise
    return send(target, method, params)
  }
  const running = run(fake, { source: "globalThis.ran = true\nreturn 1", signal: controller.signal })
  await tick()
  controller.abort()
  expect(await running).toEqual({ outcome: "stopped", logs: [] })
  gate.resolve()
  await tick()
  await tick()
  expect(fake.calls.filter((call) => call.method === "Runtime.callFunctionOn" && call.params.executionContextId !== undefined)).toEqual([])
  expect(fake.method("Runtime.terminateExecution")).toEqual([])
  expect(fake.method("Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1)
  expect([...fake.realms.values()].some((realm) => realm.context.ran)).toBe(false)
})

test("a dialog or file chooser during a run settles paused at once without terminating or retrying", async () => {
  for (const [method, reason] of [["Page.javascriptDialogOpening", "dialog"], ["Page.fileChooserOpened", "file_chooser"]]) {
    const fake = browser()
    const running = run(fake, { source: `console.log("before")\nopenHandoff(${JSON.stringify(method)})\nawait new Promise(() => {})`, timeoutMs: 100 })
    const settled = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("late"), 50))])
    expect(settled).toEqual({ outcome: "paused", reason })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await running).toEqual({ outcome: "paused", reason })
    expect(fake.method("Runtime.terminateExecution")).toEqual([])
    expect(fake.calls.filter((call) => call.method === "Runtime.callFunctionOn" && call.params.executionContextId !== undefined)).toHaveLength(1)
    await tick()
    expect(fake.method("Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1)
    contained(fake)
  }
})

test("Runtime is enabled once per tab while runs are in flight and disabled only by the last run that needed it", async () => {
  const fake = browser()
  expect(await run(fake, { source: "return 1" })).toEqual({ outcome: "completed", value: 1, logs: [] })
  await tick()
  expect(fake.calls.filter((call) => call.method === "Runtime.enable" || call.method === "Runtime.disable").map((call) => call.method))
    .toEqual(["Runtime.enable", "Runtime.disable"])

  const worlds = new Map()
  const waiting = run(fake, { source: "await waitGate()\nreturn 'late'" })
  await tick()
  expect(await run(fake, { mode: "code", leaseID: "lease-2", source: "'quick'" }, worlds)).toEqual({ outcome: "completed", value: "quick", logs: [] })
  await tick()
  expect(fake.method("Runtime.enable")).toHaveLength(2)
  expect(fake.method("Runtime.disable")).toHaveLength(1)
  fake.gate.resolve()
  expect(await waiting).toEqual({ outcome: "completed", value: "late", logs: [] })
  await tick()
  expect(fake.method("Runtime.disable")).toHaveLength(2)
  const order = fake.calls.map((call) => call.method)
  expect(order.lastIndexOf("Runtime.disable")).toBeGreaterThan(order.lastIndexOf("Runtime.callFunctionOn"))
  contained(fake)
})

test("console events stamped before the run started are not collected", async () => {
  const fake = browser()
  const worlds = new Map()
  expect(await run(fake, { mode: "code", source: "console.log('first-run'); 1" }, worlds))
    .toEqual({ outcome: "completed", value: 1, logs: [{ level: "log", text: "first-run" }] })
  expect(await run(fake, { mode: "code", source: "replayStale('first-run'); console.log('second-run'); 2" }, worlds))
    .toEqual({ outcome: "completed", value: 2, logs: [{ level: "log", text: "second-run" }] })
  contained(fake)
})

test("a debugger transport failure rejects instead of inventing an outcome", async () => {
  const fake = browser()
  fake.state.fail.add("Page.createIsolatedWorld")
  expect(await run(fake, { source: "return 1" }).catch((error) => error.message)).toBe("Debugger is not attached to the tab")
  expect(fake.method("Runtime.terminateExecution")).toEqual([])
  expect(fake.listeners.size).toBe(0)
  const worlds = new Map()
  expect(await run(fake, { mode: "code", source: "1" }, worlds).catch((error) => error.message)).toBe("Debugger is not attached to the tab")
  expect(worlds.size).toBe(0)
})
