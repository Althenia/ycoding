import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"

const server = `
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  await request.text();
  return new Response("syn_response_body", {headers: {
    "set-cookie": "syn_response_cookie=123", "x-api-key": "syn_response_key",
    "content-type": "text/event-stream"
  }});
}});
const url = "http://127.0.0.1:" + server.port + "/probe?key=syn_url_secret";
const init = {method: "POST", headers: {
  Authorization: "Bearer syn_secret_123", Cookie: "syn_cookie=456", "x-api-key": "syn_key_789"
}, body: "syn_request_body"};
`

const capture = async (source: string, level?: string) => {
  const env = { ...process.env }
  env.YCODING_PRINT_LOGS = "1"
  delete env.YCODING_LOG_LEVEL
  if (level !== undefined) env.YCODING_LOG_LEVEL = level
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit).toBe(0)
  return { stdout, stderr }
}

test("native Bun verbose exposes URL and cookie/API-key headers outside Effect logging", async () => {
  const captured = await capture(`${server}
try { const response = await fetch(url, {...init, verbose: true}); await response.text(); }
finally { server.stop(true); }`)
  const output = captured.stdout + captured.stderr
  for (const secret of [
    "syn_url_secret",
    "syn_cookie=456",
    "syn_key_789",
    "syn_response_cookie=123",
    "syn_response_key",
  ]) {
    expect(output.includes(secret)).toBe(true)
  }
  for (const secret of ["syn_secret_123", "syn_request_body", "syn_response_body"]) {
    expect(output.includes(secret)).toBe(false)
  }
})

for (const level of [undefined, "INFO", "DEBUG"]) {
  test(`AISDK debug diagnostics preserve confidentiality at ${level ?? "unset"} level`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-fetch-diagnostic-"))
    const log = join(directory, "debug.log")
    try {
      const captured = await capture(
        `
import { AISDK } from "./src/aisdk";
import { CatalogModel } from "./src/model";
import { Provider } from "./src/provider";
import { Logging } from "./src/observability/logging";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Logger, References } from "effect";
${server}
const secrets = ["syn_secret_123", "syn_cookie=456", "syn_key_789", "syn_url_secret", "syn_request_body", "syn_response_body", "syn_response_cookie=123", "syn_response_key", "syn_path_secret", "syn_user_secret", "syn_password_secret", "syn_fragment_secret"];
const logging = Logger.layer([Logging.fileLogger(${JSON.stringify(log)}, "fetch-test"), ...Logging.loggers().slice(1)], {mergeWithExisting: false}).pipe(
  Layer.provide(NodeFileSystem.layer), Layer.orDie,
  Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel()))
);
try {
  await Effect.runPromise(Effect.gen(function* () {
    const aisdk = yield* AISDK.Service;
    let request;
    yield* aisdk.hook.sdk(event => { request = event.options.fetch; event.sdk = { languageModel: () => ({}) }; });
    const model = CatalogModel.Info.make({
      ...CatalogModel.Info.empty(Provider.ID.make("synthetic"), CatalogModel.ID.make("synthetic")),
      package: Provider.aisdk("@ai-sdk/anthropic"), settings: { chunkTimeout: 1000 }
    });
    yield* aisdk.language(model);
    yield* Effect.promise(async () => { const response = await request(url.replace("/probe", "/syn_path_secret") + "#syn_fragment_secret", {...init, verbose: true}); await response.text(); });
    const reset = Object.assign(new Error("fetch failed " + url + " " + secrets.join(" ")), {
      name: "syn_secret_123", code: "syn_key_789", errno: "syn_cookie=456", syscall: "syn_request_body", statusCode: "syn_response_key",
      cause: Object.assign(new Error("socket " + secrets.join(" ")), {code: "ECONNRESET", errno: -54, syscall: "read", statusCode: 503})
    });
    for (const mode of ["headers", "fetch", "read", "timeout", "abort"]) {
      const settings = {chunkTimeout: mode === "timeout" ? 5 : 1000};
      Object.defineProperty(settings, "fetch", {enumerable: true, value: async (_url, options) => {
        if (options.verbose !== undefined || options.timeout !== false) throw new Error("Unsafe fetch options");
        if (mode === "fetch") throw reset;
        if (mode === "abort") throw new DOMException("cancelled " + secrets.join(" "), "AbortError");
        return new Response(mode === "headers" ? "syn_response_body" : new ReadableStream({start(controller) {
          if (mode === "read") controller.error(reset);
        }}), {status: 200, statusText: secrets.join(" "), headers: {
          "content-type": "text/event-stream; syn_response_key",
          "request-id": "syn_secret_123", "x-request-id": "syn_cookie=456", "cf-ray": "syn_key_789",
          "openai-processing-ms": "syn_url_secret", "retry-after": "syn_request_body", "retry-after-ms": "syn_response_body",
          "x-ratelimit-syn_path_secret": "syn_response_cookie=123", "anthropic-ratelimit-syn_user_secret": "syn_response_key",
          "x-private": secrets.join(" "), "set-cookie": "syn_response_cookie=123"
        }});
      }});
      yield* aisdk.language({...model, settings});
      yield* Effect.promise(async () => {
        const controller = new AbortController();
        if (mode === "abort") controller.abort();
        try {
          const response = await request("http://syn_user_secret:syn_password_secret@127.0.0.1:" + server.port + "/syn_path_secret?key=syn_url_secret#syn_fragment_secret", {...init, verbose: true, signal: controller.signal});
          await response.text();
          if (mode !== "headers") throw new Error("Expected synthetic failure");
        } catch(error) {
          if (mode === "headers" || error.message === "Expected synthetic failure" || error.message === "Unsafe fetch options") throw error;
          if ((mode === "fetch" || mode === "read") && error !== reset) throw new Error("Failure identity changed");
          if (mode === "timeout" && error.message !== "SSE read timed out") throw new Error("Expected chunk timeout");
        }
      });
    }
  }).pipe(Effect.provide(AISDK.locationLayer), Effect.provide(logging), Effect.scoped));
} finally { server.stop(true); }
`,
        level,
      )
      const output = captured.stdout + captured.stderr
      const file = await readFile(log, "utf8")
      for (const secret of [
        "syn_secret_123",
        "syn_cookie=456",
        "syn_key_789",
        "syn_url_secret",
        "syn_request_body",
        "syn_response_body",
        "syn_response_cookie=123",
        "syn_response_key",
        "syn_path_secret",
        "syn_user_secret",
        "syn_password_secret",
        "syn_fragment_secret",
      ]) {
        expect(output.includes(secret)).toBe(false)
        expect(file.includes(secret)).toBe(false)
      }
      if (level === "DEBUG") {
        for (const records of [captured.stderr, file])
          for (const evidence of [
            "AISDK.fetch.response",
            "AISDK.fetch.failure",
            "AISDK.stream.failure",
            "ECONNRESET",
            "durationMs",
            "chunkTimedOut=true",
            "abort=true",
            "127.0.0.1",
            "REDACTED",
          ]) {
            expect(records.includes(evidence)).toBe(true)
          }
      } else {
        expect((output + file).includes("AISDK.fetch")).toBe(false)
        expect((output + file).includes("AISDK.stream")).toBe(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
