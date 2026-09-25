import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client/promise"
import { runInteractiveDeferredMode } from "../../src/mini/runtime"
import type { LifecycleInput } from "../../src/mini/runtime.lifecycle"
import type { FooterEvent, MiniHost } from "../../src/mini/types"
import { catalogModel, catalogProvider, stubCatalogLists } from "./fixture/catalog"
import { createFooterApiFixture } from "./fixture/footer-api"

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve(data)
}

function host(): MiniHost {
  return {
    terminal: { stdin: process.stdin },
    platform: "linux",
    stdout: { write() {} },
    files: { readText: async () => "" },
    editor: { open: async () => undefined },
    paths: { home: "/home/test" },
    signals: {
      sigint: { subscribe: () => () => {} },
      sigusr2: { subscribe: () => () => {} },
    },
    startup: { showTiming: false, now: () => 0 },
    diagnostics: {},
    preferences: {
      resolveVariant: async () => undefined,
      saveVariant: async () => {},
    },
  }
}

function footer(events: FooterEvent[] = []) {
  return createFooterApiFixture({ events }).api
}

afterEach(() => {
  mock.restore()
})

describe("run interactive runtime", () => {
  test("Mini pairing uses the active Session and only starts after an explicit request", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const api = footer()
    const streamStarted = defer<void>()
    let lifecycle!: LifecycleInput
    const started = spyOn(sdk.browser, "start").mockImplementation(async () => ({
      secret: "one-time-code",
      expiresAt: Date.now() + 120_000,
    }))
    stubCatalogLists(sdk)

    const task = runInteractiveDeferredMode(
      {
        host: host(),
        sdk,
        directory: "/tmp",
        browserAddress: () => "http://127.0.0.1:43094",
        target: async () => ({
          sessionID: "ses_chrome",
          location: { directory: "/tmp", project: { id: "pro-1", directory: "/tmp" } },
          agent: "build",
          model: { providerID: "test", modelID: "model" },
          variant: undefined,
          resume: false,
        }),
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        variant: undefined,
        files: [],
      },
      {
        createRuntimeLifecycle: async (input) => {
          lifecycle = input
          return {
            footer: api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => {
            streamStarted.resolve()
            return {
              runPromptTurn: async () => {},
              interruptActiveTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => String(error),
        }),
      },
    )

    try {
      await streamStarted.promise
      expect(lifecycle.browserAddress?.()).toBe("http://127.0.0.1:43094")
      expect(started).not.toHaveBeenCalled()
      const controller = new AbortController()
      expect(await lifecycle.onChromePair?.(controller.signal)).toMatchObject({ secret: "one-time-code" })
      expect(started).toHaveBeenCalledTimes(1)
      expect(started).toHaveBeenCalledWith({ sessionID: "ses_chrome" }, { signal: controller.signal })
    } finally {
      api.close()
      await task
    }
  })

  test("switching to a model without the saved variant displays and submits no stale variant", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const footerFixture = createFooterApiFixture()
    const api = footerFixture.api
    const modelLoaded = defer<void>()
    const promptReady = defer<void>()
    let selectModel!: NonNullable<LifecycleInput["onModelSelect"]>
    const submitted: Array<{ model: unknown; variant: string | undefined }> = []
    const event = api.event.bind(api)
    const onPrompt = api.onPrompt.bind(api)
    api.onPrompt = (fn) => {
      promptReady.resolve()
      return onPrompt(fn)
    }
    api.event = (value) => {
      event(value)
      if (value.type === "model" && value.selection?.modelID === "model-a") modelLoaded.resolve()
    }
    const miniHost = host()
    miniHost.preferences.resolveVariant = async (model) => (model?.modelID === "model-b" ? "high" : undefined)
    stubCatalogLists(sdk, {
      providers: [catalogProvider("test", "Test")],
      models: [
        catalogModel({ id: "model-a", providerID: "test", variants: ["high"] }),
        catalogModel({ id: "model-b", providerID: "test" }),
      ],
    })

    const task = runInteractiveDeferredMode(
      {
        host: miniHost,
        sdk,
        directory: "/tmp",
        target: async () => ({
          sessionID: "ses-variant-switch",
          location: { directory: "/tmp", project: { id: "pro-1", directory: "/tmp" } },
          agent: "build",
          model: { providerID: "test", modelID: "model-a" },
          variant: "high",
          resume: false,
        }),
        agent: "build",
        model: { providerID: "test", modelID: "model-a" },
        variant: "high",
        files: [],
        thinking: false,
      },
      {
        createRuntimeLifecycle: async (input) => {
          selectModel = input.onModelSelect!
          return {
            footer: api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async (input) => {
              submitted.push({ model: input.model, variant: input.variant })
              api.close()
            },
            interruptActiveTurn: async () => {},
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => String(error),
        }),
      },
    )

    try {
      await modelLoaded.promise
      const selected = await selectModel({ providerID: "test", modelID: "model-b" })
      expect(selected).toMatchObject({ modelLabel: "model-b · Test", variant: undefined })
      await promptReady.promise
      footerFixture.submit("use model b")
      await task

      expect(submitted).toEqual([{ model: { providerID: "test", modelID: "model-b" }, variant: undefined }])
    } finally {
      api.close()
      await task
    }
  })

  test("routes form responses to their owners with global location and local settlement", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const api = footer()
    const streamStarted = defer<void>()
    let lifecycle!: LifecycleInput
    const settled: Array<{ sessionID: string; formID: string }> = []
    stubCatalogLists(sdk)
    const reply = spyOn(sdk.form, "reply").mockImplementation(() => ok(undefined))

    const task = runInteractiveDeferredMode(
      {
        host: host(),
        sdk,
        directory: "/tmp",
        target: async () => ({
          sessionID: "ses_root",
          location: { directory: "/tmp", project: { id: "pro-1", directory: "/tmp" } },
          agent: "build",
          model: { providerID: "test", modelID: "model" },
          variant: undefined,
          resume: false,
        }),
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        variant: undefined,
        files: [],
        thinking: false,
      },
      {
        createRuntimeLifecycle: async (input) => {
          lifecycle = input
          return {
            footer: api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => {
            streamStarted.resolve()
            return {
              runPromptTurn: async () => {},
              interruptActiveTurn: async () => {},
              selectSubagent: () => {},
              settleForm: (sessionID: string, formID: string) => settled.push({ sessionID, formID }),
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )
    await streamStarted.promise

    await lifecycle.onFormReply({
      sessionID: "global",
      formID: "frm_global",
      answer: { value: "yes" },
      location: { directory: "/remote work", workspaceID: "wrk_1" },
    })
    expect(reply).toHaveBeenCalledWith(
      {
        sessionID: "global",
        formID: "frm_global",
        answer: { value: "yes" },
        location: { directory: "/remote work", workspaceID: "wrk_1" },
      },
      {
        headers: {
          "x-ycoding-directory": "%2Fremote%20work",
          "x-ycoding-workspace": "wrk_1",
        },
      },
    )
    expect(settled).toEqual([{ sessionID: "global", formID: "frm_global" }])

    reply.mockImplementationOnce(() => Promise.reject({ _tag: "FormInvalidAnswerError", message: "Invalid answer" }))
    await expect(
      lifecycle.onFormReply({ sessionID: "ses_child", formID: "frm_invalid", answer: { value: 3 } }),
    ).rejects.toEqual({ _tag: "FormInvalidAnswerError", message: "Invalid answer" })
    expect(settled.some((item) => item.formID === "frm_invalid")).toBe(false)

    api.close()
    await task
  })

  test("resolves the deferred session only after first paint", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const lifecycleStarted = defer<void>()
    const painted = defer<void>()
    const api = footer()
    let resolved = 0
    api.idle = () => painted.promise
    stubCatalogLists(sdk)

    const task = runInteractiveDeferredMode(
      {
        host: host(),
        sdk,
        directory: "/tmp",
        target: async () => {
          resolved++
          api.close()
          return {
            sessionID: "ses-deferred",
            sessionTitle: "Deferred",
            location: { directory: "/tmp", project: { id: "pro-1", directory: "/tmp" } },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5" },
            variant: undefined,
            resume: false,
          }
        },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: undefined,
        files: [],
        thinking: false,
      },
      {
        createRuntimeLifecycle: async () => {
          lifecycleStarted.resolve()
          return {
            footer: api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
      },
    )

    await lifecycleStarted.promise
    expect(resolved).toBe(0)
    painted.resolve()
    await task
    expect(resolved).toBe(1)
  })

  test("restores deferred session history and model after first paint", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const lifecycleStarted = defer<void>()
    const painted = defer<void>()
    const events: FooterEvent[] = []
    const api = footer(events)
    api.idle = () => painted.promise
    const event = api.event
    api.event = (value) => {
      event(value)
      if (value.type === "model") api.close()
    }
    spyOn(sdk.session, "get").mockImplementation(
      () =>
        ok({
          id: "ses-resume",
          projectID: "pro-1",
          title: "Resume",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: "/tmp" },
          model: { providerID: "openai", id: "gpt-5", variant: "high" },
        }) as never,
    )
    spyOn(sdk.message, "list").mockImplementation(
      () =>
        ok([{ id: "msg-user", type: "user", text: "previous prompt", time: { created: 1 } }]) as never,
    )
    stubCatalogLists(sdk, {
      providers: [catalogProvider("openai", "OpenAI")],
      models: [
        catalogModel({
          id: "gpt-5",
          providerID: "openai",
          name: "Little Frank",
          variants: ["high"],
        }),
      ],
    })

    const task = runInteractiveDeferredMode(
      {
        host: host(),
        sdk,
        directory: "/tmp",
        target: async () => ({
          sessionID: "ses-resume",
          sessionTitle: "Resume",
          location: { directory: "/tmp", project: { id: "pro-1", directory: "/tmp" } },
          agent: "review",
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: undefined,
          resume: true,
        }),
        agent: "build",
        model: undefined,
        variant: undefined,
        files: [],
        thinking: false,
      },
      {
        createRuntimeLifecycle: async () => {
          lifecycleStarted.resolve()
          return {
            footer: api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
      },
    )

    await lifecycleStarted.promise
    expect(sdk.session.get).not.toHaveBeenCalled()
    painted.resolve()
    await task

    expect(events).toContainEqual({
      type: "history",
      history: [{ text: "previous prompt", parts: [] }],
    })
    expect(events).toContainEqual({ type: "agent", agent: "review" })
    expect(events).toContainEqual({
      type: "model",
      model: "Little Frank · OpenAI · high",
      selection: { providerID: "openai", modelID: "gpt-5" },
    })
  })

  test("aborts deferred resume history on close and uses the cached exit title", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const painted = defer<void>()
    const readsStarted = defer<void>()
    const api = footer()
    api.idle = () => painted.promise
    let reads = 0
    let aborted = 0
    let closedTitle: string | undefined
    const pending = (signal: AbortSignal | undefined) =>
      new Promise<never>((_resolve, reject) => {
        reads++
        if (reads === 2) readsStarted.resolve()
        signal?.addEventListener(
          "abort",
          () => {
            aborted++
            reject(new Error("resume history aborted"))
          },
          { once: true },
        )
      })
    const messages = spyOn(sdk.message, "list").mockImplementation(
      (_request, options) => pending(options?.signal) as never,
    )
    const session = spyOn(sdk.session, "get").mockImplementation(
      (_request, options) => pending(options?.signal) as never,
    )
    stubCatalogLists(sdk)

    const task = runInteractiveDeferredMode(
      {
        host: host(),
        sdk,
        directory: "/tmp",
        target: async () => ({
          sessionID: "ses-resume-abort",
          sessionTitle: "Cached title",
          location: { directory: "/tmp", project: { id: "pro-1", directory: "/tmp" } },
          agent: "build",
          model: undefined,
          variant: undefined,
          resume: true,
        }),
        agent: "build",
        model: undefined,
        variant: undefined,
        files: [],
        thinking: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: api,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: async (input) => {
            closedTitle = input.sessionTitle
          },
        }),
      },
    )

    painted.resolve()
    await readsStarted.promise
    api.close()
    await task

    expect(aborted).toBe(2)
    expect(messages).toHaveBeenCalledWith(
      { sessionID: "ses-resume-abort" },
      { signal: expect.any(AbortSignal) },
    )
    expect(session).toHaveBeenCalledTimes(1)
    expect(session).toHaveBeenCalledWith({ sessionID: "ses-resume-abort" }, { signal: expect.any(AbortSignal) })
    expect(closedTitle).toBe("Cached title")
  })

  test("adopts the deferred target location for catalogs, files, and runtime placement", async () => {
    const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
    const lifecycleStarted = defer<void>()
    const painted = defer<void>()
    const api = footer()
    api.idle = () => painted.promise
    let targets = 0
    let getDirectory: (() => string) | undefined
    let findFiles: ((query: string) => Promise<string[]>) | undefined
    let transportLocation: unknown
    const catalogs = stubCatalogLists(sdk, {
      location: { directory: "/session", workspaceID: "work-1" },
    })
    const fileFind = spyOn(sdk.file, "find").mockResolvedValue({
      location: {
        directory: "/session",
        workspaceID: "work-1",
        project: { id: "pro-1", directory: "/session" },
      },
      data: [{ path: "src/index.ts", type: "file" }],
    } as never)

    const task = runInteractiveDeferredMode(
      {
        host: host(),
        sdk,
        directory: "/launch",
        target: async () => {
          targets++
          return {
            sessionID: "ses-target",
            location: {
              directory: "/session",
              workspaceID: "work-1",
              project: { id: "location-project", directory: "/session" },
            },
            agent: "review",
            model: { providerID: "openai", modelID: "gpt-5" },
            variant: "high",
            resume: false,
          }
        },
        agent: undefined,
        model: undefined,
        variant: undefined,
        files: [],
      },
      {
        createRuntimeLifecycle: async (input) => {
          getDirectory = input.getDirectory
          findFiles = input.findFiles
          lifecycleStarted.resolve()
          return {
            footer: api,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async (input) => {
            transportLocation = input.location
            await findFiles?.("index")
            setTimeout(() => input.footer.close(), 0)
            return {
              runPromptTurn: async () => {},
              interruptActiveTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => String(error),
        }),
      },
    )

    await lifecycleStarted.promise
    expect(targets).toBe(0)
    expect(getDirectory?.()).toBe("/launch")
    painted.resolve()
    await task

    const query = { location: { directory: "/session", workspace: "work-1" } }
    expect(getDirectory?.()).toBe("/session")
    expect(transportLocation).toMatchObject({ directory: "/session", workspaceID: "work-1" })
    expect(catalogs.provider).toHaveBeenCalledWith(query, { signal: expect.any(AbortSignal) })
    expect(catalogs.model).toHaveBeenCalledWith(query, { signal: expect.any(AbortSignal) })
    expect(catalogs.agent).toHaveBeenCalledWith(query, { signal: expect.any(AbortSignal) })
    expect(catalogs.reference).toHaveBeenCalledWith(query, { signal: expect.any(AbortSignal) })
    expect(catalogs.command).toHaveBeenCalledWith(query, { signal: expect.any(AbortSignal) })
    expect(catalogs.skill).toHaveBeenCalledWith(query, { signal: expect.any(AbortSignal) })
    expect(fileFind).toHaveBeenCalledWith({ query: "index", type: "file", ...query })
  })
})
