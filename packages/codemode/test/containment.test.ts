import { describe, expect, spyOn, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

const run = (code: string, limits: CodeMode.ExecutionLimits = {}) =>
  Effect.runPromise(CodeMode.execute({ code, tools: {}, limits }))

describe("execution containment", () => {
  test("validates step and regex budgets", () => {
    for (const key of ["maxSteps", "regexTimeoutMs"] as const) {
      for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => CodeMode.execute({ code: "return 1", limits: { [key]: value } })).toThrow(RangeError)
      }
    }
  })

  test("step exhaustion is deterministic and cannot be caught or overridden", async () => {
    const code = `try { for (let i = 0; i < 1000; i++) {} } catch (e) { return "caught" } finally { return "finally" }`
    const first = await run(code, { maxSteps: 100 })
    expect(first).toMatchObject({ ok: false, error: { kind: "StepLimitExceeded" } })
    expect(await run(code, { maxSteps: 100 })).toEqual(first)
    expect(await run("return 1", { maxSteps: 100 })).toMatchObject({ ok: true, value: 1 })
    expect(await run("let n = 0; for (let i = 0; i < 1000; i++) n++; return n")).toMatchObject({
      ok: true,
      value: 1000,
    })
  })

  test("tool waiting consumes no evaluator steps", async () => {
    const tool = Tool.make({
      description: "Wait",
      input: Schema.Struct({}),
      output: Schema.Number,
      run: () => Effect.as(Effect.sleep(80), 7),
    })
    expect(
      await Effect.runPromise(
        CodeMode.execute({ code: "return await tools.wait({})", tools: { wait: tool }, limits: { maxSteps: 20 } }),
      ),
    ).toMatchObject({ ok: true, value: 7 })
  })

  test("rejects oversized source before transpilation or parsing", async () => {
    expect(await run("x".repeat(16_777_217))).toMatchObject({
      ok: false,
      error: { kind: "ExecutionFailure", message: "String length exceeds 16777216." },
    })
  })

  test("tool output value caps are catchable without exposing unrelated host RangeErrors", async () => {
    const large = Tool.make({
      description: "Large value",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("x".repeat(16777217)),
    })
    const hostile = Tool.make({
      description: "Host getter",
      input: Schema.Struct({}),
      run: () =>
        Effect.succeed({
          get value() {
            throw new RangeError("private host detail")
          },
        }),
    })
    expect(
      await Effect.runPromise(
        CodeMode.execute({
          tools: { large, hostile },
          code: `const names = [];
      try { await tools.large({}) } catch (e) { names.push(e.name) }
      try { await tools.hostile({}) } catch (e) { names.push(e.message) }
      return names`,
        }),
      ),
    ).toMatchObject({ ok: true, value: ["RangeError", "Invalid output from tool 'hostile'."] })
  })

  test("step exhaustion bypasses promise handlers and aggregate settlement", async () => {
    for (const code of [
      `return await (async () => { for (let i=0;i<1000;i++) {} })().catch(() => "caught")`,
      `return await Promise.allSettled([(async () => { for (let i=0;i<1000;i++) {} })()])`,
      `return await new Promise(resolve => { for (let i=0;i<1000;i++) {} }).finally(() => "finally")`,
    ]) {
      expect(await run(code, { maxSteps: 100 })).toMatchObject({ ok: false, error: { kind: "StepLimitExceeded" } })
    }
  })

  test.each([
    `"x".repeat(16777217)`,
    `"x".padStart(16777217)`,
    `"x".padEnd(16777217)`,
    `"x".repeat(8388609).concat("x".repeat(8388609))`,
    `"x".repeat(8388609) + "x".repeat(8388609)`,
    '`${"x".repeat(8388609)}${"x".repeat(8388609)}`',
    `["x".repeat(8388609), "x".repeat(8388609)].join("")`,
    `"aa".replaceAll("a", "x".repeat(8388609))`,
    `"aa".replace(/a/g, () => "x".repeat(8388609))`,
    `new Array(10000001)`,
    `Array.from({length: 10000001})`,
    `(() => { const a = new Array(10000000); a.push(1); return a })()`,
    `(() => { const a = []; a[10000000] = 1; return a })()`,
    `new Array(5000001).concat(new Array(5000001))`,
    `[...new Array(10000000), 1]`,
    `new Array(10000000).map(() => 1).concat([1])`,
    `[new Array(5000001).fill(1), new Array(5000001).fill(2)].flat()`,
    `[1, 2].flatMap(() => new Array(5000001).fill(1))`,
    `(() => { const a = new Array(10000000); a.splice(0, 0, 1); return a })()`,
    `(() => { for (let i = 0; i < 10001; i++) new Promise(() => {}); return 0 })()`,
  ])("growth cap is a catchable RangeError: %s", async (expression) => {
    expect(await run(`try { ${expression}; return "missed" } catch (e) { return e.name }`)).toMatchObject({
      ok: true,
      value: "RangeError",
    })
  })

  test.each([
    `re.test(s)`,
    `re.exec(s)`,
    `s.match(re)`,
    `s.matchAll(re)`,
    `s.search(re)`,
    `s.replace(re, "x")`,
    `s.replace(re, () => "x")`,
    `s.split(re)`,
    `s.match("^(a|a?)+$")`,
    `s.search("^(a|a?)+$")`,
  ])("regex operation times out outside the evaluator: %s", async (operation) => {
    const start = performance.now()
    const result = await run(
      `const re = /^(a|a?)+$/g; const s = "a".repeat(26) + "b"; try { ${operation}; return "missed" } catch (e) { return "caught" }`,
      { regexTimeoutMs: 20 },
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
    expect(performance.now() - start).toBeLessThan(500)
  })

  test("catastrophic matching leaves the host responsive and is killed before cleanup returns", async () => {
    const kill = spyOn(ChildProcess.prototype, "kill")
    const start = performance.now()
    let tick = 0
    const timer = setTimeout(() => {
      tick = performance.now() - start
    }, 30)
    try {
      const result = await run(`const re = /^(a|a?)+$/; re.test("a"); return re.test("a".repeat(35) + "b")`, {
        regexTimeoutMs: 80,
      })
      expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
      expect(tick).toBeGreaterThan(0)
      expect(tick).toBeLessThan(250)
      expect(performance.now() - start).toBeLessThan(500)
      expect(kill).toHaveBeenCalledWith("SIGKILL")
      const child = kill.mock.contexts[0] as ChildProcess
      expect(child.signalCode).toBe("SIGKILL")
      expect(child.stdout?.destroyed).toBe(true)
      expect(child.stdin?.destroyed).toBe(true)
      expect(child.stderr?.destroyed).toBe(true)
    } finally {
      clearTimeout(timer)
      kill.mockRestore()
    }
  })

  test("preserves stateful regex, groups, indices, implicit patterns and interpreted replacement callbacks", async () => {
    const code = `const re = /(?<letter>a)/dgy; re.lastIndex = 1;
      const m = re.exec("baac"); const first = [m[0], m.index, m.groups.letter, m.indices[0], m.indices.groups.letter, re.lastIndex];
      const calls = []; const replaced = "aba".replace(/(?<letter>a)/g, (m, c, i, s, g) => { calls.push([m,c,i,s,g.letter]); return i + g.letter });
      const all = "aba".matchAll(/(?<letter>a)/dg).map(m => [m.index, m.groups.letter, m.indices[0]]);
      const sticky = /a/y; sticky.lastIndex = 1; const search = "ba".search(sticky);
      return { first, replaced, calls, all, search, last: sticky.lastIndex, implicit: "aba".match("a")[0], split: "a1b2".split(/(\\d)/) }`
    expect(await run(code)).toMatchObject({
      ok: true,
      value: {
        first: ["a", 1, "a", [1, 2], [1, 2], 2],
        replaced: "0ab2a",
        calls: [
          ["a", "a", 0, "aba", "a"],
          ["a", "a", 2, "aba", "a"],
        ],
        all: [
          [0, "a", [0, 1]],
          [2, "a", [2, 3]],
        ],
        search: -1,
        last: 1,
        implicit: "a",
        split: ["a", "1", "b", "2", ""],
      },
    })
  })

  test("caps admit boundary values and preserve sparse flatMap results", async () => {
    expect(
      await run(
        `return ["x".repeat(16777216).length, new Array(10000000).length, [1,2].flatMap(() => new Array(5000001)).length]`,
      ),
    ).toMatchObject({ ok: true, value: [16777216, 10000000, 0] })
  })

  test("regex IPC preserves own metadata and unmatched captures as undefined", async () => {
    expect(
      await run(`const m = /(a)?b/d.exec("b"); const n = "b".match(/(?<a>a)?b/d); const all = "b".matchAll(/(?<a>a)?b/dg);
      const callbacks = []; "b".replace(/(?<a>a)?b/g, (match, capture, offset, input, groups) => { callbacks.push([capture === undefined, groups.a === undefined, Object.hasOwn(groups, "a"), input]); return "x" });
      return [m[1] === undefined, Object.hasOwn(m, 1), Object.hasOwn(m, "groups"), m.groups === undefined, m.input,
        n.groups.a === undefined, Object.hasOwn(n.groups, "a"), n.input, n.indices[1] === undefined,
        all[0].input, all[0][1] === undefined, callbacks]`),
    ).toMatchObject({
      ok: true,
      value: [true, true, true, true, "b", true, true, "b", true, "b", true, [[true, true, true, "b"]]],
    })
  })

  test("oversized regex IPC requests and responses raise catchable RangeError", async () => {
    expect(
      await run(
        `try { const s = "\\0".repeat(16777216); s.replace(/a/, s); return "missed" } catch (e) { return e.name }`,
      ),
    ).toMatchObject({ ok: true, value: "RangeError" })
    expect(
      await run(
        `try { const re = new RegExp("(?=(x*))".repeat(9)); re.exec("x".repeat(16777216)); return "missed" } catch (e) { return e.name }`,
        { regexTimeoutMs: 5000 },
      ),
    ).toMatchObject({ ok: true, value: "RangeError" })
  })

  test("regex processes are lazy, reused, and reaped on success, failure and interruption", async () => {
    const terminate = spyOn(ChildProcess.prototype, "kill")
    try {
      await run("return 'abc'.includes('a')")
      expect(terminate).toHaveBeenCalledTimes(0)
      await run("/a/.test('a'); return /b/.test('b')")
      expect(terminate).toHaveBeenCalledTimes(1)
      await run("/a/.test('a'); throw new Error('failure')")
      expect(terminate).toHaveBeenCalledTimes(2)
      const interruptedAt = performance.now()
      await Effect.runPromise(
        Effect.gen(function* () {
          const started = Deferred.makeUnsafe<void>()
          const wait = Tool.make({
            description: "Gate",
            input: Schema.Struct({}),
            output: Schema.Number,
            run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
          })
          const fiber = yield* Effect.forkChild(
            CodeMode.execute({ code: "/a/.test('a'); return await tools.wait({})", tools: { wait } }),
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
        }),
      )
      expect(performance.now() - interruptedAt).toBeLessThan(500)
      expect(terminate).toHaveBeenCalledTimes(3)
      for (const child of terminate.mock.contexts as Array<ChildProcess>) {
        expect(child.signalCode).toBe("SIGKILL")
        expect(child.stdout?.destroyed).toBe(true)
        expect(child.stdin?.destroyed).toBe(true)
        expect(child.stderr?.destroyed).toBe(true)
      }
    } finally {
      terminate.mockRestore()
    }
  })
  test("an exhausted serialization deadline rejects before spawning a regex process", async () => {
    const kill = spyOn(ChildProcess.prototype, "kill")
    try {
      expect(await run(`return /x/.test("\\0".repeat(16777216))`, { regexTimeoutMs: 1 })).toMatchObject({
        ok: false,
        error: { kind: "TimeoutExceeded" },
      })
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})
