export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#24282F"/><path fill="#67D7A4" d="M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z"/></svg>`

export function pageOperation(input) {
  const storeKey = "__ycodingInteraction"
  if (input.origin !== location.origin || input.pathname !== location.pathname) return { refusal: "target_lost" }
  const control = globalThis[storeKey]
  if (input.operation === "markCheck") {
    const image = new Image()
    image.src = input.icon
    return image.decode().then(() => ({ available: image.naturalWidth > 0 }), () => ({ available: false }))
  }
  if (input.operation === "mark") {
    if (!document.head || control) return { refusal: "permission" }
    const link = document.createElement("link")
    link.rel = "icon"
    link.href = input.icon
    const store = { link, deadline: Date.now() + 8000, refs: new Map(), timer: 0, originals: new Set() }
    const hideIcons = () => {
      for (const icon of document.head.querySelectorAll('link[rel~="icon" i]')) {
        if (icon === store.link) continue
        if (store.originals.size >= 32) return false
        const value = icon.getAttribute("rel")
        icon.setAttribute("rel", "ycoding-held-icon")
        store.originals.add({ icon, value })
      }
      if (!store.link.isConnected) document.head.append(store.link)
      return true
    }
    const clear = () => {
      clearInterval(store.timer)
      store.link.remove()
      for (const { icon, value } of store.originals) {
        if (icon.isConnected && icon.getAttribute("rel") === "ycoding-held-icon") icon.setAttribute("rel", value)
      }
      delete globalThis[storeKey]
    }
    globalThis[storeKey] = store
    store.clear = clear
    store.hideIcons = hideIcons
    if (!hideIcons()) {
      clear()
      return { refusal: "permission" }
    }
    store.timer = setInterval(() => { if (Date.now() >= store.deadline) clear() }, 1000)
    return { marked: link.isConnected && link.getAttribute("href") === input.icon }
  }
  if (input.operation === "clear") {
    control?.preview?.observer.disconnect()
    control?.clear()
    return { cleared: true }
  }
  if (window.frames.length > 0 || document.querySelector("iframe,frame,fencedframe")) return { refusal: "target_lost" }
  if (input.operation === "scope") return { verified: true }
  if (input.operation === "verify") {
    if (!control || !control.link.isConnected || control.link.href !== input.icon || !control.hideIcons())
      return { refusal: "permission" }
    control.deadline = Date.now() + 8000
    return { marked: true }
  }
  if (!input.isolated && !control?.link.isConnected) return { refusal: "permission" }
  const state = control ?? (globalThis[storeKey] ??= { refs: new Map() })
  const randomID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  const selector = "button,a[href],input,textarea,select,summary,[role],[contenteditable]"
  const captcha = /captcha|turnstile|human[ _-]*(?:check|verification)|verify[ _-]*(?:you are|human)|challenge-platform/iu
  const sensitive = /pass(?:word|code|phrase)|one[ _-]*time|verification[ _-]*code|security[ _-]*code|card[ _-]*(?:number|no)|cvv|cvc|secret|\botp\b|\bpin\b/iu
  const attributes = (element) => ["id", "name", "title", "aria-label", "placeholder", "src", "autocomplete", "class"]
    .map((key) => element.getAttribute(key) ?? "").join(" ")
  const watched = [...document.querySelectorAll("iframe,frame,form,input,textarea,[contenteditable],[id],[class]")].slice(0, 4097)
  const hasCaptcha = watched.length > 4096 || watched.some((element) => captcha.test(attributes(element)))
  const editable = (element) => element.matches("textarea,input,[contenteditable]")
  const protectedField = (element) => {
    if (!element || !editable(element)) return false
    const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/)
    return element.matches('input[type="password" i],input[type="file" i],input[type="hidden" i]') ||
      autocomplete.some((part) => part.startsWith("cc-") || ["current-password", "new-password", "one-time-code"].includes(part)) ||
      sensitive.test(`${attributes(element)} ${Array.from(element.labels ?? [], (label) => label.textContent).join(" ")}`)
  }
  const isVisible = (element) => {
    if (!element.isConnected || element.ownerDocument !== document || element.closest("[inert],[hidden],[aria-hidden=true]")) return false
    const bounds = element.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
  const label = (element) => String(element.getAttribute("aria-label") || Array.from(element.labels ?? [], (item) => item.textContent).join(" ") ||
    element.getAttribute("title") || (editable(element) ? element.getAttribute("placeholder") : element.textContent) || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 256)
  const repeatedActivation = (element) => element.closest("[disabled],[aria-disabled=true]") || protectedField(element) ||
    captcha.test(attributes(element))
  if (input.operation === "sensitiveBoxes") {
    const boxes = []
    const personal = /^(?:email|username|tel(?:-.+)?|street-address|address-line\d|address-level\d|postal-code|bday(?:-.+)?|cc-.+|.+-password|one-time-code)$/u
    const patterns = input.patterns.map(({ source, flags }) => new RegExp(source, flags.includes("g") ? flags : `${flags}g`))
    const matches = (text) => patterns.some((pattern) => {
      pattern.lastIndex = 0
      return pattern.test(text)
    })
    const add = (rect) => {
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return
      boxes.push([Math.floor(rect.left) - 2, Math.floor(rect.top) - 2, Math.ceil(rect.width) + 4, Math.ceil(rect.height) + 4])
    }
    const roots = [document]
    for (let index = 0; index < roots.length; index++) {
      if (roots.length > 64) return { refusal: "sensitive" }
      for (const element of roots[index].querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot)
    }
    let visited = 0
    for (const root of roots) {
      for (const element of root.querySelectorAll("input,textarea,select,[contenteditable],[data-sensitive],[data-private]")) {
        if (++visited > 4096) return { refusal: "sensitive" }
        const tokens = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/)
        if (element.matches('[data-sensitive],[data-private],input[type="email" i],input[type="tel" i]') || protectedField(element) ||
          tokens.some((token) => personal.test(token)) || matches(String(element.value ?? ""))) add(element.getBoundingClientRect())
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++visited > 16384) return { refusal: "sensitive" }
        for (const pattern of patterns) {
          for (const match of node.data.matchAll(pattern)) {
            const range = document.createRange()
            range.setStart(node, match.index)
            range.setEnd(node, match.index + match[0].length)
            for (const rect of range.getClientRects()) add(rect)
          }
        }
      }
    }
    if (boxes.length > 1024) return { refusal: "sensitive" }
    return { boxes, width: innerWidth, height: innerHeight, title: document.title }
  }
  if (input.operation === "observe") {
    state.refs.clear()
    const elements = []
    if (hasCaptcha) return { elements }
    const maxObservationBytes = 240 * 1024
    const encoder = new TextEncoder()
    let encodedBytes = encoder.encode('{"elements":[]}').byteLength
    for (const element of [...document.querySelectorAll(selector)].slice(0, 4096)) {
      if (elements.length === 200) break
      if (!isVisible(element) || repeatedActivation(element)) continue
      const name = label(element)
      if (!name || sensitive.test(name) || captcha.test(name)) continue
      const id = randomID()
      const role = (element.getAttribute("role") || (editable(element) ? "textbox" : element.tagName.toLowerCase()))
        .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256)
      const row = { id, role, label: name, editable: editable(element) }
      encodedBytes += encoder.encode(JSON.stringify(row)).byteLength + Number(elements.length > 0)
      if (encodedBytes > maxObservationBytes) break
      state.refs.set(id, { element, name, role })
      elements.push(row)
    }
    return { elements }
  }
  if (input.operation === "preview") {
    const text = document.body?.innerText
    const privateText = /https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\d[ -]?){8,}|medical record|patient |social security|passport|account number|bank statement|api[ _-]*key|access[ _-]*token|authorization/iu
    const safe = !hasCaptcha && document.designMode === "off" && typeof text === "string" && text.length <= 8192 &&
      !privateText.test(text) && !sensitive.test(text) && !document.querySelector(
        'input,textarea,select,[contenteditable],[role~="textbox" i],[role~="searchbox" i],[role~="combobox" i],iframe,frame,fencedframe,portal,object,embed,canvas,video,img,svg',
      )
    if (input.ticket) {
      const preview = state.preview
      if (!preview || preview.ticket !== input.ticket) return { refusal: "stale" }
      const unchanged = !preview.changed && preview.observer.takeRecords().length === 0 && Date.now() < preview.expiresAt
      if (input.keep && safe && unchanged) return { safe: true }
      preview.observer.disconnect()
      clearTimeout(preview.timer)
      state.preview = undefined
      return { safe: safe && unchanged }
    }
    if (!safe) return { refusal: "sensitive" }
    state.preview?.observer.disconnect()
    clearTimeout(state.preview?.timer)
    const preview = { ticket: randomID(), changed: false, expiresAt: Date.now() + 2000 }
    preview.observer = new MutationObserver(() => { preview.changed = true })
    preview.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    preview.timer = setTimeout(() => {
      preview.observer.disconnect()
      if (state.preview === preview) state.preview = undefined
    }, 2000)
    state.preview = preview
    return { safe: true, ticket: preview.ticket }
  }
  if (hasCaptcha) return { refusal: "captcha" }
  if (input.operation === "scroll") {
    window.scrollBy({ top: input.deltaY, behavior: "instant" })
    state.refs.clear()
    return { applied: true }
  }
  const ref = state.refs.get(input.elementID)
  const element = ref?.element
  if (!element || !isVisible(element) || label(element) !== ref.name) return { refusal: "stale" }
  if (protectedField(element)) return { refusal: "sensitive" }
  if (repeatedActivation(element)) return { refusal: "policy" }
  if (input.operation === "click") {
    const link = element.closest("a[href]")
    if (!element.matches("button,a[href],summary,input[type=checkbox],input[type=radio],[role=button],[role=checkbox],[role=radio],[role=option]"))
      return { refusal: "unsupported" }
    if (link && (link.hasAttribute("download") || (link.target && link.target !== "_self") ||
      new URL(link.href).href !== location.href)) return { refusal: "policy" }
    if (!input.destructive && ((element instanceof HTMLButtonElement && element.type === "submit" && element.form) ||
      (element instanceof HTMLInputElement && element.form))) return { refusal: "confirmation_required" }
    state.refs.clear()
    HTMLElement.prototype.click.call(element)
    return { applied: true }
  }
  if (input.operation !== "fill" || !element.matches('input:not([type]),input[type="text" i],input[type="search" i],textarea') ||
    element.readOnly || element.disabled) return { refusal: "unsupported" }
  if (![element, document.body, document.documentElement].includes(document.activeElement)) return { refusal: "sensitive" }
  const field = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  if (Object.getOwnPropertyDescriptor(field, "value")?.set === undefined) return { refusal: "unsupported" }
  state.refs.clear()
  if (!Reflect.set(field, "value", input.text, element)) return { refusal: "unsupported" }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText" }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
  return { applied: true }
}

