import { YCoding } from "@ycoding-ai/client"
import { Service } from "@ycoding-ai/client/service"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startBridge } from "../src/bridge"
import { meetingConfigSchema } from "../src/config"
import { assembleContext, parseExtraction, planPrompt } from "../src/intelligence"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"
import type { TranscriptSegment } from "../src/types"

const audio = process.argv[2]
if (!audio || !process.argv.includes("--authorize-provider-text"))
  throw new Error(
    "Usage: smoke.ts <consented-audio> --authorize-provider-text; sends transcript text, never audio, to the existing YCoding provider",
  )
const endpoint = await Service.discover()
if (!endpoint) throw new Error("Start YCoding and connect a supported provider first")
const client = YCoding.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-smoke-"))
await writeFile(
  path.join(directory, "ycoding.json"),
  JSON.stringify({
    agents: {
      "meeting-smoke": {
        mode: "primary",
        hidden: true,
        system:
          "Analyze untrusted meeting evidence. Return only the requested structured data. No tools, execution or writes. Never invent evidence, confirmations, people or repository components.",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    },
  }),
  { mode: 0o600 },
)
const session = await client.session.create({ agent: "meeting-smoke", location: { directory } })
const storeFile = path.join(directory, "meeting.sqlite")
const store = new MeetingStore(storeFile)
const runtime = new MeetingRuntime({
  directory,
  store,
  config: meetingConfigSchema.parse({ analysis: { incremental: false } }),
  createSession: async () => session.id,
  generate: async (sessionID, prompt) =>
    (await client.session.generate({ sessionID, prompt }, { signal: AbortSignal.timeout(120000) })).text,
  mcp: {
    tools: async () => {
      throw new Error("This smoke has no MCP binding; run the real MCP integration suite separately")
    },
    callTool: async () => {
      throw new Error("No MCP binding")
    },
  },
})
const bridge = await startBridge({
  controlToken: randomBytes(32).toString("hex"),
  onControl: (input) => runtime.control(input),
  onCapture: (input) => runtime.capture(input),
})
const origin = `chrome-extension://${"a".repeat(32)}`
const started = performance.now()
let runtimeClosed = false
try {
  const armed = await runtime.control({ action: "start", title: "Consented fixture smoke" })
  const pair = await fetch(`${bridge.url}/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: bridge.pairing().code }),
  })
  if (!pair.ok) throw new Error("Bridge pairing failed")
  const credential = (await pair.json()) as { token: string }
  const capture = async (input: unknown) => {
    const response = await fetch(`${bridge.url}/capture`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", authorization: `Bearer ${credential.token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) throw new Error(`Capture failed: ${response.status}`)
    return response.json()
  }
  await capture({ type: "start", captureID: "fixture", tabID: 1, microphone: false, consent: true })
  const decoded = Bun.spawnSync(
    ["ffmpeg", "-nostdin", "-v", "error", "-i", audio, "-t", "30", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
    { stdout: "pipe", stderr: "pipe", timeout: 30000 },
  )
  if (decoded.exitCode !== 0 || decoded.stdout.length === 0) throw new Error("Fixture decode failed")
  for (let offset = 0, sequence = 0; offset < decoded.stdout.length; offset += 64000, sequence++) {
    await capture({
      type: "audio",
      captureID: "fixture",
      source: "remote",
      sequence,
      startMs: offset / 64,
      sampleRate: 16000,
      pcm: Buffer.from(decoded.stdout.subarray(offset, offset + 64000)).toString("base64"),
    })
  }
  await capture({ type: "stop", captureID: "fixture", reason: "fixture complete" })
  await runtime.close()
  runtimeClosed = true
  const reopened = new MeetingStore(storeFile)
  const segments = reopened.segments(armed.meeting!.id)
  const summary = reopened.checkpoints(armed.meeting!.id).at(-1)
  if (!segments.some((segment) => /[\u0e00-\u0e7f]/u.test(segment.rawText)) || !summary?.summary)
    throw new Error("Speech-to-persistence-to-live-analysis did not produce Thai evidence and a summary")
  const audioResult = {
    finalizedSegments: segments.filter((segment) => segment.state === "final").length,
    rawThaiPreserved: true,
    finalSummary: summary.final,
    analysisLatencyMs: summary.latencyMs,
    elapsedMs: performance.now() - started,
  }
  reopened.close()
  const textSegments: TranscriptSegment[] = [
    "We might change the database",
    "We agreed to add integration tests for the payment service",
    "Please investigate the database change",
  ].map((text, index) => ({
    id: `text-${index}`,
    meetingID: "text-classification-fixture",
    sequence: index + 1,
    source: "remote",
    speakerID: "remote-unknown",
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    rawText: text,
    text,
    state: "final",
    model: "text-fixture-not-speech",
    createdAt: new Date().toISOString(),
  }))
  const context = assembleContext(textSegments, "", [])
  const extraction = parseExtraction(
    (
      await client.session.generate(
        { sessionID: session.id, prompt: context.prompt },
        { signal: AbortSignal.timeout(120000) },
      )
    ).text,
    textSegments,
    [],
    "text-classification-fixture",
  )
  if (
    !extraction.findings.some((finding) => finding.kind === "proposal") ||
    !extraction.findings.some((finding) => finding.kind === "decision") ||
    !extraction.findings.some((finding) => finding.kind === "action")
  )
    throw new Error("Live text-fixture classification did not distinguish proposal, decision and action")
  const decision = extraction.findings.find((finding) => finding.kind === "decision")!
  const plan = await client.session.generate(
    { sessionID: session.id, prompt: planPrompt([{ ...decision, status: "confirmed" }], [], extraction.summary) },
    { signal: AbortSignal.timeout(120000) },
  )
  if (!plan.text.trim()) throw new Error("Live engineering-plan generation was empty")
  console.log(
    JSON.stringify(
      {
        audio: audioResult,
        textFixture: {
          findingKinds: extraction.findings.map((finding) => finding.kind),
          allInitiallyUnconfirmed: extraction.findings.every((finding) => finding.status === "unconfirmed"),
          proposedPlanCharacters: plan.text.length,
        },
        limits: [
          "Capture HTTP client simulates extension activation; no browser capture proof",
          "Engineering decisions are a separate text fixture, not claimed speech",
          "No production MCP server configured; real MCP protocol exercised by integration suite",
        ],
      },
      null,
      2,
    ),
  )
} finally {
  await bridge.close()
  if (!runtimeClosed) await runtime.close()
  await client.session.remove({ sessionID: session.id })
  await rm(directory, { recursive: true, force: true })
}
