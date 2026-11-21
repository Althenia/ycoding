import { ChromeFault, pageURL } from "./controller.js"
import { MARK, pageOperation, previewFrame, safeTree, withinPreviewSize } from "./page.js"
import { redactionPatterns } from "./redact.js"
import { discardWorlds, runScript as executeScript } from "./script.js"

const icon = `data:image/svg+xml,${encodeURIComponent(MARK)}`
const groupTitle = "YCoding control"
const groupColor = "green"
const badgeBackground = "#28753E"
const noGroup = -1
const activeIcon = { 16: "icons/active-16.png", 32: "icons/active-32.png" }
const idleIcon = { 16: "icons/idle-16.png", 32: "icons/idle-32.png" }
const maxFrameBytes = 160 * 1024
const storedGroups = "controlGroups"
export const scriptMethods = new Set(["Runtime.enable", "Runtime.disable", "Runtime.evaluate", "Runtime.callFunctionOn",
  "Runtime.releaseObjectGroup", "Runtime.terminateExecution", "Page.getFrameTree", "Page.createIsolatedWorld",
  "Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument"])
const previewTransitions = new Set(["Page.frameAttached", "Page.frameDetached", "Page.frameSubtreeWillBeDetached",
  "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.documentOpened", "Page.frameStartedLoading",
  "Page.frameStartedNavigating", "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened",
  "DOM.documentUpdated"])

function matchesPage(raw, target) {
  const url = pageURL(raw)
  return !!url && url.origin === target.origin && url.pathname === target.pathname
}

function matchesFrame(frame, target) {
  return !!frame && frame.securityOrigin === target.origin && frame.unreachableUrl === undefined && matchesPage(frame.url, target)
}

function matchesDocument(frame, target) {
  return frame?.id === target.frame && frame?.loaderId === target.document && matchesFrame(frame, target)
}

function networkURL(raw) {
  const url = pageURL(raw)
  if (!url) return undefined
  url.hash = ""
  return url.href
}

export async function composeFrame(base64, boxes, viewport) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
  const ratio = bitmap.width / viewport.width
  const scale = Math.min(1, 960 / bitmap.width, 720 / bitmap.height)
  const width = Math.max(1, Math.floor(bitmap.width * scale))
  const height = Math.max(1, Math.floor(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  context.fillStyle = "#000000"
  const unit = ratio * scale
  for (const [x, y, w, h] of boxes) context.fillRect(Math.floor(x * unit), Math.floor(y * unit), Math.ceil(w * unit), Math.ceil(h * unit))
  for (const quality of [0.8, 0.6, 0.45, 0.3]) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality })
    if (blob.size > maxFrameBytes) continue
    const data = new Uint8Array(await blob.arrayBuffer())
    const text = Array.from({ length: Math.ceil(data.length / 32768) }, (_, index) =>
      String.fromCharCode(...data.subarray(index * 32768, (index + 1) * 32768))).join("")
    return previewFrame("image/jpeg", btoa(text))
  }
  return undefined
}

