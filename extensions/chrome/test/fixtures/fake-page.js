import { runInNewContext } from "node:vm"

export function createFakePage() {
  const clock = createClock()
  const observers = new Set()
  const listeners = new Map()
  const moves = []
  const scrolls = []
  const animations = []
  const state = { visibility: "visible", reducedMotion: false, headless: false, frameRequests: 0, suppressFrames: false }

  class Style {
    cssText = ""
    _transform = ""
    setProperty() {}
    set transform(value) {
      this._transform = value
      moves.push(value)
    }
    get transform() {
      return this._transform
    }
  }

  class Node {
    constructor(tagName, namespace) {
      this.tagName = tagName.toUpperCase()
      this.namespace = namespace
      this.attributes = new Map()
      this.dataset = {}
      this.style = new Style()
      this.children = []
      this.parent = undefined
      this.textContent = ""
      this.hidden = false
      this.shadow = undefined
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value))
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent?.detach(node)
        node.parent = this
        this.children.push(node)
      }
      changed()
    }
    detach(node) {
      this.children.splice(this.children.indexOf(node), 1)
      node.parent = undefined
    }
    remove() {
      this.parent?.detach(this)
      changed()
    }
    get isConnected() {
      let node = this
      while (node.parent) node = node.parent
      return node === documentElement
    }
    attachShadow() {
      this.shadow = new Node("#shadow-root")
      return this.shadow
    }
    animate(keyframes, options) {
      animations.push({ node: this, keyframes, options })
    }
    matches(selector) {
      if (selector.startsWith("[")) return this.attributes.has(selector.slice(1, -1))
      return this.tagName === selector.toUpperCase()
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }

  const documentElement = new Node("html")
  const head = new Node("head")
  documentElement.children.push(head)
  head.parent = documentElement

  function changed() {
    for (const observer of observers) queueMicrotask(() => observer.active && observer.callback([]))
  }

  const document = {
    documentElement,
    get head() {
      return state.headless ? null : head
    },
    get visibilityState() {
      return state.visibility
    },
    get title() {
      return (documentElement.querySelector("title")?.textContent ?? "").trim().replace(/\s+/g, " ")
    },
    set title(value) {
      let element = documentElement.querySelector("title")
      if (!element) {
        element = new Node("title")
        head.append(element)
      }
      element.textContent = String(value)
      changed()
    },
    createElement: (tag) => new Node(tag),
    createElementNS: (namespace, tag) => new Node(tag, namespace),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    removeEventListener: (name, listener) =>
      listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener)),
  }

  class MutationObserver {
    constructor(callback) {
      this.callback = callback
      this.active = false
    }
    observe() {
      this.active = true
      observers.add(this)
    }
    disconnect() {
      this.active = false
      observers.delete(this)
    }
  }

  const globals = {
    document,
    MutationObserver,
    Date: { now: () => clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    performance: { now: () => 0 },
    innerWidth: 100,
    innerHeight: 80,
    matchMedia: () => ({ matches: state.reducedMotion }),
    scrollBy: (x, y) => scrolls.push([x, y]),
  }

  return {
    clock,
    moves,
    scrolls,
    animations,
    document,
    get frameRequests() {
      return state.frameRequests
    },
    set suppressFrames(value) {
      state.suppressFrames = value
    },
    set reducedMotion(value) {
      state.reducedMotion = value
    },
    set headless(value) {
      state.headless = value
    },
    setVisibility: (value) => (state.visibility = value),
    setPageTitle(value) {
      document.title = value
    },
    removeTitle() {
      documentElement.querySelector("title")?.remove()
    },
    dispatch: (name) => Promise.all((listeners.get(name) ?? []).map((listener) => listener())),
    markers: () => documentElement.querySelectorAll("[data-ycoding-agent-marker]"),
    hosts: () => documentElement.querySelectorAll("[data-ycoding-agent-cursor]"),
    chipText: () => {
      const walk = (node) => [node, ...node.children.flatMap(walk), ...(node.shadow ? walk(node.shadow) : [])]
      return walk(documentElement).filter((node) => node.tagName === "SPAN" && node.textContent).map((node) => node.textContent)
    },
    domText() {
      const walk = (node) => [
        node.textContent,
        ...node.attributes.values(),
        ...Object.values(node.dataset),
        ...node.children.flatMap(walk),
        ...(node.shadow ? walk(node.shadow) : []),
      ]
      return walk(documentElement).join("\n")
    },
    navigate() {
      for (const child of documentElement.children.slice()) if (child !== head) child.remove()
      for (const child of head.children.slice()) child.remove()
      for (const observer of Array.from(observers)) observer.disconnect()
      listeners.clear()
      clock.reset()
    },
    async evaluate(expression) {
      let frame = 0
      return runInNewContext(expression, {
        ...globals,
        requestAnimationFrame: (callback) => {
          state.frameRequests++
          if (state.visibility === "visible" && !state.suppressFrames) callback(frame++ === 0 ? 0 : 320)
          return state.frameRequests
        },
      })
    },
    reset() {
      this.navigate()
      moves.length = 0
      scrolls.length = 0
      animations.length = 0
      state.visibility = "visible"
      state.reducedMotion = false
      state.headless = false
      state.frameRequests = 0
      state.suppressFrames = false
    },
  }
}

function createClock() {
  let timers = []
  let sequence = 0
  const clock = {
    now: 1_000_000,
    setTimeout: (callback, delay = 0) => {
      const timer = { id: ++sequence, at: clock.now + delay, callback }
      timers.push(timer)
      return timer.id
    },
    clearTimeout: (id) => {
      timers = timers.filter((timer) => timer.id !== id)
    },
    advance(ms) {
      const target = clock.now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        timers = timers.filter((timer) => timer !== due)
        clock.now = due.at
        due.callback()
      }
      clock.now = target
    },
    reset() {
      timers = []
    },
  }
  return clock
}
