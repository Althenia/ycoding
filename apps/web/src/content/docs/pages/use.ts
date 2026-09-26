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
              ["One direct prompt", "ycoding --model <provider/model> \"<prompt>\"", "A non-interactive request with an explicit model."],
              ["Scripted run", "ycoding run <message> [options]", "Session selection, attachments, JSON output, or explicit autonomy."],
              ["Remote workspace", "Open /remote in a browser", "Continue work on a connected machine."],
            ],
          },
          {
            kind: "steps",
            items: [
              { title: "Open the project", text: "Start YCoding in the project directory. The interactive interface uses that working directory for local tools and configuration." },
              { title: "Choose the model and agent", text: "Use the TUI pickers, or specify --model and --agent for a scripted run. A model reference uses provider/model; ycoding run also accepts a #variant suffix." },
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
              ["Sidebar", "Inspect Session context, status, subagents, and runtime state."],
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
              ["ycoding --model <provider/model> \"<prompt>\"", "Run a prompt directly instead of opening the TUI. Requires a model and positional prompt."],
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
              ["--model", "<provider/model>", "Unset", "Run the positional prompt with this model."],
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
              ["--model", "<provider/model#variant>; alias -m", "Unset", "Select a model and optional variant; resolved Session or agent default applies when omitted."],
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
              ["ycoding update", "Optional --version <version>", "Install the latest release or a specific published version."],
              ["ycoding service status", "None", "Show background service status."],
              ["ycoding service restart", "None", "Restart the background service."],
              ["ycoding remote enroll <enrollmentID>", "Optional --name <name>, --relay <origin>, --replace", "Enroll this machine; the one-use code is read at a prompt, never from argv."],
              ["ycoding remote connect", "Optional --relay <origin>, --server <url>, or --standalone", "Run the foreground remote connector for backend Sessions."],
              ["ycoding remote status", "Optional --server <url> or --standalone", "Show device enrollment and backend Session access."],
              ["ycoding remote sessions", "Optional --server <url> or --standalone", "List Sessions available to the enrolled machine owner."],
            ],
          },
          { kind: "code", language: "sh", label: "Update to the latest published release", code: "ycoding update" },
          { kind: "callout", tone: "warning", title: "Updating installs a release", text: "The updater replaces an installed release after validating its published archive. Local development builds cannot self-update; rebuild them from the repository." },
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
        heading: "Sign in and connect",
        blocks: [
          { kind: "paragraph", text: "The remote workspace is a browser client for Sessions on a machine running YCoding. Open /remote; when signed out, the workspace shows a dedicated sign-in screen with OAuth provider buttons (Google is available today). After sign-in, select an online machine and one of its Sessions. Account and connection states remain distinct, so an offline device does not appear signed out." },
          {
            kind: "steps",
            items: [
              { title: "Sign in", text: "Choose Continue with Google. The account must be eligible for the deployed workspace. Success: the workspace loads the account and device state. If sign-in fails, retry and confirm the account is allowed." },
              { title: "Create an enrollment", text: "Open Settings, then Devices, and choose Create enrollment code. The page shows an enrollment ID, a copyable command, and a one-use code with an expiration. If hidden or expired, create a new enrollment." },
              { title: "Enroll the machine", text: "Run the displayed command on the machine that runs YCoding. Enter the code at its hidden prompt; the code is not a command argument. Success: enrollment completes without placing the code in shell history." },
              { title: "Start the connector", text: "Run ycoding remote connect on that machine and leave it running. Success: the device appears online and its Sessions are selectable. If it does not, run ycoding remote status and confirm the connector and relay origin." },
              { title: "Open a Session", text: "Choose the online machine, using Confirm Selection in the phone picker, then select an existing Session or choose New session and a previously opened repository. Closing the phone picker without confirming keeps the current machine. Success: Conversation opens without sending a prompt; type a message to begin or continue work." },
            ],
          },
          { kind: "code", language: "sh", label: "Enroll and connect", code: "ycoding remote enroll <enrollmentID> --relay <origin>\n# Enter the one-use code when prompted.\nycoding remote connect" },
          { kind: "callout", tone: "warning", title: "A connected device grants broad Session access", text: "The enrolled account can reach all existing and future Sessions in that local backend while the device is connected. Keep the connector on a machine and account you trust." },
          {
            kind: "table",
            head: ["State", "Visible result", "What to check"],
            rows: [
              ["Signed out", "Dedicated sign-in screen with Continue with Google.", "Complete sign-in; if rejected, confirm the account is eligible for this workspace."],
              ["Signed in, no machine", "Workspace offers device enrollment in Settings.", "Create a one-use enrollment and run the displayed CLI command."],
              ["Machine offline", "Device is not selectable; reconnect is offered for a selected device.", "Restore network and restart ycoding remote connect on the machine."],
              ["Machine online, no Sessions", "Connected machine reports an empty Session list and offers New session.", "Choose a previously opened repository. If none is listed, open it locally, then refresh repositories."],
            ],
          },
        ],
      },
      {
        heading: "What the browser can do",
        blocks: [
          {
            kind: "table",
            head: ["Area", "Actions"],
            rows: [
              ["Sessions", "Create a Session in a previously opened repository, or browse, search, filter, and reopen existing Sessions on the connected machine."],
              ["Conversation", "Read the transcript, send a prompt with a delivery mode, and interrupt active work. The browser shows at most the first 4,000 characters of tool text; device truncation is labeled separately, and captured shell output can be loaded in pages."],
              ["Requests", "Reply to permission or guardrail asks and answer or cancel pending Forms and questions."],
              ["Activity", "Review reported tool calls, terminal commands, file changes, and pending decisions."],
              ["Settings", "Manage account, enrolled devices, appearance, autonomy and goals, and notification preferences."],
            ],
          },
          { kind: "paragraph", text: "On tablets, the Conversation header can hide or show the session sidebar without changing the selected Session. Sessions, Conversation, Activity, and Settings remain available in the navigation." },
          { kind: "paragraph", text: "New session uses the machine's local agent and model defaults and does not send a prompt until you do. An unknown creation result can be checked or retried explicitly with the same Session identity; check Sessions before dismissing it. The browser cannot choose an arbitrary filesystem path or create a repository." },
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
              ["Goal", "Set a durable objective or stop the active goal for the selected Session."],
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
              { title: "Open the request", text: "Pending requests appear in the selected conversation and Activity. A request belongs to a specific Session." },
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
              ["Agent completed", "A Session reports successful completion."],
              ["Approval requested", "A permission request or Form needs input."],
              ["Guardrail block", "A guardrail review or denial needs attention."],
              ["Error or failure", "Execution reports an error or failed step."],
              ["Device disconnected", "The connector for a device goes offline."],
            ],
          },
          {
            kind: "list",
            items: [
              "Settings provides independent workspace and desktop switches for each category.",
              "The browser requests desktop-notification permission only when you press its permission button. Desktop alerts use generic text rather than Session details.",
              "Notices cover live events while the page is open. There is no background push; reconnecting does not replay alerts for earlier work.",
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
