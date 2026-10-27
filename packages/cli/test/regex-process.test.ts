import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import {
  decodeRegexValue,
  REGEX_PROCESS_MARKER,
  regexProcessSource,
} from "../../codemode/src/internal/regex-process.js"

const exchange = async (
  command: string,
  args: Array<string>,
  request = { pattern: "a+", flags: "g", lastIndex: 1, method: "test", input: "baab" },
) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const lines = createInterface({ input: child.stdout })
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  try {
    for await (const line of lines) {
      const reply = JSON.parse(line)
      if (reply.ready) {
        child.stdin.write(JSON.stringify(request) + "\n")
        continue
      }
      expect(stderr).toBe("")
      return reply
    }
    throw new Error("Regex process exited without a reply.")
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    lines.close()
    await closed
  }
}

test.each([process.execPath, Bun.which("node")!])("fixed regex source runs in %s", async (runtime) => {
  expect(await exchange(runtime, ["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER])).toEqual({
    result: true,
    lastIndex: 3,
  })
})

test.each([process.execPath, Bun.which("node")!])(
  "fixed regex matchAll transport preserves metadata in %s",
  async (runtime) => {
    const plain = await exchange(runtime, ["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER], {
      pattern: ".",
      flags: "g",
      lastIndex: 0,
      method: "matchAll",
      input: "ab",
    })
    expect(plain.lastIndex).toBe(0)
    expect(decodeRegexValue(plain.result)).toEqual([
      Object.assign(["a"], { index: 0, groups: undefined }),
      Object.assign(["b"], { index: 1, groups: undefined }),
    ])
    const named = await exchange(runtime, ["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER], {
      pattern: "(?<letter>a)(b)?",
      flags: "dg",
      lastIndex: 0,
      method: "matchAll",
      input: "aba",
    })
    expect(named.lastIndex).toBe(0)
    expect(decodeRegexValue(named.result)).toEqual([
      Object.assign(["ab", "a", "b"], {
        index: 0,
        groups: { letter: "a" },
        indices: Object.assign(
          [
            [0, 2],
            [0, 1],
            [1, 2],
          ],
          { groups: { letter: [0, 1] } },
        ),
      }),
      Object.assign(["a", "a", undefined], {
        index: 2,
        groups: { letter: "a" },
        indices: Object.assign([[2, 3], [2, 3], undefined], { groups: { letter: [2, 3] } }),
      }),
    ])
  },
)

test.each(["index.ts", "tui.ts", "node/index.ts"])(
  "private regex bootstrap bypasses normal startup in %s",
  async (entry) => {
    expect(
      await exchange(process.execPath, [
        `${import.meta.dir}/../src/${entry}`,
        "-e",
        regexProcessSource,
        "--",
        REGEX_PROCESS_MARKER,
      ]),
    ).toEqual({ result: true, lastIndex: 3 })
  },
)

test("private bootstrap does not evaluate arbitrary argv", async () => {
  const path = `${import.meta.dir}/../../codemode/src/internal/regex-process.ts`
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {runRegexProcess} from ${JSON.stringify(path)};
    process.argv = [process.execPath, "-e", "throw new Error('must not evaluate')", "--", ${JSON.stringify(REGEX_PROCESS_MARKER)}];
    console.log(runRegexProcess())`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode).toBe(0)
  expect(stdout).toBe("false\n")
  expect(stderr).toBe("")
})

test("private bootstrap starts once and validates argv after startup", async () => {
  const path = `${import.meta.dir}/../../codemode/src/internal/regex-process.ts`
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {runRegexProcess, regexProcessSource, REGEX_PROCESS_MARKER} from ${JSON.stringify(path)};
const valid = [process.execPath, "-e", regexProcessSource, "--", REGEX_PROCESS_MARKER];
process.argv = valid;
if (!runRegexProcess()) throw new Error("First valid bootstrap was rejected");
process.argv = [process.execPath, "entry.ts", ...valid.slice(1)];
if (!runRegexProcess()) throw new Error("Second valid bootstrap was rejected");
for (const invalid of [
  [process.execPath],
  [process.execPath, "-e", "throw new Error('must not evaluate')", "--", REGEX_PROCESS_MARKER],
  [process.execPath, "-e", regexProcessSource, "invalid", REGEX_PROCESS_MARKER],
  [process.execPath, "-e", regexProcessSource, "--", "invalid"],
  [...valid, "extra"],
]) {
  process.argv = invalid;
  if (runRegexProcess()) throw new Error("Invalid argv was accepted after startup");
}`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  try {
    await child.stdin.write(
      JSON.stringify({ pattern: "a+", flags: "g", lastIndex: 1, method: "test", input: "baab" }) + "\n",
    )
    await child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ ready: true }, { result: true, lastIndex: 3 }])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
})
