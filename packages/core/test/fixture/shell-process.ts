import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"

export function shellProcess(directory: string, ignore = false) {
  const ready = join(directory, "ready")
  const term = join(directory, "term")
  const childTerm = join(directory, "child-term")
  const allocate = join(directory, "allocate")
  const child = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(childTerm)}, "term"));
    process.stdout.write("ready");
    setInterval(() => {}, 1000);
  `
  const script = `
    const fs = require("node:fs");
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], {stdio: ["ignore", "pipe", "ignore"]});
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(term)}, "term"); ${ignore ? "" : "process.exit(0);"} });
    child.stdout.once("data", () => {
      child.stdout.destroy();
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    });
    const retained = [];
    fs.watch(${JSON.stringify(directory)}, () => {
      if (fs.existsSync(${JSON.stringify(allocate)}) && !retained.length) retained.push(Buffer.alloc(160 * 1024 * 1024, 1));
    });
    setInterval(() => void retained.length, 1000);
  `
  return {
    ready,
    term,
    childTerm,
    allocate,
    script,
    command: `exec node -e '${script.replaceAll("'", "'\\''")}'`,
  }
}

export const fileReady = (file: string) =>
  Effect.gen(function* () {
    while (true) {
      const text = yield* Effect.promise(() => readFile(file, "utf8").catch(() => undefined))
      if (text !== undefined) return text
      yield* Effect.sleep(10)
    }
  }).pipe(Effect.timeout(5_000), Effect.orDie)

export function groupAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Invalid test process group: ${pid}`)
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true
    throw new Error(`Cannot inspect test process group ${pid}`, { cause: error })
  }
}

export const groupGone = (pid: number) =>
  Effect.gen(function* () {
    while (groupAlive(pid)) yield* Effect.sleep(10)
  }).pipe(Effect.timeout(5_000), Effect.orDie)

export const cleanGroup = (pid: number) =>
  Effect.try({ try: () => process.kill(-pid, "SIGKILL"), catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")
        ? Effect.void
        : Effect.die(error),
    ),
    Effect.andThen(groupGone(pid)),
  )

export function escapedProcess(directory: string, options: { writing?: boolean; leaderExits?: boolean } = {}) {
  const ready = join(directory, "escaped-ready")
  const child = `
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    ${options.writing ? 'process.stdout.on("error", () => {}); setInterval(() => process.stdout.write("x".repeat(512)), 2);' : "setInterval(() => {}, 1000);"}
  `
  const script = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], {detached: true, stdio: "inherit"}); ${options.leaderExits ? "process.exit(0)" : "setInterval(() => {}, 1000)"}`
  return { ready, command: `exec node -e '${script.replaceAll("'", "'\\''")}'` }
}
