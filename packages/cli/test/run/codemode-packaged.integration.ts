import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { deltaChunk, finishChunk, toolCallChunk } from "../../../ai/test/lib/openai-chunks"
import { providerConfig, startProviderStandIn } from "../remote-harness"

const artifactEnv = "YCODING_CODEMODE_PACKAGED_ARTIFACTS"
const rawArtifacts = process.env[artifactEnv]
const artifactHelp = `${artifactEnv} must be a non-empty JSON array of built executable paths. Select this file explicitly with bun test ./packages/cli/test/run/codemode-packaged.integration.ts.`
if (rawArtifacts === undefined) throw new Error(artifactHelp)
let artifacts: unknown
try {
  artifacts = JSON.parse(rawArtifacts)
} catch {
  throw new Error(artifactHelp)
}
if (
  !Array.isArray(artifacts) ||
  artifacts.length === 0 ||
  !artifacts.every((value): value is string => typeof value === "string" && value.trim().length > 0)
)
  throw new Error(artifactHelp)

const calls = [
  {
    id: "packaged_regex_metadata",
    code: `const re = /(?<letter>a)(b)?/dg;
const match = re.exec("a");
return {
  input: match.input,
  index: match.index,
  lastIndex: re.lastIndex,
  missing: match[2] === undefined,
  group: match.groups.letter,
  range: match.indices[1],
  namedRange: match.indices.groups.letter,
  matches: "ab".matchAll(/./g).map(item => item[0]),
  replaced: "ab".replace(/(?<letter>a)(b)/g, (whole, a, b, index, input, groups) => groups.letter.toUpperCase() + b)
};`,
  },
  {
    id: "packaged_regex_timeout",
    code: `try {
  return new RegExp("^(?:" + "(a?)".repeat(32) + ")+$").test("a".repeat(80) + "b");
} catch (error) {
  return "caught regex timeout";
}`,
  },
  { id: "packaged_regex_recovery", code: 'return /fresh/.test("fresh") ? "fresh execution" : "missing match";' },
] as const
const finalText = "Packaged regex sequence completed."
const runTimeoutMs = 45_000

type ChatRequest = {
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>
  readonly messages?: ReadonlyArray<{
    readonly role?: string
    readonly tool_call_id?: string
    readonly content?: unknown
  }>
}

test.each(artifacts)(
  "packaged execute preserves regex metadata, enforces its deadline, and recovers: %s",
  async (artifact) => {
    const binary = path.resolve(artifact)
    if (!(await Bun.file(binary).exists()))
      throw new Error(`Packaged executable not found: ${binary}. Build it first or correct ${artifactEnv}.`)
    const scratch = path.resolve(import.meta.dir, "../../../../.cache/tmp")
    await mkdir(scratch, { recursive: true })
    const directory = await mkdtemp(path.join(scratch, "codemode-packaged-"))
    const home = path.join(directory, "home")
    const project = path.join(directory, "project")
    const tmp = path.join(directory, "tmp")
    const issued: Array<string> = []
    const issueTimes = new Map<string, number>()
    const observed = new Map<string, { content: unknown; time: number }>()
    let standIn: Awaited<ReturnType<typeof startProviderStandIn>> | undefined
    try {
      standIn = await startProviderStandIn({
        text: "Unexpected final before the regex sequence completed.",
        reply: (rawRequest) => {
          const request = rawRequest as ChatRequest
          for (const message of request.messages ?? []) {
            if (
              message.role !== "tool" ||
              message.tool_call_id === undefined ||
              !calls.some((call) => call.id === message.tool_call_id) ||
              observed.has(message.tool_call_id)
            )
              continue
            observed.set(message.tool_call_id, { content: message.content, time: performance.now() })
          }
          const next = calls[observed.size]
          if (next && !issued.includes(next.id) && request.tools?.some((tool) => tool.function?.name === "execute")) {
            issued.push(next.id)
            issueTimes.set(next.id, performance.now())
            return [toolCallChunk(next.id, "execute", JSON.stringify({ code: next.code })), finishChunk("tool_calls")]
          }
          return [
            deltaChunk({ role: "assistant", content: next ? "Unexpected final before all tool results." : finalText }),
            finishChunk("stop"),
          ]
        },
      })
      await Promise.all([home, project, tmp].map((item) => mkdir(item, { recursive: true })))
      const config = path.join(directory, "run.json")
      await writeFile(
        config,
        JSON.stringify({
          ...JSON.parse(providerConfig(standIn)),
          capabilities: { instructions: { project: false }, builtin_instructions: { enabled: false } },
        }),
      )
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"].includes(key)),
      )
      const started = performance.now()
      const child = spawn(
        binary,
        [
          "run",
          "--isolated",
          "--config",
          config,
          "--model",
          `${standIn.providerID}/${standIn.modelID}`,
          "--title",
          "Packaged regex acceptance",
          "--format",
          "json",
          "Complete the regex sequence.",
        ],
        {
          cwd: project,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...inherited,
            HOME: home,
            YCODING_TEST_HOME: home,
            XDG_CONFIG_HOME: path.join(home, "config"),
            XDG_DATA_HOME: path.join(home, "data"),
            XDG_CACHE_HOME: path.join(home, "cache"),
            XDG_STATE_HOME: path.join(home, "state"),
            TMPDIR: tmp,
            TMP: tmp,
            TEMP: tmp,
            PWD: project,
            YCODING_DISABLE_MODELS_FETCH: "1",
            YCODING_DISABLE_AUTOUPDATE: "1",
            NO_COLOR: "1",
          },
        },
      )
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk
      })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      const killGroup = () => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killGroup()
      }, runTimeoutMs)
      try {
        const result = await closed
        const diagnostics = `${binary}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        expect(timedOut, diagnostics).toBe(false)
        expect(result.signal, diagnostics).toBeNull()
        expect(result.code, diagnostics).toBe(0)
        expect(performance.now() - started, diagnostics).toBeLessThan(runTimeoutMs)
        expect(issued, diagnostics).toEqual(calls.map((call) => call.id))
        expect([...observed.keys()], diagnostics).toEqual(calls.map((call) => call.id))
        const metadata = observed.get(calls[0].id)!
        expect(typeof metadata.content, diagnostics).toBe("string")
        expect(
          () => JSON.parse(String(metadata.content)),
          `${diagnostics}\nmetadata tool content:\n${String(metadata.content)}`,
        ).not.toThrow()
        expect(JSON.parse(metadata.content as string), diagnostics).toEqual({
          input: "a",
          index: 0,
          lastIndex: 1,
          missing: true,
          group: "a",
          range: [0, 1],
          namedRange: [0, 1],
          matches: ["a", "b"],
          replaced: "Ab",
        })
        const timeout = observed.get(calls[1].id)!
        expect(timeout.content, diagnostics).toContain("Regular expression operation timed out after 1000ms.")
        expect(timeout.time - issueTimes.get(calls[1].id)!, diagnostics).toBeLessThan(3_000)
        expect(observed.get(calls[2].id)!.content, diagnostics).toBe("fresh execution")
        const events = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        expect(
          events.filter((event) => event.type === "run_finish"),
          diagnostics,
        ).toMatchObject([{ status: "succeeded" }])
        expect(stdout, diagnostics).toContain(finalText)
      } finally {
        clearTimeout(timer)
        killGroup()
        child.stdout.destroy()
        child.stderr.destroy()
        await closed
      }
    } finally {
      await standIn?.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
