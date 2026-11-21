import { selfCommand } from "./util/process"

export function frontendLaunchArguments(command: readonly string[] = selfCommand()) {
  const [executable, ...prefix] = command
  if (!executable) throw new Error("Failed to resolve frontend executable")
  return [
    "--frontend-executable",
    executable,
    ...(prefix.length === 0 ? [] : ["--frontend-arguments", JSON.stringify(prefix)]),
  ]
}
