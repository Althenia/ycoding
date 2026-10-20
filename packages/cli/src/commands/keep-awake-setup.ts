import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const RulePath = "/etc/sudoers.d/ycoding-keep-awake"

export type Runner = (argv: string[]) => Promise<number>

export function rule(user: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`Unsupported user name: ${user}`)
  return `${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n`
}

export async function setupKeepAwake(input: {
  platform: string
  user: string
  run: Runner
  tmpdir?: string
}): Promise<{ code: number; message: string }> {
  if (input.platform !== "darwin") return { code: 1, message: "keep-awake setup is supported only on macOS" }
  const content = await Promise.resolve()
    .then(() => rule(input.user))
    .catch((error: Error) => error)
  if (content instanceof Error) return { code: 1, message: content.message }
  const dir = await fs.mkdtemp(path.join(input.tmpdir ?? os.tmpdir(), "ycoding-keep-awake-"))
  const tmp = path.join(dir, "rule")
  try {
    await Bun.write(tmp, content)
    await fs.chmod(tmp, 0o600)
    const steps: [string, string[]][] = [
      ["validate the sudoers rule", ["/usr/bin/sudo", "/usr/sbin/visudo", "-cf", tmp]],
      [
        "install the sudoers rule",
        ["/usr/bin/sudo", "/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", tmp, RulePath],
      ],
      ["verify passwordless pmset", ["/usr/bin/sudo", "-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"]],
    ]
    for (const [name, argv] of steps) {
      const code = await input.run(argv)
      if (code !== 0) return { code: 1, message: `keep-awake setup failed: could not ${name} (exit ${code})` }
    }
    return {
      code: 0,
      message: `keep-awake can now hold system sleep. Remove the rule with: sudo rm ${RulePath}`,
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
