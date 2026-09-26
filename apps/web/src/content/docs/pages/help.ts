import type { DocPage } from "../types"

export const helpPages: readonly DocPage[] = [
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    group: "Help",
    description: "Diagnose installation, configuration, provider, Session, database, and remote-workspace problems with concrete checks.",
    sections: [
      {
        heading: "The `ycoding` command is not found",
        blocks: [
          {
            kind: "list",
            items: [
              "**Symptom:** macOS or Linux reports `ycoding: command not found` after installation. **Cause:** The installer added `~/.local/bin` to a shell profile, but the current terminal has not loaded it. **Fix:** Open a new terminal. If it still fails, add `$HOME/.local/bin` to PATH and run `ycoding --version` again.",
              "**Symptom:** The install script reports an unsupported platform. **Cause:** The shell installer supports macOS arm64/x64 and Linux x64 only. **Fix:** Download the matching release archive from GitHub Releases. Windows users need the Windows x64 ZIP; Linux arm64 is not a published shell-installer target.",
              "**Symptom:** PowerShell cannot find `ycoding.exe`. **Cause:** The release ZIP has not been extracted, or the shell is in another directory. **Fix:** Change to the extracted folder, then run `.\\ycoding.exe --version`; alternatively use the full path to the extracted executable.",
            ],
          },
          { kind: "code", language: "sh", label: "Check whether YCoding is on PATH", code: "ycoding --version" },
          { kind: "related", slugs: ["installation"] },
        ],
      },
      {
        heading: "A configuration change has no effect",
        blocks: [
          {
            kind: "steps",
            items: [
              { title: "Check the file type", text: "Runtime settings belong in `ycoding.json` or `ycoding.jsonc`; terminal preferences belong in `cli.json`. Project runtime files may also live under `.ycoding/`." },
              { title: "Check the complete document", text: "If a document contains a rejected key, YCoding ignores that document as a whole. Remove the rejected key before expecting its other settings to apply." },
              { title: "Check which source wins", text: "A more-specific project source overrides a global source for scalar fields. `YCODING_CONFIG_CONTENT` has the highest precedence." },
              { title: "Check discovery overrides", text: "If `YCODING_CONFIG` or `YCODING_CONFIG_DIR` is set, confirm it points at the file or directory you edited." },
            ],
          },
          {
            kind: "paragraph",
            text: "To print configuration-discovery logs for one run, set both documented logging variables in the shell that starts YCoding:",
          },
          { kind: "code", language: "sh", label: "macOS or Linux", code: "YCODING_LOG_LEVEL=all YCODING_PRINT_LOGS=1 ycoding" },
          { kind: "code", language: "powershell", label: "Windows PowerShell", code: "$env:YCODING_LOG_LEVEL = 'all'\n$env:YCODING_PRINT_LOGS = '1'\n.\\ycoding.exe" },
          {
            kind: "paragraph",
            text: "Expected result: log output reports accepted or rejected configuration documents. Fix the named source, remove rejected keys, then start YCoding again. Close the process or clear the two shell variables after diagnosing if you do not want logs on later runs.",
          },
          { kind: "related", slugs: ["configuration"] },
        ],
      },
      {
        heading: "The provider or model request fails",
        blocks: [
          {
            kind: "list",
            items: [
              "**Symptom:** The model selector has no usable provider or model. **Cause:** No provider credential profile is connected, the profile is inactive, or the model is not in the effective catalog. **Fix:** Open the TUI and run `/connect`; finish the provider flow, then select a model listed for that connected profile.",
              "**Symptom:** A configured provider cannot authenticate. **Cause:** The credential is absent, expired, or not attached to the active profile. **Fix:** Reconnect that provider with `/connect`, select the intended profile, and retry the prompt. Do not paste API keys into a public issue or log.",
              "**Symptom:** A request stops after a long wait or a rate-limit response. **Cause:** The provider may be rate limiting or the network transport may have failed. **Fix:** Check the provider's service and account limits, confirm network access, then retry from the TUI. YCoding retries eligible failures before it has received output; it does not replay a request after output has started.",
              "**Symptom:** The error says the prompt exceeds context. **Cause:** The model's input limit is smaller than the selected conversation and prompt. **Fix:** Choose a model with a larger context limit or start a new Session with only the relevant context, then resend the task.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "Direct runs do not wait for interactive approval",
            text: "A direct `ycoding --model ...` or `ycoding run ...` cannot pause for you to answer a permission, question, or guardrail review. Run the task with `ycoding` when it needs an interactive decision, or change only the relevant permissions after reviewing their scope.",
          },
          { kind: "related", slugs: ["quickstart", "configuration/providers", "configuration/permissions", "configuration/guardrails"] },
        ],
      },
      {
        heading: "The Session appears to be waiting",
        blocks: [
          {
            kind: "list",
            items: [
              "**Symptom:** A permission request is visible in the transcript. **Cause:** The next tool action needs a permission decision. **Fix:** Read the requested action and resource, then choose an available permission response or reject it in the TUI.",
              "**Symptom:** A guardrail review is visible. **Cause:** A high-impact action needs a Session-family review, independently of tool permissions. **Fix:** Inspect the action and choose the available review response. Hard reviews require a fresh human decision.",
              "**Symptom:** The command is still running and output is incomplete. **Cause:** Foreground shell commands that continue beyond 300 seconds move to the background and report their eventual result. **Fix:** Use the terminal's shell status and output controls to inspect it; do not start a duplicate command unless the first has settled or been cancelled.",
              "**Symptom:** A direct run exits unsuccessfully while an approval is pending. **Cause:** Non-interactive runs cannot accept human input and reject or cancel unresolved blockers. **Fix:** Repeat the task with `ycoding` in an interactive terminal and answer the request there.",
            ],
          },
          { kind: "related", slugs: ["usage/tui", "usage/sessions", "configuration/permissions", "configuration/guardrails"] },
        ],
      },
      {
        heading: "Startup or database errors",
        blocks: [
          {
            kind: "list",
            items: [
              "**Symptom:** Startup reports that it cannot obtain the database lock. **Cause:** Another YCoding process is writing the same database, or the write lock is unavailable during startup. **Fix:** Close other YCoding processes that use the database, then run `ycoding` again. Startup retries the conversion on the next run; it does not silently skip it.",
              "**Symptom:** The first start after an upgrade takes longer or needs more disk space. **Cause:** SQLite may convert auto-vacuum mode using a one-time database rebuild that needs temporary free disk space. **Fix:** Keep a backup, close other database writers, free disk space up to twice the database size, and retry `ycoding`. Do not delete the database to resolve the delay.",
              "**Symptom:** The managed service cannot bind its configured port. **Cause:** Another process is using that port. **Fix:** Choose another port in the channel service configuration, or run `ycoding --standalone` for a private server.",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Do not remove session data as a port-conflict fix",
            text: "Changing the service port or using `--standalone` addresses the conflict without deleting Session history.",
          },
          { kind: "related", slugs: ["installation", "configuration"] },
        ],
      },
      {
        heading: "The remote workspace has no sessions",
        blocks: [
          {
            kind: "list",
            items: [
              "**Symptom:** No device is available to select. **Cause:** The account is not signed in, the device is not enrolled, or its connector is not connected. **Fix:** Sign in, enroll the machine using the workspace's enrollment flow, then run `ycoding remote connect` on that machine.",
              "**Symptom:** The selected online device has an empty session list. **Cause:** There are no Sessions on that machine's local backend yet. **Fix:** Open a terminal in the project folder on that machine and run `ycoding` to create a Session, then refresh or reselect the device in the workspace.",
              "**Symptom:** The machine went offline and its Sessions cannot be opened. **Cause:** The local connector is disconnected. The last session list stays visible as read-only until reconnect. **Fix:** On the machine, restore its network connection and restart `ycoding remote connect` if it exited; then reselect the device after it reports online.",
            ],
          },
          {
            kind: "paragraph",
            text: "An offline machine does not mean its sessions were deleted: its last session list stays visible read-only until it reconnects. The remote workspace controls the connected machine's Sessions; execution remains on that machine.",
          },
          { kind: "related", slugs: ["usage/remote", "configuration"] },
        ],
      },
    ],
  },
]
