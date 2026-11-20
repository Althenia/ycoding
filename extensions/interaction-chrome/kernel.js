import { ChromeFault, pageURL } from "./controller.js"
import { MARK, pageOperation, previewFrame, safeTree, withinPreviewSize } from "./page.js"

const icon = `data:image/svg+xml,${encodeURIComponent(MARK)}`
const groupTitle = "YCoding control"
const groupColor = "green"
const badgeBackground = "#28753E"
const noGroup = -1
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

export function createChromeKernel(api) {
  const attached = new Map()
  const creating = new Set()
  const grouping = new Set()
  const ownedGroups = new Map()
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

  async function groupState(tab, fence) {
    if (tab.groupId === noGroup) return undefined
    const group = await step(fence, () => api.tabGroups.get(tab.groupId))
    const members = await step(fence, () => api.tabs.query({ groupId: tab.groupId }))
    if (group.id !== tab.groupId || group.windowId !== tab.windowId || !members.some((member) => member.id === tab.id) || members.length > 64 ||
      members.some((member) => member.windowId !== tab.windowId)) throw new ChromeFault("stale")
    return { id: group.id, windowId: group.windowId, title: group.title, color: group.color, collapsed: group.collapsed,
      members: members.toSorted((first, second) => first.index - second.index).map((member) => [member.id, member.index]) }
  }

  async function sameGroup(tab, target, fence) {
    const group = await groupState(tab, fence)
    return !!group && JSON.stringify(group) === JSON.stringify(target.group)
  }

  async function snapshot(tab, fence) {
    const group = await groupState(tab, fence)
    if (!group) return undefined
    const known = ownedGroups.get(group.id)
    if (group.title !== groupTitle || group.color !== groupColor || group.collapsed || group.members.length !== 1 ||
      JSON.stringify(known) !== JSON.stringify(group)) throw new ChromeFault("permission")
    return known
  }

  async function windowState(tab, fence) {
    const members = await step(fence, () => api.tabs.query({ windowId: tab.windowId }))
    if (members.length > 256 || !members.some((member) => member.id === tab.id) ||
      members.some((member) => member.windowId !== tab.windowId)) throw new ChromeFault("stale")
    return members.filter((member) => member.id !== tab.id).toSorted((first, second) => first.index - second.index)
      .map((member) => [member.id, member.groupId, member.active, member.pinned])
  }

  async function groupTab(tab, target, fence) {
    if (tab.groupId !== noGroup || ownedGroups.size >= 128) throw new ChromeFault("permission")
    const before = await windowState(tab, fence)
    const exact = await step(fence, () => api.tabs.get(tab.id))
    if (exact.windowId !== tab.windowId || exact.groupId !== noGroup || exact.url !== tab.url || exact.index !== tab.index || exact.pinned ||
      exact.active !== tab.active) throw new ChromeFault("stale")
    grouping.add(tab.id)
    try {
      const id = await step(fence, () => api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } }))
      const grouped = await step(fence, () => api.tabs.get(tab.id))
      if (grouped.windowId !== tab.windowId || grouped.active !== tab.active || grouped.groupId !== id || grouped.pinned ||
        grouped.url !== tab.url) throw new ChromeFault("stale")
      const state = await groupState(grouped, fence)
      if (state?.members.length !== 1 || JSON.stringify(before) !== JSON.stringify(await windowState(tab, fence)))
        throw new ChromeFault("stale")
      target.group = state
      target.createdGroup = true
      const unchanged = await groupState(grouped, fence)
      if (JSON.stringify(unchanged) !== JSON.stringify(state)) throw new ChromeFault("stale")
      await step(fence, () => api.tabGroups.update(id, { title: groupTitle, color: groupColor, collapsed: false }))
      const marked = await groupState(grouped, fence)
      if (marked?.title !== groupTitle || marked.color !== groupColor || marked.collapsed || marked.members.length !== 1 ||
        JSON.stringify(marked.members) !== JSON.stringify(state.members)) throw new ChromeFault("permission")
      target.group = marked
      target.groupPublished = true
      ownedGroups.set(id, marked)
      if (JSON.stringify(before) !== JSON.stringify(await windowState(tab, fence))) throw new ChromeFault("stale")
    } finally {
      grouping.delete(tab.id)
    }
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
  }

  async function verify(target, fence) {
    if (target.nativeDetached || target.documentChanged || attached.get(target.tabId) !== target || ownedGroups.get(target.group?.id) !== target.group) return false
    const tab = await step(fence, () => api.tabs.get(target.tabId))
    if (tab.windowId !== target.windowId || tab.pinned || tab.discarded || tab.incognito || tab.pendingUrl ||
      !matchesPage(tab.url, target) || !await sameGroup(tab, target, fence)) return false
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
    target.closing = (async () => {
      const settled = await Promise.allSettled([
        api.action.setBadgeText({ tabId: target.tabId, text: "" }),
        target.context && !target.nativeDetached ? run(target, () => {}, { operation: "clear" }) : undefined,
      ])
      const detachment = target.nativeDetached || !target.debuggerAttached ? [] :
        await Promise.allSettled([api.debugger.detach(session(target.tabId))])
      if ((target.owned && reason !== "cancelled" && !target.nativeDetached) || (!target.owned && target.createdGroup)) {
        const tab = await api.tabs.get(target.tabId).catch(() => undefined)
        if (tab && (!tab.active || !target.owned) && !tab.pinned && tab.windowId === target.windowId &&
          (!target.groupPublished || ownedGroups.get(target.group?.id) === target.group) &&
          (target.group ? await sameGroup(tab, target, () => {}).catch(() => false) : tab.groupId === noGroup)) {
          const current = await api.tabs.get(target.tabId).catch(() => undefined)
          if (current && (!current.active || !target.owned) && !current.pinned && current.windowId === tab.windowId &&
            current.groupId === tab.groupId && current.index === tab.index) {
            if (target.owned) await api.tabs.remove(target.tabId)
            else await api.tabs.ungroup(target.tabId)
            if (target.group) ownedGroups.delete(target.group.id)
          }
        }
      }
      if ([...settled, ...detachment].some((result) => result.status === "rejected") && reason !== "cancelled")
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
        fence()
        if (!Number.isSafeInteger(tab.id) || tab.windowId !== scope.windowId || !target.origin || tab.pinned || tab.incognito ||
          tab.discarded || owned && (tab.active || tab.url !== "about:blank" && tab.pendingUrl !== "about:blank"))
          throw new ChromeFault("stale")
        const current = await step(fence, () => api.tabs.get(tab.id))
        if (current.windowId !== tab.windowId || current.groupId !== tab.groupId || current.pinned || current.incognito ||
          !owned && (current.url !== tab.url || current.pendingUrl) || owned && current.active) throw new ChromeFault("stale")
        if (scope.grouping === "already") {
          target.group = await snapshot(current, fence)
          if (!target.group || JSON.stringify(target.group) !== JSON.stringify(scope.group)) throw new ChromeFault("stale")
        } else {
          await groupTab(current, target, fence)
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
        if (target) creating.delete(target.tabId)
      }
    },
    maintain(target, fence, invalidated) {
      let running = false
      target.markerTimer = setInterval(() => {
        if (running || target.navigating) return
        running = true
        void verify(target, fence).then((valid) => { if (!valid) invalidated() }, invalidated).finally(() => { running = false })
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
      if (intercept) await command(target, fence, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
      try {
        fence()
        if (target.documentChanged || target.nativeDetached) throw new ChromeFault("target_lost")
        dispatched()
        const result = await run(target, fence, { ...action, operation: action.type })
        if ((target.chooserEvents ?? 0) !== first) throw new ChromeFault("policy")
        if (result.refusal) return { refusal: result.refusal }
        if (!result.applied || !await verify(target, fence)) throw new ChromeFault("target_lost")
        return {}
      } finally {
        if (intercept) await command(target, fence, "Page.setInterceptFileChooserDialog", { enabled: false })
      }
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
    groupingChange: (id, groupId) => grouping.has(id) || groupId !== undefined && attached.get(id)?.group?.id === groupId,
    forgetGroup(id) { ownedGroups.delete(id) },
    foreignMember(groupId, id) {
      if (ownedGroups.get(groupId)?.members.some(([member]) => member !== id)) ownedGroups.delete(groupId)
    },
    targetsInGroup: (id) => [...attached.values()].filter((target) => target.group?.id === id).map((target) => target.tabId),
    nativeDetached(id) {
      const target = attached.get(id)
      if (target) target.nativeDetached = true
    },
    nativeEvent(id, method, params) {
      const target = attached.get(id)
      if (target && previewTransitions.has(method)) target.previewEpoch++
      if (target?.frame && !target.navigating &&
        ((method === "Page.frameNavigated" || method === "Page.documentOpened") && params.frame?.id === target.frame ||
          method === "Page.navigatedWithinDocument" && params.frameId === target.frame)) target.documentChanged = true
      if (target && method === "Page.javascriptDialogOpening") target.dialogOpen = true
      if (target && method === "Page.javascriptDialogClosed") target.dialogOpen = false
      if (target && method === "Page.fileChooserOpened") target.chooserEvents = (target.chooserEvents ?? 0) + 1
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
