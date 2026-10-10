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
  readonly tmpdir?: string
}

const catastrophic: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp; readonly reason: string }> = [
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
    const operands = operation.targets.filter((target) => !isTemporary(target, operation.workdir, paths))
    const targets = operands.map((target) => classifyTarget(target, operation.workdir, paths))
    if (targets.includes("root"))
      return [
        {
          id: "standard.catastrophic.rm-root",
          decision: "deny",
          reason: "Recursive deletion of a filesystem root",
          hardReview: false,
        },
      ]
    if (targets.includes("home"))
      return [
        {
          id: "standard.catastrophic.rm-user-home",
          decision: "deny",
          reason: "Recursive deletion of a user home directory",
          hardReview: false,
        },
      ]
    if (targets.includes("system"))
      return [
        {
          id: "standard.catastrophic.rm-system",
          decision: "deny",
          reason: "Recursive deletion of system directories",
          hardReview: false,
        },
      ]
    if (targets.includes("project"))
      return [
        {
          id: "standard.review.project-deletion",
          decision: "ask",
          reason: "Recursive deletion of the current project or one of its ancestors",
          hardReview: true,
        },
      ]
    if (operands.some((target) => isHomeChild(target, operation.workdir, paths)))
      return [
        {
          id: "standard.review.home-child",
          decision: "ask",
          reason: "Recursive deletion of a direct child of the home directory",
          hardReview: false,
        },
      ]
    return []
  })
  return matches.find((match) => match.decision === "deny") ?? matches.find((match) => match.hardReview) ?? matches[0]
}

const temporaryRoots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders"]
const systemRoots = ["/System", "/Library", "/usr", "/etc", "/bin", "/sbin", "/opt", "/Applications", "/var"]

function isTemporary(target: string, workdir: string, paths?: Paths) {
  const resolved = resolveTarget(wholeTarget(target), workdir, paths)
  return [...temporaryRoots, ...(paths?.tmpdir ? [path.resolve(paths.tmpdir)] : [])].some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  )
}

export function semanticResources(action: string, resources: ReadonlyArray<string>, paths: Paths) {
  return resources.flatMap((resource) => {
    if (action !== "shell")
      return (action === "file_mutation" || path.isAbsolute(resource)) && isTemporary(resource, paths.workdir, paths)
        ? [] : [resource]
    if (readOnlyShell(resource)) return []
    const operations = rmOperations(resource, paths)
    const removals = operations.flatMap((operation) =>
      operation.targets.flatMap((target, index) => {
        const reachable = operations.filter((other) => other.segment === operation.segment)
        return reachable.every((other) => isTemporary(target, other.workdir, paths)) ? [operation.ranges[index]] : []
      }),
    )
    if (removals.length === 0) return [resource]
    const sanitized = shellSegments(resource).flatMap((segment, index) => {
      const operation = operations.find((operation) => operation.segment === index)
      if (operation && operation.ranges.every((range) => removals.includes(range))) return []
      const tokens = segment.rawTokens.filter((_, index) => !removals.includes(segment.ranges[index]))
      if (tokens.length === 0) return []
      return [{ separator: segment.separator, text: tokens.join(" ") }]
    })
    return sanitized.length === 0
      ? []
      : [sanitized.map((segment, index) => `${index === 0 ? "" : segment.separator}${segment.text}`).join("")]
  })
}

const shellReaders = new Set([
  "cat", "head", "tail", "wc", "ls", "grep", "egrep", "fgrep", "rg", "cut", "tr", "nl",
  "basename", "dirname", "realpath", "readlink", "stat", "file", "du", "df", "pwd", "echo", "printf",
  "which", "type", "true", "false", "test", "diff", "cmp", "comm", "jq", "cd", "sed", "find", "sort", "uniq", "git",
])

