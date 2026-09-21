export * as RemotePrompt from "./remote-prompt"

/**
 * Read a secret from the terminal. A TTY hides the typed characters and never
 * echoes the value; a pipe is read to the end so scripts can supply it without
 * putting the secret in argv or the environment.
 */
export async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readPiped()
  process.stderr.write(prompt)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding("utf8")
  return new Promise<string>((resolve, reject) => {
    let value = ""
    const finish = (error?: Error) => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Canceled"))
          return
        }
        if (character === "\r" || character === "\n") {
          finish()
          return
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1)
          continue
        }
        value += character
      }
    }
    stdin.on("data", onData)
    stdin.once("error", (error) => finish(error))
  })
}

async function readPiped() {
  const { text } = await import("node:stream/consumers")
  return (await text(process.stdin)).trim()
}
