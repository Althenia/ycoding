export function createFixture(options) {
  return {
    languageModel(id) {
      return {
        doStream: async (input) => {
          const response =
            id === "http"
              ? await options.fetch(`${options.baseURL}/chat`, {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-sdk": "fixture", ...input.headers },
                  body: JSON.stringify({
                    model: id,
                    prompt: input.prompt,
                    nested: { keep: "sdk", replace: "sdk" },
                    list: ["sdk"],
                  }),
                  signal: input.abortSignal,
                })
              : undefined
          if (response && !response.ok) throw new Error(`Authored HTTP status ${response.status}`)
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "raw", rawValue: { id, options, prompt: input.prompt } })
                controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" } })
                controller.close()
              },
            }),
          }
        },
      }
    },
  }
}
