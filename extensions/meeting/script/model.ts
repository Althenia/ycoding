import { spawn } from "node:child_process"
import {
  createProvider,
  defaultTranscriptionConfig,
  installModel,
  listModels,
  transcriptionConfigSchema,
} from "../src/transcription"
import { AudioProcessor } from "../src/audio"
import { speechAccuracy } from "../src/evaluate"

const [command, argument, ...flags] = process.argv.slice(2)
const config = transcriptionConfigSchema.parse({
  ...defaultTranscriptionConfig,
  ...(process.env.YCODING_MEETING_MODEL ? { model: process.env.YCODING_MEETING_MODEL } : {}),
  ...(process.env.YCODING_MEETING_DEVICE ? { device: process.env.YCODING_MEETING_DEVICE } : {}),
  ...(process.env.YCODING_MEETING_CACHE ? { cacheDir: process.env.YCODING_MEETING_CACHE } : {}),
  ...(process.env.YCODING_MEETING_PYTHON ? { pythonExecutable: process.env.YCODING_MEETING_PYTHON } : {}),
})

if (command === "list") console.log(JSON.stringify(await listModels(config), null, 2))
else if (command === "install" && argument) {
  await installModel(argument, flags.includes("--authorize-download"), config)
  console.log(JSON.stringify({ installed: argument }))
} else if (command === "doctor") {
  const child = spawn(
    config.pythonExecutable,
    [
      "-c",
      "import json,torch,transformers,numpy; print(json.dumps({'torch':torch.__version__,'transformers':transformers.__version__,'numpy':numpy.__version__,'cuda':torch.cuda.is_available(),'mps':torch.backends.mps.is_available()}))",
    ],
    { stdio: "inherit" },
  )
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} else if (command === "test" && argument) {
  const provider = createProvider(config)
  const started = performance.now()
  const output: string[] = []
  try {
    await provider.initialize(config)
    const processor = new AudioProcessor({
      chunkSeconds: config.chunkSeconds,
      overlapSeconds: 0,
      vad: true,
      onChunk: async (chunk) => {
        const segments = await provider.transcribe(chunk, { hints: [] })
        output.push(...segments.map((item) => item.text))
      },
      onGap: () => {
        throw new Error("Fixture audio has a discontinuity")
      },
    })
    const decoder = spawn(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-i", argument, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const completion = new Promise<void>((resolve, reject) => {
      decoder.once("error", reject)
      decoder.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("Fixture audio decoding failed"))))
    })
    decoder.stderr.resume()
    let pending = Buffer.alloc(0)
    let sequence = 0
    let frames = 0
    try {
      for await (const bytes of decoder.stdout) {
        pending = Buffer.concat([pending, Buffer.from(bytes)])
        while (pending.length >= 64000) {
          const samples = Float32Array.from({ length: 16000 }, (_, index) => pending.readFloatLE(index * 4))
          await processor.push({
            captureID: "fixture",
            source: "remote",
            sequence: sequence++,
            startMs: frames / 16,
            sampleRate: 16000,
            samples,
          })
          frames += samples.length
          pending = pending.subarray(64000)
        }
      }
      await completion
      if (pending.length % 4) throw new Error("Truncated decoded fixture")
      if (pending.length) {
        const samples = Float32Array.from({ length: pending.length / 4 }, (_, index) => pending.readFloatLE(index * 4))
        await processor.push({
          captureID: "fixture",
          source: "remote",
          sequence,
          startMs: frames / 16,
          sampleRate: 16000,
          samples,
        })
        frames += samples.length
      }
      await processor.close()
      const text = output.join(" ")
      const referencePath = flags.find((flag) => flag.startsWith("--reference="))?.slice("--reference=".length)
      console.log(
        JSON.stringify(
          {
            model: config.model,
            text,
            durationSeconds: frames / 16000,
            elapsedMs: performance.now() - started,
            health: await provider.healthCheck(),
            ...(referencePath ? { accuracy: speechAccuracy(await Bun.file(referencePath).text(), text) } : {}),
          },
          null,
          2,
        ),
      )
    } finally {
      decoder.kill()
      await completion.catch(() => undefined)
    }
  } finally {
    await provider.dispose()
  }
} else
  throw new Error(
    "Usage: model.ts doctor | list | install <model> --authorize-download | test <audio> [--reference=<text-file>]",
  )
