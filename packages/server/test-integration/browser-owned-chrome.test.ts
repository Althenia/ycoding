import { expect, test } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { connect, type Client } from "@ycoding-ai/core/browser/isolated-cdp"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Schema, Scope } from "effect"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"

const chrome = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
const extension = resolve(import.meta.dir, "../../../extensions/chrome")
const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`
const chromeRecord = Schema.Record(Schema.String, Schema.Unknown)
const owner = "ses_browser_owned_live_owner"
const other = "ses_browser_owned_live_other"

test("pairs a private Chrome extension for owned and automatically listed existing tab flows", async () => {
  if (!chrome) throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to an installed Chrome for Testing executable")
  if (!(await Bun.file(chrome).exists())) throw new Error("Chrome for Testing executable is unavailable")
  const directory = await mkdtemp(join(tmpdir(), "ycoding-owned-chrome-"))
  const scope = await Effect.runPromise(Scope.make())
  let redirectLoads = 0
  const submissions: string[] = []
  const crossOrigin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("synthetic-cross-site-private-marker")
    },
  })
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/redirect") {
        redirectLoads++
        return Response.redirect(`http://127.0.0.1:${crossOrigin.port}/forbidden`)
      }
      if (url.pathname === "/submitted") {
        submissions.push(url.searchParams.get("value") ?? "")
        return new Response("recorded")
      }
      if (url.pathname === "/foreground")
        return new Response(
          "<!doctype html><title>Foreground fixture</title><input aria-label='Message'><button aria-label='Submit' onclick=\"fetch('/submitted?value='+encodeURIComponent(document.querySelector('input').value))\">Submit</button>",
          {
            headers: { "content-type": "text/html" },
          },
        )
      return new Response(
        "<!doctype html><title>Private fixture</title><button aria-label='Fixture button'>OK</button>",
        {
          headers: { "content-type": "text/html" },
        },
      )
    },
  })
  const origin = `http://127.0.0.1:${fixture.port}`
  const port = await availablePort()
  const base = `http://127.0.0.1:${port}`
  const request = (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers)
    headers.set("authorization", auth)
    return fetch(`${base}${path}`, { ...options, headers })
  }
  let child: ReturnType<typeof spawn> | undefined
  let cdp: Client | undefined
  try {
    const startingRaw = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "test-password",
      database: { path: ":memory:" },
      config: { directory, project: false, content: "{}" },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    // Runtime-owned request markers are supplied when the assembled router dispatches.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
    await Effect.runPromise(starting)
    for (const sessionID of [owner, other]) {
      const created = await request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sessionID, location: { directory } }),
      })
      expect(created.status, await created.text()).toBe(200)
    }
    const pairingHTTP = await request(`/api/session/${owner}/browser/start`, { method: "POST" })
    expect(pairingHTTP.status).toBe(200)
    const pairing = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Pairing }))(await pairingHTTP.json()).data

    child = spawn(
      chrome,
      [
        "--headless=new",
        `--user-data-dir=${join(directory, "profile")}`,
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-breakpad",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "about:blank",
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    )
    const readable = child.stdio[4]
    const writable = child.stdio[3]
    if (!(readable instanceof Readable) || !(writable instanceof Writable))
      throw new Error("Private Chrome did not expose its control pipe")
    cdp = connect(readable, writable)
    const version = record(await cdp.send("Browser.getVersion"))
    expect(Number(/^Chrome\/(\d+)\./.exec(String(version.product))?.[1])).toBeGreaterThanOrEqual(152)
    await cdp.send("Target.setDiscoverTargets", { discover: true })
    const worker = await eventually(async () => {
      const infos = record(await cdp!.send("Target.getTargets")).targetInfos
      return Array.isArray(infos)
        ? infos
            .map(record)
            .find(
              (info) =>
                info.type === "service_worker" &&
                /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/.test(String(info.url)),
            )
        : undefined
    }, "private extension service worker")
    const extensionID = /^chrome-extension:\/\/([a-p]{32})\//.exec(string(worker.url))?.[1]
    if (!extensionID) throw new Error("Private extension identity unavailable")
    const workerSession = string(
      record(
        await cdp.send("Target.attachToTarget", {
          targetId: string(worker.targetId),
          flatten: true,
        }),
      ).sessionId,
    )
    await cdp.send("Runtime.enable", {}, workerSession)

    const popup = record(await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionID}/popup.html` }))
    const popupSession = string(
      record(
        await cdp.send("Target.attachToTarget", {
          targetId: string(popup.targetId),
          flatten: true,
        }),
      ).sessionId,
    )
    await cdp.send("Runtime.enable", {}, popupSession)
    await eventually(
      async () =>
        (await evaluate(cdp!, popupSession, "typeof chrome === 'object' && !!chrome.runtime?.sendMessage")) === true
          ? true
          : undefined,
      "private extension popup",
    )
    await eventually(
      async () =>
        (await evaluate(
          cdp!,
          popupSession,
          "document.querySelector('#connection-state')?.textContent === 'Disconnected' && !document.querySelector('#pairing-view')?.hidden",
        )) === true
          ? true
          : undefined,
      "private popup initial pairing view",
    )
    for (const [scheme, background] of [
      ["light", "rgb(255, 255, 255)"],
      ["dark", "rgb(23, 25, 29)"],
    ] as const) {
      await cdp.send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: scheme }] },
        popupSession,
      )
      expect(
        await eventually(async () => {
          const color = await evaluate(cdp!, popupSession, "getComputedStyle(document.body).backgroundColor")
          return color === background ? color : undefined
        }, `private popup ${scheme} background`),
      ).toBe(background)
    }
    const existingProfileTab = record(
      await evaluate(
        cdp,
        popupSession,
        `chrome.tabs.create({url:${JSON.stringify(`${origin}/profile-existing`)},active:false})`,
      ),
    )
    const existingID = number(existingProfileTab.id)
    await eventually(async () => {
      const native = record(await evaluate(cdp!, popupSession, `chrome.tabs.get(${existingID})`))
      return native.url === `${origin}/profile-existing` && native.status === "complete" ? true : undefined
    }, "loaded existing private tab before pairing")
    const paired = record(
      await evaluate(
        cdp,
        popupSession,
        `chrome.runtime.sendMessage({type:'pair',serverURL:${JSON.stringify(base)},secret:${JSON.stringify(pairing.secret)}})`,
      ),
    )
    expect(paired).toMatchObject({ paired: true, connected: true, profileGranted: true })
    await eventually(
      async () =>
        (await evaluate(
          cdp!,
          popupSession,
          "document.querySelector('#connection-state')?.textContent === 'Connected' && document.querySelector('#pairing-view')?.hidden && !document.querySelector('#connected-view')?.hidden && document.querySelector('#settings-toggle') === null && document.querySelector('#forget')?.hidden === false",
        )) === true
          ? true
          : undefined,
      "private popup connected view without pairing form",
    )
    const status = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Status }))(
      await (await request(`/api/session/${owner}/browser`)).json(),
    ).data
    expect(status.state).toBe("connected")
    if (!status.generation) throw new Error("Private bridge has no generation")

    const foreground = record(await cdp.send("Target.createTarget", { url: `${origin}/foreground` }))
    await cdp.send("Target.activateTarget", { targetId: string(foreground.targetId) })
    const activeBefore = await activeTabIDs(cdp, workerSession)
    const countBefore = await tabCount(cdp, workerSession)
    expect(activeBefore).toHaveLength(1)
    const foregroundProfile = await eventually(async () => {
      const listed = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await (await request(`/api/session/${other}/browser/tabs`)).json(),
      ).data
      return listed.find((item) => item.mode === "profile" && item.page.path === "/foreground")
    }, "automatically listed foreground tab")
    expect(foregroundProfile.status).toBe("shared")
    const foregroundRead = await request(`/api/session/${other}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: foregroundProfile.id,
        generation: foregroundProfile.generation,
        callID: "foreground-read",
      }),
    })
    expect(foregroundRead.status, await foregroundRead.clone().text()).toBe(200)
    const foregroundObserved = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Observation }))(
      await foregroundRead.json(),
    ).data
    const messageInput = foregroundObserved.elements.find((element) => element.name === "Message")
    if (!messageInput) throw new Error("Private foreground input was not observed")
    const foregroundAction = async (
      observation: Browser.Observation,
      action: Browser.ActionInput["action"],
      callID: string,
    ) => {
      const response = await request(`/api/session/${other}/browser/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabID: foregroundProfile.id,
          generation: foregroundProfile.generation,
          documentGeneration: observation.documentGeneration,
          observationRevision: observation.revision,
          callID,
          action,
        }),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      return Schema.decodeUnknownSync(Schema.Struct({ data: Browser.ActionResult }))(await response.json()).data
    }
    expect(
      (
        await foregroundAction(
          foregroundObserved,
          { type: "type", ref: messageInput.ref, text: "synthetic-value" },
          "foreground-type",
        )
      ).status,
    ).toBe("completed")
    const afterTypeHTTP = await request(`/api/session/${other}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: foregroundProfile.id,
        generation: foregroundProfile.generation,
        callID: "foreground-after-type",
      }),
    })
    expect(afterTypeHTTP.status, await afterTypeHTTP.clone().text()).toBe(200)
    const afterType = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Observation }))(
      await afterTypeHTTP.json(),
    ).data
    const submitButton = afterType.elements.find((element) => element.name === "Submit")
    if (!submitButton) throw new Error("Private foreground button was not observed")
    expect(
      (await foregroundAction(afterType, { type: "click", ref: submitButton.ref }, "foreground-click")).status,
    ).toBe("completed")
    await eventually(async () => (submissions.length === 1 ? true : undefined), "foreground fixture submit")
    expect(submissions).toEqual(["synthetic-value"])
    expect((await foregroundAction(afterType, { type: "scroll", deltaY: 20 }, "foreground-scroll")).status).toBe(
      "completed",
    )
    const capturedForeground = await foregroundAction(afterType, { type: "capture" }, "foreground-capture")
    expect(capturedForeground).toMatchObject({ status: "completed", capture: { mediaType: "image/png" } })
    expect(await activeTabIDs(cdp, workerSession)).toEqual(activeBefore)

    const openedHTTP = await request(`/api/session/${owner}/browser/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation: status.generation, url: `${origin}/fixture`, callID: "real-open" }),
    })
    expect(openedHTTP.status, await openedHTTP.clone().text()).toBe(200)
    const tab = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Tab }))(await openedHTTP.json()).data
    expect(tab).toMatchObject({ sessionID: owner, mode: "owned", status: "shared", page: { origin, path: "/fixture" } })
    expect(await activeTabIDs(cdp, workerSession)).toEqual(activeBefore)
    expect(await tabCount(cdp, workerSession)).toBe(countBefore + 1)
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await (await request(`/api/session/${other}/browser/tabs`)).json(),
      ).data.every((item) => item.mode !== "owned"),
    ).toBe(true)
    const forbidden = await request(`/api/session/${other}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabID: tab.id, generation: tab.generation, callID: "foreign-read" }),
    })
    expect(forbidden.status).toBe(403)
    const observedHTTP = await request(`/api/session/${owner}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabID: tab.id, generation: tab.generation, callID: "real-observe" }),
    })
    expect(observedHTTP.status, await observedHTTP.clone().text()).toBe(200)
    const observed = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Observation }))(
      await observedHTTP.json(),
    ).data
    expect(observed.elements).toContainEqual(expect.objectContaining({ role: "button", name: "Fixture button" }))
    const unsafe = await request(`/api/session/${owner}/browser/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: tab.id,
        generation: tab.generation,
        documentGeneration: observed.documentGeneration,
        observationRevision: observed.revision,
        callID: "unsafe-navigation",
        action: { type: "navigate", url: "file:///private" },
      }),
    })
    expect(unsafe.status).toBe(409)
    expect(await activeTabIDs(cdp, workerSession)).toEqual(activeBefore)
    const closed = await request(`/api/session/${owner}/browser/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabID: tab.id, generation: tab.generation, callID: "real-close" }),
    })
    expect(closed.status, await closed.text()).toBe(204)
    expect(await activeTabIDs(cdp, workerSession)).toEqual(activeBefore)
    await eventually(
      async () => ((await tabCount(cdp!, workerSession)) === countBefore ? true : undefined),
      "owned tab close",
    )
    const redirect = await request(`/api/session/${owner}/browser/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation: status.generation, url: `${origin}/redirect`, callID: "real-redirect" }),
    })
    expect(redirect.status).toBe(400)
    expect(redirectLoads).toBe(1)
    expect(await redirect.text()).not.toContain("synthetic-cross-site-private-marker")
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await (await request(`/api/session/${owner}/browser/tabs`)).json(),
      ).data.every((item) => item.mode !== "owned"),
    ).toBe(true)
    await eventually(
      async () => ((await tabCount(cdp!, workerSession)) === countBefore ? true : undefined),
      "redirected tab revocation",
    )
    expect(await activeTabIDs(cdp, workerSession)).toEqual(activeBefore)

    const tabsBeforeActiveOpen = await tabIDs(cdp, workerSession)
    const activeOpen = await request(`/api/session/${owner}/browser/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation: status.generation, url: `${origin}/active`, callID: "real-user-takeover" }),
    })
    expect(activeOpen.status, await activeOpen.clone().text()).toBe(200)
    const ownedActive = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Tab }))(await activeOpen.json()).data
    const nativeTabID = (await tabIDs(cdp, workerSession)).find((id) => !tabsBeforeActiveOpen.includes(id))
    if (nativeTabID === undefined) throw new Error("Private Chrome did not create an owned tab")
    expect(await debuggerAttached(cdp, workerSession, nativeTabID)).toBe(true)
    const activeTarget = await eventually(async () => {
      const infos = record(await cdp!.send("Target.getTargets")).targetInfos
      return Array.isArray(infos)
        ? infos.map(record).find((info) => info.type === "page" && info.url === `${origin}/active`)
        : undefined
    }, "private owned tab target")
    await cdp.send("Target.activateTarget", { targetId: string(activeTarget.targetId) })
    await eventually(
      async () => ((await activeTabIDs(cdp!, workerSession)).includes(nativeTabID) ? true : undefined),
      "user-activated owned tab",
    )
    const foregroundOwned = await eventually(async () => {
      const listed = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await (await request(`/api/session/${owner}/browser/tabs`)).json(),
      ).data
      return listed.find((item) => item.id === ownedActive.id && item.status === "shared")
    }, "active owned tab remains controllable")
    const ownedRead = await request(`/api/session/${owner}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: foregroundOwned.id,
        generation: foregroundOwned.generation,
        callID: "active-owned-read",
      }),
    })
    expect(ownedRead.status, await ownedRead.clone().text()).toBe(200)
    const ownedObserved = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Observation }))(
      await ownedRead.json(),
    ).data
    const ownedScroll = await request(`/api/session/${owner}/browser/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: foregroundOwned.id,
        generation: foregroundOwned.generation,
        documentGeneration: ownedObserved.documentGeneration,
        observationRevision: ownedObserved.revision,
        callID: "active-owned-scroll",
        action: { type: "scroll", deltaY: 18 },
      }),
    })
    expect(ownedScroll.status, await ownedScroll.clone().text()).toBe(200)
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ data: Browser.ActionResult }))(await ownedScroll.json()).data.status,
    ).toBe("completed")
    expect(await activeTabIDs(cdp, workerSession)).toEqual([nativeTabID])
    const archived = await request(`/api/session/${owner}/archive`, { method: "POST" })
    expect(archived.status, await archived.text()).toBe(204)
    await eventually(
      async () => !(await debuggerAttached(cdp!, workerSession, nativeTabID)) || undefined,
      "active owned tab debugger detach on Session archive",
    )
    expect(await tabIDs(cdp, workerSession)).toContain(nativeTabID)
    expect(await activeTabIDs(cdp, workerSession)).toEqual([nativeTabID])

    await cdp.send("Target.activateTarget", { targetId: string(foreground.targetId) })
    await eventually(
      async () => ((await activeTabIDs(cdp!, workerSession)).includes(activeBefore[0]) ? true : undefined),
      "private fixture tab selection",
    )
    expect(record(await evaluate(cdp, popupSession, "chrome.runtime.getManifest()")).name).toBe("YCoding")
    const futureProfileTab = record(
      await evaluate(
        cdp,
        popupSession,
        `chrome.tabs.create({url:${JSON.stringify(`${origin}/profile-future`)},active:false})`,
      ),
    )
    const futureID = number(futureProfileTab.id)
    const profileTabs = await eventually(async () => {
      const listed = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await (await request(`/api/session/${other}/browser/tabs`)).json(),
      ).data.filter((item) => item.mode === "profile")
      return listed.some((item) => item.page.path === "/profile-existing") &&
        listed.some((item) => item.page.path === "/profile-future")
        ? listed
        : undefined
    }, "private existing and future profile tabs")
    const profile = profileTabs.find((item) => item.page.path === "/profile-existing")!
    const nextProfile = profileTabs.find((item) => item.page.path === "/profile-future")!
    expect(await debuggerAttached(cdp, workerSession, existingID)).toBe(false)
    const profileObservation = await request(`/api/session/${other}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabID: profile.id, generation: profile.generation, callID: "profile-observe" }),
    })
    expect(profileObservation.status, await profileObservation.clone().text()).toBe(200)
    const profileObserved = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Observation }))(
      await profileObservation.json(),
    ).data
    expect(await debuggerAttached(cdp, workerSession, existingID)).toBe(true)
    expect(await evaluate(cdp, popupSession, `chrome.action.getBadgeText({tabId:${existingID}})`)).toBe("ON")
    const groupHTTP = await request(`/api/session/${other}/browser/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: profile.id,
        generation: profile.generation,
        documentGeneration: profileObserved.documentGeneration,
        observationRevision: profileObserved.revision,
        callID: "profile-group",
        action: { type: "group", tabIDs: [profile.id, nextProfile.id], title: "YCoding fixture" },
      }),
    })
    expect(groupHTTP.status, await groupHTTP.clone().text()).toBe(200)
    const grouped = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.ActionResult }))(await groupHTTP.json()).data
    expect(grouped.status).toBe("completed")
    expect(typeof grouped.groupID).toBe("number")
    const nativeGroup = await evaluate(cdp, popupSession, `chrome.tabs.get(${existingID}).then(tab=>tab.groupId)`)
    expect(nativeGroup).toBe(grouped.groupID)
    expect(await evaluate(cdp, popupSession, `chrome.tabs.get(${futureID}).then(tab=>tab.groupId)`)).toBe(
      grouped.groupID,
    )
    const regroupObservation = await request(`/api/session/${other}/browser/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabID: profile.id, generation: profile.generation, callID: "profile-regroup-observe" }),
    })
    expect(regroupObservation.status, await regroupObservation.clone().text()).toBe(200)
    const regrouped = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Observation }))(
      await regroupObservation.json(),
    ).data
    const ungroupHTTP = await request(`/api/session/${other}/browser/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabID: profile.id,
        generation: profile.generation,
        documentGeneration: regrouped.documentGeneration,
        observationRevision: regrouped.revision,
        callID: "profile-ungroup",
        action: { type: "ungroup", groupID: grouped.groupID, tabIDs: [profile.id, nextProfile.id] },
      }),
    })
    expect(ungroupHTTP.status, await ungroupHTTP.clone().text()).toBe(200)
    expect(await evaluate(cdp, popupSession, `chrome.tabs.get(${existingID}).then(tab=>tab.groupId)`)).toBe(-1)
    expect(await activeTabIDs(cdp, workerSession)).toEqual(activeBefore)
    const forgotten = record(await evaluate(cdp, popupSession, "chrome.runtime.sendMessage({type:'forget'})"))
    expect(forgotten).toMatchObject({ paired: false, connected: false, profileGranted: false })
    expect(await evaluate(cdp, popupSession, `chrome.action.getBadgeText({tabId:${existingID}})`)).toBe("")
    expect(await debuggerAttached(cdp, workerSession, existingID)).toBe(false)
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await (await request(`/api/session/${other}/browser/tabs`)).json(),
      ).data.every((item) => item.mode !== "profile"),
    ).toBe(true)
    expect(await tabIDs(cdp, workerSession)).toContain(existingID)
    expect(await tabIDs(cdp, workerSession)).toContain(futureID)
  } finally {
    try {
      if (cdp) {
        await cdp.send("Browser.close").catch(() => {})
        cdp.close()
      }
      if (child) await terminate(child)
    } finally {
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      } finally {
        await fixture.stop(true)
        await crossOrigin.stop(true)
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}, 120_000)

test("recovers a stopped Chrome worker without reopening its popup or repeating pairing", async () => {
  if (!chrome) throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to an installed Chrome for Testing executable")
  if (!(await Bun.file(chrome).exists())) throw new Error("Chrome for Testing executable is unavailable")
  const directory = await mkdtemp(join(tmpdir(), "ycoding-browser-recovery-"))
  const scope = await Effect.runPromise(Scope.make())
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("<!doctype html><title>Private recovery fixture</title>", {
        headers: { "content-type": "text/html" },
      })
    },
  })
  const port = await availablePort()
  const base = `http://127.0.0.1:${port}`
  const sessionID = "ses_browser_recovery_live"
  const request = (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers)
    headers.set("authorization", auth)
    return fetch(`${base}${url}`, { ...options, headers })
  }
  let child: ReturnType<typeof spawn> | undefined
  let cdp: Client | undefined
  try {
    const startingRaw = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "test-password",
      database: { path: ":memory:" },
      config: { directory, project: false, content: "{}" },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    // Runtime-owned request markers are supplied when the assembled router dispatches.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
    await Effect.runPromise(starting)
    const created = await request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sessionID, location: { directory } }),
    })
    expect(created.status, await created.text()).toBe(200)
    const pairingHTTP = await request(`/api/session/${sessionID}/browser/start`, { method: "POST" })
    expect(pairingHTTP.status).toBe(200)
    const pairing = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Pairing }))(await pairingHTTP.json()).data

    child = spawn(
      chrome,
      [
        "--headless=new",
        `--user-data-dir=${join(directory, "profile")}`,
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-breakpad",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "about:blank",
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    )
    const readable = child.stdio[4]
    const writable = child.stdio[3]
    if (!(readable instanceof Readable) || !(writable instanceof Writable))
      throw new Error("Private Chrome did not expose its control pipe")
    cdp = connect(readable, writable)
    await cdp.send("Target.setDiscoverTargets", { discover: true })
    const worker = await eventually(async () => {
      const infos = record(await cdp!.send("Target.getTargets")).targetInfos
      return Array.isArray(infos)
        ? infos
            .map(record)
            .find(
              (info) =>
                info.type === "service_worker" &&
                /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/.test(String(info.url)),
            )
        : undefined
    }, "private extension service worker")
    const extensionID = /^chrome-extension:\/\/([a-p]{32})\//.exec(string(worker.url))?.[1]
    if (!extensionID) throw new Error("Private extension identity unavailable")
    const blank = record(await cdp.send("Target.getTargets")).targetInfos
    if (!Array.isArray(blank)) throw new Error("Private Chrome did not provide page targets")
    const page = blank.map(record).find((info) => info.type === "page" && info.url === "about:blank")
    if (!page) throw new Error("Private Chrome did not provide an inert page for worker lifecycle events")
    const pageSession = string(
      record(
        await cdp.send("Target.attachToTarget", {
          targetId: string(page.targetId),
          flatten: true,
        }),
      ).sessionId,
    )
    let workerVersion: string | undefined
    const unsubscribe = cdp.subscribe((event) => {
      if (event.method !== "ServiceWorker.workerVersionUpdated") return
      const versions = event.params?.versions
      if (!Array.isArray(versions)) return
      const matching = versions
        .map(record)
        .find((version) => /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/.test(String(version.scriptURL)))
      if (matching) workerVersion = string(matching.versionId)
    })
    await cdp.send("ServiceWorker.enable", {}, pageSession)
    const workerSession = string(
      record(
        await cdp.send("Target.attachToTarget", {
          targetId: string(worker.targetId),
          flatten: true,
        }),
      ).sessionId,
    )
    const popup = record(await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionID}/popup.html` }))
    const popupSession = string(
      record(
        await cdp.send("Target.attachToTarget", {
          targetId: string(popup.targetId),
          flatten: true,
        }),
      ).sessionId,
    )
    await cdp.send("Runtime.enable", {}, popupSession)
    await eventually(
      async () =>
        (await evaluate(cdp!, popupSession, "typeof chrome === 'object' && !!chrome.runtime?.sendMessage")) === true
          ? true
          : undefined,
      "private extension popup",
    )
    const paired = record(
      await evaluate(
        cdp,
        popupSession,
        `chrome.runtime.sendMessage({type:'pair',serverURL:${JSON.stringify(base)},secret:${JSON.stringify(pairing.secret)}})`,
      ),
    )
    expect(paired).toMatchObject({ paired: true, connected: true, profileGranted: true })
    const profilePage = `${fixture.url.origin}/persist`
    const opened = record(
      await evaluate(cdp, popupSession, `chrome.tabs.create({url:${JSON.stringify(profilePage)},active:false})`),
    )
    const profileChromeID = number(opened.id)
    await eventually(async () => {
      const info = record(await evaluate(cdp!, popupSession, `chrome.tabs.get(${profileChromeID})`))
      return info.url === profilePage && info.status === "complete" ? true : undefined
    }, "loaded private profile recovery tab")
    const original = await eventually(async () => {
      const response = await request(`/api/session/${sessionID}/browser/tabs`)
      const tabs = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await response.json(),
      ).data
      return tabs.find((tab) => tab.mode === "profile" && tab.page.path === "/persist")
    }, "profile tab before worker stop")
    const status = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Status }))(
      await (await request(`/api/session/${sessionID}/browser`)).json(),
    ).data
    expect(status).toMatchObject({ state: "connected", profileGranted: true })
    if (!status.generation) throw new Error("Private Chrome bridge had no initial generation")
    await cdp.send("Target.detachFromTarget", { sessionId: workerSession })
    await cdp.send("Target.closeTarget", { targetId: string(popup.targetId) })
    for (let attempt = 0; attempt < 19; attempt++) {
      const response = await request(`/api/session/${sessionID}/browser`)
      expect(response.status).toBe(200)
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Status }))(await response.json()).data,
      ).toMatchObject({ state: "connected", generation: status.generation, profileGranted: true })
      if (attempt < 18) await Bun.sleep(2_000)
    }
    const versionID = await eventually(async () => workerVersion, "Chrome extension worker version")
    await cdp.send("ServiceWorker.stopWorker", { versionId: versionID }, pageSession)
    const resumed = await eventuallyFor(
      async () => {
        const response = await request(`/api/session/${sessionID}/browser`)
        const latest = Schema.decodeUnknownSync(Schema.Struct({ data: Browser.Status }))(await response.json()).data
        return latest.state === "connected" && latest.generation && latest.generation > status.generation!
          ? latest
          : undefined
      },
      "unprompted Chrome bridge reconnect",
      70_000,
    )
    expect(resumed.profileGranted).toBe(true)
    if (!resumed.generation) throw new Error("Recovered Chrome bridge has no generation")
    const restored = await eventually(async () => {
      const response = await request(`/api/session/${sessionID}/browser/tabs`)
      const tabs = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Browser.Tab) }))(
        await response.json(),
      ).data
      return tabs.find((tab) => tab.mode === "profile" && tab.page.path === "/persist")
    }, "profile grant after worker restart")
    expect(restored.id).not.toBe(original.id)
    expect(restored.generation).toBe(resumed.generation)
    unsubscribe()
  } finally {
    try {
      if (cdp) {
        await cdp.send("Browser.close").catch(() => {})
        cdp.close()
      }
      if (child) await terminate(child)
    } finally {
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      } finally {
        await fixture.stop(true)
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}, 180_000)

async function evaluate(cdp: Client, sessionID: string, expression: string) {
  const result = record(
    await cdp.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionID,
    ),
  )
  if (result.exceptionDetails) throw new Error("Private extension evaluation failed")
  return record(result.result).value
}

async function activeTabIDs(cdp: Client, sessionID: string) {
  const value = await evaluate(cdp, sessionID, "chrome.tabs.query({active:true}).then(tabs=>tabs.map(tab=>tab.id))")
  if (!Array.isArray(value) || value.some((id) => typeof id !== "number"))
    throw new Error("Private extension did not report active tabs")
  return value
}

async function tabCount(cdp: Client, sessionID: string) {
  const value = await evaluate(cdp, sessionID, "chrome.tabs.query({}).then(tabs=>tabs.length)")
  if (typeof value !== "number") throw new Error("Private extension did not report tab count")
  return value
}

async function tabIDs(cdp: Client, sessionID: string) {
  const value = await evaluate(cdp, sessionID, "chrome.tabs.query({}).then(tabs=>tabs.map(tab=>tab.id))")
  if (!Array.isArray(value) || value.some((id) => typeof id !== "number"))
    throw new Error("Private extension did not report tab IDs")
  return Schema.decodeUnknownSync(Schema.Array(Schema.Number))(value)
}

async function debuggerAttached(cdp: Client, sessionID: string, tabID: number) {
  const value = await evaluate(
    cdp,
    sessionID,
    `chrome.debugger.getTargets().then(targets=>targets.find(target=>target.tabId===${tabID})?.attached)`,
  )
  if (typeof value !== "boolean") throw new Error("Private Chrome did not report debugger attachment")
  return value
}

async function eventually<A>(check: () => Promise<A | undefined>, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function eventuallyFor<A>(check: () => Promise<A | undefined>, label: string, timeoutMs: number) {
  for (let attempt = 0; attempt < timeoutMs / 1_000; attempt++) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(1_000)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Private Chrome returned an invalid response")
  return Schema.decodeUnknownSync(chromeRecord)(value)
}

function string(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("Private Chrome omitted an identifier")
  return value
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Private Chrome omitted a tab ID")
  return value
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve browser test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function terminate(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = () =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  if (await exited()) return
  if (child.pid) process.kill(-child.pid, "SIGTERM")
  if (await exited()) return
  if (child.pid) process.kill(-child.pid, "SIGKILL")
  if (!(await exited())) throw new Error("Private Chrome process did not exit")
}
