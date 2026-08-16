import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { Keymap } from "../context/keymap"
import { pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { IntegrationInfo, IntegrationOAuthMethod, McpServer } from "@ycoding-ai/client"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useConfig } from "../config"
import { getScrollAcceleration } from "../util/scroll"
import { beginOAuth } from "./dialog-integration"
import { mcpStatusPresentation, type McpTone } from "../mcp-presentation"

function statusError(status: McpServer["status"]) {
  if (status.status === "failed" || status.status === "needs_client_registration") return status.error
  return undefined
}

function Status(props: { status: McpServer["status"]["status"]; loading: boolean }) {
  const { themeV2 } = useTheme().contextual("elevated")
  if (props.loading) return <span style={{ fg: themeV2.text.subdued }}>⋯ Loading</span>
  const presentation = () => mcpStatusPresentation(props.status)
  const color = (tone: McpTone) => {
    if (tone === "success") return themeV2.text.feedback.success.default
    if (tone === "warning") return themeV2.text.feedback.warning.default
    if (tone === "error") return themeV2.text.feedback.error.default
    return themeV2.text.subdued
  }
  return (
    <span
      style={{
        fg: color(presentation().tone),
        attributes: presentation().tone === "subdued" ? undefined : TextAttributes.BOLD,
      }}
    >
      {presentation().symbol} {presentation().label}
    </span>
  )
}

export function mcpDialogAction(status: McpServer["status"]["status"]) {
  if (status === "pending") return "none" as const
  if (status === "connected") return "disconnect" as const
  if (status === "needs_auth") return "authorize" as const
  return "connect" as const
}

export function mcpOAuthTarget(server: McpServer, integrations: readonly IntegrationInfo[]) {
  if (!server.integrationID) return undefined
  const integration = integrations.find((entry) => entry.id === server.integrationID)
  if (!integration) return undefined
  const method = integration.methods.find((entry): entry is IntegrationOAuthMethod => entry.type === "oauth")
  return method ? { integration, method } : undefined
}

export function DialogMcp() {
  const data = useData()
  const dialog = useDialog()
  const client = useClient()
  const toast = useToast()
  const { themeV2 } = useTheme().contextual("elevated")
  const [focused, setFocused] = createSignal<string>()
  const [detail, setDetail] = createSignal<McpServer>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const servers = createMemo(() =>
    pipe(
      data.location.mcp.server.list() ?? [],
      sortBy((server) => server.name),
    ),
  )

  createEffect(() => {
    if (focused()) return
    const first = servers()[0]
    if (first) setFocused(first.name)
  })

  const options = createMemo(() => {
    const loadingMcp = loading()
    return servers().map((server) => ({
      value: server.name,
      title: server.name,
      description: server.status.status,
      footer: <Status status={server.status.status} loading={loadingMcp === server.name} />,
    }))
  })

  const focusedServer = createMemo(() => servers().find((entry) => entry.name === focused()))
  const focusedError = createMemo(() => {
    const server = focusedServer()
    return server ? statusError(server.status) : undefined
  })

  const open = (name: string | undefined) => {
    const server = servers().find((entry) => entry.name === name)
    if (!server) return
    if (server.status.status === "needs_auth") {
      authorize(server)
      return
    }
    if (!statusError(server.status)) return
    setDetail(server)
  }

  function authorize(server: McpServer) {
    const target = mcpOAuthTarget(server, data.location.integration.list() ?? [])
    if (!target) {
      toast.show({
        variant: "error",
        message: `MCP server ${server.name} requires OAuth, but its authorization method is unavailable`,
      })
      return
    }
    void beginOAuth(target.integration, target.method, dialog, () => {
      data.location.mcp.server.invalidate()
      void data.location.mcp.server.sync().finally(() => dialog.clear())
    }).catch(toast.error)
  }

  // Authentication-gated servers must enter their registered OAuth flow; retrying the
  // unauthenticated MCP transport would only return needs_auth again.
  const toggle = (name: string) => {
    if (loading() !== null) return
    const server = servers().find((entry) => entry.name === name)
    if (!server) return
    const action = mcpDialogAction(server.status.status)
    if (action === "none") return
    if (action === "authorize") {
      authorize(server)
      return
    }
    setLoading(name)
    const current = data.location.default()
    const input = { server: name, location: { directory: current.directory, workspace: current.workspaceID } }
    const call = action === "disconnect" ? client.api.mcp.disconnect(input) : client.api.mcp.connect(input)
    void call.catch(toast.error).finally(() => setLoading(null))
  }

  return (
    <box>
      <Show
        when={detail()}
        fallback={
          <DialogSelect
            title="MCP servers"
            options={options()}
            current={focused()}
            preserveSelection
            onMove={(option) => setFocused(option.value as string)}
            onSelect={(option) => open(option.value as string)}
            actions={[
              {
                title: "toggle",
                command: "dialog.mcp.toggle",
                onTrigger: (option) => {
                  setFocused(option.value as string)
                  toggle(option.value as string)
                },
              },
            ]}
            footer={
              <Show
                when={focusedServer()?.status.status === "needs_auth"}
                fallback={
                  <Show when={focusedError()}>
                    <text fg={themeV2.text.subdued}>enter to view error</text>
                  </Show>
                }
              >
                <text fg={themeV2.text.feedback.warning.default}>enter or space to authorize in browser</text>
              </Show>
            }
          />
        }
      >
        {(server) => (
          <DialogMcpError
            server={server()}
            onBack={() => {
              setDetail()
              dialog.setSize("medium")
            }}
          />
        )}
      </Show>
    </box>
  )
}

