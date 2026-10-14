import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { z } from "zod"
import { connect, type Client } from "../../../packages/core/src/browser/isolated-cdp"
import { startBackend } from "./fixture/runtime"
import { viewAssets, viewPolicy } from "../view/assets"

test("Passage captures real tab audio, preserves evidence, recovers failure and finalizes with advisory chat", async () => {
  const backend = await startBackend()
  const captureMessages: { type: string; captureID: string; source?: string; sequence?: number; reason?: string }[] = []
  let audible = false
  const fixture = mediaFixture()
  let browser: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await backend.control({ action: "start", title: "Passage · synthetic Thai / English" })
    const url = backend.url
    const response = await fetch(`${backend.origin}/view`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toBe(viewPolicy)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await response.text()).toBe(viewAssets.get("/view")!.body)
    for (const [asset, expected] of viewAssets) {
      const reply = await fetch(`${backend.origin}${asset}`)
      expect(reply.status).toBe(200)
      expect(await reply.text()).toBe(expected.body)
    }
    browser = await launch()
    const media = await openMedia(browser.cdp, fixture.port)
    const page = string(record(await browser.cdp.send("Target.createTarget", { url: "about:blank" })).targetId)
    const session = string(
      record(await browser.cdp.send("Target.attachToTarget", { targetId: page, flatten: true })).sessionId,
    )
    const errors: string[] = []
    const network: string[] = []
    const reads = new Set<string>()
    let maximumReads = 0
    let trackEndedRequest: string | undefined
    const trackEnded = Promise.withResolvers<void>()
    const unsubscribe = browser.cdp.subscribe((event) => {
      if (event.sessionId !== session) return
      if (event.method === "Runtime.exceptionThrown") errors.push("Page exception")
      if (event.method === "Network.requestWillBeSent") {
        const request = record(event.params?.request)
        const target = new URL(string(request.url))
        if (target.protocol === "data:" || target.href === "about:blank") return
        if (target.origin !== backend.origin || target.search || target.hash) network.push("Unexpected network target")
        if (target.pathname === "/view/capture" && typeof request.postData === "string") {
          const input = z
            .object({
              type: z.string(),
              captureID: z.string(),
              source: z.string().optional(),
              sequence: z.number().optional(),
              reason: z.string().optional(),
              pcm: z.string().optional(),
              sampleRate: z.number().optional(),
            })
            .parse(JSON.parse(request.postData))
          captureMessages.push(input)
          if (input.type === "stop" && input.reason === "track_ended")
            trackEndedRequest = string(event.params?.requestId)
          if (input.type === "audio") {
            const pcm = Buffer.from(input.pcm!, "base64")
            for (let offset = 0; offset < pcm.length; offset += 4)
              if (Math.abs(pcm.readFloatLE(offset)) > 0.001) audible = true
            expect(pcm.length / 4).toBeLessThanOrEqual(input.sampleRate!)
          }
        }
        if (target.pathname === "/view/state") {
          reads.add(string(event.params?.requestId))
          maximumReads = Math.max(maximumReads, reads.size)
        }
      }
      if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed")
        reads.delete(string(event.params?.requestId))
      if (event.method === "Network.loadingFinished" && event.params?.requestId === trackEndedRequest)
        trackEnded.resolve()
      if (event.method === "Network.loadingFailed" && event.params?.requestId === trackEndedRequest)
        trackEnded.reject(new Error("Track-ended Stop request failed"))
    })
    await browser.cdp.send("Runtime.enable", {}, session)
    await browser.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session)
    await browser.cdp.send("Network.enable", {}, session)
    await browser.cdp.send("Page.enable", {}, session)
    await browser.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `window.omitOptionalDiagnostics=true;const nativeFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await nativeFetch(...args);if(window.omitOptionalDiagnostics&&new URL(args[0],location.href).pathname==='/view/state'){const value=await response.json();delete value.findings;value.audio={sources:value.audio?.sources};return new Response(JSON.stringify(value),{status:response.status,headers:response.headers})}return response}`,
      },
      session,
    )
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
    expect(await evaluate(browser.cdp, session, "document.querySelector('#findings-title').textContent")).toBe(
      "Findings · unreported",
    )
    await evaluate(browser.cdp, session, "window.omitOptionalDiagnostics=false;true")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#start').disabled")).toBe(true)
    await click(browser.cdp, session, "#consent")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#start').disabled")).toBe(true)
    await click(browser.cdp, session, "#policy")
    await click(browser.cdp, session, "#microphone")
    await click(browser.cdp, session, "#start")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#segments').textContent.includes('canary rollout') && document.querySelector('#meeting-status').textContent.includes('REC')",
    )
    expect(
      await evaluate(browser.cdp, session, "document.querySelector('#segments').textContent.includes('Temporary')"),
    ).toBe(true)
    expect((await backend.status()).audio.processedSeconds).toBeGreaterThan(0)
    expect((await backend.status()).audio.sources?.microphone).toBe("capturing")
    expect(captureMessages.some((message) => message.type === "audio" && message.source === "microphone")).toBe(true)
    expect(audible).toBe(true)
    await waitDOM(browser.cdp, session, "parseFloat(document.querySelector('#buffered').textContent)>0")
    expect(captureMessages.some((message) => message.type === "audio")).toBe(true)
    expect(
      await evaluate(
        browser.cdp,
        session,
        "!document.querySelector('#consent').checked && !document.querySelector('#policy').checked && !document.querySelector('#ownership').hidden",
      ),
    ).toBe(true)
    expect(await evaluate(browser.cdp, media.session, "!document.querySelector('audio').paused")).toBe(true)
    await click(browser.cdp, session, "#leave-preview")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#leave-dialog').open")).toBe(true)
    await key(browser.cdp, session, "Escape", 27)
    await waitDOM(browser.cdp, session, "!document.querySelector('#leave-dialog').open")
    expect(await evaluate(browser.cdp, session, "document.activeElement.id")).toBe("leave-preview")
    expect(
      await evaluate(
        browser.cdp,
        session,
        "(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()",
      ),
    ).toBe(true)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#findings').open")).toBe(false)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#transcript-window').hidden")).toBe(true)
    const stable = await evaluate(browser.cdp, session, "window.viewRow = document.querySelector('.segment'); true")
    expect(stable).toBe(true)
    await click(browser.cdp, session, "#follow")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#follow').getAttribute('aria-pressed')")).toBe(
      "false",
    )
    for (const width of [320, 390, 767, 768, 769, 820, 844, 1024, 1180, 1440, 1920, 2560])
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
        if (process.env.YCODING_MEETING_RENDER_AUDIT) {
          await evaluate(browser.cdp, session, await Bun.file(process.env.YCODING_MEETING_RENDER_AUDIT).text())
          const audit = record(
            await evaluate(
              browser.cdp,
              session,
              "auditRender({spacing:[0,2,4,8,12,16,24,32],iconSizes:[32],controlHeights:[44,66],minTarget:24,coarseTarget:44})",
            ),
          )
          expect(audit.findings).toEqual([])
        }
        const tracks = record(
          await evaluate(
            browser.cdp,
            session,
            `(()=>{const t=document.querySelector('#transcript').getBoundingClientRect(),c=document.querySelector('#capture-panel').getBoundingClientRect(),i=document.querySelector('#insights').getBoundingClientRect();return {sheet:c.bottom<=t.top&&t.bottom<=i.top&&document.querySelector('.passage').getBoundingClientRect().width<=1040,phone:getComputedStyle(document.querySelector('#capture-panel')).gridTemplateColumns.split(' ').length===1}})()`,
          ),
        )
        expect(tracks.sheet).toBe(true)
        if (width <= 768) expect(tracks.phone).toBe(true)
        expect(
          await evaluate(
            browser.cdp,
            session,
            "['buffered','backlog','processed','lag'].every(id=>document.getElementById(id).checkVisibility()) && !document.querySelector('#runtime-details').open",
          ),
        ).toBe(true)
        expect(await evaluate(browser.cdp, session, "document.querySelector('#buffered').textContent")).toMatch(
          /^\d+\.\d s$/,
        )
        expect(await evaluate(browser.cdp, session, "document.querySelector('#backlog').textContent")).toMatch(
          /^\d+ chunks$/,
        )
        expect(await evaluate(browser.cdp, session, "document.querySelector('#processed').textContent")).toMatch(
          /^\d+\.\d s$/,
        )
        expect(await evaluate(browser.cdp, session, "document.querySelector('#lag').textContent")).toBe("Unreported")
        if (process.env.YCODING_MEETING_SCREENSHOTS && [390, 1024, 1440].includes(width)) {
          await mkdir(process.env.YCODING_MEETING_SCREENSHOTS, { recursive: true })
          await evaluate(browser.cdp, session, "window.scrollTo(0,0);true")
          const size = record(record(await browser.cdp.send("Page.getLayoutMetrics", {}, session)).cssContentSize)
          const shot = record(
            await browser.cdp.send(
              "Page.captureScreenshot",
              {
                format: "png",
                captureBeyondViewport: true,
                clip: { x: 0, y: 0, width, height: Number(size.height), scale: 1 },
              },
              session,
            ),
          )
          await writeFile(
            path.join(process.env.YCODING_MEETING_SCREENSHOTS, `passage-live-${theme}-${width}.png`),
            Buffer.from(string(shot.data), "base64"),
          )
        }
      }
    await browser.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 900, deviceScaleFactor: 1, mobile: false },
      session,
    )
    expect(
      await evaluate(
        browser.cdp,
        session,
        `(async()=>{const sizes=[...document.querySelectorAll('body,body *')].map(node=>[node,node.style.fontSize,getComputedStyle(node).fontSize]);sizes.forEach(([node,original,size])=>{node.style.fontSize=parseFloat(size)*2+'px'});await new Promise(resolve=>requestAnimationFrame(resolve));const overflow=document.documentElement.scrollWidth>innerWidth;sizes.forEach(([node,original])=>{node.style.fontSize=original});return !overflow})()`,
      ),
    ).toBe(true)
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
    const busy = await fetch(`${backend.origin}/view/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${new URL(url).hash.slice(5)}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "concurrent" }),
    })
    expect(busy.status).toBe(409)
    backend.releaseAnswer.resolve()
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
    backend.flags.answerFailing = false
    await click(browser.cdp, session, "#retry-question")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#chat-feedback').textContent.includes('Answered') && !document.querySelector('#ask').disabled",
    )
    const state = await fetch(`${backend.origin}/view/state`, {
      headers: { authorization: `Bearer ${new URL(url).hash.slice(5)}` },
    })
    expect(state.status).toBe(200)
    const asked = record(record(await state.json()).ask).history
    if (!Array.isArray(asked)) throw new Error("Missing Rust Ask history")
    expect(asked.at(-1)).toMatchObject({ question: "fail", status: "answered" })
    expect(await evaluate(browser.cdp, session, "document.querySelector('#question').value")).toBe("unsaved draft")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#question').value")).toBe("unsaved draft")
    await backend.failAudio(true)
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
    await backend.failAudio(false)
    await click(browser.cdp, session, "#retry-audio")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#control-feedback').textContent.includes('retry completed')",
    )
    expect((await backend.status()).audio.backlog).toBe(0)
    expect((await backend.status()).audio.sources?.remote).toBe("inactive")
    expect(await evaluate(browser.cdp, session, "window.viewRow === document.querySelector('.segment')")).toBe(true)
    for (let index = 0; index < 51; index++) {
      const answer = await fetch(`${backend.origin}/view/ask`, {
        method: "POST",
        headers: { authorization: `Bearer ${new URL(url).hash.slice(5)}`, "content-type": "application/json" },
        body: JSON.stringify({ question: `history-${index}` }),
      })
      expect(answer.status).toBe(200)
    }
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelectorAll('.chat-entry').length===50 && document.querySelector('#chat-history').textContent.includes('history-50')",
    )
    expect(
      await evaluate(browser.cdp, session, "document.querySelector('#chat-history').textContent.includes('history-0')"),
    ).toBe(false)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#question').value")).toBe("unsaved draft")
    await backend.control({ action: "start", title: "Second capture" })
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#meeting-title').textContent === 'Second capture' && !document.querySelector('#consent').disabled",
    )
    expect(await evaluate(browser.cdp, session, "document.querySelector('#start').disabled")).toBe(true)
    await click(browser.cdp, session, "#consent")
    await click(browser.cdp, session, "#policy")
    await click(browser.cdp, session, "#start")
    await waitDOM(
      browser.cdp,
      session,
      "!document.querySelector('#stop').disabled && !document.querySelector('#stop').hidden",
    )
    await click(browser.cdp, session, "#stop")
    expect(await evaluate(browser.cdp, session, "document.querySelector('#stop-dialog').open")).toBe(true)
    expect(await evaluate(browser.cdp, session, "document.activeElement.textContent")).toBe("Keep recording")
    await key(browser.cdp, session, "Tab", 9)
    expect(await evaluate(browser.cdp, session, "document.activeElement.id")).toBe("confirm-stop")
    await key(browser.cdp, session, "Tab", 9)
    expect(await evaluate(browser.cdp, session, "document.activeElement.textContent")).toBe("Keep recording")
    expect(
      await evaluate(browser.cdp, session, "getComputedStyle(document.querySelector('#stop-dialog')).animationName"),
    ).toBe("none")
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
    expect(await evaluate(browser.cdp, session, "document.activeElement.id")).toBe("stop")
    expect((await backend.status()).meeting?.status).toBe("recording")
    await click(browser.cdp, session, "#stop")
    await click(browser.cdp, session, "#confirm-stop")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#control-feedback').textContent.includes('Capture stopped')",
    )
    expect((await backend.status()).meeting?.status).toBe("stopped")
    const firstCapture = captureMessages.find((message) => message.type === "start")!.captureID
    for (const source of ["remote", "microphone"]) {
      const sequences = captureMessages
        .filter(
          (message) => message.type === "audio" && message.captureID === firstCapture && message.source === source,
        )
        .map((message) => message.sequence)
      expect(sequences.length).toBeGreaterThan(0)
      expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, sequence) => sequence))
    }
    expect(maximumReads).toBe(1)
    expect(await evaluate(browser.cdp, session, "document.querySelector('#insights').nextElementSibling.id")).toBe(
      "transcript",
    )
    await backend.control({ action: "select", meetingID: "imported" })
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
    await backend.control({ action: "correct", segmentID: "reading-0", text: "Long corrected evidence · ".repeat(120) })
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
    await backend.control({ action: "start", title: "Chrome sharing ended" })
    await waitDOM(browser.cdp, session, "document.querySelector('#meeting-title').textContent==='Chrome sharing ended'")
    await click(browser.cdp, session, "#consent")
    await click(browser.cdp, session, "#policy")
    await click(browser.cdp, session, "#start")
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#capture-feedback').textContent.includes('Recording live')",
    )
    await browser.cdp.send("Target.closeTarget", { targetId: media.target })
    await waitDOM(
      browser.cdp,
      session,
      "document.querySelector('#capture-feedback').textContent.includes('Stop sharing ended capture')",
    )
    const stopDeadline = setTimeout(() => trackEnded.reject(new Error("Track-ended Stop did not settle")), 10000)
    await trackEnded.promise.finally(() => clearTimeout(stopDeadline))
    expect(
      captureMessages.some(
        (message) => message.type === "stop" && "reason" in message && message.reason === "track_ended",
      ),
    ).toBe(true)
    expect((await backend.status()).meeting?.status).toBe("stopped")
    await navigate(browser.cdp, session, "about:blank")
    await navigate(browser.cdp, session, `${backend.origin}/view#key=${"f".repeat(64)}`)
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
    backend.releaseAnswer.resolve()
    await browser?.close()
    fixture.stop(true)
    await backend.stop()
  }
}, 240000)

