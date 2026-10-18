import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { z } from "zod"
import { connect, type Client } from "../../../packages/core/src/browser/isolated-cdp"
import { startBackend } from "./fixture/runtime"

test("owner link exposes working Ask model and connector settings while the ordinary link stays readonly", async () => {
  const backend = await startBackend("local", true)
  let browser: Awaited<ReturnType<typeof launch>> | undefined
  try {
    const pageURL = async (action: string) => {
      const reply = await backend.control({ action })
      if (typeof reply !== "object" || reply === null || !("url" in reply) || typeof reply.url !== "string")
        throw new Error("Missing page URL")
      return reply.url
    }
    const ordinaryURL = await pageURL("view")
    const ownerURL = await pageURL("owner-view")
    const viewKey = new URLSearchParams(new URL(ordinaryURL).hash.slice(1)).get("key")!
    const ownerKey = new URLSearchParams(new URL(ownerURL).hash.slice(1)).get("owner")!
    const settingsFile = () => Bun.file(path.join(backend.meetingDirectory, "settings.json")).json()
    const api = (route: string, token: string, body?: unknown) =>
      fetch(`${backend.origin}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: backend.origin,
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const inventory = (await (await api("/view/owner/settings", ownerKey)).json()) as {
      models: { providerID: string; id: string; variants: string[] }[]
    }
    const high = inventory.models.find((model) => model.providerID === "openai" && model.id === "gpt-reasoning-high")
    expect(high?.variants).toEqual(["none", "low", "high"])
    expect((await api("/view/owner/settings", ownerKey, { knowledge: { mcpEnabled: true, bindings: [] } })).status).toBe(
      200,
    )
    await backend.control({ action: "start", title: "Owner settings browser" })
    const capture = async (payload: unknown) =>
      expect((await api("/view/capture", viewKey, payload)).status).toBe(200)
    await capture({ type: "start", captureID: "owner-browser", microphone: false, consent: true })
    await capture({
      type: "audio",
      captureID: "owner-browser",
      source: "remote",
      sequence: 0,
      startMs: 0,
      sampleRate: 16000,
      pcm: Buffer.from(new Float32Array(16000).fill(0.1).buffer).toString("base64"),
    })
    await capture({ type: "stop", captureID: "owner-browser", reason: "fixture complete" })

    browser = await launch()
    const target = string(record(await browser.cdp.send("Target.createTarget", { url: "about:blank" })).targetId)
    const session = string(
      record(await browser.cdp.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId,
    )
    const errors: string[] = []
    const ownerReads: string[] = []
    let ownerPosts = 0
    let failOwnerReply = false
    const unsubscribe = browser.cdp.subscribe((event) => {
      if (event.sessionId !== session) return
      if (event.method === "Runtime.exceptionThrown") errors.push("Page exception")
      if (event.method === "Network.requestWillBeSent") {
        const request = record(event.params?.request)
        const targetURL = new URL(string(request.url))
        if (targetURL.protocol === "data:" || targetURL.href === "about:blank") return
        if (targetURL.origin !== backend.origin || targetURL.search || targetURL.hash)
          errors.push("Unexpected network target")
        if (targetURL.pathname === "/view/owner/settings") {
          ownerReads.push(targetURL.pathname)
          if (request.method === "POST") ownerPosts++
        }
      }
      if (event.method === "Fetch.requestPaused") {
        const requestId = string(event.params?.requestId)
        const method = string(record(event.params?.request).method)
        if (method === "POST" && failOwnerReply) {
          failOwnerReply = false
          void browser!.cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" }, session)
          return
        }
        void browser!.cdp.send("Fetch.continueRequest", { requestId }, session)
      }
    })
    await browser.cdp.send("Runtime.enable", {}, session)
    await browser.cdp.send("Network.enable", {}, session)
    await browser.cdp.send("Page.enable", {}, session)

    await navigate(browser.cdp, session, ordinaryURL)
    await waitDOM(browser.cdp, session, "document.querySelector('#connection')?.textContent.includes('Connected')")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-panel').hidden")).toBe(true)
    expect(await evaluate(browser.cdp, session, "location.hash")).toBe("")
    expect(ownerReads).toEqual([])

    await navigate(browser.cdp, session, ownerURL)
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#owner-feedback')?.textContent.includes('Owner settings loaded')",
    )
    expect(await evaluate(browser.cdp, session, "location.hash")).toBe("")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-panel').hidden")).toBe(false)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-details').open")).toBe(false)
    await click(browser.cdp, session, "#owner-details > summary")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-form').checkVisibility()")).toBe(true)
    for (const step of [
      { key: "Tab", code: 9, modifiers: 0, focus: "owner-model", open: true },
      { key: "Tab", code: 9, modifiers: 8, focus: "owner-title", open: true },
      { key: "Enter", code: 13, modifiers: 0, focus: "owner-title", open: false },
      { key: "Enter", code: 13, modifiers: 0, focus: "owner-title", open: true },
    ]) {
      for (const type of ["keyDown", "keyUp"])
        await browser.cdp.send(
          "Input.dispatchKeyEvent",
          {
            type,
            key: step.key,
            code: step.key,
            windowsVirtualKeyCode: step.code,
            modifiers: step.modifiers,
            ...(step.key === "Enter" && type === "keyDown" ? { text: "\r" } : {}),
          },
          session,
        )
      await waitDOM(browser.cdp, session, `document.querySelector('#owner-details').open===${step.open}`)
      expect(await evaluate(browser.cdp, session, "document.activeElement.id")).toBe(step.focus)
      expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-details').open")).toBe(step.open)
    }
    expect(await evaluate(browser.cdp, session, "localStorage.length + sessionStorage.length")).toBe(0)
    expect(await evaluate(browser.cdp, session, `document.body.innerText.includes(${JSON.stringify(ownerKey)})`)).toBe(
      false,
    )
    expect(
      await evaluate(
        browser.cdp,
        session,
        "[...document.querySelector('#owner-model').options].map((option) => option.textContent).join(' | ')",
      ),
    ).toContain("GPT Reasoning High")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').disabled")).toBe(true)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-add-server').disabled")).toBe(false)
    expect(await evaluate(browser.cdp, session, "getComputedStyle(document.querySelector('#owner-model')).appearance")).toBe("base-select")

    await choose(browser.cdp, session, "#owner-model", "openai · GPT Reasoning High")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').disabled")).toBe(false)
    await choose(browser.cdp, session, "#owner-variant", "high")
    await choose(browser.cdp, session, "#owner-add-server", "knowledge")
    await choose(browser.cdp, session, "#owner-add-search", "search")
    await choose(browser.cdp, session, "#owner-add-read", "read")
    await choose(browser.cdp, session, "#owner-add-write", "replace")
    await click(browser.cdp, session, "#owner-add")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#owner-bindings')?.textContent.includes('Server connected · write requires approval')",
    )
    await click(browser.cdp, session, "#owner-save")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#owner-feedback')?.textContent.includes('Owner settings saved')",
    )
    expect(
      await evaluate(browser.cdp, session, "document.querySelector('#owner-bindings').textContent"),
    ).toContain("revision-aware")
    const saved = await settingsFile()
    expect(saved.analysis.askModel).toEqual({ providerID: "openai", id: "gpt-reasoning-high", variant: "high" })
    expect(saved.analysis.model).toBe("inherit")
    expect(saved.knowledge.bindings).toEqual([
      { server: "knowledge", search: "search", read: "read", write: "replace", enabled: true },
    ])
    expect(saved.knowledge.autoApply).toBe(false)
    expect(saved.knowledge.requireApproval).toBe(true)

    await fill(browser.cdp, session, "#question", "What is pending?")
    await click(browser.cdp, session, "#ask")
    await waitDOM(browser.cdp, session, "document.querySelector('#chat-history')?.textContent.includes('Advisory')")
    const asked = backend.requests.filter((body) => JSON.stringify(body).includes('\\"question\\":'))
    expect(asked).toHaveLength(1)
    expect(JSON.stringify(asked[0])).toContain('"service_tier":"priority"')

    await evaluate(
      browser.cdp,
      session,
      "(()=>{const node=document.querySelector('#owner-variant');const option=document.createElement('option');option.value='not-reported';option.textContent='not-reported';node.append(option);node.value='not-reported';node.dispatchEvent(new Event('change',{bubbles:true}));return true})()",
    )
    await click(browser.cdp, session, "#owner-save")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#owner-feedback')?.textContent.includes('choose a reported option')",
    )
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').value")).toBe("not-reported")
    expect((await settingsFile()).analysis.askModel).toEqual({
      providerID: "openai",
      id: "gpt-reasoning-high",
      variant: "high",
    })

    await navigate(browser.cdp, session, "about:blank")
    await navigate(browser.cdp, session, ownerURL)
    await waitDOM(browser.cdp, session, "document.querySelector('#owner-feedback')?.textContent.includes('Owner settings loaded')")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-details').open")).toBe(false)
    await click(browser.cdp, session, "#owner-details > summary")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').disabled")).toBe(false)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').value")).toBe("high")
    await click(browser.cdp, session, "#owner-mcp")
    await click(browser.cdp, session, "#owner-save")
    await waitDOM(browser.cdp, session, "document.querySelector('#owner-feedback')?.textContent.includes('Owner settings saved')")
    const disconnected = await settingsFile()
    expect(disconnected.analysis.askModel).toEqual({ providerID: "openai", id: "gpt-reasoning-high", variant: "high" })
    expect(disconnected.knowledge.mcpEnabled).toBe(false)
    expect(disconnected.knowledge.bindings).toHaveLength(1)

    await choose(browser.cdp, session, "#owner-variant", "low")
    await browser.cdp.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*/view/owner/settings", requestStage: "Response" }] },
      session,
    )
    failOwnerReply = true
    const postsBefore = ownerPosts
    await click(browser.cdp, session, "#owner-save")
    await waitDOM(browser.cdp, session, "document.querySelector('#owner-feedback')?.textContent.includes('outcome is unknown')")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-retry').hidden")).toBe(false)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').value")).toBe("low")
    expect((await settingsFile()).analysis.askModel).toEqual({
      providerID: "openai",
      id: "gpt-reasoning-high",
      variant: "low",
    })
    const savedPosts = ownerPosts
    expect(savedPosts).toBe(postsBefore + 1)
    await click(browser.cdp, session, "#owner-retry")
    await waitDOM(browser.cdp, session, "document.querySelector('#owner-feedback')?.textContent.includes('Owner settings loaded')")
    expect(ownerPosts).toBe(savedPosts)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-variant').value")).toBe("low")
    await browser.cdp.send("Fetch.disable", {}, session)

    await browser.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      session,
    )
    expect(
      await evaluate(
        browser.cdp,
        session,
        "document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#owner-save').getBoundingClientRect().height >= 44 && document.querySelector('#owner-model').getBoundingClientRect().height >= 44",
      ),
    ).toBe(true)
    await browser.cdp.send("Emulation.clearDeviceMetricsOverride", {}, session)

    await browser.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }, session)
    for (const [theme, background] of [["light", "rgb(255, 255, 255)"], ["dark", "rgb(21, 30, 36)"]] as const) {
      await browser.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, session)
      await click(browser.cdp, session, "#owner-model")
      expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-model').matches(':open')")).toBe(true)
      expect(await evaluate(browser.cdp, session, "getComputedStyle(document.querySelector('#owner-model'), '::picker(select)').backgroundColor")).toBe(background)
      const screenshots = process.env.YCODING_MEETING_SCREENSHOTS ?? backend.root
      await mkdir(screenshots, { recursive: true })
      await Bun.write(path.join(screenshots, `meeting-owner-${theme}.png`), Buffer.from(string(record(await browser.cdp.send("Page.captureScreenshot", { format: "png" }, session)).data), "base64"))
      await browser.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, session)
      await browser.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, session)
      expect(await evaluate(browser.cdp, session, "document.activeElement === document.querySelector('#owner-model') && !document.querySelector('#owner-model').matches(':open')")).toBe(true)
    }

    const tampered = new URL(ownerURL)
    tampered.hash = `#key=${viewKey}&owner=${"f".repeat(64)}`
    await navigate(browser.cdp, session, "about:blank")
    await navigate(browser.cdp, session, tampered.href)
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#owner-feedback')?.textContent.includes('owner link is invalid')",
    )
    await waitDOM(browser.cdp, session, "document.querySelector('#connection')?.textContent.includes('Connected')")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#owner-form').hidden")).toBe(true)
    expect((await settingsFile()).analysis.askModel).toEqual({
      providerID: "openai",
      id: "gpt-reasoning-high",
      variant: "low",
    })
    expect((await Bun.file(backend.knowledgeState).json()).writes).toEqual([])
    expect(errors).toEqual([])
    unsubscribe()
  } finally {
    await browser?.close()
    await backend.stop()
  }
}, 240000)

