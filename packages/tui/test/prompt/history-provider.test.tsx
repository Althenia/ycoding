/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TuiPathsProvider } from "../../src/context/runtime"
import { PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { tmpdir } from "../fixture/fixture"

test("down rejects at the newest history item with an empty prompt", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  let history: ReturnType<typeof usePromptHistory>

  function Consumer() {
    history = usePromptHistory()
    return <box />
  }

  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Consumer />
      </PromptHistoryProvider>
    </TuiPathsProvider>
  ))
  try {
    await app.renderOnce()
    history!.append({ text: "previous", files: [], agents: [], pasted: [] })

    expect(history!.move(1, "")).toBeUndefined()
    expect(history!.move(-1, "")?.text).toBe("previous")
    expect(history!.move(1, "previous")?.text).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("canonical history reconciliation preserves dispatch order when receipts settle in reverse order", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  let history!: ReturnType<typeof usePromptHistory>
  function Consumer() {
    history = usePromptHistory()
    return <box />
  }
  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Consumer />
      </PromptHistoryProvider>
    </TuiPathsProvider>
  ))
  try {
    await app.renderOnce()
    const first = { text: "first", files: [{ uri: "file:///tmp/first.png" }], pasted: [] }
    const second = { text: "second", files: [{ uri: "file:///tmp/second.png" }], pasted: [] }
    const settleFirst = history.append(first)
    const settleSecond = history.append(second)
    expect(settleFirst).toBeDefined()
    expect(settleSecond).toBeDefined()
    await settleSecond?.({ ...second, files: [{ uri: `ycoding-attachment://sha256/${"b".repeat(64)}` }] })
    await settleFirst?.({ ...first, files: [{ uri: `ycoding-attachment://sha256/${"a".repeat(64)}` }] })
    expect(history.move(-1, "")?.text).toBe("second")
    expect(history.move(-1, "second")?.text).toBe("first")
    const stored = (await Bun.file(path.join(state, "prompt-history.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(stored.map((item) => item.text)).toEqual(["first", "second"])
    expect(stored.map((item) => item.files[0].uri)).toEqual([
      `ycoding-attachment://sha256/${"a".repeat(64)}`,
      `ycoding-attachment://sha256/${"b".repeat(64)}`,
    ])
  } finally {
    app.renderer.destroy()
  }
})