test("native tab sharing without audio and denied microphone recover without runtime admission", async () => {
  const backend = await startBackend()
  const messages: string[] = []
  const fixture = mediaFixture()
  let browser: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await backend.control({ action: "start", title: "Permission recovery" })
    const url = backend.url
    for (const surface of ["silent", "tab"] as const) {
      browser = await launch(surface)
      {
        await openMedia(browser.cdp, fixture.port)
        if (surface === "tab")
          await browser.cdp.send("Browser.setPermission", {
            origin: backend.origin,
            permission: { name: "microphone" },
            setting: "denied",
          })
      }
      const target = string(record(await browser.cdp.send("Target.createTarget", { url: "about:blank" })).targetId)
      const session = string(
        record(await browser.cdp.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId,
      )
      await browser.cdp.send("Runtime.enable", {}, session)
      await browser.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session)
      await browser.cdp.send("Network.enable", {}, session)
      browser.cdp.subscribe((event) => {
        if (event.sessionId === session && event.method === "Network.requestWillBeSent") {
          const request = record(event.params?.request)
          if (new URL(string(request.url)).pathname === "/view/capture") messages.push(string(request.postData))
        }
      })
      await browser.cdp.send("Page.enable", {}, session)
      await navigate(browser.cdp, session, url)
      await waitDOM(browser.cdp, session, "document.querySelector('#connection').textContent.includes('Connected')")
      await click(browser.cdp, session, "#consent")
      await click(browser.cdp, session, "#policy")
      if (surface === "tab") await click(browser.cdp, session, "#microphone")
      await click(browser.cdp, session, "#start")
      await waitDOM(
        browser.cdp,
        session,
        surface === "silent"
          ? "document.querySelector('#capture-feedback').textContent.includes('Tab audio was not shared')"
          : "document.querySelector('#capture-feedback').textContent.includes('Microphone is blocked')",
      )
      expect(messages).toEqual([])
      expect((await backend.status()).meeting?.status).toBe("ready")
      expect(await evaluate(browser.cdp, session, "document.visibilityState")).toBe("visible")
      expect(
        await evaluate(
          browser.cdp,
          session,
          "document.querySelector('#start').disabled && !document.querySelector('#consent').checked && !document.querySelector('#policy').checked",
        ),
      ).toBe(true)
      if (surface === "tab") {
        await click(browser.cdp, session, "#settings-help")
        expect(
          await evaluate(
            browser.cdp,
            session,
            "document.querySelector('#settings-dialog').textContent.includes(location.origin)",
          ),
        ).toBe(true)
        expect(
          await evaluate(
            browser.cdp,
            session,
            "document.querySelector('#settings-dialog').textContent.includes('including the port')",
          ),
        ).toBe(true)
        await key(browser.cdp, session, "Escape", 27)
        await click(browser.cdp, session, "#tab-only")
        expect(
          await evaluate(
            browser.cdp,
            session,
            "!document.querySelector('#microphone').checked && document.activeElement.id==='consent'",
          ),
        ).toBe(true)
      }
      await browser.close()
      browser = undefined
    }
  } finally {
    await browser?.close()
    fixture.stop(true)
    await backend.stop()
  }
}, 240000)