export function safeTree(root) {
  if (root?.nodeType !== 9 || root.nodeName !== "#document" || !Array.isArray(root.children) || !root.children.length) return false
  const pending = [root]
  let visited = 0
  while (pending.length) {
    const node = pending.pop()
    if (!node || ++visited > 4096 || typeof node.nodeName !== "string" || ![1, 3, 7, 8, 9, 10].includes(node.nodeType) ||
      (node.shadowRoots !== undefined && (!Array.isArray(node.shadowRoots) || node.shadowRoots.length !== 0)) ||
      node.contentDocument !== undefined || node.frameId !== undefined ||
      /^(INPUT|TEXTAREA|SELECT|IFRAME|FRAME|FENCEDFRAME|PORTAL|OBJECT|EMBED|CANVAS|VIDEO|IMG|SVG)$/i.test(node.nodeName) ||
      (node.attributes !== undefined && (!Array.isArray(node.attributes) || node.attributes.length % 2 !== 0 ||
        node.attributes.some((attribute) => typeof attribute !== "string"))) ||
      node.attributes?.some((attribute, index) => index % 2 === 0 && (attribute === "contenteditable" ||
        (attribute === "role" && /(?:^|\s)(?:textbox|searchbox|combobox)(?:\s|$)/i.test(node.attributes[index + 1])))) ||
      (node.children !== undefined && !Array.isArray(node.children)) ||
      ([1, 9].includes(node.nodeType) && node.childNodeCount !== (node.children?.length ?? 0)) ||
      visited + pending.length + (node.children?.length ?? 0) > 4096) return false
    if (node.children) pending.push(...node.children)
  }
  return true
}

