import type { DocPage } from "../types"

export const usePages: readonly DocPage[] = [
  {
    slug: "usage",
    title: "Using YCoding",
    group: "Use",
    description: "Choose a terminal workflow, run a prompt from a script, or continue durable work from another device.",
    sections: [
      {
        heading: "Choose how to work",
        blocks: [
          {
            kind: "table",
            head: ["Surface", "Start here", "Best for"],
            rows: [
              ["Interactive terminal", "ycoding", "Prompts, approvals, Session navigation, terminals, and review."],
              ["One direct prompt", "ycoding --model <[profile#]provider/model[#variant]> \"<prompt>\"", "A non-interactive request with an explicit model."],
              ["Scripted run", "ycoding run <message> [options]", "Session selection, attachments, JSON output, or explicit autonomy."],
              ["Remote workspace", "Open /remote in a browser", "Continue work on a connected machine."],
            ],
          },
          {
            kind: "steps",
            items: [
              { title: "Open the project", text: "Start YCoding in the project directory. The interactive interface uses that working directory for local tools and configuration." },
              { title: "Choose the model and agent", text: "Use the TUI pickers, or specify --model and --agent for a scripted run. A model reference uses [profile#]provider/model[#variant]; an omitted profile uses the provider default." },
              { title: "Send the task", text: "Use the TUI when a person may need to answer a permission or guardrail review. A non-interactive run cannot pause for a person to answer a blocker." },
            ],
          },
          { kind: "code", language: "sh", label: "Open the terminal interface", code: "pwd\nycoding" },
          { kind: "callout", tone: "tip", title: "Choose by interaction needs", text: "Use the TUI for work that may require decisions during execution. Use ycoding run for bounded automation and check its exit status." },
        ],
      },
      {
        heading: "Sessions keep the thread",
        blocks: [
          { kind: "paragraph", text: "A Session stores its history and pending input durably. Reusing a Session ID adopts that Session instead of starting a second history. The terminal can resume a Session, and ycoding run --session <sessionID> can continue it." },
          {
            kind: "list",
            items: [
              "Prompts steer by default: while work is active, a new prompt promotes at the next safe step boundary and execution continues.",
              "Queued prompts wait until the Session would otherwise become idle, then promote one at a time.",
              "A Session can be archived and unarchived without deleting its transcript.",
              "The remote browser controls the local Session; model, shell, tool, and file execution remain on the machine.",
            ],
          },
        ],
      },
      {
        heading: "Run a scripted example",
        blocks: [
          { kind: "code", language: "sh", label: "Run and request JSON output", code: 'ycoding run --format json "Summarize the failing tests in this project"' },
          { kind: "paragraph", text: "On success, the command prints the model response in the selected output format and exits with status 0. The answer depends on the configured model and project. A provider error or unresolved non-interactive blocker can produce an unsuccessful exit; inspect stderr and the status before treating the task as complete." },
          { kind: "related", slugs: ["usage/tui", "usage/cli", "usage/sessions", "usage/remote"] },
        ],
      },
    ],
  },
  {
    slug: "usage/tui",
    title: "Working in the terminal",
    group: "Use",
    description: "Navigate the Session view, compose prompts, answer reviews, and inspect the transcript and activity.",
    sections: [
      {
        heading: "Orient in a Session",
        blocks: [
          { kind: "paragraph", text: "The interactive terminal centers on the selected Session and its transcript. The header and sidebar expose the selected model, agent, autonomy, context, orchestration, and todo state. The composer stays available for the next prompt. Open the command palette with ctrl+p to find actions available in the current view." },
          {
            kind: "table",
            head: ["Area", "Use it to"],
            rows: [
              ["Transcript", "Read user and assistant messages, tool calls, compaction records, and execution results in order."],
              ["Sidebar", "Inspect Session context, generation speed, status, subagents, and runtime state."],
              ["Composer", "Write multi-line prompts, choose delivery behavior, and attach supported files or images."],
              ["Command palette", "Find Session, model, agent, service, theme, and context-sensitive actions."],
            ],
          },
          {
            kind: "steps",
            items: [
              { title: "Create or resume", text: "Press ctrl+x, then n for a new Session, or ctrl+x, then l to open the Session list. Select an entry to resume it. Success: the selected Session title and transcript appear. If the Session is missing, check the current Location and Session list." },
              { title: "Choose a model or agent", text: "Press ctrl+x, then m for the model picker, or ctrl+x, then a for the agent picker. Success: the Session header shows the selected model or agent. If a choice is unavailable, check provider credentials, model availability, or the configured agent list." },
              { title: "Find earlier work", text: "Press ctrl+x, then g, or enter /timeline to jump to a transcript point. Open a message action to fork or revert from that point. A message no longer available after a history reload can be selected again from the timeline." },
            ],
          },
        ],
      },
      {
        heading: "Compose and deliver prompts",
        blocks: [
          {
            kind: "table",
            head: ["Input", "Default behavior"],
            rows: [
              ["Return", "Submit the prompt."],
              ["Shift+Return", "Insert a newline. ctrl+return, alt+return, and ctrl+j also insert a newline."],
              ["Leader+d (default leader is ctrl+x)", "Send the prompt and steer immediately, interrupting the active step to reach the next safe boundary."],
              ["Leader+q (default leader is ctrl+x)", "Open queued-prompt management."],
            ],
          },
          { kind: "paragraph", text: "Ordinary prompts steer by default. They are admitted durably and promoted at a safe execution boundary. A queued input stays pending until the Session would otherwise stop. Promoting new input resets the selected agent's step allowance." },
          {
            kind: "steps",
            items: [
              { title: "Draft", text: "Use Shift+Return for a new line and Return to submit." },
              { title: "Attach", text: "Paste a clipboard image or a supported local file path. Attachment preparation happens before prompt admission, with a 20 MiB byte limit." },
              { title: "Check delivery", text: "A pending prompt shows a clock receipt, a promoted prompt one check, and a prompt consumed by a physical model request two checks." },
            ],
          },
          { kind: "callout", tone: "info", title: "Cancel preparation separately from execution", text: "Escape or Cancel pending action cancels local preparation, such as clipboard reading or waking an admitted prompt. The Session interrupt action stops active execution when it is available." },
        ],
      },
      {
        heading: "Approvals, guardrails, and Forms",
        blocks: [
          { kind: "paragraph", text: "Permission asks govern one tool action under its permission rules. Guardrail reviews separately check higher-impact actions and can block the Session family. Read the action and resource before choosing a reply." },
          {
            kind: "table",
            head: ["Request", "Choices", "Effect"],
            rows: [
              ["Permission", "once, always, reject", "Approve once, save the matching requested action and resources for this project, or reject."],
              ["Ordinary guardrail", "once, always, reject", "Always applies only to exact matching asks and metadata in the Session family and current Location process."],
              ["Hard guardrail", "once, reject", "A human decision is required at every autonomy level; reusable approvals do not apply."],
              ["Form or question", "Submit an answer or cancel", "Complete required typed fields, defaults, and choices shown in the request."],
            ],
          },
          { kind: "callout", tone: "warning", title: "YOLO does not bypass hard reviews", text: "Only YOLO 3 can automatically approve ordinary guardrail reviews. Hard reviews still require a human once or reject decision." },
          { kind: "related", slugs: ["configuration/permissions", "configuration/yolo"] },
        ],
      },
      {
        heading: "Slash commands",
        blocks: [
          { kind: "paragraph", text: "Type / in the composer to search slash commands and skills. A command may take text after its name; some commands are useful only while a Session is selected." },
          {
            kind: "table",
            head: ["Command", "Action"],
            rows: [
              ["/help", "Open terminal help."],
              ["/sessions, /resume, /continue", "Open the Session list."],
              ["/new, /clear", "Start a new Session."],
              ["/models, /mo; /agents; /variants; /mcps", "Open model, agent, variant, or MCP pickers."],
              ["/connect", "Connect a provider integration."],
              ["/goal <objective>", "Set a Session goal through the goal command."],
              ["/yolo [0|1|2|3]", "Cycle autonomy, or set a valid explicit level."],
              ["/compact, /summarize", "Start Session compaction."],
              ["/timeline; /fork; /undo; /redo", "Navigate history, fork, stage a revert, or clear the staged revert."],
              ["/daybreak [blue|red|off]", "Set the Daybreak program supported by the selected model."],
              ["/settings; /status; /pair; /themes; /debug", "Open settings, status, pairing, themes, or debug information."],
              ["/restart", "Restart the service when the connected client provides restart support."],
              ["/exit, /quit, /q", "Exit the terminal interface."],
            ],
          },
          { kind: "callout", tone: "tip", title: "Use the palette for the complete action list", text: "The command palette opens with ctrl+p and filters actions for the current screen. Skills and configured commands can also appear in slash completion." },
        ],
      },
      {
        heading: "Keybindings",
        blocks: [
          {
            kind: "table",
            head: ["Default key", "Action"],
            rows: [
              ["ctrl+x", "Leader key for combinations."],
              ["ctrl+p", "Open command palette."],
              ["ctrl+x, then n / l / g", "New Session / Session list / timeline."],
              ["ctrl+x, then m / a / v", "Model / agent / variant picker."],
              ["ctrl+x, then b / c / q", "Toggle sidebar / compact Session / queued prompts."],
              ["ctrl+x, then d", "Send prompt and steer immediately."],
              ["Escape", "Interrupt active Session; cancels local prompt preparation when a preparation is pending."],
              ["ctrl+x, then 1–9", "Switch to the Session in quick slot 1–9."],
              ["PageUp / PageDown", "Scroll transcript by a page."],
              ["ctrl+x, then q", "Exit the application."],
            ],
          },
          { kind: "paragraph", text: "The default leader is ctrl+x. Keybindings are configurable in cli.json; set a binding to none to disable it. Open /help or the command palette to inspect actions in your current view." },
        ],
      },
      {
        heading: "Subagents, terminals, and transcript tools",
        blocks: [
          {
            kind: "list",
            items: [
              "Subagents are durable child Sessions that run in the background. Use child-session controls to inspect status and conversation, then return to the parent Session.",
              "Session-owned terminals open from the command palette. Inspection is read-only until you explicitly take control; closing the inspector detaches without terminating the terminal.",
              "The transcript contains tool and compaction records. Use /timeline to navigate, /fork to branch, and /undo or /redo to stage or clear a revert boundary.",
              "Chrome extension and isolated-browser controls are distinct tools with explicit permissions. Availability depends on installation and platform support.",
            ],
          },
          { kind: "related", slugs: ["usage/sessions", "configuration/appearance", "configuration/permissions"] },
        ],
      },
    ],
  },
  {
    slug: "usage/cli",
    title: "Command line",
    group: "Use",
    description: "Run prompts, adopt Sessions, set autonomy, attach files, update YCoding, and configure the CLI environment.",
    sections: [
      {
        heading: "Start the interactive interface",
        blocks: [
          { kind: "code", language: "sh", label: "Open the current project", code: "pwd\nycoding" },
          {
            kind: "table",
            head: ["Invocation", "Effect"],
            rows: [
              ["ycoding [directory]", "Start the TUI, optionally in the given directory."],
              ["ycoding --continue or -c", "Continue the last Session."],
              ["ycoding --session <sessionID> or -s <sessionID>", "Open a specific Session."],
              ["ycoding --model <[profile#]provider/model[#variant]> \"<prompt>\"", "Run a prompt directly instead of opening the TUI. Requires a model and positional prompt."],
              ["ycoding --help", "Show CLI help and available commands."],
            ],
          },
          {
            kind: "table",
            head: ["Root option", "Argument", "Default", "Effect"],
            rows: [
              ["directory", "Optional positional path", "Current directory", "Start the TUI in that directory."],
              ["--continue", "Boolean; alias -c", "false", "Continue the last Session."],
              ["--session", "<sessionID>; alias -s", "Unset", "Open a specific Session."],
              ["--model", "<[profile#]provider/model[#variant]>", "Unset", "Run the positional prompt with this model, optional profile, and variant."],
              ["--server", "<url>", "Unset", "Connect to a server URL instead of the background service."],
              ["--standalone", "Boolean", "false", "Run with a private server instead of the background service."],
            ],
          },
          { kind: "paragraph", text: "The root --model option requires a positional prompt. Use ycoding run when you need the full non-interactive option set." },
        ],
      },
      {
        heading: "Run a prompt",
        blocks: [
          { kind: "code", language: "sh", label: "Basic run", code: 'ycoding run --format json "Summarize the failing tests in this project"' },
          { kind: "paragraph", text: "The run command sends the message through the durable Session runtime. On success it prints the model response and exits with status 0. The default format is default; use --format json when the caller needs JSON. A missing model, unavailable credentials, provider failure, or non-interactive blocker can prevent a successful response; inspect stderr and the exit status." },
          { kind: "code", language: "sh", label: "Attach a test report", code: 'ycoding run --file ./test-output.txt "Summarize this test output"' },
        ],
      },
      {
        heading: "Adopt or fork a Session",
        blocks: [
          {
            kind: "table",
            head: ["Option", "Argument / alias", "Default", "Effect"],
            rows: [
              ["--continue", "Boolean; -c", "false", "Continue the last Session."],
              ["--session", "<id>; -s", "Unset", "Continue the named Session."],
              ["--fork", "Boolean", "false", "Fork before continuing; requires --continue or --session."],
              ["--title", "<text>", "Unset", "Set the Session title."],
            ],
          },
          { kind: "code", language: "sh", label: "Continue a Session", code: 'ycoding run --session ses_123 "Continue the investigation"' },
          { kind: "code", language: "sh", label: "Fork the last Session", code: 'ycoding run --continue --fork --title "Alternative approach" "Try a different implementation"' },
          { kind: "callout", tone: "info", title: "Autonomy belongs to the Session", text: "Omitting --yolo preserves an adopted Session's current autonomy. Set it explicitly when a script needs a known level." },
        ],
      },
      {
        heading: "Run options",
        blocks: [
          {
            kind: "table",
            head: ["Option", "Argument / alias", "Default", "Effect"],
            rows: [
              ["--model", "<[profile#]provider/model[#variant]>; alias -m", "Unset", "Select a model and optional profile and variant; an omitted profile uses the provider default."],
              ["--agent", "<name>", "Unset", "Select an agent; default agent selection applies when omitted."],
              ["--format", "default or json", "default", "Choose output format."],
              ["--file", "<path>; alias -f; repeatable up to 100", "None", "Attach files to the message."],
              ["--title", "<text>", "Unset", "Set the Session title."],
              ["--thinking", "Boolean", "false", "Show thinking blocks in output."],
              ["--yolo", "<level>: 0, 1, 2, or 3", "0 for new Sessions; preserves adopted Session value", "Set durable Session YOLO before prompt admission; an explicit value is required when the option is present."],
              ["--continue", "Boolean; alias -c", "false", "Continue the last Session."],
              ["--session", "<id>; alias -s", "Unset", "Continue a Session by ID."],
              ["--fork", "Boolean", "false", "Fork before continuing; requires --continue or --session."],
              ["--server", "<url>", "Unset", "Connect to a server URL instead of the background service."],
              ["--standalone", "Boolean", "false", "Use a private server instead of the background service."],
            ],
          },
          {
            kind: "table",
            head: ["YOLO level", "Automatic behavior"],
            rows: [
              ["0", "No YOLO-level automation; an active goal can still auto-answer questions and permissions."],
              ["1", "Automatically answer questions and Forms."],
              ["2", "Also approve tool permissions."],
              ["3", "Also approve ordinary guardrail reviews; hard reviews still require a human."],
            ],
          },
          { kind: "code", language: "sh", label: "Set autonomy explicitly", code: 'ycoding run --yolo 2 "Inspect the tests and report failures"' },
        ],
      },
      {
        heading: "Update, service, and remote commands",
        blocks: [
          {
            kind: "table",
            head: ["Command", "Arguments / options", "Purpose"],
            rows: [
              ["ycoding update", "Optional --version <version>", "Install the latest release or a specific published version, then restart an idle background server onto it."],
              ["ycoding service status", "None", "Show background service status."],
              ["ycoding service restart", "None", "Restart the background service."],
              ["ycoding remote enroll <enrollmentID>", "Optional --name <name>, --relay <origin>, --replace", "Enroll this machine; the one-use code is read at a prompt, never from argv."],
              ["ycoding remote connect", "Optional --relay <origin>, --server <url>, or --standalone", "Turn on the machine's remote connection in its background server and return once it is on; with --standalone it stays in the foreground until Ctrl-C."],
              ["ycoding remote disconnect", "Optional --server <url> or --standalone", "Turn off the machine's remote connection."],
              ["ycoding remote status", "Optional --server <url> or --standalone", "Show device enrollment, backend Session access, and the remote connection state."],
              ["ycoding remote sessions", "Optional --server <url> or --standalone", "List Sessions available to the enrolled machine owner."],
            ],
          },
          { kind: "code", language: "sh", label: "Update to the latest published release", code: "ycoding update" },
          { kind: "callout", tone: "warning", title: "Updating installs a release", text: "The updater replaces an installed release after validating its published archive, then restarts a running background server that has no Session work outstanding. A server with running work keeps running; run `ycoding service restart` once that work finishes to apply the update. Local development builds cannot self-update; rebuild them from the repository." },
        ],
      },
      {
        heading: "Other CLI commands",
        blocks: [
          {
            kind: "table",
            head: ["Command", "Arguments and flags", "Defaults or constraints", "Purpose"],
            rows: [
              ["ycoding api <request>", "One operation ID or HTTP method and path; --data/-d; repeatable --header/-H; optional --param key=value", "Request required; headers up to 100", "Make a request to the running server."],
              ["ycoding debug agents", "No command-specific flags", "—", "List available agents."],
              ["ycoding console login [url]", "Optional Console URL", "Unset", "Log in to OpenCode Console."],
              ["ycoding auth connect <url>", "Well-known provider URL", "Required", "Connect to an authentication provider."],
              ["ycoding mcp list", "No command-specific flags", "—", "List configured MCP servers and status."],
              ["ycoding mcp add <name> [-- <command...>]", "Local command after -- or remote --url; repeatable --header name=value and --env name=value; --global", "Choose local command or remote URL; --global false", "Add an MCP server configuration."],
              ["ycoding mcp auth <name>; ycoding mcp logout <name>", "Server name", "Required", "Authenticate with an OAuth-capable remote server; remove its stored OAuth credentials."],
              ["ycoding plugin list", "No command-specific flags", "—", "List active plugins."],
              ["ycoding mini", "--continue/-c, --session/-s, --fork, --replay, --replay-limit <N>, --model/-m, --agent, --prompt; shared --server/--standalone", "continue/fork false; replay true; remaining optional", "Start the minimal interactive interface. --fork requires --continue or --session."],
              ["ycoding service start/restart/status/stop", "No command-specific flags", "—", "Manage the background server."],
              ["ycoding service get [key]", "Optional key", "Unset", "Get service configuration."],
              ["ycoding service set <key> <value>; ycoding service unset <key>", "Key and value; key", "Required", "Set or unset service configuration."],
              ["ycoding pair", "No command-specific flags", "—", "Show server pairing information."],
              ["ycoding serve", "--hostname <host>, --port <number>, --service, --stdio", "hostname/port unset; booleans false", "Start the API server."],
            ],
          },
          { kind: "paragraph", text: "Global --server <url> and --standalone options are also available to commands using shared server connection settings. Use ycoding <command> --help for the installed binary's argument syntax. Check ycoding service status before retrying a command that cannot reach its server." },
        ],
      },
      {
        heading: "Environment variables",
        blocks: [
          {
            kind: "table",
            head: ["Variable", "Effect"],
            rows: [
              ["YCODING_CONFIG", "Select an explicit runtime configuration file."],
              ["YCODING_CONFIG_CONTENT", "Supply inline runtime configuration at highest priority."],
              ["YCODING_CONFIG_DIR", "Override the global configuration directory."],
              ["YCODING_CONFIG_PROJECT_DISABLE", "Disable project configuration discovery."],
              ["YCODING_DISABLE_PROJECT_CONFIG", "Alternate project-discovery disable switch."],
              ["YCODING_DB", "Override the session database path."],
              ["YCODING_LOG_LEVEL", "Set the logging threshold."],
              ["YCODING_PRINT_LOGS", "Print logs to the terminal."],
              ["YCODING_DISABLE_AUTOUPDATE", "Disable update checks."],
              ["YCODING_PASSWORD", "Password for an explicitly connected or standalone server."],
              ["YCODING_SERVER_PASSWORD", "Alternate server-password variable when YCODING_PASSWORD is unset."],
              ["YCODING_REMOTE_URL", "Relay origin used by ycoding remote; --relay takes precedence."],
              ["YCODING_MODELS_URL", "Override the model catalog URL."],
              ["YCODING_MODELS_PATH", "Read the model catalog from a local file."],
              ["YCODING_DISABLE_MODELS_FETCH", "Disable model-catalog network refresh."],
              ["YCODING_GIT_BASH_PATH", "Set the Git Bash path used on Windows."],
              ["YCODING_FILEWATCHER_DISABLE", "Disable the filesystem watcher."],
              ["YCODING_DISABLE_FILEWATCHER", "Alternate filesystem-watcher disable switch."],
              ["YCODING_DISABLE_FFF", "Disable the FFF filesystem backend."],
              ["YCODING_WEBSEARCH_PROVIDER", "Select the web-search provider."],
              ["YCODING_TERMINAL", "Override the terminal identity used by shell and PTY behavior."],
            ],
          },
          { kind: "paragraph", text: "Runtime configuration precedence and supported fields are documented on the Configuration page. Build, test, and internal diagnostic variables are not stable user settings." },
          { kind: "related", slugs: ["configuration", "configuration/yolo", "configuration/permissions", "usage/remote"] },
        ],
      },
    ],
  },
  {
    slug: "usage/remote",
    title: "Remote workspace",
    group: "Use",
    description: "Sign in, enroll your machine, create or reopen a Session, and work through the browser while execution stays local.",
    sections: [
      {
        heading: "Command palette",
        blocks: [
          { kind: "paragraph", text: "Inside the workspace, choose Open command palette in the header or press Ctrl+K or Cmd+K. Ctrl+P also opens it outside text fields; Cmd+P keeps browser printing. Search actions by name, slash command, or skill ID, then use the arrow keys and Enter or tap a result. Available Session actions, configured commands, skills, navigation, appearance, notifications, and account actions follow your current view and connection state." },
          { kind: "paragraph", text: "Select provider and model opens the current composer's model, profile, and effort controls without changing the draft. Connect provider adds or replaces a named profile on the selected machine and makes it that provider's default; it does not replace a Session's explicit profile selection. Keys and manual authorization codes pass through the authenticated relay to the machine. Methods that need a local browser say so. Failed or uncertain authentication is not automatically retried; check status or refresh profiles first." },
          { kind: "paragraph", text: "Commands that need text fill the composer for editing while preserving your draft; they do not send automatically. Escape returns focus to the opener. On phones, the palette fills the visible screen above the on-screen keyboard. The terminal palette uses Ctrl+P and also searches slash names and aliases." },
        ],
      },
      {
        heading: "Sign in and connect",
        blocks: [
          { kind: "paragraph", text: "The remote workspace is a browser client for Sessions on a machine running YCoding. Its three primary destinations are Sessions (/remote/sessions), Usage (/remote/usage), and Settings (/remote/settings). New session at /remote is the landing with the wordmark, repository choice and composer; a selected transcript is the Session detail at /remote/session?session_id=<id>&device_id=<id>. Open /remote; when signed out, use Continue with Google or enter an access key from a redeemed invite. After sign-in, select an online machine and one of its Sessions. Account and connection states remain distinct, so an offline device does not appear signed out." },
          {
            kind: "steps",
            items: [
              { title: "Sign in", text: "Choose Continue with Google with an eligible account, or enter your access key. Success: the workspace loads the account and device state. If a key is invalid or attempts are limited, the form explains how to retry." },
              { title: "Accept an invite", text: "Open your invite link. Its secret fragment disappears from the address bar immediately. Select Accept invite to create your separate account, then store the access key shown once. Use that key to sign in on another device and choose Continue to open the workspace. A used, deleted, or fragment-less link cannot be accepted; use your existing access key to sign in instead." },
              { title: "Create an enrollment", text: "Open Settings, then Devices, and choose Create enrollment code. The page shows an enrollment ID, a copyable command, and a one-use code with an expiration. If hidden or expired, create a new enrollment." },
              { title: "Enroll the machine", text: "Run the displayed command on the machine that runs YCoding. Enter the code at its hidden prompt; the code is not a command argument. Success: enrollment completes without placing the code in shell history." },
              { title: "Turn on the connection", text: "Run ycoding remote connect on that machine, or turn on Remote connection in the TUI command palette. The machine's background server keeps the connection on, even with no TUI open, until you turn it off from any TUI or with ycoding remote disconnect. Success: the device appears online and its Sessions are selectable. If it does not, run ycoding remote status and confirm the connection state and relay origin." },
              { title: "Open a Session", text: "Choose the online machine, using Confirm Selection in the phone picker, then select an existing Session or choose New session. Selecting an existing Session opens its transcript at /remote/session?session_id=<id>&device_id=<id>; New session remains the wordmark landing. From New session, choose a previously opened repository, an agent, and a model with its variant, then type your first prompt. Closing the phone picker without confirming keeps the current machine. Success: an existing transcript opens on its owning machine; a new Session opens after creation and starts with the prompt you typed." },
            ],
          },
          { kind: "code", language: "sh", label: "Enroll and connect", code: "ycoding remote enroll <enrollmentID> --relay <origin>\n# Enter the one-use code when prompted.\nycoding remote connect" },
          { kind: "callout", tone: "warning", title: "A connected device grants broad Session access", text: "The enrolled account can reach all existing and future Sessions in that local backend while the device is connected. Keep the connector on a machine and account you trust." },
          {
            kind: "table",
            head: ["State", "Visible result", "What to check"],
            rows: [
              ["Signed out", "Dedicated sign-in screen with Continue with Google and an access-key form.", "Complete sign-in; if Google is rejected, confirm the account is eligible; an invalid key or too many attempts is reported separately."],
              ["Signed in, no machine", "Workspace offers device enrollment in Settings.", "Create a one-use enrollment and run the displayed CLI command."],
              ["Machine offline", "Device is not selectable; reconnect is offered for a selected device.", "Restore the machine's network and run ycoding remote status. An enabled connecting state recovers automatically. Enable an off connection; for error, repair the reported problem, then run ycoding remote connect or turn the TUI toggle off and then on."],
              ["Machine online, no Sessions", "Connected machine reports an empty Session list and offers New session.", "Choose a previously opened repository. If none is listed, open it locally, then refresh repositories."],
            ],
          },
        ],
      },
      {
        heading: "Connection recovery",
        blocks: [
          { kind: "paragraph", text: "The machine saves your enabled choice and restores it when its background service starts. While enabled, it automatically retries recoverable startup failures, connector-lock contention, network outages, and failed credential rotation. Update the connected machine with `ycoding update` to use the current recovery behavior; replace development builds and Windows binaries manually." },
          {
            kind: "table",
            head: ["Local connection state", "Meaning", "Next action"],
            rows: [
              ["`off`", "Remote access is disabled.", "Run `ycoding remote connect` or select Remote connection in the TUI to enable it."],
              ["`connecting`", "Remote access is enabled and starting or recovering.", "Restore network access and let recovery continue. Startup and lock retries wait 1, 2, 4, 8, 16, then at most 30 seconds; ordinary socket reconnection is automatic. Authentication and socket opening each have a 30-second deadline."],
              ["`on`", "The machine's relay connection is open.", "Select the machine and open a Session in the browser."],
              ["`error`", "Setup or authentication needs attention.", "Run `ycoding remote status` and repair the reported problem. Missing or invalid enrollment, rejected credentials, a relay-origin mismatch, and unsafe local endpoints require attention; recovery does not automatically reenroll a device. Then run `ycoding remote connect`, or turn the TUI toggle off and then on."],
            ],
          },
          { kind: "paragraph", text: "Selecting Remote connection while it is connecting, on, or in error turns it off. A second toggle during a pending enable also requests disable. Disabling with the toggle or `ycoding remote disconnect` aborts pending authentication, cancels recovery, and prevents late replies from reopening the connection. When you stop the background service, the live connection closes but its saved enabled choice remains for the next start." },
          { kind: "code", language: "sh", label: "Inspect or disable remote access", code: "ycoding remote status\nycoding remote disconnect" },
        ],
      },
      {
        heading: "What the browser can do",
        blocks: [
          {
            kind: "table",
            head: ["Area", "Actions"],
            rows: [
              ["Sessions", "On tablets and desktops, one global 288px rail owns primary navigation (Sessions, Usage, Settings) and the contextual Workspaces list; choose a workspace there or from the Sessions-page picker on phones. On phones, Open sessions retains the drawer, and the bottom bar shows three labeled destinations in one row. Workspaces appear by name; the global project and temporary folders are not listed. Selecting Sessions from another screen opens it at the top, and a floating Jump to top button appears once you scroll down the list. Browse root Sessions 25 at a time, ordered running first, then pinned, then most recent. A dot marks a Session waiting for your decision; a Session whose last run failed shows a Failed chip instead, with no dot, until it runs again; search and status filters apply within the selected workspace and show only matching Sessions, and opening a Session clears them. At the top, the swipeable Running and recent carousel shows up to ten root Sessions across all workspaces: running ones first, including a Session whose subagents are still working, then recently active ones, each card marked Running or with its last-active time. It uses 300px cards on desktop and 85%-width cards with a next-card peek on phones. Cards snap while scrolling; pagination dots select a card and appear only when the row overflows. Reduced motion removes smooth dot scrolling. Select a card to open its Session. On Session detail, the same rail shows the open Session's workspace as a heading without a picker and highlights the root of an open child Session. On tablets and desktops, Hide workspace sidebar in the rail collapses it to three icon links so the page uses the freed width, and Show workspace sidebar restores it without changing the Session; the workspace picker stays available while collapsed, and the browser remembers this choice across reloads. The Conversation–Office selector pairs an icon with each label and slides between views while the header Team control stays in place, and reduced motion disables these animations. Initial account and Session-list loads reserve space with delayed placeholders; refreshing the same machine keeps existing Session rows visible. Changing a search or filter keeps the current rows visible but not selectable until the new list arrives, and Running and recent holds its space during its first read, then shows cards or closes the empty space. Start a New session or reopen an existing one. The three primary destinations are Sessions, Usage, and Settings."],
              ["Session", "Read the transcript with formatted Markdown, collapsible thinking and tool rows with durations and status badges, and agent, model, and duration details under each reply. Each prompt gets its own Edited files card after that prompt's last reply. It lists the files changed by completed `edit` and `patch` calls from that prompt and from the subagent work the prompt started, sent to, or answered, with one row per file that sums that prompt's recorded changes; totals from earlier prompts never carry into a later card. The card is one collapsed summary row at every width; open it to list every file, then expand a file to see its captured diffs, with counts matching the changes shown: split on tablets and desktops, unified on phones. Oversized patches are labeled unavailable, and a machine without the updated read shows no card. The view follows new output near the bottom; scroll up to pause it. The Session title and Back to Sessions stay pinned above the history while it scrolls. From another page, Resume session returns to the active detail with its draft intact (in the rail on desktop, in the header on phones). A Session link carries session_id and device_id in the URL, so it opens on its owning machine rather than the currently selected device. Use the floating Jump to top or Jump to latest controls at the transcript's bottom edge to navigate and resume following; they take no row of their own. On desktop you can also select a prompt from the narrow right-side tick rail. Scroll up to load older messages without losing your place until the latest completed compaction card starts the visible history, and open an image thumbnail for a full-size view; large content loads when it is ready, and unavailable content offers a retry. Subagent updates appear as compact status notices with expandable details. Opening a managed subagent replaces the composer with a compact read-only context bar: the agent and status in words, named icon buttons for Main, Previous, Next, and Subagent details, and directly available answers to waiting questions. Subagent details opens the complete task description, labelled Model, Tokens, Cache, Cost, and Context values, and full parent title in a bottom sheet on phones or a dialog on larger screens. Closing it returns keyboard focus; switching Sessions dismisses it. BTW side chats keep a composer. A read-only todo panel directly above the composer shows completed/total progress and the active task while the selected Session has a task that is not completed, and hides once every task is completed; expand it to inspect the full status-marked list without covering the transcript. The model-adjacent ring shows used and remaining context when you hover or focus it; on phone, open the model row for the context bar and token totals. The composer also shows the latest generation speed in tok/s when measured; buffered bursts with less than one second of observed streaming, unavailable metrics, and measurements for a different selected model stay hidden. When the last task completes, the panel collapses without taking focus, and reduced motion removes it at once. The floating composer footer shows execution, waiting, YOLO, and goal status; open the goal chip for details or Stop goal. Send with scrollable autocomplete for / commands, @ files, agents, and references, and $ or # skills; suggestions sit above the field within the visible screen, keep a Close control, and stay closed after Close, Escape, or a tap outside, which leaves focus on whatever you tapped, until you change that text or move to another one; choose an agent and a searchable model with reasoning effort (pending choices apply with your next send), and use the lightning toggle to switch to the model's fast counterpart when the provider offers one; toggle Steer or Queue beside Send, or interrupt active work. Use `/goal <objective>` to set this Session's goal without sending a message, `/yolo` or `/yolo 0–3` to change autonomy, and `/skill-name` to load a slash-enabled skill. `$skill` and `#` skill choices travel with your prompt and load in the runtime before it executes; queued skills wait for their queued prompt. `#` agent choices insert an `@agent` mention. Other unmatched slash text is sent as a prompt; unsupported TUI-only slash actions keep your draft and show an error. Attach files by pasting from the clipboard, choosing them with the attach button, or dropping them on the composer; each file can be up to 20 MiB, shows its upload progress, and can be removed or cancelled before sending. Attachments and the todo panel need an up-to-date YCoding on the machine. The browser shows at most the first 4,000 characters of tool text; device truncation is labeled separately, and captured shell output can be loaded in pages."],
              ["New session", "Start a new Session from the wordmark landing at /remote; the global New session action is labeled and unscoped. A Session started from a project plus retains that repository and origin in the URL and disables repository selection; when that repository is unavailable on the selected machine, creation is blocked instead of falling back to another. Opening New session without a project origin lets you choose an available repository. A selected existing or newly created transcript opens in the Session detail."],
              ["Team", "Open Team with the icon and active count beside Notifications in the header, on desktop, tablet, or phone. Its activity count combines reported active subagents and live background shells; settled shells are not running, and unreported or truncated activity is labeled instead of shown as an exact zero or total. On phones, its sheet has one Team heading with the active count and one Close Team control; scroll through the cards to Load older after the list. Browse the selected root family’s subagents and reported usage; open a child, answer a waiting question, or confirm cancellation. Read verified family shell output in pages or confirm a kill. Browse BTW side chats or start one with the parent’s recent history, then send a prompt in its Conversation. An older machine asks for a YCoding update; an uncertain mutation is not resent automatically."],
              ["Requests", "Reply to permission or guardrail asks and answer or cancel pending Forms and questions. A pending family guardrail review can be answered from the current Session: inspect its owner, action and targets first. Missing inspectable context disables approval but leaves Reject available. Hard reviews require a human one-time approval or rejection; an uncertain reply is not resent automatically."],
              ["Office", "On tablets and desktops, switch Conversation to Office to see the selected Session and its reported subagent tasks in a shared pixel workspace. Each character keeps its own workstation among varied desks, plants and personal details, with shared lounge seating, a meeting area and a coffee corner. Office is available on viewports at least 768px wide that are at least 600px tall or have a fine primary pointer; elsewhere Conversation stays visible and the switch is hidden, whatever the stored preference. Office opens near the selected agent at a readable working scale. Drag or scroll to pan, use Shift-scroll to move sideways, or focus the floor and use arrow keys. Fit shows the whole floor, including its bottom edge. The stage uses the height left below headers and notices, and the Agents list scrolls independently. The toolbar zooms, fits, follows the selected character, or returns to Conversation, where your requests and composer are."],
              ["Usage", "View connected providers' reported quota windows, reset countdowns, and pace; refresh them from the machine. See spend for today, yesterday, and the last 30 days, plus a current-month provider donut with Spend and Tokens views; the UTC | Local switch, remembered in this browser, sets the time zone for days, months, and hours. The daily chart offers a table. The provider donut lists each provider with its share and exact value in one legend beside the chart, without a separate table, and Spend and Tokens each keep their own unit and unreported values. Model, Session, project, and agent breakdowns can be sorted and paged. Changing a breakdown page, group, or sort keeps the previous rows in place while the new report loads, and same-machine reconnects and quota refreshes keep the previous values visible until replacements arrive. Switching machines, disconnecting, or signing out clears the display; the summary metrics form one divided strip that stacks when the available content width is narrow. Hover, focus, or tap a daily bar or provider segment for its exact values. Costs are estimates from recorded usage and model pricing, not provider bills."],
              ["Settings", "Choose the active machine, and manage your account, enrolled devices, app installation, appearance, Office view, and notification preferences. Appearance holds the Light, Dark, or System theme and a Color scheme select: Default, One Dark, One Dark Pro, or High contrast. One Dark Pro paints dark mode only; with System and the Default scheme, a system request for more contrast paints High contrast. Both choices are stored in this browser. Remove a revoked device, or all revoked devices at once, after confirming. Notification categories have independent channel switches in a horizontally scrollable table on narrow screens. System alerts offers the permission request until the browser decides, then shows whether alerts are allowed or blocked while YCoding is open. Set a Session's autonomy level and goal from its Conversation status instead. The entire Office settings section appears only where the Office view is available."],
            ],
          },
          { kind: "paragraph", text: "While the selected Session is running, the newest prompt's Edited files card stays hidden; earlier prompts keep their cards beside their own replies, and the newest card appears once the Session is idle, interrupted, or failed. Intermediate tool and text steps do not create separate summaries: each prompt has one card at the end of its completed response, with only that prompt's changes." },
          { kind: "paragraph", text: "Use the named plus button on a workspace in the rail or Sessions list to start a New session without losing the draft in your current Session. The URL retains the opaque workspace ID, its origin (sessions or sidebar), and the device ID; the repository choice is disabled. If that originating repository is unavailable on the selected machine, creation is blocked rather than falling back to another repository. Starting from the global New session action without a project origin lets you choose a repository. In a selected connected Session, `/compact` starts compaction directly rather than sending a prompt or command. It accepts no arguments, attachments, or mentions. A newer draft and another Session's draft stay unchanged when compaction settles; a failed or uncertain request remains visible, and an uncertain mutation is never resent automatically." },
          { kind: "paragraph", text: "While you stay on the same composer, returning to a model restores the supported effort you chose for that model. Model settings means no explicit effort override: it is neither an offered variant nor an inferred provider default. The separate Clear reasoning effort override action removes the override and clears that model's remembered effort; the slider contains only offered variants. The model name, effort hero, slider, and next send agree. If the saved effort is not offered by the machine's current model list, the composer keeps your draft and asks you to clear the override or choose an offered effort before sending; reading it does not change the Session. A confirmed choice stops overriding later model changes from another client, while an unconfirmed different choice remains pending. A refused model switch keeps the submitted input in its failed receipt and admits no prompt. Fast mode keeps the effort only if its counterpart offers it, otherwise omits it; models without effort omit it. Measured diagnostics keep their actual model reference, and unavailable values stay unreported." },
          { kind: "paragraph", text: "Settings → Machine → Keep machine awake controls the selected machine, not this browser. On macOS it prevents idle sleep only, not manual sleep or closing the lid. It starts Off, is not remembered or re-enabled automatically, and ends when YCoding on the machine stops or restarts. Linux and Windows show Unsupported. The switch stays disabled until an online machine answers its initial read; an older or unanswered machine asks for a YCoding update. Errors remain visible with a retry where available. An uncertain change is checked with a fresh read without claiming that the request succeeded or sending it again." },
          { kind: "paragraph", text: "On tablets and desktops, Hide workspace sidebar collapses the global rail to a narrow strip that keeps three icon links for Sessions, Usage and Settings; select Show workspace sidebar to reopen it. On tablets, the header menu button also hides or shows it. Neither changes the selected Session. New session at /remote is the landing; Session detail at /remote/session?session_id=<id>&device_id=<id> displays the selected transcript on its owning machine." },
          { kind: "paragraph", text: "The header's connection label states the connection. A banner under the header appears only while the connection needs attention (connecting, offline, signed out, or an error) and offers Reconnect or Open settings where they help." },
          { kind: "paragraph", text: "When you run YCoding as an installed app, from your Home Screen or as an app installed from the browser, pinch zoom is turned off so the workspace stays steady. Open it in a browser tab when you need to zoom." },
          {
            kind: "steps",
            items: [
              { title: "Check the mode", text: "Open the remote workspace's Settings → App. Mode says Browser or Installed app. An installed app has no Install App button." },
              { title: "Install from Chrome or Edge", text: "When the browser offers installation, select Install App in Settings → App and accept the browser's install dialog. If the button is absent, check the browser's install menu and that you opened the secure site; browsers decide when to offer the prompt." },
              { title: "Install from iPhone or iPad Safari", text: "Select Install App for instructions, then use Safari's Share button → Add to Home Screen → Add. YCoding cannot open Apple's Add to Home Screen flow for you." },
              { title: "Install from Safari on Mac", text: "On macOS Sonoma 14 or later, select Install App for instructions, then in Safari choose File → Add to Dock and click Add. If Add to Dock is unavailable, check your macOS version." },
            ],
          },
          { kind: "paragraph", text: "The Sessions table and conversation sidebar both load the selected workspace's top-level Sessions as you scroll. They keep a small window of pages instead of rendering the entire machine's inventory; scroll back to retrieve earlier rows. Running and waiting marks update live, and rows re-sort as Sessions start and stop. Changing the workspace or filter does not change the conversation you already opened. A loading state is not an empty Session list." },
          { kind: "paragraph", text: "Your prompts appear in right-aligned bubbles that contain only your text; the delivery state sits below each bubble, and Read appears only after YCoding consumes the prompt, not just when the browser sends it. YCoding replies appear on the left. Thinking and tool rows stay collapsed until you open them, and empty reasoning is hidden. Completed compaction hides covered older messages from the browser view without deleting Session history." },
          { kind: "paragraph", text: "Submitting releases the composer for your next draft while delivery continues. A static receipt beneath the bubble says Sending before admission, Processing for an admitted steer, Queued for an admitted queued prompt, and Read when YCoding consumes it. These admitted inputs are recovered from the connected machine after reload or reconnect, and a lost live event is reconciled with Session history without a manual refresh. A failed or uncertain send stays on its message with Retry send; retry keeps the same identity and submitted attachments without erasing a newer draft. Only failed and uncertain mutation outcomes raise toasts below the header, dismissing after about six seconds unless hovered or focused; successful sends keep their receipt without a popup. The composer status names an active goal and shows Setting goal while one is being set. Only one goal is set at a time, and a failed or uncertain goal on the current connection returns to an empty draft as `/goal <text>`. Only the request's own response reports a goal as set: after an uncertain outcome the status shows the Session's current goal, but the request stays unconfirmed because the goal may have been set by another writer." },
          { kind: "paragraph", text: "The latest compaction appears as one stable transcript divider, and a newer compaction replaces it; once a compaction completes, its card is the start of the visible history. A completed divider shows excluded messages, input and retained tokens, reduction, its compression number, and total tokens saved across the Session. With an older YCoding connector, the divider keeps its own figures but omits the number and total. Reduced motion removes the completion fade." },
          { kind: "paragraph", text: "Each visible character follows its own Session activity at its own workstation: reading and searching use its reference spot; tests, typecheck, lint and commands use its test spot; subagent and todo coordination uses its planning board; editing and writing use its desk. Desk arrangements and accessories stay stable as work changes. An idle root may rest at its desk or in shared seating while its subagents work. The office includes shared meeting, lounge and pantry areas with open walkways." },
          { kind: "paragraph", text: "Office shows only the selected Session family: its root and the direct child tasks the machine reports. Up to sixteen agents have separate workstation claims; additional children are counted outside the scene rather than sharing a desk. Every work activity retargets immediately within the character's own claim, including during a walk. Each character keeps a stable name; compact floor labels show that name, while the Agents list also shows the agent, location and current action. The browser reads one bounded family activity page about every three seconds while Office is visible. Working members show their short current action; idle and finished members have no state-word bubble. A machine without that read asks for a YCoding update rather than inventing work. New children enter through the perimeter entrance, and departing children leave; live corroborated delegation and reports appear as in-place bubbles. Selection within the same family preserves the scene, positions and walks. Reconnect and history never replay cues, and reduced motion uses static spots. Panning pauses camera following; Follow selected or an Agents row centers the chosen character again. Fit gives a complete overview and keeps it fitted through resize. Settings → Office controls presentation and appearance. If Office cannot start, return to Conversation without losing your draft or connection." },
          { kind: "paragraph", text: "New session at /remote opens a composer in the main area. Choose a repository by name, an agent (or the machine's default agent), and a model and variant; the browser preselects the model you last chose on it, otherwise the machine's default model. A project-origin New session retains its workspace ID and origin in the URL and locks repository choice; an unavailable originating repository blocks creation. Your first prompt or command is sent right after the Session is created, then the created Session opens at /remote/session?session_id=<id>&device_id=<id>. An unknown creation result can be checked or retried explicitly with the same Session identity; check Sessions before dismissing it. The browser cannot choose an arbitrary filesystem path or create a repository." },
          { kind: "paragraph", text: "Unsent drafts stay with each Session while you navigate remote pages or reconnect to the same machine. Switching machines, disconnecting explicitly, signing out, leaving the remote workspace, or reloading the page clears drafts." },
          { kind: "paragraph", text: "Agent execution, shell commands, files, tools, and model calls run on the selected machine. The relay carries a closed set of authenticated operations; it does not provide an arbitrary shell or filesystem browser." },
          {
            kind: "table",
            head: ["Autonomy control", "Behavior"],
            rows: [
              ["Standard", "Questions and approvals wait for you."],
              ["YOLO 1", "Automatically answer questions and Forms."],
              ["YOLO 2", "Also approve tool permissions."],
              ["YOLO 3", "Also approve ordinary guardrail reviews; hard reviews still require a human."],
              ["Goal", "Set a durable objective or stop the active goal for the selected Session. Goal stays available to set a new objective but appears neutral and announces Goal off when no goal is active, including after completion, stopping, or exhaustion; only an active goal uses the green status treatment and announces Goal active, and a goal being set shows the same treatment with a dot trail and announces Setting goal."],
            ],
          },
        ],
      },
      {
        heading: "Approvals, questions, and prompts",
        blocks: [
          {
            kind: "steps",
            items: [
              { title: "Open the request", text: "Pending requests appear in the selected conversation. A request belongs to a specific Session." },
              { title: "Review an approval", text: "Read the permission or guardrail scope. Ordinary guardrail reviews can offer once or session-family Always. Hard reviews offer only one-time approval or rejection." },
              { title: "Answer a Form", text: "Complete its displayed typed fields and submit, or cancel. Supported fields include text, number, integer, boolean, multiselect, and external-step acknowledgement." },
              { title: "Choose delivery", text: "Steer delivers at the next safe step boundary; queue waits until the Session would become idle. Interrupt is a separate action." },
            ],
          },
          { kind: "callout", tone: "info", title: "No automatic replay after disconnect", text: "If a connection drops while a mutation is in flight, its outcome can be unknown. The workspace does not resend it automatically; check Session state before deliberately retrying." },
        ],
      },
      {
        heading: "Notifications and availability",
        blocks: [
          {
            kind: "table",
            head: ["Notification category", "Event"],
            rows: [
              ["Work finished", "Get notified after the agent declares its requested work finished and verified, its final reply settles, and no input, subagent, shell or goal work remains pending. An ordinary reply or idle status alone does not trigger an alert. Reconnecting does not repeat an accepted completion."],
              ["Needs your attention", "Get notified when a Session needs your decision, a guardrail blocks an action, or a run fails. Each Session keeps one unread stored attention notice. While it stays unread, the Session alerts again on that notice only when it needs something different or at least 10 minutes after its last alert. A later run clears failure attention."],
              ["Machine offline", "Get notified when a paired machine stays disconnected from the relay for 40 seconds, so a routine reconnect raises no alert. An open workspace alerts for its selected machine, and Push to this device alerts a closed browser or app; each browser shows one System alert per outage. A browser-only relay disconnect does not establish that the machine is offline."],
            ],
          },
          {
            kind: "list",
            items: [
              "The bell opens a notification center grouped by day. Opening it does not read a notice: dismiss a row, open its Session, open its System alert, or use Read all to remove it from every browser on that machine. The relay stores unread work and attention notices until read; Load more fetches older pages, with 200 rows resident at once and the total remaining count visible. A relay storage error appears on the bell and in the center while stored notices remain readable. Session notices show the matching Session title once the machine supplies it, and a resolved title updates the center and any visible toast in place; a failed title read keeps the fixed description. While the center stays open, ages and notice changes update in place, and reconnect reads do not replay alerts. The center animates open and closed; its closing layer cannot receive focus or input, closing returns focus to the bell immediately, and reduced motion removes the exit delay.",
              "A guardrail block raised in this workspace can create a temporary toast; ordinary completion, machine status, and relay-synced attention notices stay in the notification center without a popup. Failed or uncertain sends also raise a toast; sending and successful delivery use the static receipt beneath the message. At most three toasts share the area below the header and dismiss after about six seconds; hovering or focusing pauses dismissal. Open goes to that Session, and dismissing a notice toast leaves its center notice intact. Loading history or reconnecting does not replay toasts.",
              "Settings provides independent In app and System switches for each of the three categories. Each System switch also decides whether Push to this device sends that category while the browser or installed app is closed; this device's choices are saved with its push registration, and a failed update says so instead of claiming it was saved.",
              "Preferences stay in this browser. Only the three listed category keys are read; unknown keys are ignored, and missing categories use enabled defaults.",
              "System alerts name the Session and what it needs: YCoding — approval needed / “Session title” is waiting for you to allow or deny a tool request; YCoding — question for you / … is waiting for your answer; YCoding — guardrail review / … is waiting for you to approve or reject a guarded action; YCoding — session failed / … stopped with an error. Open it to review and retry; YCoding — work finished / … finished all its work. Alerts say A session when the machine has not reported the title, and never include paths, commands, tool input, or error text.",
              "The browser requests System-alert permission only when you press a permission button: Turn on System alerts in the notification center or the button in Settings. The notification center shows that button, or Re-enable, whenever System alerts cannot reach this device. System alerts show the Session title, including on a lock screen.",
              "Stored work and attention notices sync across browsers signed in to the same machine and survive reloads and reconnects; loading them does not replay earlier alerts. Turn on Settings → Push to this device to also get the System alerts you chose while the browser or installed app is closed; each new notice raises one System alert per browser, from push when the push service accepted it and otherwise from one open tab; more than 20 alerts in a minute arrive as one summary alert that opens YCoding; a guardrail block raises its own alert, “Session title” included; if the browser drops its push registration, an Alerts paused alert asks you to open YCoding. Activating a Session alert opens /remote/session?session_id=<id>&device_id=<id>, with optional &notice_id=<id>; it preserves the device even without a notice. The workspace resolves that active, online device in your account before opening the Session; an unknown, revoked, or offline device is reported unavailable, with no fallback to another machine. Signing in preserves the route and query. Opening a notice alert also marks that notice read. Availability depends on the browser and platform. Opening the workspace renews this device's push registration automatically; if the device has no active push subscription, Settings shows push as off with a Re-enable action, and push can be unavailable when the service is not configured. The installed app opens directly to the remote workspace.",
              "The connection strip shows this browser's own connection to the relay. After that connection drops, the strip keeps its latest close code and reason for the selected machine through reconnects; choosing another machine or disconnecting clears them.",
              "If the device is offline, restore its connection and use Reconnect. If no Session is selected, select one before sending a prompt or answering a request.",
            ],
          },
          { kind: "related", slugs: ["usage/sessions", "configuration/notifications", "configuration/yolo"] },
        ],
      },
    ],
  },
  {
    slug: "usage/sessions",
    title: "Sessions",
    group: "Use",
    description: "Understand durable prompts, Session history, archive, compaction, revert, and managed attachments.",
    sections: [
      {
        heading: "A Session is durable work",
        blocks: [
          { kind: "paragraph", text: "A Session keeps its transcript and execution state beyond an individual prompt. YCoding admits a prompt durably before scheduling execution. Pending input remains distinct until a safe boundary promotes it into the visible transcript." },
          {
            kind: "table",
            head: ["Delivery", "Promotion"],
            rows: [
              ["Steer (default)", "At the next safe step boundary while the active execution continues."],
              ["Queue", "When the Session would otherwise become idle; queued inputs promote one at a time."],
              ["Retry with the same prompt ID", "Returns the already-admitted record for that Session and input kind; first admission wins."],
            ],
          },
          {
            kind: "list",
            items: [
              "Reusing a Session ID resumes that Session instead of creating a separate history.",
              "A prompt message ID belongs to one Session and one input kind. Reuse across Sessions or input kinds is rejected.",
              "Each logical step is one model request. A settled response with no assistant text and no tool continuation can receive one bounded text-only recovery step.",
            ],
          },
        ],
      },
      {
        heading: "Archive and resume",
        blocks: [
          {
            kind: "steps",
            items: [
              { title: "Open the Session list", text: "Press ctrl+x, then l, or enter /sessions in the TUI." },
              { title: "Archive or unarchive", text: "Select the Session and use its archive action; ctrl+a is the default binding. Success: the Session remains listed with or without the Archived label." },
              { title: "Resume", text: "Select an archived or active Session. Its transcript opens, with the Archived label if applicable. If it is absent, check the current Session list and Location." },
            ],
          },
          { kind: "callout", tone: "info", title: "Archive is not delete", text: "Archived Sessions remain available. Archive and unarchive do not delete history or change the last-activity time." },
        ],
      },
      {
        heading: "Compaction preserves the transcript",
        blocks: [
          { kind: "paragraph", text: "Compaction creates a checkpoint for later model requests so covered history does not need to be replayed in full. The stored transcript remains available; selective compaction does not rewrite or delete covered messages. Advisory or manual compaction protects the newest messages according to compaction.keep_recent_messages." },
          {
            kind: "steps",
            items: [
              { title: "Start compaction", text: "Choose Compact session in the command palette or enter /compact (also /summarize)." },
              { title: "Continue the Session", text: "After activation, YCoding assembles model context from the checkpoint and later history. Earlier transcript messages remain navigable." },
              { title: "Tune the retained tail", text: "The compaction.keep_recent_messages setting controls recent messages protected by advisory or manual compaction. See the Configuration reference for related context settings." },
            ],
          },
          { kind: "code", language: "jsonc", label: "Compaction settings", code: '{\n  "compaction": {\n    "keep_recent_messages": 20,\n    "context_safety_margin_tokens": 4096,\n    "advisory": {\n      "consider_percent": 70,\n      "strongly_advised_percent": 90,\n    },\n  },\n}' },
        ],
      },
      {
        heading: "Fork and revert from history",
        blocks: [
          { kind: "paragraph", text: "Message actions can fork a Session from a chosen point or stage a revert boundary. A staged revert changes the active transcript boundary; committing can also apply associated file changes. /undo stages a boundary at the preceding non-empty user message; /redo clears the staged revert." },
          {
            kind: "steps",
            items: [
              { title: "Choose a point", text: "Use /timeline or open a specific transcript message's actions." },
              { title: "Fork or stage revert", text: "Fork creates a separate Session from that point. Revert stages a boundary and reports associated file changes." },
              { title: "Review the result", text: "Inspect staged changes, then commit the revert or clear it to restore the prior boundary." },
            ],
          },
        ],
      },
      {
        heading: "Attachments and terminals",
        blocks: [
          {
            kind: "table",
            head: ["Input", "Handling"],
            rows: [
              ["PNG, JPEG, GIF, WebP", "Imported as managed image attachments and read again for the provider when used."],
              ["PDF, XLS, XLSX, SVG, and other supported non-image files", "Managed attachment metadata and resolved path are available to the model; the file bytes are not embedded as an image."],
              ["Local image or supported file path", "Paste a path in the composer to attach a supported local file rather than send the path as plain text."],
              ["Session terminal", "Open from the Session command palette. Inspection is read-only until you explicitly take control."],
            ],
          },
          { kind: "callout", tone: "warning", title: "Attachment size limit", text: "The runtime enforces a 20 MiB limit. If preparation fails, the prompt draft stays available so you can remove the attachment or try again." },
          { kind: "related", slugs: ["usage/tui", "usage/remote", "configuration/tools"] },
        ],
      },
    ],
  },
]