function DialogMcpError(props: { server: McpServer; onBack: () => void }) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const toast = useToast()
  const { themeV2 } = useTheme().contextual("elevated")
  const { themeV2: overlayTheme } = useTheme().contextual("overlay")
  const dimensions = useTerminalDimensions()
  const config = useConfig().data
  const [copied, setCopied] = createSignal(false)
  const error = () => statusError(props.server.status) ?? "Unknown MCP connection error"
  const height = createMemo(() => Math.max(3, Math.floor(dimensions().height / 2) - 5))
  let scroll: ScrollBoxRenderable | undefined

  onMount(() => dialog.setSize("large"))

  const copy = () => {
    if (!clipboard.write) return
    void clipboard
      .write(error())
      .then(() => setCopied(true))
      .catch(toast.error)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [{ bind: "escape", title: "Back to MCP servers", group: "Dialog", run: props.onBack }],
  }))

  useKeyboard((event) => {
    if (event.name === "c") return copy()
    if (event.name === "up") return scroll?.scrollBy(-1)
    if (event.name === "down") return scroll?.scrollBy(1)
    if (event.name === "pageup") return scroll?.scrollBy(-height())
    if (event.name === "pagedown") return scroll?.scrollBy(height())
    if (event.name === "home") return scroll?.scrollTo(0)
    if (event.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
  })

  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={themeV2.text.default}>
          MCP server: {props.server.name}
        </text>
        <text fg={themeV2.text.subdued} onMouseUp={props.onBack}>
          esc back
        </text>
      </box>
      <text fg={themeV2.text.feedback.error.default}>✗ Failed</text>
      <box
        backgroundColor={overlayTheme.background.default}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (scroll = element)}
          height={height()}
          scrollbarOptions={{ visible: false }}
          scrollAcceleration={getScrollAcceleration(config)}
        >
          <text fg={overlayTheme.text.default} wrapMode="word">
            {error()}
          </text>
        </scrollbox>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={themeV2.text.subdued}>↑↓ scroll</text>
        <text fg={themeV2.text.subdued} onMouseUp={copy}>
          {copied() ? "✓ copied" : "c copy details"}
        </text>
      </box>
    </box>
  )
}
