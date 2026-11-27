import { expect, test } from "bun:test"

const tui = new URL("../../tui/src/", import.meta.url)
const source = (path: string) => Bun.file(new URL(path, tui)).text()
const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

const slashGroups = {
  navigation: ["sessions", "projects", "new", "workspaces", "help", "docs", "exit"],
  selection: ["models", "agents", "variants", "themes"],
  services: ["mcps", "connect", "settings", "status", "pair", "restart", "debug", "dots", "keep-awake"],
  history: ["share", "rename", "timeline", "fork", "undo", "redo", "thinking", "copy", "export", "unshare"],
  execution: ["compact", "daybreak", "goal", "autonomous", "sleep", "wake"],
  composition: ["editor", "skills", "btw", "suggest", "prompt", "btw-send", "move", "cd"],
  resources: ["project-settings", "diff"],
}

test("inventory: every literal TUI slash command has a named parity boundary", async () => {
  const files = new Bun.Glob("**/*.{ts,tsx}")
  const found: string[] = []
  const aliases: string[] = []
  for await (const file of files.scan({ cwd: tui.pathname })) {
    const text = await source(file)
    for (const match of text.matchAll(/slash:\s*\{([^}]+)\}/g)) {
      const name = match[1]!.match(/name:\s*"([^"]+)"/)?.[1]
      if (name) found.push(name)
      const alias = match[1]!.match(/aliases:\s*\[([^\]]+)\]/)?.[1]
      if (alias) aliases.push(...[...alias.matchAll(/"([^"]+)"/g)].map((item) => item[1]!))
    }
  }
  expect(sorted(found)).toEqual(sorted(Object.values(slashGroups).flat()))
  expect(sorted(aliases)).toEqual(sorted(["resume", "continue", "clear", "mo", "quit", "q", "summarize", "toggle-thinking"]))
  console.info(`TUI slash inventory: ${sorted(found).length} names, ${sorted(aliases).length} aliases`)
})

const dialogGroups = {
  selection: ["component/dialog-agent.tsx", "component/dialog-model.tsx", "component/dialog-variant.tsx", "component/dialog-theme-list.tsx", "component/dialog-skill.tsx"],
  composition: ["component/dialog-stash.tsx", "component/dialog-btw-export.tsx", "component/dialog-prompt-generate.tsx", "component/dialog-suggest.tsx"],
  lifecycle: ["component/dialog-session-list.tsx", "component/dialog-session-rename.tsx", "component/dialog-session-delete-failed.tsx", "component/dialog-move-session.tsx", "component/dialog-project-copy-name.tsx", "component/dialog-retry-action.tsx"],
  history: ["routes/session/dialog-fork.tsx", "routes/session/dialog-message.tsx", "routes/session/dialog-timeline.tsx", "ui/dialog-export-options.tsx", "ui/dialog-export-result.tsx"],
  decisions: ["component/dialog-autonomous.tsx", "component/dialog-session-goal.tsx", "routes/session/dialog-subagent.tsx"],
  services: ["component/dialog-integration.tsx", "component/dialog-custom-endpoint.tsx", "component/dialog-mcp.tsx", "component/dialog-pair.tsx", "component/dialog-dots-connection.tsx", "component/dialog-session-browser.tsx"],
  resources: ["component/dialog-session-skills.tsx", "component/dialog-workspace-file-changes.tsx"],
  settings: ["component/dialog-config.tsx", "component/dialog-telemetry-consent.tsx"],
  diagnostics: ["component/dialog-debug.tsx", "component/dialog-status.tsx", "component/dialog-session-terminals.tsx"],
  primitives: ["ui/dialog-alert.tsx", "ui/dialog-confirm.tsx", "ui/dialog-help.tsx", "ui/dialog-prompt.tsx", "ui/dialog-select.tsx"],
}

test("inventory: every file-owned TUI dialog has a named parity boundary", async () => {
  const found = await Array.fromAsync(new Bun.Glob("**/dialog-*.tsx").scan({ cwd: tui.pathname }))
  expect(sorted(found)).toEqual(sorted(Object.values(dialogGroups).flat()))
  console.info(`TUI dialog inventory: ${found.length} file-owned dialogs`)
})

const settingPaths = [
  "theme.name", "theme.mode", "animations", "hints.onboarding", "session.sidebar", "session.scrollbar", "session.thinking", "session.grouping",
  "diffs.view", "diffs.wrap", "diffs.tree", "diffs.single", "scroll.speed", "scroll.acceleration", "mouse", "prompt.editor", "prompt.paste", "leader.timeout",
  "attention.enabled", "attention.notifications", "attention.sound", "attention.volume", "terminal.title", "terminal.copy_on_select", "debug.devtools", "debug.timing",
]

test("inventory: every TUI settings row is included, including search-only rows", async () => {
  const text = await source("component/dialog-config.tsx")
  const paths = [...text.matchAll(/path:\s*\[([^\]]+)\]/g)].map((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((part) => part[1]!).join("."))
  expect(sorted(paths)).toEqual(sorted(settingPaths))
  console.info(`TUI settings inventory: ${paths.length} rows`)
})

