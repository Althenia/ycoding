import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { YCoding } from "../../../../packages/client/src/v5/index"
import { startMeetingRuntime } from "../../script/dev"
import { validateDescriptor } from "../../src/discovery"
import { sendControl } from "../../src/bridge-client"
import { isMeetingView } from "../../src/view"

export async function startBackend(channel = "beta", knowledge = false) {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-rust-"))
  const project = path.join(root, "project")
  const data = path.join(root, "data")
  await Promise.all([mkdir(project), mkdir(path.join(root, "home"))])
  const flags = { answerFailing: true }
  const releaseAnswer = Promise.withResolvers<void>()
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json()
      if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages))
        throw new Error("Expected model messages")
      const messages: unknown[] = body.messages
      const prompt = messages
        .flatMap((message) =>
          message && typeof message === "object" && "role" in message && message.role === "user" && "content" in message
            ? [typeof message.content === "string" ? message.content : JSON.stringify(message.content)]
            : [],
        )
        .join("\n")
      if (prompt.includes('"question":"fail"') && flags.answerFailing)
        return Response.json({ error: { message: "Fixture provider unavailable" } }, { status: 400 })
      if (prompt.includes('"question":"hold"')) await releaseAnswer.promise
      const evidence =
        knowledge && !prompt.includes('"question":')
          ? (JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)) as { transcript: { id: string }[] })
          : undefined
      const text = prompt.includes('"question":')
        ? "Advisory: rollout ยังเป็นข้อเสนอ · cite supplied transcript evidence."
        : JSON.stringify({
            summary: "สรุป rollout · unconfirmed",
            findings: [],
            proposals: evidence?.transcript.length
              ? [
                  {
                    server: "knowledge",
                    target: "doc-1",
                    suggestedContent: "Reviewed canonical replacement",
                    explanation: "Meeting evidence",
                    sourceSegmentIds: [evidence.transcript[0].id],
                    confidence: 0.8,
                  },
                ]
              : [],
          })
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const worker = path.join(root, "worker.cjs")
  const failure = path.join(root, "fail-audio")
  await writeFile(
    worker,
    `#!/usr/bin/env node
const fs = require("node:fs")
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  const response = { id: request.id, ok: true }
  if (request.op === "initialize") response.metrics = { device: "test-device" }
  if (request.op === "health") response.healthy = true
  if (request.op === "transcribe") {
    if (fs.existsSync(${JSON.stringify(failure)})) { response.ok = false; response.error = "inference_failed" }
    else response.results = [{ startMs: request.chunk.startMs, endMs: request.chunk.startMs + 900, text: "เราจะทดสอบ canary rollout และ transcription latency" }]
  }
  process.stdout.write(JSON.stringify(response) + "\\n")
})
`,
    { mode: 0o700 },
  )
  const modelCatalog = path.resolve(
    import.meta.dirname,
    "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json",
  )
  const knowledgeState = path.join(root, "knowledge.json")
  const knowledgeWorker = path.join(root, "knowledge.cjs")
  if (knowledge) {
    await writeFile(
      knowledgeState,
      JSON.stringify({ revision: "r1", content: "Original canonical content", searches: [], reads: [], writes: [] }),
    )
    await writeFile(
      knowledgeWorker,
      `const fs=require("node:fs");const file=${JSON.stringify(knowledgeState)};
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;let result={};
 if(request.method==="initialize")result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"knowledge-fixture",version:"1"}};
 if(request.method==="tools/list")result={tools:[{name:"search",inputSchema:{type:"object",properties:{query:{type:"string"},limit:{type:"number"}},required:["query","limit"]}},{name:"read",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"]}},{name:"replace",inputSchema:{type:"object",properties:{id:{type:"string"},content:{type:"string"},expectedRevision:{type:"string"}},required:["id","content","expectedRevision"]}}]};
 if(request.method==="tools/call"){
  const state=JSON.parse(fs.readFileSync(file,"utf8")),args=request.params.arguments;let data={};
  if(request.params.name==="search"){state.searches.push(args);data={documents:[{id:"doc-1"}]};}
  if(request.params.name==="read"){state.reads.push(args);data={id:"doc-1",revision:state.revision,content:state.content};}
  if(request.params.name==="replace"){if(args.expectedRevision!==state.revision){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32000,message:"stale"}})+"\\n");return;}state.writes.push(args);state.content=args.content;state.revision="r2";data={updated:true};}
  fs.writeFileSync(file,JSON.stringify(state));result={content:[{type:"text",text:JSON.stringify(data)}],structuredContent:data};
 }
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
});`,
    )
  }
  await writeFile(
    path.join(project, "ycoding.json"),
    JSON.stringify({
      model: { providerID: "openai", model: "gpt-reasoning" },
      providers: {
        openai: {
          package: "@ycoding-ai/ai/providers/openai-compatible",
          settings: { apiKey: "fixture", baseURL: `http://127.0.0.1:${provider.port}` },
        },
      },
      ...(knowledge
        ? { mcp: { servers: { knowledge: { type: "local", command: [process.execPath, knowledgeWorker] } } } }
        : {}),
    }),
  )
  const environment = {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    TMPDIR: process.env.TMPDIR,
    YCODING_RUNTIME_EXECUTABLE: process.env.YCODING_RUNTIME_EXECUTABLE,
    YCODING_CHANNEL: channel,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    YCODING_CONFIG_CONTENT: "{}",
    YCODING_MODELS_PATH: modelCatalog,
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_PRINT_LOGS: "1",
  }
  const locationKey = createHash("sha256")
    .update(await realpath(project))
    .digest("hex")
    .slice(0, 32)
  const stable = path.join(data, "ycoding/meeting", locationKey)
  const selected = path.join(data, channel === "beta" ? "ycoding-beta" : "ycoding", "meeting", locationKey)
  await mkdir(selected, { recursive: true, mode: 0o700 })
  await writeFile(
    path.join(selected, "settings.json"),
    JSON.stringify({
      transcription: { pythonExecutable: worker, chunkSeconds: 1, overlapSeconds: 0 },
      streaming: { vad: false },
      analysis: { incremental: false },
      knowledge: {
        mcpEnabled: knowledge,
        bindings: knowledge ? [{ server: "knowledge", search: "search", read: "read", write: "replace" }] : [],
      },
    }),
    { mode: 0o600 },
  )
  if (channel === "beta") {
    await mkdir(stable, { recursive: true, mode: 0o700 })
    await copyFile(
      path.join(import.meta.dirname, "stable-meeting/checkpointed/meetings.sqlite"),
      path.join(stable, "meetings.sqlite"),
    )
    const fixture = new Database(path.join(stable, "meetings.sqlite"))
    try {
      for (let index = 0; index < 24; index++) {
        const segment = {
          id: `reading-${index}`,
          meetingID: "imported",
          sequence: index + 2,
          source: "remote",
          speakerID: "remote-unknown",
          startMs: index * 1000,
          endMs: (index + 1) * 1000,
          rawText: `Evidence ${index} · canary rollout ยังไม่ยืนยัน`,
          text: `Evidence ${index} · canary rollout ยังไม่ยืนยัน`,
          state: "final",
          model: "fixture",
          createdAt: "2026-01-01T00:00:00.000Z",
        }
        fixture
          .query("INSERT INTO segments (id,meeting_id,sequence,state,original_text,data) VALUES (?,?,?,?,?,?)")
          .run(segment.id, segment.meetingID, segment.sequence, segment.state, segment.rawText, JSON.stringify(segment))
      }
    } finally {
      fixture.close()
    }
  }
  const launch = await startMeetingRuntime({ directory: project, env: environment }).catch(async (error: unknown) => {
    const diagnostics: string[] = []
    for await (const file of new Bun.Glob("**/*.log").scan({ cwd: root }))
      diagnostics.push((await Bun.file(path.join(root, file)).text()).slice(-8192))
    await provider.stop(true)
    await rm(root, { recursive: true, force: true })
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics.join("\n")}`, {
      cause: error,
    })
  })
  const client = YCoding.make({
    endpoint: { url: launch.url, auth: { type: "basic", username: "ycoding", password: launch.env.YCODING_PASSWORD } },
    location: { directory: project },
    socket: (url, headers) => new WebSocket(url, { headers }),
  })
  const attached = await client.agent
    .list({ location: { directory: project } })
    .then(async () => validateDescriptor(await Bun.file(path.join(selected, "bridge.json")).json()))
    .finally(() => client.transport.close())
    .catch(async (error: unknown) => {
      await launch.stop()
      await provider.stop(true)
      await rm(root, { recursive: true, force: true })
      throw error
    })
  const control = async (input: unknown) => {
    const result = await sendControl(attached.url, attached.token, input)
    if (result && typeof result === "object" && "error" in result && typeof result.error === "string")
      throw new Error(result.error)
    return result
  }
  const status = async () => {
    const view = await control({ action: "status" })
    if (!isMeetingView(view)) throw new Error("Invalid Rust Meeting state")
    return view
  }
  const address = await control({ action: "view" })
  if (!address || typeof address !== "object" || !("url" in address) || typeof address.url !== "string")
    throw new Error("Missing Rust Meeting page URL")
  return {
    root,
    project,
    data,
    url: address.url,
    origin: new URL(address.url).origin,
    knowledgeState,
    control,
    status,
    async settled() {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const view = await status()
        if (view.analysis.status !== "analyzing") {
          if (view.analysis.status === "error") throw new Error(JSON.stringify(view.analysis))
          return view
        }
        await Bun.sleep(25)
      }
      throw new Error("Rust Meeting analysis did not settle")
    },
    flags,
    releaseAnswer,
    async failAudio(value: boolean) {
      if (value) await writeFile(failure, "fail")
      if (!value) await rm(failure, { force: true })
    },
    async stop() {
      releaseAnswer.resolve()
      await launch.stop()
      await provider.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}
