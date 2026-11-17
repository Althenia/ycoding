import { expect, spyOn, test } from "bun:test"
import { Browser } from "@ycoding-ai/schema/browser"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
import { Cause, Effect, Exit } from "effect"
import { IsolatedBrowserExecutor } from "../../src/browser/isolated-executor"

test.each(["fill", "select"] as const)(
  "does not replay isolated %s after losing an applied control response",
  async (type) => {
    const transport = await import("../../src/browser/isolated-cdp")
    const connect = transport.connect
    let applications = 0
    const hook = spyOn(transport, "connect").mockImplementation((...args) => {
      const client = connect(...args)
      return {
        ...client,
        send: async (...command: Parameters<typeof client.send>) => {
          const result = await client.send(...command)
          const values = command[1]?.arguments
          if (command[0] === "Runtime.callFunctionOn" && Array.isArray(values) && values[1]?.value === true) {
            applications++
            if (applications === 1) throw new Error("Cannot find context with specified id")
          }
          return result
        },
      }
    })
    let changes = 0
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/changed") {
          changes++
          return new Response("recorded")
        }
        return new Response(
          `<!doctype html><title>Recovery fixture</title>
        <input type="date" aria-label="Due" value="2026-11-01" onchange="fetch('/changed')">
        <select aria-label="Choice" onchange="fetch('/changed')"><option value="a">A</option><option value="b">B</option></select>`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    let runtime: IsolatedBrowserExecutor.Runtime | undefined
    try {
      runtime = await Effect.runPromise(
        Effect.gen(function* () {
          const executor = yield* IsolatedBrowserExecutor.Service
          return yield* executor.launch({
            instanceID: IsolatedBrowser.InstanceID.create(),
            tabID: Browser.TabID.create(),
            url: origin,
          })
        }).pipe(Effect.provide(IsolatedBrowserExecutor.layer)),
      )
      const observation = await Effect.runPromise(runtime.observe)
      const element = observation.elements.find((item) => item.name === (type === "fill" ? "Due" : "Choice"))
      expect(element).toBeDefined()
      if (!element) throw new Error("Synthetic control was not observed")
      const action =
        type === "fill" ? { type, ref: element.ref, text: "2026-11-17" } : { type, ref: element.ref, values: ["b"] }
      const outcome = await Effect.runPromiseExit(runtime.action(action, [origin]))
      expect({ applications, failed: Exit.isFailure(outcome) }).toEqual({ applications: 1, failed: true })
      if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toMatchObject({ phase: "postdispatch" })
      await Effect.runPromise(runtime.action({ type: "wait", load: "networkidle" }, [origin]))
      expect(changes).toBe(1)
      const fresh = await Effect.runPromise(runtime.observe)
      const recovered = fresh.elements.find((item) => item.name === element.name)
      expect(recovered).toMatchObject({ value: type === "fill" ? "2026-11-17" : "B" })
      expect(applications).toBe(1)
      if (!recovered) throw new Error("Synthetic control was not recovered")
      const explicit = await Effect.runPromiseExit(runtime.action({ ...action, ref: recovered.ref }, [origin]))
      expect(Exit.isSuccess(explicit)).toBe(true)
      expect(applications).toBe(2)
      await Effect.runPromise(runtime.action({ type: "wait", load: "networkidle" }, [origin]))
      expect(changes).toBe(2)
    } finally {
      if (runtime) await Effect.runPromise(runtime.close)
      await fixture.stop(true)
      hook.mockRestore()
    }
  },
  30_000,
)
