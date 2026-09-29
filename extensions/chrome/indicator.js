export const tokens = {
  colors: {
    "agent-cursor": "#8b5cf6",
    "agent-label": "#6d28d9",
    "agent-label-text": "#ffffff",
    "agent-ripple": "#a78bfa",
    "agent-shadow": "#00000088",
    "badge-on": "#28753e",
  },
  typography: {
    "agent-label": { fontFamily: "system-ui, sans-serif", fontSize: "12px", fontWeight: 400, lineHeight: 1.2 },
  },
  rounded: { "agent-label": "5px" },
  motion: { duration: { "cursor-move": "320ms", ripple: "450ms" } },
  layers: { "agent-overlay": 2147483647 },
  components: {
    "agent-cursor": { height: "20px" },
    "agent-label": { padding: "3px 6px" },
    "agent-ripple": { size: "22px" },
  },
}

export const TITLE_PREFIX = "[YCoding] "

export const LABELS = { click: "Click", type: "Type", scroll: "Scroll" }

export const timing = {
  refresh: 5000,
  expiry: 15000,
  check: 1000,
  clear: 600,
  mark: 2000,
  cursorAnimationTimeout: 500,
}

export function markerScript(op, cursor) {
  const label = tokens.typography["agent-label"]
  return `(${agentMarker.toString()})(${JSON.stringify({
    op,
    prefix: TITLE_PREFIX,
    ttl: timing.expiry,
    check: timing.check,
    animationTimeout: timing.cursorAnimationTimeout,
    cursor,
    style: {
      layer: tokens.layers["agent-overlay"],
      height: parseInt(tokens.components["agent-cursor"].height),
      arrow: tokens.colors["agent-cursor"],
      shadow: tokens.colors["agent-shadow"],
      labelBackground: tokens.colors["agent-label"],
      labelText: tokens.colors["agent-label-text"],
      labelRadius: tokens.rounded["agent-label"],
      labelPadding: tokens.components["agent-label"].padding,
      labelFont: `${label.fontSize}/${String(label.lineHeight)} ${label.fontFamily}`,
      ripple: tokens.colors["agent-ripple"],
      rippleSize: parseInt(tokens.components["agent-ripple"].size),
      moveMs: parseInt(tokens.motion.duration["cursor-move"]),
      rippleMs: parseInt(tokens.motion.duration.ripple),
    },
  })})`
}