function readOnlyShell(command: string) {
  const text: string[] = []
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (quote === "'") {
      text.push(character)
      if (character === quote) quote = undefined
      continue
    }
    if (character === "`" || character === "$" || (!quote && /[(){}#]/.test(character))) return false
    if (character === "\\") {
      if (!command[index + 1] || command[index + 1] === "\n") return false
      text.push(character, command[++index])
      continue
    }
    if (quote) {
      text.push(character)
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      text.push(character)
      continue
    }
    if (character === "<") return false
    if (character === ">" || (/\d/.test(character) && command[index + 1] === ">" &&
      (index === 0 || /[\s;|&]/.test(command[index - 1])))) {
      const redirect = command.slice(index).match(/^(?:[012])?>(?:>\s*\/dev\/null|\s*\/dev\/null|&[012])(?=\s|[;|&]|$)/)?.[0]
      if (!redirect) return false
      text.push(" ")
      index += redirect.length - 1
      continue
    }
    text.push(character)
  }
  if (quote) return false
  const segments = shellSegments(text.join(""))
  return segments.length > 0 && segments.every((segment) => readOnlyInvocation(segment.tokens))
}

function readOnlyInvocation(tokens: ReadonlyArray<string>) {
  const name = path.basename(tokens[0])
  if (!shellReaders.has(name) || (tokens[0] !== name && !["/bin", "/usr/bin"].includes(path.dirname(tokens[0])))) return false
  const args = tokens.slice(1)
  if (name === "sed") {
    const scripts: string[] = []
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]
      if (argument === "-n" || argument === "--quiet" || argument === "--silent") continue
      if (argument === "-e" || argument === "--expression") {
        if (!args[index + 1]) return false
        scripts.push(args[++index])
        continue
      }
      if (argument.startsWith("-e") || argument.startsWith("--expression=")) {
        scripts.push(argument.slice(argument.startsWith("-e") ? 2 : 13))
        continue
      }
      if (argument.startsWith("-")) return false
      if (scripts.length === 0) scripts.push(argument)
    }
    return scripts.length > 0 && scripts.every((script) => script.split(";").every((instruction) =>
      /^\s*(?:\d+|\$)?\s*(?:,\s*(?:\d+|\$)\s*)?[pd=]\s*$/.test(instruction)))
  }
  if (name === "find") return !args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(arg))
  if (name === "rg") return !args.some((arg) => /^--pre(?:=|$)/.test(arg))
  if (name === "sort") return !args.some((arg) => /^-[^-]*o/.test(arg) ||
    (arg.startsWith("--") && ["--output", "--compress-program"].some((option) => option.startsWith(arg.split("=")[0]))))
  if (name === "uniq") {
    const operands: string[] = []
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]
      if (["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"].includes(argument)) { index++; continue }
      if (argument === "--") { operands.push(...args.slice(index + 1)); break }
      if (!argument.startsWith("-") || argument === "-") operands.push(argument)
    }
    return operands.length <= 1
  }
  if (name === "file") return !args.some((arg) => /^-[^-]*C/.test(arg) || (arg.startsWith("--") && "--compile".startsWith(arg)))
  if (name === "jq") return !args.includes("--run-tests")
  if (name !== "git") return true
  if (args.some((arg) => arg.startsWith("--") && ["--output", "--ext-diff", "--textconv"].some((option) => option.startsWith(arg.split("=")[0])))) return false
  const gitArgs = args[0] === "--no-pager" ? args.slice(1) : args
  if (["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "merge-base"].includes(gitArgs[0])) return true
  if (gitArgs[0] === "branch") return gitArgs.length > 1 && gitArgs.slice(1).every((arg) =>
    ["--show-current", "--list", "-a", "-r", "-v"].includes(arg))
  if (gitArgs[0] === "worktree") return gitArgs[1] === "list" && gitArgs.slice(2).every((arg) => ["--porcelain", "-z", "-v"].includes(arg))
  return gitArgs[0] === "remote" && gitArgs.length === 2 && gitArgs[1] === "-v"
}

function isHomeChild(target: string, workdir: string, paths?: Paths) {
  if (!paths) return false
  return path.dirname(resolveTarget(wholeTarget(target), workdir, paths)) === path.resolve(paths.home)
}

interface RmOperation {
  readonly recursive: boolean
  readonly targets: ReadonlyArray<string>
  readonly workdir: string
  readonly segment: number
  readonly ranges: ReadonlyArray<string>
}

interface ShellState {
  readonly workdir: string
  readonly succeeded: boolean
}

type Connector = "always" | "and" | "or"

interface ShellSegment {
  readonly tokens: ReadonlyArray<string>
  readonly rawTokens: ReadonlyArray<string>
  readonly connector: Connector
  readonly separator: string
  readonly ranges: ReadonlyArray<string>
}

function rmOperations(command: string, paths?: Paths): ReadonlyArray<RmOperation> {
  return shellSegments(command).reduce(
    (state, segment, segmentIndex) => {
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
      const targetIndexes = invocation.args.flatMap((token, index) => {
        if (separator >= 0 && index > separator) return [index]
        return token !== "--" && !token.startsWith("-") && !/^[<>]/.test(token) ? [index] : []
      })
      const targets = targetIndexes.map((index) => invocation.args[index])
      const ranges = targetIndexes.map((index) => segment.ranges[segment.tokens.length - invocation.args.length + index])
      return {
        states: uniqueStates([...skipped, ...uncertain(executing)]),
        operations: [
          ...state.operations,
          ...Array.from(new Set(executing.map((item) => item.workdir)), (workdir) => ({
            recursive, targets, workdir, segment: segmentIndex, ranges,
          })),
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
  let rawTokens: string[] = []
  let connector: Connector = "always"
  let separator = ""
  let ranges: string[] = []
  let token = ""
  let tokenStart = 0
  let quote: "'" | '"' | undefined
  let escaped = false
  const pushToken = (end: number) => {
    if (!token) return
    tokens.push(token)
    rawTokens.push(command.slice(tokenStart, end))
    ranges.push(`${segments.length}:${tokens.length - 1}`)
    token = ""
  }
  const pushSegment = (next: Connector, nextSeparator: string, end: number) => {
    pushToken(end)
    if (tokens.length > 0) {
      segments.push({ tokens, rawTokens, connector, separator, ranges })
      tokens = []
      rawTokens = []
      ranges = []
    }
    connector = next
    separator = nextSeparator
  }
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      if (!token) tokenStart = index
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === "'" || character === '"') {
      if (!token) tokenStart = index
      quote = character
      continue
    }
    if (character === ";" || character === "\n") {
      pushSegment("always", `${character} `, index)
      continue
    }
    if (character === "|" || character === "&") {
      const repeated = command[index + 1] === character
      pushSegment(repeated ? (character === "|" ? "or" : "and") : "always", ` ${character}${repeated ? character : ""} `, index)
      if (repeated) index++
      continue
    }
    if (/\s/.test(character)) {
      pushToken(index)
      continue
    }
    if (!token) tokenStart = index
    token += character
  }
  pushSegment("always", "", command.length)
  return segments
}

function classifyTarget(target: string, workdir: string, paths?: Paths) {
  const literal = wholeTarget(target)
  if (literal === "/" || literal === "~" || literal === "$HOME" || literal === "${HOME}")
    return literal === "/" ? "root" : "home"
  const resolved = resolveTarget(literal, workdir, paths)
  if (resolved === path.parse(resolved).root) return "root"
  if ((paths && resolved === path.resolve(paths.home)) || /^\/(?:Users|home)\/[^/]+$/.test(resolved)) return "home"
  if (systemRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return "system"
  if (!paths) return "narrow"
  const relative = path.relative(resolved, path.resolve(paths.project))
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
    return "project"
  return "narrow"
}

function wholeTarget(target: string) {
  return target.replace(/\/(?:\*|\.\*)$/, "") || "/"
}

function resolveTarget(target: string, workdir: string, paths?: Paths) {
  if (paths?.tmpdir && /^(?:\$TMPDIR|\$\{TMPDIR\})(?:\/|$)/.test(target))
    return path.resolve(paths.tmpdir, target.replace(/^(?:\$TMPDIR|\$\{TMPDIR\})\/?/, ""))
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