async function launch() {
  const executable = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
  if (!executable || !(await Bun.file(executable).exists()))
    throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to installed Chrome for Testing")
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-owner-chrome-"))
  const child = spawn(
    executable,
    [
      "--headless=new",
      `--user-data-dir=${directory}`,
      "--remote-debugging-pipe",
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-breakpad",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  )
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
  const readable = child.stdio[4]
  const writable = child.stdio[3]
  if (!(readable instanceof Readable) || !(writable instanceof Writable))
    throw new Error("Chrome control pipe unavailable")
  const cdp = connect(readable, writable)
  return {
    cdp,
    async close() {
      cdp.close()
      if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGKILL")
      await exited
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function evaluate(cdp: Client, session: string, expression: string) {
  const result = record(
    await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session, undefined, 15000),
  )
  if (result.exceptionDetails) throw new Error(`Chrome evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
  return record(result.result).value
}

async function navigate(cdp: Client, session: string, url: string) {
  const loaded = Promise.withResolvers<void>()
  const timer = setTimeout(() => loaded.reject(new Error("Meeting view navigation did not load")), 10000)
  const unsubscribe = cdp.subscribe((event) => {
    if (
      event.sessionId === session &&
      (event.method === "Page.loadEventFired" || event.method === "Page.navigatedWithinDocument")
    )
      loaded.resolve()
  })
  try {
    await cdp.send("Page.navigate", { url }, session)
    await loaded.promise
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}

function waitDOM(cdp: Client, session: string, expression: string) {
  return evaluate(
    cdp,
    session,
    `new Promise((resolve,reject)=>{const matches=()=>(${expression});if(matches())return resolve(true);const observer=new MutationObserver(()=>{if(matches()){observer.disconnect();clearTimeout(timer);resolve(true)}});const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Meeting view state did not render'))},10000);observer.observe(document,{subtree:true,attributes:true,childList:true,characterData:true})})`,
  )
}

async function choose(cdp: Client, session: string, selector: string, label: string) {
  await evaluate(
    cdp,
    session,
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw new Error('Control unavailable');const usable=[...node.options].filter((item)=>!item.disabled);const option=usable.find((item)=>item.value===${JSON.stringify(label)}||item.textContent.trim()===${JSON.stringify(label)})??usable.find((item)=>item.textContent.includes(${JSON.stringify(label)}));if(!option)throw new Error('Option unavailable');node.focus();node.value=option.value;node.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  )
}

async function click(cdp: Client, session: string, selector: string) {
  const point = record(
    await evaluate(
      cdp,
      session,
      `(async()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw new Error('Control unavailable');node.scrollIntoView({block:'center'});await new Promise(r=>{requestAnimationFrame(r);setTimeout(r,100)});const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`,
    ),
  )
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, session)
}

async function fill(cdp: Client, session: string, selector: string, value: string) {
  await evaluate(
    cdp,
    session,
    `document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select();true`,
  )
  await cdp.send("Input.insertText", { text: value }, session)
  expect(await evaluate(cdp, session, `document.querySelector(${JSON.stringify(selector)}).value`)).toBe(value)
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value)
}
function string(value: unknown) {
  if (typeof value !== "string") throw new Error("Expected test boundary string")
  return value
}