async function launch(surface: "tab" | "silent" = "tab") {
  const executable = process.env.YCODING_TEST_ISOLATED_BROWSER_CHROME
  if (!executable || !(await Bun.file(executable).exists()))
    throw new Error("Set YCODING_TEST_ISOLATED_BROWSER_CHROME to installed Chrome for Testing")
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-passage-chrome-"))
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
      "--auto-accept-camera-and-microphone-capture",
      "--use-fake-device-for-media-stream",
      "--auto-select-tab-capture-source-by-title=Passage media fixture",
      ...(surface === "silent" ? ["--tab-capture-audio-default-unchecked"] : []),
      "--autoplay-policy=no-user-gesture-required",
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

async function key(cdp: Client, session: string, value: string, code: number) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", { type, key: value, code: value, windowsVirtualKeyCode: code }, session)
}

async function openMedia(cdp: Client, port: number | undefined) {
  if (typeof port !== "number") throw new Error("Audio fixture TCP port unavailable")
  const target = string(record(await cdp.send("Target.createTarget", { url: "about:blank" })).targetId)
  const session = string(record(await cdp.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId)
  await Promise.all([cdp.send("Runtime.enable", {}, session), cdp.send("Page.enable", {}, session)])
  await navigate(cdp, session, `http://127.0.0.1:${port}`)
  expect(await evaluate(cdp, session, "document.querySelector('audio').play().then(()=>true)")).toBe(true)
  return { target, session }
}

function tone() {
  const sampleRate = 48000
  const buffer = Buffer.alloc(44 + sampleRate * 2)
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write("WAVEfmt ", 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(sampleRate * 2, 40)
  for (let index = 0; index < sampleRate; index++)
    buffer.writeInt16LE(Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 6000), 44 + index * 2)
  return buffer
}

function mediaFixture() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/tone.wav")
        return new Response(tone(), { headers: { "content-type": "audio/wav" } })
      return new Response(
        '<!doctype html><title>Passage media fixture</title><h1>Synthetic meeting audio</h1><audio autoplay loop controls src="/tone.wav"></audio>',
        { headers: { "content-type": "text/html" } },
      )
    },
  })
}

