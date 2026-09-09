export * as SessionGuardrailStandard from "./guardrail-standard"

import path from "path"

export interface Match {
  readonly id: string
  readonly decision: "ask" | "deny"
  readonly reason: string
  readonly hardReview: boolean
}

export interface Paths {
  readonly workdir: string
  readonly project: string
  readonly home: string
}

const catastrophic: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp; readonly reason: string }> = [
  {
    id: "standard.catastrophic.rm-root",
    pattern: /^\s*(?:sudo\s+)?rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:--\s+)?(?:\/|~|\$HOME)(?:\s|$)/i,
    reason: "Recursive deletion of a filesystem root or home directory",
  },
  {
    id: "standard.catastrophic.format-disk",
    pattern: /(?:^|\s)(?:mkfs(?:\.[a-z0-9]+)?|diskutil\s+eraseDisk|format\s+[a-z]:)(?:\s|$)/i,
    reason: "Filesystem or disk formatting",
  },
  {
    id: "standard.catastrophic.block-device-write",
    pattern: /(?:^|\s)dd\s+[^\n]*\bof=\/dev\/(?:disk|sd|nvme|vd)[^\s]*/i,
    reason: "Raw block-device write",
  },
  {
    id: "standard.catastrophic.fork-bomb",
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Unbounded process spawning",
  },
]

const reviews: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp; readonly reason: string }> = [
  {
    id: "standard.review.git-destructive",
    pattern: /(?:^|\s)git\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--\s+\.|restore\s+[^\n]*--worktree)/i,
    reason: "Destructive Git operation",
  },
  {
    id: "standard.review.force-push",
    pattern: /(?:^|\s)git\s+push\s+[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/i,
    reason: "Force push",
  },
  {
    id: "standard.review.publish",
    pattern: /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:publish|release)(?:\s|$)|(?:^|\s)docker\s+push(?:\s|$)/i,
    reason: "Package, release, or image publication",
  },
  {
    id: "standard.review.production",
    pattern:
      /(?:^|\s)(?:kubectl\s+[^\n]*(?:production|prod)|terraform\s+apply|helm\s+(?:install|upgrade)\s+[^\n]*(?:production|prod))/i,
    reason: "Production infrastructure mutation",
  },
  {
    id: "standard.review.database-destructive",
    pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table|delete\s+from\s+[^\s;]+\s*;?\s*$)/i,
    reason: "Destructive database operation",
  },
  {
    id: "standard.review.security-mutation",
    pattern:
      /(?:^|\s)(?:security\s+(?:add|delete)-generic-password|chmod\s+[^\n]*(?:777|a\+w)|ufw\s+(?:disable|reset)|iptables\s+-F)(?:\s|$)/i,
    reason: "Credential, access-control, or security-policy mutation",
  },
]

export function match(action: string, resource: string, paths?: Paths): Match | undefined {
  if (action === "mcp_execute")
    return {
      id: "standard.review.mcp-execute",
      decision: "ask",
      reason: `MCP process execution: ${resource}`,
      hardReview: false,
    }
  if (action !== "shell") return undefined
  const command = resource.replace(/\s+/g, " ").trim()
  const denied = catastrophic.find((rule) => rule.pattern.test(command))
  const deletion = deletionMatch(resource, paths)
  if (denied) return { ...denied, decision: "deny", hardReview: false }
  if (deletion?.decision === "deny") return deletion
  if (deletion) return deletion
  const review = reviews.find((rule) => rule.pattern.test(command))
  return review ? { ...review, decision: "ask", hardReview: false } : undefined
}

function deletionMatch(command: string, paths?: Paths): Match | undefined {
  const matches = rmOperations(command, paths).flatMap((operation): ReadonlyArray<Match> => {
    if (!operation.recursive) return []
    const targets = operation.targets.map((target) => classifyTarget(target, operation.workdir, paths))
    if (targets.some((target) => target === "root" || target === "home"))
      return [
        {
          id: "standard.catastrophic.rm-root",
          decision: "deny",
          reason: "Recursive deletion of a filesystem root or home directory",
          hardReview: false,
        },
      ]
    if (operation.targets.length > 1 || targets.some((target) => target === "project"))
      return [
        {
          id: "standard.review.broad-deletion",
          decision: "ask",
          reason: "Recursive deletion includes the current project, one of its ancestors, or multiple targets",
          hardReview: true,
        },
      ]
    return []
  })
  return matches.find((match) => match.decision === "deny") ?? matches[0]
}

interface RmOperation {
  readonly recursive: boolean
  readonly targets: ReadonlyArray<string>
  readonly workdir: string
}

interface ShellState {
  readonly workdir: string
  readonly succeeded: boolean
}

type Connector = "always" | "and" | "or"

interface ShellSegment {
  readonly tokens: ReadonlyArray<string>
  readonly connector: Connector
}