// Serialized into the page's isolated world, so it must not close over module state. All state lives in
// the marker element's data attributes so any later evaluation, in any context, continues the same marker.
async function agentMarker(options) {
  const MARKER = "[data-ycoding-agent-marker]"
  const CURSOR = "[data-ycoding-agent-cursor]"
  const restoreTitle = (marker) => {
    if (marker.dataset.marked === undefined || document.title !== marker.dataset.marked) return
    if (marker.dataset.created) document.querySelector("title")?.remove()
    else document.title = marker.dataset.base
  }
  const clear = (marker) => {
    restoreTitle(marker)
    marker.dataset.epoch = ""
    marker.remove()
  }
  const sync = (marker) => {
    const current = document.title
    if (current === marker.dataset.marked) return
    marker.dataset.base = current
    if (current) marker.dataset.created = ""
    document.title = options.prefix + current
    marker.dataset.marked = document.title
  }
  const watch = (marker, epoch) => {
    const live = () => marker.isConnected && marker.dataset.epoch === epoch
    let timer
    const observer = new MutationObserver(() => {
      if (live()) sync(marker)
      else retire()
    })
    const stop = () => {
      observer.disconnect()
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", tick)
      document.removeEventListener("resume", tick)
    }
    function retire() {
      stop()
      if (marker.dataset.epoch !== epoch) return
      clear(marker)
      for (const cursor of document.querySelectorAll(CURSOR)) cursor.remove()
    }
    function tick() {
      if (!live()) return retire()
      if (Date.now() <= Number(marker.dataset.deadline)) return sync(marker)
      retire()
    }
    const loop = () => {
      tick()
      if (live()) timer = setTimeout(loop, options.check)
    }
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    observer.observe(document.documentElement, { childList: true })
    document.addEventListener("visibilitychange", tick)
    document.addEventListener("resume", tick)
    timer = setTimeout(loop, options.check)
  }
  const cursorHosts = () => [...document.querySelectorAll(CURSOR)]
  const existing = document.querySelector(MARKER)

  if (options.op === "clear") {
    if (existing) clear(existing)
    for (const cursor of cursorHosts()) cursor.remove()
    return { ok: true }
  }
  if (!document.head || !document.documentElement) return { ok: false }

  const marker = existing?.dataset.epoch ? existing : document.createElement("div")
  if (marker !== existing) {
    existing?.remove()
    marker.setAttribute("data-ycoding-agent-marker", "")
    marker.hidden = true
    marker.dataset.created = document.querySelector("title") ? "" : "1"
    marker.dataset.epoch = `${Date.now()}-${Math.random()}`
    document.documentElement.append(marker)
    marker.dataset.deadline = String(Date.now() + options.ttl)
    watch(marker, marker.dataset.epoch)
  }
  marker.dataset.deadline = String(Date.now() + options.ttl)
  sync(marker)

  if (options.cursor) await moveCursor(options.cursor)
  return { ok: marker.isConnected && document.title === marker.dataset.marked && document.title.startsWith(options.prefix.trim()) }

  async function moveCursor({ x, y, label, click }) {
    const style = options.style
    const previous = cursorHosts().at(-1)
    const startX = previous ? Number(previous.dataset.x) : innerWidth / 2
    const startY = previous ? Number(previous.dataset.y) : innerHeight / 2
    for (const host of cursorHosts()) host.remove()
    const host = document.createElement("div")
    host.setAttribute("data-ycoding-agent-cursor", "")
    host.dataset.x = String(startX)
    host.dataset.y = String(startY)
    host.style.cssText = `position:fixed;left:0;top:0;z-index:${style.layer};pointer-events:none;`
    const root = host.attachShadow({ mode: "closed" })
    const cursor = document.createElement("div")
    cursor.style.cssText = `position:fixed;left:0;top:0;will-change:transform;pointer-events:none;filter:drop-shadow(0 1px 2px ${style.shadow});`
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    arrow.setAttribute("viewBox", "0 0 14 20")
    arrow.setAttribute("width", String((style.height * 14) / 20))
    arrow.setAttribute("height", String(style.height))
    arrow.style.cssText = "display:block;pointer-events:none;"
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path")
    shape.setAttribute("d", "M0 0L0 17L4.5 13L7.5 20L10 19L7 12L13 12Z")
    shape.setAttribute("fill", style.arrow)
    arrow.append(shape)
    const chip = document.createElement("span")
    chip.textContent = `YCoding · ${label}`
    chip.style.cssText = `position:absolute;left:14px;top:15px;padding:${style.labelPadding};border-radius:${style.labelRadius};background:${style.labelBackground};color:${style.labelText};font:${style.labelFont};white-space:nowrap;pointer-events:none;`
    cursor.append(arrow, chip)
    root.append(cursor)
    document.documentElement.append(host)
    cursor.style.transform = `translate(${startX}px,${startY}px)`
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    if (document.visibilityState === "visible" && !reduced) {
      let active = true
      let timeout
      await Promise.race([
        new Promise((resolve) => {
          const started = performance.now()
          const frame = (now) => {
            if (!active) return resolve()
            const progress = Math.min(1, (now - started) / style.moveMs)
            const eased = 1 - Math.pow(1 - progress, 3)
            cursor.style.transform = `translate(${startX + (x - startX) * eased}px,${startY + (y - startY) * eased}px)`
            if (progress < 1) requestAnimationFrame(frame)
            else resolve()
          }
          requestAnimationFrame(frame)
        }),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, options.animationTimeout)
        }),
      ])
      active = false
      clearTimeout(timeout)
    }
    cursor.style.transform = `translate(${x}px,${y}px)`
    host.dataset.x = String(x)
    host.dataset.y = String(y)
    if (!click) return
    const ripple = document.createElement("span")
    const half = style.rippleSize / 2
    ripple.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${style.rippleSize}px;height:${style.rippleSize}px;margin:${-half}px 0 0 ${-half}px;box-sizing:border-box;border:2px solid ${style.ripple};border-radius:50%;pointer-events:none;`
    root.append(ripple)
    if (!reduced)
      ripple.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2)", opacity: 0 }], {
        duration: style.rippleMs,
        easing: "ease-out",
        fill: "forwards",
      })
    setTimeout(() => ripple.remove(), style.rippleMs + 50)
  }
}