export function createChromeKernel(api, { compose = composeFrame, runScript = executeScript } = {}) {
  const attached = new Map()
  const worlds = new Map()
  const creating = new Set()
  const grouping = new Set()
  const controlGroups = new Map()
  const session = (tabId) => ({ tabId })

  async function step(fence, body) {
    fence()
    const value = await body()
    fence()
    return value
  }

  const command = (target, fence, method, params = {}) => step(fence, () => api.debugger.sendCommand(session(target.tabId), method, params))
  const mainFrame = async (target, fence) => {
    const tree = (await command(target, fence, "Page.getFrameTree")).frameTree
    if (!tree || (tree.childFrames !== undefined && (!Array.isArray(tree.childFrames) || tree.childFrames.length !== 0))) return undefined
    return tree.frame?.parentId === undefined ? tree.frame : undefined
  }

  async function run(target, fence, input) {
    const result = await command(target, fence, "Runtime.callFunctionOn", {
      executionContextId: target.context,
      functionDeclaration: pageOperation.toString(),
      returnByValue: true,
      awaitPromise: true,
      arguments: [{ value: { ...input, origin: target.origin, pathname: target.pathname, icon } }],
    })
    if (result.exceptionDetails || !result.result?.value) throw new ChromeFault("target_lost")
    return result.result.value
  }

  async function controlGroup(windowId, fence) {
    const id = controlGroups.get(windowId)
    if (id === undefined) return undefined
    const group = await step(fence, () => api.tabGroups.get(id)).catch(() => undefined)
    if (group?.id === id && group.windowId === windowId && group.title === groupTitle && group.color === groupColor && !group.collapsed) return id
    dropGroup(windowId)
    return undefined
  }

  function remember() {
    void api.storage?.local.set({ [storedGroups]: [...controlGroups] }).catch(() => {})
  }

  function setGroup(windowId, id) {
    controlGroups.set(windowId, id)
    remember()
  }

  function dropGroup(windowId) {
    if (controlGroups.delete(windowId)) remember()
  }

  async function recover() {
    const stored = (await api.storage?.local.get(storedGroups).catch(() => undefined))?.[storedGroups]
    if (!Array.isArray(stored)) return
    await Promise.allSettled(stored.slice(0, 64).map(async ([windowId, id]) => {
      if (attached.size || controlGroups.has(windowId)) return
      const group = await api.tabGroups.get(id)
      if (group.windowId !== windowId || group.title !== groupTitle || group.color !== groupColor) return
      const members = await api.tabs.query({ groupId: id })
      if (members.length) await api.tabs.ungroup(members.map((member) => member.id))
    }))
    if (!attached.size) await api.storage.local.remove(storedGroups).catch(() => {})
  }

  async function snapshot(tab, fence) {
    if (tab.groupId === noGroup) return undefined
    if (await controlGroup(tab.windowId, fence) === tab.groupId) return { id: tab.groupId }
    throw new ChromeFault("permission")
  }

  async function windowState(tab, fence) {
    const members = await step(fence, () => api.tabs.query({ windowId: tab.windowId }))
    if (members.length > 256 || !members.some((member) => member.id === tab.id) ||
      members.some((member) => member.windowId !== tab.windowId)) throw new ChromeFault("stale")
    return members.filter((member) => member.id !== tab.id).toSorted((first, second) => first.index - second.index)
      .map((member) => [member.id, member.groupId, member.active, member.pinned])
  }

  async function joinGroup(tab, target, fence) {
    if (tab.groupId !== noGroup) throw new ChromeFault("permission")
    const before = await windowState(tab, fence)
    const exact = await step(fence, () => api.tabs.get(tab.id))
    if (exact.windowId !== tab.windowId || exact.groupId !== noGroup || (!target.owned && exact.url !== tab.url) || exact.index !== tab.index || exact.pinned ||
      exact.active !== tab.active) throw new ChromeFault("stale")
    const existing = await controlGroup(tab.windowId, fence)
    const id = await step(fence, () => api.tabs.group(existing === undefined ?
      { tabIds: [tab.id], createProperties: { windowId: tab.windowId } } : { groupId: existing, tabIds: [tab.id] }))
    target.group = id
    target.grouped = true
    if (existing === undefined) await step(fence, () => api.tabGroups.update(id, { title: groupTitle, color: groupColor, collapsed: false }))
    const grouped = await step(fence, () => api.tabs.get(tab.id))
    const group = await step(fence, () => api.tabGroups.get(id))
    if (grouped.windowId !== tab.windowId || grouped.active !== tab.active || grouped.groupId !== id || grouped.pinned ||
      (!target.owned && grouped.url !== tab.url)) throw new ChromeFault("stale")
    if (group.title !== groupTitle || group.color !== groupColor || group.collapsed || group.windowId !== tab.windowId)
      throw new ChromeFault("permission")
    if (JSON.stringify(before) !== JSON.stringify(await windowState(tab, fence))) throw new ChromeFault("stale")
    setGroup(tab.windowId, id)
  }

  async function settleDocument(target, fence) {
    const frame = await mainFrame(target, fence)
    if (!frame?.id || !frame.loaderId || !matchesFrame(frame, target)) throw new ChromeFault("target_lost")
    const world = await command(target, fence, "Page.createIsolatedWorld", { frameId: frame.id, worldName: "ycoding-interaction" })
    if (!Number.isSafeInteger(world.executionContextId)) throw new ChromeFault("target_lost")
    target.frame = frame.id
    target.document = frame.loaderId
    target.context = world.executionContextId
    if (!(await run(target, fence, { operation: "markCheck" })).available) throw new ChromeFault("permission")
    const marker = await run(target, fence, { operation: "mark" })
    if (!marker.marked) throw new ChromeFault("permission")
    const badge = { tabId: target.tabId }
    await step(fence, () => api.action.setBadgeBackgroundColor({ ...badge, color: badgeBackground }))
    await step(fence, () => api.action.setBadgeText({ ...badge, text: "ON" }))
    if (await step(fence, () => api.action.getBadgeText(badge)) !== "ON") throw new ChromeFault("permission")
    await step(fence, () => api.action.setIcon({ ...badge, path: activeIcon }))
  }

  async function verify(target, fence) {
    if (target.nativeDetached || target.documentChanged || attached.get(target.tabId) !== target ||
      target.group === undefined || controlGroups.get(target.windowId) !== target.group) return false
    const tab = await step(fence, () => api.tabs.get(target.tabId))
    if (tab.windowId !== target.windowId || tab.pinned || tab.discarded || tab.incognito || tab.pendingUrl ||
      !matchesPage(tab.url, target) || tab.groupId !== target.group || await controlGroup(target.windowId, fence) !== target.group) return false
    const frame = await mainFrame(target, fence)
    if (!matchesDocument(frame, target)) return false
    const mark = await run(target, fence, { operation: "verify" })
    if (!mark.marked) return false
    return await step(fence, () => api.action.getBadgeText({ tabId: target.tabId })) === "ON" && !target.documentChanged && !target.nativeDetached
  }

  async function detach(target, reason) {
    if (target.closing) return target.closing
    if (attached.get(target.tabId) === target) attached.delete(target.tabId)
    clearInterval(target.markerTimer)
    target.loading?.reject(new ChromeFault("stopped"))
    const running = target.running
    running?.stop()
    target.closing = (async () => {
      if (running && target.debuggerAttached && !target.nativeDetached)
        await api.debugger.sendCommand(session(target.tabId), "Runtime.terminateExecution").catch(() => {})
      if (target.runLease !== undefined) discardWorlds(worlds, target.runLease)
      const settled = await Promise.allSettled([
        api.action.setBadgeText({ tabId: target.tabId, text: "" }),
        api.action.setIcon({ tabId: target.tabId, path: idleIcon }),
        target.context && !target.nativeDetached ? run(target, () => {}, { operation: "clear" }) : undefined,
      ])
      const detachment = target.nativeDetached || !target.debuggerAttached ? [] :
        await Promise.allSettled([api.debugger.detach(session(target.tabId))])
      const tab = await api.tabs.get(target.tabId).catch(() => undefined)
      const ours = tab && !tab.pinned && tab.windowId === target.windowId && target.grouped && tab.groupId === target.group &&
        await controlGroup(target.windowId, () => {}) === target.group
      const removable = target.owned && reason !== "cancelled" && !target.nativeDetached && tab && !tab.active && !tab.pinned &&
        tab.windowId === target.windowId && (ours || tab.groupId === noGroup)
      const release = await Promise.allSettled([removable ? api.tabs.remove(target.tabId) : ours ? api.tabs.ungroup(target.tabId) : undefined])
      const released = release[0].status === "fulfilled"
      if (released && target.group !== undefined && ![...attached.values()].some((other) => other.group === target.group))
        if (controlGroups.get(target.windowId) === target.group) dropGroup(target.windowId)
      if ([...settled, ...detachment, ...release].some((result) => result.status === "rejected") && reason !== "cancelled")
        throw new ChromeFault("cleanup")
    })()
    return target.closing
  }

  async function navigate(target, url, fence, dispatched = () => {}) {
    const loaded = Promise.withResolvers()
    const frame = await mainFrame(target, fence)
    if (!frame?.id || target.documentChanged || (target.frame !== undefined && !matchesDocument(frame, target)))
      throw new ChromeFault("target_lost")
    const loading = { resolve: loaded.resolve, reject: loaded.reject, frames: new Set(), loader: undefined, frame: frame.id, fence }
    target.loading = loading
    void loaded.promise.catch(() => {})
    const timer = setTimeout(() => loading.reject(new ChromeFault("target_lost")), 6000)
    try {
      await command(target, fence, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] })
      const current = await mainFrame(target, fence)
      if (current?.id !== frame.id || current.loaderId !== frame.loaderId || current.url !== frame.url || current.urlFragment !== frame.urlFragment ||
        current.securityOrigin !== frame.securityOrigin)
        throw new ChromeFault("target_lost")
      fence()
      dispatched()
      const start = await command(target, fence, "Page.navigate", { url })
      if (start.errorText || !start.loaderId || start.isDownload) throw new ChromeFault("policy")
      loading.loader = start.loaderId
      if (!loading.frames.has(start.loaderId)) await step(fence, () => loaded.promise)
      const landed = await mainFrame(target, fence)
      if (landed?.loaderId !== start.loaderId || !matchesFrame(landed, target) || networkURL(landed.url) !== networkURL(target.url))
        throw new ChromeFault("target_lost")
      await command(target, fence, "Fetch.disable")
    } finally {
      clearTimeout(timer)
      target.loading = undefined
    }
  }

  return {
    recover,
    list: async () => (await api.tabs.query({})).slice(0, 64),
    tab: (id) => api.tabs.get(id),
    snapshot,
    async attach(original, scope, fence) {
      const owned = original === undefined
      if (owned && !pageURL(scope.url)) throw new ChromeFault("policy")
      if (owned ? scope.grouping !== "create" : scope.grouping !== "move" && scope.grouping !== "already")
        throw new ChromeFault("consent")
      let target
      const stillAttached = () => {
        fence()
        if (target?.nativeDetached) throw new ChromeFault("stopped")
      }
      try {
        fence()
        const tab = original ?? await api.tabs.create({ active: false, windowId: scope.windowId, url: "about:blank" })
        const url = pageURL(owned ? scope.url : tab.url)
        target = { tabId: tab.id, windowId: tab.windowId, owned, origin: url?.origin, pathname: url?.pathname, url: url?.href, previewEpoch: 0 }
        if (owned) creating.add(tab.id)
        grouping.add(tab.id)
        fence()
        if (!Number.isSafeInteger(tab.id) || tab.windowId !== scope.windowId || !target.origin || tab.pinned || tab.incognito ||
          tab.discarded || owned && (tab.active || tab.url !== "about:blank" && tab.pendingUrl !== "about:blank"))
          throw new ChromeFault("stale")
        const current = await step(fence, () => api.tabs.get(tab.id))
        if (current.windowId !== tab.windowId || current.groupId !== tab.groupId || current.pinned || current.incognito ||
          !owned && (current.url !== tab.url || current.pendingUrl) || owned && current.active) throw new ChromeFault("stale")
        if (scope.grouping === "already") {
          const group = await snapshot(current, fence)
          if (!group || group.id !== scope.group?.id) throw new ChromeFault("stale")
          target.group = group.id
          target.grouped = true
        } else {
          await joinGroup(current, target, fence)
        }
        attached.set(tab.id, target)
        fence()
        await api.debugger.attach(session(tab.id), "1.3")
        target.debuggerAttached = true
        stillAttached()
        await command(target, stillAttached, "Page.enable")
        if (owned) {
          await command(target, stillAttached, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
          await command(target, stillAttached, "Page.setLifecycleEventsEnabled", { enabled: true })
          await navigate(target, scope.url, stillAttached)
        }
        await settleDocument(target, stillAttached)
        stillAttached()
        if (!await verify(target, stillAttached)) throw new ChromeFault("permission")
        return target
      } catch (cause) {
        if (target && Number.isSafeInteger(target.tabId)) await detach(target, "stopped").catch(() => {})
        throw cause
      } finally {
        if (target) {
          creating.delete(target.tabId)
          grouping.delete(target.tabId)
        }
      }
    },
    maintain(target, fence, invalidated) {
      let running = false
      target.markerTimer = setInterval(() => {
        if (running || target.navigating || target.held) return
        running = true
        const lost = () => { if (!target.held) invalidated() }
        void verify(target, fence).then((valid) => { if (!valid) lost() }, lost).finally(() => { running = false })
      }, 2500)
    },
    verify,
    async observe(target, fence) {
      if (!matchesDocument(await mainFrame(target, fence), target) || target.documentChanged || target.nativeDetached)
        throw new ChromeFault("target_lost")
      const result = await run(target, fence, { operation: "observe" })
      if (!Array.isArray(result.elements)) throw new ChromeFault(result.refusal ?? "target_lost")
      if (!await verify(target, fence)) throw new ChromeFault("target_lost")
      return { elements: result.elements, pathname: target.pathname }
    },
    async perform(target, action, fence, dispatched) {
      if (action.type === "navigate") {
        const url = pageURL(action.url)
        if (!url || url.href !== target.url) return { refusal: "policy" }
        target.navigating = true
        try {
          await command(target, fence, "Page.setLifecycleEventsEnabled", { enabled: true })
          await navigate(target, url.href, fence, dispatched)
          await settleDocument(target, fence)
          fence()
          if (!await verify(target, fence)) throw new ChromeFault("target_lost")
          return {}
        } finally {
          target.navigating = false
        }
      }
      const intercept = !target.owned && (action.type === "click" || action.type === "fill")
      const first = target.chooserEvents ?? 0
      const handoff = Promise.withResolvers()
      if (intercept) await command(target, fence, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
      target.handoff = handoff.resolve
      let paused
      try {
        fence()
        if (target.documentChanged || target.nativeDetached) throw new ChromeFault("target_lost")
        dispatched()
        const running = run(target, fence, { ...action, operation: action.type })
        void running.catch(() => {})
        const settled = await Promise.race([running.then((value) => ({ value })), handoff.promise.then((reason) => ({ reason }))])
        paused = settled.reason ?? ((target.chooserEvents ?? 0) !== first ? "file_chooser" : undefined)
        if (paused) return { paused }
        if (settled.value.refusal) return { refusal: settled.value.refusal }
        if (!settled.value.applied || !await verify(target, fence)) throw new ChromeFault("target_lost")
        return {}
      } finally {
        target.handoff = undefined
        const restore = intercept ? command(target, () => {}, "Page.setInterceptFileChooserDialog", { enabled: false }) : undefined
        if (paused) void restore?.catch(() => {})
        else await restore
      }
    },
    async run(target, request, fence) {
      fence()
      if (target.closing || target.documentChanged || target.nativeDetached) throw new ChromeFault("target_lost")
      if (target.dialogOpen) return { outcome: "paused", reason: "dialog" }
      const tabs = await step(fence, () => api.tabs.query({}))
      if (!tabs.some((tab) => tab.id === target.tabId)) throw new ChromeFault("target_lost")
      if (tabs.some((tab) => tab.id === target.tabId ? tab.openerTabId !== undefined : tab.openerTabId === target.tabId))
        return { outcome: "refused", reason: "policy" }
      if (target.closing) throw new ChromeFault("target_lost")
      const attachedOnly = () => { if (target.nativeDetached) throw new ChromeFault("target_lost") }
      const cdp = {
        send(tabId, method, params) {
          if (tabId !== target.tabId) return Promise.reject(new ChromeFault("ownership"))
          if (!scriptMethods.has(method)) return Promise.reject(new ChromeFault("policy"))
          return command(target, attachedOnly, method, params)
        },
        onEvent(tabId, listener) {
          if (tabId !== target.tabId) return () => {}
          target.listeners ??= new Set()
          target.listeners.add(listener)
          return () => target.listeners.delete(listener)
        },
      }
      const stopped = Promise.withResolvers()
      target.running = { stop: () => stopped.resolve(undefined) }
      target.runLease = request.leaseID
      try {
        const result = await Promise.race([runScript({ tabId: target.tabId, leaseID: request.leaseID, mode: request.mode, source: request.source,
          timeoutMs: request.timeoutMs, signal: request.signal }, cdp, worlds), stopped.promise])
        if (!result) return { result: { outcome: "stopped", logs: [] }, verified: false }
        if (result.outcome === "paused") return result
        return { result, verified: await verify(target, () => {}).catch(() => false) }
      } finally {
        target.running = undefined
      }
    },
    async resume(target, fence) {
      if (target.dialogOpen || target.nativeDetached) throw new ChromeFault("busy")
      if (target.interceptReleased) {
        await command(target, fence, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
        target.interceptReleased = false
      }
      if (await verify(target, fence)) return
      await settleDocument(target, fence)
      if (!await verify(target, fence)) throw new ChromeFault("target_lost")
    },
    async capture(target, fence) {
      if (target.dialogOpen || target.navigating || target.nativeDetached) throw new ChromeFault("busy")
      if (!await verify(target, fence)) throw new ChromeFault("target_lost")
      const before = await run(target, fence, { operation: "sensitiveBoxes", patterns: redactionPatterns })
      if (!Array.isArray(before.boxes)) throw new ChromeFault(before.refusal ?? "sensitive")
      const image = await command(target, fence, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false })
      const after = await run(target, fence, { operation: "sensitiveBoxes", patterns: redactionPatterns })
      if (!Array.isArray(after.boxes) || after.width !== before.width || after.height !== before.height || typeof image?.data !== "string")
        throw new ChromeFault("stale")
      if (!await verify(target, fence)) throw new ChromeFault("target_lost")
      const frame = await compose(image.data, [...before.boxes, ...after.boxes], { width: before.width, height: before.height })
      if (!frame) throw new ChromeFault("sensitive")
      const tab = await step(fence, () => api.tabs.get(target.tabId))
      return { frame, title: typeof tab.title === "string" ? tab.title : undefined, url: typeof tab.url === "string" ? tab.url : undefined }
    },
    async preview(target, fence) {
      const withheld = { status: "withheld" }
      const epoch = target.previewEpoch
      const { frame: frameID, document: documentID, context } = target
      const current = () => attached.get(target.tabId) === target && !target.nativeDetached && !target.navigating &&
        !target.dialogOpen && (target.owned || !target.chooserEvents) && epoch === target.previewEpoch &&
        frameID === target.frame && documentID === target.document && context === target.context
      const bound = async () => current() && await verify(target, fence) && current()
      const safe = async () => current() && safeTree((await command(target, fence, "DOM.getDocument", { depth: 32, pierce: true })).root) && current()
      if (!await bound()) return withheld
      const before = await run(target, fence, { operation: "preview" })
      if (before.safe !== true || typeof before.ticket !== "string" || !await safe()) return withheld
      const viewport = (await command(target, fence, "Page.getLayoutMetrics")).cssVisualViewport
      const { clientWidth: width, clientHeight: height, pageX: x, pageY: y } = viewport ?? {}
      if (!withinPreviewSize(width, height) || ![x, y].every(Number.isFinite) || !await bound() ||
        (await run(target, fence, { operation: "preview", ticket: before.ticket, keep: true })).safe !== true || !current()) return withheld
      const image = await command(target, fence, "Page.captureScreenshot", { format: "jpeg", quality: 65, fromSurface: true,
        captureBeyondViewport: false, clip: { x, y, width, height, scale: 1 } })
      if (!await bound() || !await safe() ||
        (await run(target, fence, { operation: "preview", ticket: before.ticket })).safe !== true || !current()) return withheld
      const frame = previewFrame("image/jpeg", image.data)
      return frame ? { status: "ready", frame } : withheld
    },
    detach,
    ownedChange: (id) => creating.has(id) || attached.get(id)?.navigating === true,
    groupingChange: (id, groupId) => grouping.has(id) || groupId !== undefined && attached.get(id)?.group === groupId,
    controlled: (id) => attached.has(id),
    forgetGroup(id) {
      for (const [windowId, groupId] of controlGroups) if (groupId === id) dropGroup(windowId)
    },
    foreignMember(groupId, id) {
      if (grouping.has(id) || attached.get(id)?.group === groupId || ![...controlGroups.values()].includes(groupId)) return false
      for (const [windowId, owned] of controlGroups) if (owned === groupId) dropGroup(windowId)
      return true
    },
    targetsInGroup: (id) => [...attached.values()].filter((target) => target.group === id).map((target) => target.tabId),
    nativeDetached(id) {
      const target = attached.get(id)
      if (target) target.nativeDetached = true
    },
    nativeEvent(source, method, params) {
      if (source?.sessionId !== undefined || source?.targetId !== undefined) return
      const target = attached.get(source?.tabId)
      for (const listener of target?.listeners ?? []) listener(method, params)
      if (target && previewTransitions.has(method)) target.previewEpoch++
      if (target?.frame && !target.navigating &&
        ((method === "Page.frameNavigated" || method === "Page.documentOpened") && params.frame?.id === target.frame ||
          method === "Page.navigatedWithinDocument" && params.frameId === target.frame)) target.documentChanged = true
      if (target && method === "Page.javascriptDialogOpening") {
        target.dialogOpen = true
        target.handoff?.("dialog")
        target.onPause?.("dialog")
      }
      if (target && method === "Page.javascriptDialogClosed") target.dialogOpen = false
      if (target && method === "Page.fileChooserOpened") {
        target.chooserEvents = (target.chooserEvents ?? 0) + 1
        target.handoff?.("file_chooser")
        target.onPause?.("file_chooser")
        if (target.owned && !target.interceptReleased) {
          target.interceptReleased = true
          void command(target, () => {}, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {})
        }
      }
      const loading = target?.loading
      if (!loading) return
      if (method === "Fetch.requestPaused" && typeof params.requestId === "string") {
        const requestId = params.requestId
        const approved = params.frameId === loading.frame && params.redirectedRequestId === undefined &&
          networkURL(params.request?.url) === networkURL(target.url)
        const respond = approved ? command(target, loading.fence, "Fetch.continueRequest", { requestId }) :
          command(target, loading.fence, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        void respond.then(() => { if (!approved) loading.reject(new ChromeFault("policy")) }, loading.reject)
        return
      }
      if (method !== "Page.lifecycleEvent" || params.name !== "DOMContentLoaded" || typeof params.loaderId !== "string") return
      if (loading.frames.size < 64) loading.frames.add(params.loaderId)
      if (loading.loader === params.loaderId) loading.resolve()
    },
  }
}
