import { realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"

if (process.argv[3] !== "auth" || process.argv[4] !== "login" || process.argv[5] !== "--claudeai") process.exit(42)
const directory = process.env.CLAUDE_CONFIG_DIR
if (!directory || process.cwd() !== await realpath(directory) || process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ||
  Object.keys(process.env).some((key) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_)/.test(key))) process.exit(43)
const mode = process.argv[2]
const credential = { claudeAiOauth: { accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000, subscriptionType: "max" } }
await writeFile(join(directory, "pid"), String(process.pid))
const url = `https://${mode === "foreign" ? "claude.com.evil" : "claude.com"}/cai/oauth/authorize?state=fixture`
process.stdout.write(`If the browser didn't open, visit: ${mode === "hyperlink" ? `\x1b]8;;${url}\x07\x1b[36m${url}\x1b[0m\x1b]8;;\x07` : url}\n`)
if (mode === "wait") await new Promise(() => {})
if (mode === "manual") {
  const line = await new Promise<string>((resolve) => process.stdin.once("data", (chunk) => resolve(String(chunk))))
  if (line !== "code#state\n") process.exit(44)
  process.stdin.pause()
}
if (mode === "failure") {
  process.stderr.write("private-identity")
  process.exit(45)
}
if (mode !== "empty") await writeFile(join(directory, ".credentials.json"), JSON.stringify(credential), { mode: 0o600 })
process.exit(0)