function rmOperations(command: string, paths?: Paths): ReadonlyArray<RmOperation> {
  return shellSegments(command).reduce(
    (state, segment) => {
      const executing =
        segment.connector === "and"
          ? state.states.filter((item) => item.succeeded)
          : segment.connector === "or"
            ? state.states.filter((item) => !item.succeeded)
            : state.states
      const skipped =
        segment.connector === "and"
          ? state.states.filter((item) => !item.succeeded)
          : segment.connector === "or"
            ? state.states.filter((item) => item.succeeded)
            : []
      const invocation = executable(segment.tokens)
      if (invocation?.name === "cd") {
        const separator = invocation.args.indexOf("--")
        const target =
          separator >= 0 ? invocation.args[separator + 1] : invocation.args.find((token) => !token.startsWith("-"))
        const home = invocation.args.every((token) => token === "--") ? paths?.home : undefined
        const destination = target ?? home
        const outcomes = destination
          ? executing.flatMap(
              (item): ReadonlyArray<ShellState> => [
                { workdir: resolveTarget(destination, item.workdir, paths), succeeded: true },
                { workdir: item.workdir, succeeded: false },
              ],
            )
          : uncertain(executing)
        return { states: uniqueStates([...skipped, ...outcomes]), operations: state.operations }
      }
      if (invocation?.name !== "rm")
        return { states: uniqueStates([...skipped, ...uncertain(executing)]), operations: state.operations }
      const separator = invocation.args.indexOf("--")
      const options = separator < 0 ? invocation.args : invocation.args.slice(0, separator)
      const recursive = options.some(
        (token) => token === "--recursive" || (/^-[^-]/.test(token) && /[rR]/.test(token.slice(1))),
      )
      const targets = invocation.args.filter((token, index) => {
        if (separator >= 0 && index > separator) return true
        return token !== "--" && !token.startsWith("-") && !/^[<>]/.test(token)
      })
      return {
        states: uniqueStates([...skipped, ...uncertain(executing)]),
        operations: [
          ...state.operations,
          ...Array.from(new Set(executing.map((item) => item.workdir)), (workdir) => ({ recursive, targets, workdir })),
        ],
      }
    },
    {
      states: [{ workdir: paths?.workdir ?? process.cwd(), succeeded: true }] as ReadonlyArray<ShellState>,
      operations: [] as ReadonlyArray<RmOperation>,
    },
  ).operations
}

function uncertain(states: ReadonlyArray<ShellState>): ReadonlyArray<ShellState> {
  return states.flatMap((item) => [
    { workdir: item.workdir, succeeded: true },
    { workdir: item.workdir, succeeded: false },
  ])
}

function uniqueStates(states: ReadonlyArray<ShellState>) {
  return Array.from(new Map(states.map((item) => [`${item.workdir}\0${item.succeeded}`, item])).values())
}

function executable(tokens: ReadonlyArray<string>) {
  const cleaned = tokens.map((token) => token.replace(/^\(+|\)+$/g, ""))
  const index = cleaned.findIndex((token) => {
    const name = path.basename(token)
    return name === "rm" || name === "cd"
  })
  if (index < 0) return undefined
  const wrappers = cleaned.slice(0, index)
  if (
    wrappers.some(
      (token) =>
        !["sudo", "command", "env", "nohup"].includes(path.basename(token)) &&
        !token.startsWith("-") &&
        !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token),
    )
  )
    return undefined
  return { name: path.basename(cleaned[index]), args: cleaned.slice(index + 1) }
}

function shellSegments(command: string): ReadonlyArray<ShellSegment> {
  const segments: ShellSegment[] = []
  let tokens: string[] = []
  let connector: Connector = "always"
  let token = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  const pushToken = () => {
    if (!token) return
    tokens.push(token)
    token = ""
  }
  const pushSegment = (next: Connector) => {
    pushToken()
    if (tokens.length > 0) {
      segments.push({ tokens, connector })
      tokens = []
    }
    connector = next
  }
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === ";" || character === "\n") {
      pushSegment("always")
      continue
    }
    if (character === "|" || character === "&") {
      const repeated = command[index + 1] === character
      pushSegment(repeated ? (character === "|" ? "or" : "and") : "always")
      if (repeated) index++
      continue
    }
    if (/\s/.test(character)) {
      pushToken()
      continue
    }
    token += character
  }
  pushSegment("always")
  return segments
}

function classifyTarget(target: string, workdir: string, paths?: Paths) {
  const literal = wholeTarget(target)
  if (literal === "/" || literal === "~" || literal === "$HOME" || literal === "${HOME}")
    return literal === "/" ? "root" : "home"
  if (!paths) return "narrow"
  const resolved = resolveTarget(literal, workdir, paths)
  if (resolved === path.parse(resolved).root) return "root"
  if (resolved === path.resolve(paths.home)) return "home"
  const relative = path.relative(resolved, path.resolve(paths.project))
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
    return "project"
  return "narrow"
}

function wholeTarget(target: string) {
  return target.replace(/\/(?:\*|\.\*)$/, "") || "/"
}

function resolveTarget(target: string, workdir: string, paths?: Paths) {
  const expanded =
    target === "~" || target === "$HOME" || target === "${HOME}"
      ? (paths?.home ?? target)
      : target.startsWith("~/")
        ? path.join(paths?.home ?? "~", target.slice(2))
        : target === "$PWD" || target === "${PWD}"
          ? workdir
          : target.startsWith("$PWD/")
            ? path.join(workdir, target.slice(5))
            : target.startsWith("${PWD}/")
              ? path.join(workdir, target.slice(7))
              : target.startsWith("$HOME/")
                ? path.join(paths?.home ?? "$HOME", target.slice(6))
                : target.startsWith("${HOME}/")
                  ? path.join(paths?.home ?? "${HOME}", target.slice(8))
                  : target
  return path.resolve(workdir, expanded)
}