const maxPreviewBytes = 160 * 1024
const maxPreviewBase64 = 4 * Math.ceil(maxPreviewBytes / 3)

export function withinPreviewSize(width, height) {
  return Number.isSafeInteger(width) && width > 0 && width <= 960 && Number.isSafeInteger(height) && height > 0 && height <= 720
}

export function previewFrame(mimeType, base64) {
  if (typeof base64 !== "string" || base64.length < 8 || base64.length > maxPreviewBase64 || base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  if (base64.length * 3 / 4 - padding > maxPreviewBytes) return undefined
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return undefined
  const data = atob(base64)
  const dimensions = mimeType === "image/png" ? pngSize(data) : jpegSize(data)
  if (!dimensions || !withinPreviewSize(dimensions.width, dimensions.height)) return undefined
  return { mimeType, base64, ...dimensions }
}

function pngSize(data) {
  if (data.length < 45 || !data.startsWith("\x89PNG\r\n\x1a\n\0\0\0\rIHDR") || data.slice(-8, -4) !== "IEND") return undefined
  const uint32 = (at) => data.charCodeAt(at) * 0x1000000 + data.charCodeAt(at + 1) * 0x10000 +
    data.charCodeAt(at + 2) * 0x100 + data.charCodeAt(at + 3)
  return { width: uint32(16), height: uint32(20) }
}

function jpegSize(data) {
  if (!data.startsWith("\xff\xd8") || !data.endsWith("\xff\xd9")) return undefined
  const uint16 = (at) => data.charCodeAt(at) * 256 + data.charCodeAt(at + 1)
  for (let start = 2; start + 4 < data.length;) {
    if (data.charCodeAt(start++) !== 0xff) return undefined
    while (data.charCodeAt(start) === 0xff) start++
    const marker = data.charCodeAt(start++)
    const length = uint16(start)
    if (!Number.isInteger(length) || length < 2 || start + length >= data.length || marker === 0xda) return undefined
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return undefined
      return { width: uint16(start + 5), height: uint16(start + 3) }
    }
    start += length
  }
  return undefined
}
