export const tokens = {
  colors: {
    "badge-on": "#28753e",
    "agent-mark": "#67d7a4",
  },
}

const MARK_PATH = "M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z"

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#24282F"/><path d="${MARK_PATH}" fill="#67D7A4"/></svg>`

export const timing = {
  refresh: 5000,
  expiry: 15000,
  check: 1000,
  clear: 600,
  mark: 2000,
}

export function markerScript(op) {
  return `(${agentMarker.toString()})(${JSON.stringify({
    op,
    favicon: `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`,
    ttl: timing.expiry,
    check: timing.check,
  })})`
}

// Serialized into the page's isolated world, so it must not close over module state. All state lives in
// the marker element's data attributes so any later evaluation, in any context, continues the same marker.
async function agentMarker(options) {
  const MARKER = "[data-ycoding-agent-marker]"
  const ICON_ATTRS = ["rel", "href", "type", "sizes", "media", "color", "crossorigin", "referrerpolicy", "as"]
  const iconLinks = () =>
    Array.from(document.head?.querySelectorAll("link") ?? []).filter((node) =>
      (node.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("icon"),
    )
  const ownIcon = () => document.querySelector("[data-ycoding-agent-icon]")
  const snapshotIcons = (marker, links) => {
    marker.dataset.icons = JSON.stringify(
      links.map((node) =>
        ICON_ATTRS.flatMap((name) => {
          const value = node.getAttribute(name)
          return value === null ? [] : [[name, value]]
        }),
      ),
    )
  }
  const restoreIcons = (marker) => {
    ownIcon()?.remove()
    let saved = []
    try {
      saved = JSON.parse(marker.dataset.icons ?? "[]")
    } catch {}
    for (const attrs of saved) {
      const link = document.createElement("link")
      for (const [name, value] of attrs) link.setAttribute(name, value)
      document.head?.append(link)
    }
  }
  const clear = (marker) => {
    restoreIcons(marker)
    marker.dataset.epoch = ""
    marker.remove()
  }
  const sync = (marker) => {
    const own = ownIcon()
    const page = iconLinks().filter((node) => node !== own)
    if (page.length > 0) {
      snapshotIcons(marker, page)
      for (const node of page) node.remove()
    }
    if (own) return
    const link = document.createElement("link")
    link.setAttribute("rel", "icon")
    link.setAttribute("type", "image/svg+xml")
    link.setAttribute("href", options.favicon)
    link.setAttribute("data-ycoding-agent-icon", "")
    document.head?.append(link)
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
  const faviconLoads = () =>
    new Promise((resolve) => {
      if (typeof Image !== "function") return resolve(false)
      const probe = new Image()
      const timeout = setTimeout(() => resolve(false), 1000)
      probe.onload = () => {
        clearTimeout(timeout)
        resolve(probe.naturalWidth > 0)
      }
      probe.onerror = () => {
        clearTimeout(timeout)
        resolve(false)
      }
      probe.src = options.favicon
    })
  const existing = document.querySelector(MARKER)

  if (options.op === "clear") {
    if (existing) clear(existing)
    return { ok: true }
  }
  if (!document.head || !document.documentElement) return { ok: false }
  if (existing?.dataset.iconVerified !== "1" && !(await faviconLoads())) {
    if (existing) clear(existing)
    return { ok: false }
  }

  const marker = existing?.dataset.epoch ? existing : document.createElement("div")
  if (marker !== existing) {
    existing?.remove()
    marker.setAttribute("data-ycoding-agent-marker", "")
    marker.hidden = true
    snapshotIcons(marker, iconLinks())
    marker.dataset.epoch = `${Date.now()}-${Math.random()}`
    document.documentElement.append(marker)
    marker.dataset.deadline = String(Date.now() + options.ttl)
    watch(marker, marker.dataset.epoch)
  }
  marker.dataset.deadline = String(Date.now() + options.ttl)
  marker.dataset.iconVerified = "1"
  sync(marker)

  return { ok: marker.isConnected && ownIcon() !== null && ownIcon().getAttribute("href") === options.favicon }
}