test("inventory: configuration-only settings remain distinct from dialog rows", async () => {
  const text = await source("config/schema.ts")
  const schema = text.slice(text.indexOf("export const Info = Schema.Struct({"))
  const keys = [...schema.matchAll(/^  ([a-z][a-z_]*): Schema\./gm)].map((match) => match[1]!)
  expect(keys).toEqual(["theme", "keybinds", "plugins", "leader", "scroll", "attention", "diffs", "terminal", "prompt", "session", "hints", "debug", "animations", "mouse"])
  for (const key of ["sound_pack", "sounds", "coordination", "scope", "sessionIDs", "categories"]) expect(text).toContain(`${key}:`)
})

test("inventory: every configurable shortcut belongs to an explicit interaction family", async () => {
  const text = await source("config/keybind.ts")
  const definitions = text.slice(text.indexOf("export const Definitions ="), text.indexOf("satisfies Record<string, Definition>"))
  const names = [...definitions.matchAll(/^\s*(?:"([^"]+)"|([a-z_][a-z0-9_]*)):\s*keybind\(/gm)].map((match) => match[1] ?? match[2]!)
  const families = [
    /^(leader|command_list|help_show|docs_open|app_)/,
    /^(diff_|theme_|sidebar_|scrollbar_|status_|debug_|display_)/,
    /^(session_|messages_|project_)/,
    /^(editor_|prompt_|input_|history_|stash_)/,
    /^(model_|mcp_|provider_|agent_|variant_)/,
    /^(shell_output_|workspaces\.|dialog\.|permission\.|prompt\.)/,
    /^(terminal_|plugin_|plugins\.|which_key_)/,
  ]
  expect(names.length).toBeGreaterThan(150)
  expect(names.filter((name) => !families.some((family) => family.test(name)))).toEqual([])
  expect(names.filter((name) => name.startsWith("session_quick_switch_"))).toHaveLength(9)
  console.info(`TUI shortcut inventory: ${names.length} configurable bindings; ${panels.length} panel source anchors`)
})

const panels = [
  ["routes/home.tsx", "Home"],
  ["routes/session/index.tsx", "SessionMemoryCommand"],
  ["routes/session/composer/index.tsx", "Previous tab"],
  ["routes/session/composer/projects-tab.tsx", 'label: "Projects"'],
  ["routes/session/composer/side-chats-tab.tsx", "New side chat"],
  ["routes/session/composer/subagents-tab.tsx", "Continue stopped subagent"],
  ["routes/session/composer/shell-tab.tsx", "Kill shell command"],
  ["routes/session/project-members.tsx", "Delete member"],
  ["routes/session/projects.tsx", "Delete project"],
  ["routes/session/review-box.tsx", "Submit review answer"],
  ["routes/session/permission.tsx", "Reject permission"],
  ["routes/session/guardrail.tsx", "guardrail"],
  ["routes/session/form.tsx", "form"],
  ["routes/session/subagent-blocked.tsx", "Submit subagent answer"],
  ["routes/session/subagent-footer.tsx", "session.parent"],
  ["routes/session/btw.tsx", "Back to main chat"],
  ["routes/session/provider-usage.tsx", "Usage"],
  ["routes/session/provider-usage-reports.tsx", "Custom UTC range"],
  ["routes/session/subagent-todos.tsx", "todo"],
  ["routes/session/context-breakdown.tsx", "Context"],
  ["routes/workspaces.tsx", "workspaces"],
  ["routes/shell-output.tsx", "Retry shell output"],
  ["routes/terminal-inspector.tsx", "SessionTerminalInspector"],
  ["feature-plugins/system/diff-viewer.tsx", "Toggle selected diff file reviewed"],
  ["feature-plugins/system/which-key.tsx", "Toggle pending key preview"],
  ["feature-plugins/system/plugins.tsx", "Install plugin"],
  ["feature-plugins/system/scrap.tsx", "Open scrap screen"],
  ["feature-plugins/sidebar/context.tsx", "context"],
  ["feature-plugins/sidebar/guardrails.tsx", "guardrail"],
  ["feature-plugins/sidebar/mcp.tsx", "mcp"],
  ["feature-plugins/sidebar/skills.tsx", "resolveSkillConflict"],
  ["feature-plugins/sidebar/subagents.tsx", "subagent"],
  ["feature-plugins/sidebar/todo.tsx", "todo"],
  ["feature-plugins/sidebar/footer.tsx", "footer"],
  ["feature-plugins/home/footer.tsx", "footer"],
  ["component/devtools-sidebar.tsx", "DevTools"],
  ["component/terminal-inspector.tsx", "TerminalInspector"],
  ["mini/footer.prompt.tsx", "Previous prompt history"],
  ["mini/footer.view.tsx", "Manage queued prompts"],
  ["component/prompt/index.tsx", "Shell mode"],
  ["component/prompt/autocomplete.tsx", "Autocomplete"],
] as const

test("inventory: Session, composer, sidebar, auxiliary and terminal panels retain their source anchors", async () => {
  const missing = await Promise.all(panels.map(async ([path, anchor]) => (await source(path)).includes(anchor) ? [] : [`${path}: ${anchor}`]))
  expect(missing.flat()).toEqual([])
})
