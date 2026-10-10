import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { z } from "zod"
import { connect, type Client } from "../../../packages/core/src/browser/isolated-cdp"
import { startBridge } from "../src/bridge"
import { meetingConfigSchema } from "../src/config"
import { createMeetingQuestions } from "../src/plugin"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"
import { viewAssets, viewPolicy } from "../view/assets"

test("Telemetry cockpit renders reported/Unreported metrics, operations-first reflow, recovery/stop and advisory chat", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-view-"))
  const store = new MeetingStore(path.join(directory, "meeting.sqlite"))
  let failing = false
  let answerFailing = true
  let reportFindings = false
  let reportMetrics = false
  const releaseAnswer = Promise.withResolvers<void>()
  const runtime = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse({
      analysis: { incremental: false },
      knowledge: { mcpEnabled: false },
      streaming: { vad: false },
      transcription: { chunkSeconds: 1, overlapSeconds: 0 },
    }),
    createSession: async () => "view-test-session",
    generate: async (_session, prompt) => {
      if (prompt.includes('"question":"fail"') && answerFailing) throw new Error("Provider unavailable")
      if (prompt.includes('"question":"hold"')) await releaseAnswer.promise
      if (prompt.includes('"question":')) return "Advisory: rollout ยังเป็นข้อเสนอ · cite supplied transcript evidence."
      return JSON.stringify({ summary: "สรุป rollout · unconfirmed", findings: [], proposals: [] })
    },
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("View must not use tools")
      },
    },
    providerFactory: (config) => ({
      id: config.provider,
      initialize: async () => undefined,
      dispose: async () => undefined,
      healthCheck: async () => ({ healthy: true, initialized: true, metrics: { device: "test-device" } }),
      transcribe: async (chunk) => {
        if (failing) throw new Error("inference_failed")
        return [
          {
            startMs: chunk.startMs,
            endMs: chunk.startMs + 900,
            text: "เราจะทดสอบ canary rollout และ transcription latency",
          },
        ]
      },
    }),
  })
  const questions = createMeetingQuestions(runtime)
  const controller = "v".repeat(64)
  const bridge = await startBridge({
    controlToken: controller,
    onView: () => ({
      ...questions.state(),
      findings: reportFindings ? runtime.status().findings : undefined,
      ...(reportMetrics ? {} : { audio: { sources: runtime.status().audio.sources } }),
    }),
    onAsk: (question) => questions.ask(question),
    onControl: async (value) => {
      if (record(value).action === "pair") {
        runtime.pairing = { url: bridge.url, ...bridge.pairing() }
        return questions.state()
      }
      return runtime.control(value)
    },
    onCapture: (input) => runtime.capture(input),
    onPaired: () => {
      runtime.pairing = undefined
    },
  })
  let browser: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await runtime.control({ action: "start", title: "Telemetry · synthetic Thai / English" })
    runtime.pairing = { url: bridge.url, ...bridge.pairing() }
    const urlReply = await fetch(`${bridge.url}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${controller}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "view" }),
    })
    const url = string(record(await urlReply.json()).url)
    const response = await fetch(`${bridge.url}/view`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toBe(viewPolicy)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await response.text()).toBe(viewAssets.get("/view")!.body)
    for (const [asset, expected] of viewAssets) {
      const reply = await fetch(`${bridge.url}${asset}`)
      expect(reply.status).toBe(200)
      expect(await reply.text()).toBe(expected.body)
    }
    browser = await launch()
    const page = string(record(await browser.cdp.send("Target.createTarget", { url: "about:blank" })).targetId)
    const session = string(
      record(await browser.cdp.send("Target.attachToTarget", { targetId: page, flatten: true })).sessionId,
    )
    const errors: string[] = []
    const network: string[] = []
    const unsubscribe = browser.cdp.subscribe((event) => {
      if (event.sessionId !== session) return
      if (event.method === "Runtime.exceptionThrown") errors.push("Page exception")
      if (event.method === "Network.requestWillBeSent") {
        const request = record(event.params?.request)
        const target = new URL(string(request.url))
        if (target.protocol === "data:" || target.href === "about:blank") return
        if (target.origin !== bridge.url || target.search || target.hash) network.push("Unexpected network target")
      }
    })
    await browser.cdp.send("Runtime.enable", {}, session)
    await browser.cdp.send("Network.enable", {}, session)
    await browser.cdp.send("Page.enable", {}, session)
    await browser.cdp.send("Page.navigate", { url }, session)
    await waitDOM(browser.cdp, session, "document.querySelector('#connection')?.textContent.includes('Connected')")
    expect(await evaluate(browser.cdp, session, "location.hash")).toBe("")
    expect(
      await evaluate(
        browser.cdp,
        session,
        "['buffered','backlog','processed','lag'].every(id=>{const n=document.getElementById(id);return n.textContent==='Unreported' && n.checkVisibility()})",
      ),
    ).toBe(true)
    reportMetrics = true
    expect(await evaluate(browser.cdp, session, "document.querySelector('#findings-title').textContent")).toBe(
      "Findings · unreported",
    )
    reportFindings = true
    expect(await evaluate(browser.cdp, session, "document.querySelector('#pair-code').textContent")).toBe(
      runtime.pairing.code,
    )
    expect(
      await evaluate(
        browser.cdp,
        session,
        "document.querySelector('#pair-countdown').textContent.includes('remaining')",
      ),
    ).toBe(true)
    await click(browser.cdp, session, "#new-code")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#control-feedback').textContent.includes('New pairing code ready')",
    )
    const origin = `chrome-extension://${"a".repeat(32)}`
    const pairing = await fetch(`${bridge.url}/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: runtime.pairing.code }),
    })
    const captureToken = string(record(await pairing.json()).token)
    const capture = async (value: unknown) => {
      const result = await fetch(`${bridge.url}/capture`, {
        method: "POST",
        headers: { origin, authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      })
      expect(result.status).toBe(200)
      return result.json()
    }
    await capture({ type: "start", captureID: "first", tabID: 1, microphone: false, consent: true })
    const packet = (sequence: number) => ({
      type: "audio",
      captureID: "first",
      source: "remote",
      sequence,
      startMs: sequence * 1000,
      sampleRate: 16000,
      pcm: Buffer.from(new Float32Array(16000).fill(0.2).buffer).toString("base64"),
    })
    await capture(packet(0))
    await runtime.settled()
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#segments').textContent.includes('canary rollout') && document.querySelector('#meeting-status').textContent.includes('REC')",
    )
    expect(
      await evaluate(browser.cdp, session, "document.querySelector('#segments').textContent.includes('Temporary')"),
    ).toBe(true)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#findings').open")).toBe(false)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#transcript-window').hidden")).toBe(true)
    const stable = await evaluate(browser.cdp, session, "window.viewRow = document.querySelector('.segment'); true")
    expect(stable).toBe(true)
    await click(browser.cdp, session, "#follow")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#follow').getAttribute('aria-pressed')")).toBe(
      "false",
    )
    for (const width of [390, 1024, 1440])
      for (const theme of ["light", "dark"]) {
        await browser.cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width, height: 900, deviceScaleFactor: 1, mobile: false },
          session,
        )
        await browser.cdp.send(
          "Emulation.setEmulatedMedia",
          {
            features: [
              { name: "prefers-color-scheme", value: theme },
              { name: "prefers-reduced-motion", value: "reduce" },
            ],
          },
          session,
        )
        const layout = record(
          await evaluate(
            browser.cdp,
            session,
            `(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(r));const image=document.querySelector('.brand img');return {overflow:document.documentElement.scrollWidth>innerWidth,logo:image.complete&&image.naturalWidth>0,controls:[...document.querySelectorAll('button,summary')].filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().height>=44),bg:getComputedStyle(document.body).backgroundColor}})()`,
          ),
        )
        expect(layout.overflow).toBe(false)
        expect(layout.logo).toBe(true)
        expect(layout.controls).toBe(true)
        expect(layout.bg).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(11, 17, 21)")
        const tracks = record(
          await evaluate(
            browser.cdp,
            session,
            `(()=>{const operations=document.querySelector('#operations'),insights=document.querySelector('#insights-column');if(!operations||!insights)return {desktop:false,phone:false};const t=document.querySelector('#transcript').getBoundingClientRect(),o=operations.getBoundingClientRect(),i=insights.getBoundingClientRect();return {desktop:o.right<=t.left&&t.right<=i.left&&t.width>o.width&&t.width>i.width,phone:o.bottom<=t.top&&t.bottom<=i.top}})()`,
          ),
        )
        expect(width === 390 ? tracks.phone : tracks.desktop).toBe(true)
        expect(
          await evaluate(
            browser.cdp,
            session,
            "['buffered','backlog','processed','lag'].every(id=>document.getElementById(id).checkVisibility()) && !document.querySelector('#runtime-details').open",
          ),
        ).toBe(true)
        expect(await evaluate(browser.cdp, session, "document.querySelector('#buffered').textContent")).toBe(
          `${runtime.status().audio.bufferedSeconds.toFixed(1)} s`,
        )
        expect(await evaluate(browser.cdp, session, "document.querySelector('#backlog').textContent")).toBe(
          `${runtime.status().audio.backlog} chunks`,
        )
        expect(await evaluate(browser.cdp, session, "document.querySelector('#processed').textContent")).toBe(
          `${runtime.status().audio.processedSeconds.toFixed(1)} s`,
        )
        expect(await evaluate(browser.cdp, session, "document.querySelector('#lag').textContent")).toBe("Unreported")
        if (process.env.YCODING_MEETING_SCREENSHOTS) {
          await mkdir(process.env.YCODING_MEETING_SCREENSHOTS, { recursive: true })
          await evaluate(browser.cdp, session, "window.scrollTo(0,0);true")
          const shot = record(await browser.cdp.send("Page.captureScreenshot", { format: "png" }, session))
          await writeFile(
            path.join(process.env.YCODING_MEETING_SCREENSHOTS, `telemetry-live-${theme}-${width}.png`),
            Buffer.from(string(shot.data), "base64"),
          )
        }
      }
    await click(browser.cdp, session, "#ask")
    expect(
      await evaluate(
        browser.cdp,
        session,
        "document.querySelector('#chat-feedback').textContent.includes('Enter a question')",
      ),
    ).toBe(true)
    await fill(browser.cdp, session, "#question", "What is the rollout proposal?")
    await click(browser.cdp, session, "#ask")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#chat-history').textContent.includes('Advisory: rollout')",
    )
    await fill(browser.cdp, session, "#question", "hold")
    await click(browser.cdp, session, "#ask")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#ask').disabled && document.querySelector('#chat-feedback').textContent.includes('one question')",
    )
    releaseAnswer.resolve()
    await waitDOM(browser.cdp, session, "!document.querySelector('#ask').disabled")
    await fill(browser.cdp, session, "#question", "fail")
    await click(browser.cdp, session, "#ask")
    await waitDOM(browser.cdp, session, "!document.querySelector('#retry-question').hidden")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#chat-history').textContent.includes('provider could not answer')",
    )
    expect(
      await evaluate(
        browser.cdp,
        session,
        "document.querySelector('#chat-history').textContent.includes('provider could not answer')",
      ),
    ).toBe(true)
    await fill(browser.cdp, session, "#question", "unsaved draft")
    answerFailing = false
    await click(browser.cdp, session, "#retry-question")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#chat-feedback').textContent.includes('Answered') && !document.querySelector('#ask').disabled",
    )
    expect(questions.state().ask.history.at(-1)?.question).toBe("fail")
    expect(questions.state().ask.history.at(-1)?.status).toBe("answered")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#question').value")).toBe("unsaved draft")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#question').value")).toBe("unsaved draft")
    failing = true
    await capture(packet(1))
    await runtime.settled()
    await waitDOM(browser.cdp, session, "!document.querySelector('#retry-audio').hidden")
    expect(
      await evaluate(browser.cdp, session, "document.querySelector('#retry-audio').getClientRects().length>0"),
    ).toBe(true)
    expect(
      await evaluate(
        browser.cdp,
        session,
        "document.querySelector('#recovery-text').textContent.includes('Capture remains stopped')",
      ),
    ).toBe(true)
    failing = false
    await click(browser.cdp, session, "#retry-audio")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#control-feedback').textContent.includes('retry completed')",
    )
    expect(runtime.status().audio.backlog).toBe(0)
    expect(runtime.status().audio.sources?.remote).toBe("inactive")
    expect(await evaluate(browser.cdp, session, "window.viewRow === document.querySelector('.segment')")).toBe(true)
    await runtime.control({ action: "start", title: "Second capture" })
    await capture({ type: "start", captureID: "second", tabID: 1, microphone: false, consent: true })
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#meeting-title').textContent === 'Second capture' && !document.querySelector('#stop').disabled",
    )
    await click(browser.cdp, session, "#stop")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#stop-dialog').open")).toBe(true)
    await browser.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      session,
    )
    await browser.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      session,
    )
    await waitDOM(browser.cdp, session, "!document.querySelector('#stop-dialog').open")
    expect(runtime.status().meeting?.status).toBe("recording")
    await click(browser.cdp, session, "#stop")
    await click(browser.cdp, session, "#confirm-stop")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#control-feedback').textContent.includes('Capture stopped')",
    )
    expect(runtime.status().meeting?.status).toBe("stopped")
    const stoppedMeeting = runtime.status().meeting!
    const firstSequence = store.nextSequence(stoppedMeeting.id)
    for (let index = 0; index < 24; index++)
      store.putSegment({
        id: `reading-${index}`,
        meetingID: stoppedMeeting.id,
        sequence: firstSequence + index,
        source: "remote",
        speakerID: "remote-unknown",
        startMs: index * 1000,
        endMs: (index + 1) * 1000,
        rawText: `Evidence ${index} · canary rollout ยังไม่ยืนยัน`,
        text: `Evidence ${index} · canary rollout ยังไม่ยืนยัน`,
        state: "final",
        model: "fixture",
        createdAt: new Date().toISOString(),
      })
    await waitDOM(browser.cdp, session, "document.querySelectorAll('.segment').length>=24")
    await evaluate(
      browser.cdp,
      session,
      "document.querySelector('[data-segment-id=\"reading-12\"]').scrollIntoView({block:'center'});true",
    )
    const anchorTop = Number(
      await evaluate(
        browser.cdp,
        session,
        "document.querySelector('[data-segment-id=\"reading-12\"]').getBoundingClientRect().top",
      ),
    )
    store.correctSegment("reading-0", "Long corrected evidence · ".repeat(120))
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('[data-segment-id=\"reading-0\"]').textContent.includes('Long corrected evidence')",
    )
    expect(
      Math.abs(
        Number(
          await evaluate(
            browser.cdp,
            session,
            "document.querySelector('[data-segment-id=\"reading-12\"]').getBoundingClientRect().top",
          ),
        ) - anchorTop,
      ),
    ).toBeLessThanOrEqual(1)
    await navigate(browser.cdp, session, "about:blank")
    await navigate(browser.cdp, session, `${bridge.url}/view#key=${"f".repeat(64)}`)
    await waitDOM(browser.cdp, session, "document.querySelector('#connection')?.textContent.includes('key is invalid')")
    expect(
      await evaluate(
        browser.cdp,
        session,
        "document.querySelector('#stop').disabled && document.querySelector('#ask').disabled && location.hash === ''",
      ),
    ).toBe(true)
    expect(errors).toEqual([])
    expect(network).toEqual([])
    unsubscribe()
  } finally {
    releaseAnswer.resolve()
    await browser?.close()
    await bridge.close()
    await questions.settled()
    await runtime.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

async function launch() {
  const executable = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
  if (!executable || !(await Bun.file(executable).exists()))
    throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to installed Chrome for Testing")
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-telemetry-chrome-"))
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
      if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGTERM")
      await exited
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function evaluate(cdp: Client, session: string, expression: string) {
  const result = record(
    await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      session,
      undefined,
      15000,
    ),
  )
  if (result.exceptionDetails) throw new Error(`Chrome evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
  return record(result.result).value
}

async function navigate(cdp: Client, session: string, url: string) {
  const loaded = Promise.withResolvers<void>()
  const timer = setTimeout(() => loaded.reject(new Error("Meeting view navigation did not load")), 10000)
  const unsubscribe = cdp.subscribe((event) => {
    if (event.sessionId === session && event.method === "Page.loadEventFired") loaded.resolve()
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

async function click(cdp: Client, session: string, selector: string) {
  const point = record(
    await evaluate(
      cdp,
      session,
      `(async()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw new Error('Control unavailable');node.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(r));const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`,
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