async function evaluate(cdp: Client, session: string, expression: string) {
  const result = record(
    await cdp
      .send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session, undefined, 15000)
      .catch((cause: unknown) => {
        throw new Error(`Chrome evaluation did not settle: ${expression}`, { cause })
      }),
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

async function waitDOM(cdp: Client, session: string, expression: string) {
  return evaluate(
    cdp,
    session,
    `new Promise((resolve,reject)=>{const matches=()=>(${expression});if(matches())return resolve(true);const observer=new MutationObserver(()=>{if(matches()){observer.disconnect();clearTimeout(timer);resolve(true)}});const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Meeting view state did not render'))},10000);observer.observe(document,{subtree:true,attributes:true,childList:true,characterData:true})})`,
  ).catch(async (cause: unknown) => {
    const state = await evaluate(
      cdp,
      session,
      "JSON.stringify({visibility:document.visibilityState,capture:document.querySelector('#capture-feedback')?.textContent,control:document.querySelector('#control-feedback')?.textContent,meeting:document.querySelector('#meeting-status')?.textContent})",
    )
    throw new Error(`Meeting view predicate did not settle: ${expression}; state=${state}`, { cause })
  })
}

async function click(cdp: Client, session: string, selector: string) {
  await cdp.send("Page.bringToFront", {}, session)
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
