import { useData } from "../context/data"
import { createMemo } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { DialogSelect } from "../ui/dialog-select"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { keepAwakeAssertionLabel, keepAwakeStatusLabel, useKeepAwake } from "../keep-awake"
import { useRemote } from "../remote-connector"
import { useTelemetry } from "../context/telemetry"
import { useDialog } from "../ui/dialog"
import { DialogMcp } from "./dialog-mcp"
import { mcpStatusPresentation, mcpSummary } from "../mcp-presentation"
import type { usePlugin } from "../plugin/context"

export type DialogStatusProps = {
  version?: string
  bunVersion?: string
  pluginCount?: number
  serviceSummary?: { configured: number; connected: number }
  startupPlugins?: ReturnType<ReturnType<typeof usePlugin>["list"]>
}

export function DialogStatus(props: DialogStatusProps = {}) {
  const data = useData()
  const remote = useRemote()
  const keepAwake = useKeepAwake()
  const telemetry = useTelemetry()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const mcp = createMemo(() => data.location.mcp.server.list() ?? [])
  const diagnostics = createMemo(() => data.location.config.diagnostics.list() ?? [])
  const connected = createMemo(() => mcp().filter((server) => server.status.status === "connected").length)
  const plugins = createMemo(() => ({
    count: props.pluginCount ?? props.startupPlugins?.filter((plugin) => plugin.status === "active").length ?? 0,
    failed: props.startupPlugins?.some((plugin) => plugin.status === "failed") ?? false,
    loading: props.startupPlugins?.some((plugin) => plugin.status === "loading") ?? false,
  }))
  return (
    <DialogSelect
      title="Status"
      options={[
        {
          title: "YCoding",
          description: props.version ?? InstallationVersion,
          footer: "Connected",
          category: "Runtime",
          value: "ycoding",
        },
        {
          title: "Bun",
          footer: props.bunVersion ?? process.versions.bun ?? "unknown",
          category: "Runtime",
          value: "bun",
        },
        {
          title: "Remote",
          description: remote.status().message,
          footer: remote.status().state,
          state:
            remote.status().state === "error"
              ? ("error" as const)
              : remote.status().state === "on"
                ? ("connected" as const)
                : undefined,
          category: "Services",
          value: "remote",
        },
        {
          title: "Relay MCP",
          details: [remote.mcp().message, ...urlLines(remote.mcp().url, Math.max(1, Math.min(76, dimensions().width - 12)))].filter((value) => value !== undefined),
          detailsWrap: true,
          footer: remote.mcp().state,
          state:
            remote.mcp().state === "error"
              ? ("error" as const)
              : remote.mcp().state === "on"
                ? ("connected" as const)
                : remote.mcp().state === "connecting"
                  ? ("connecting" as const)
                  : undefined,
          category: "Services",
          value: "relayMcp",
        },
        {
          title: "Keep awake",
          details: [keepAwakeAssertionLabel(keepAwake.status()), keepAwake.status()?.message].filter((message) => message !== undefined),
          detailsWrap: true,
          footer: keepAwakeStatusLabel(keepAwake.status()),
          state:
            keepAwake.status()?.state === "error"
              ? ("error" as const)
              : keepAwake.status()?.state === "on"
                ? ("connected" as const)
                : undefined,
          category: "Services",
          value: "keepAwake",
        },
        {
          title: "Telemetry",
          footer: telemetry.consent()?.enabled ? "on" : "off",
          category: "Services",
          value: "telemetry",
        },
        {
          title: "MCP servers",
          description: `${props.serviceSummary?.configured ?? mcp().length} configured`,
          footer: `${props.serviceSummary?.connected ?? connected()} connected`,
          state: mcpSummary(mcp()).attention > 0 ? "error" : mcpSummary(mcp()).pending > 0 ? "connecting" : "connected",
          category: "Services",
          value: "mcp",
        },
        ...mcp()
          .filter((server) => ["failed", "needs_auth", "needs_client_registration"].includes(server.status.status))
          .map((server) => ({
            title: server.name,
            description: (server as typeof server & { transport?: string }).transport,
            footer: mcpStatusPresentation(server.status.status).label,
            state: server.status.status === "needs_auth" ? undefined : ("error" as const),
            category: "Services",
            value: `mcp:${server.name}`,
          })),
        ...diagnostics().map((diagnostic, index) => ({
          title: diagnostic.path,
          details: [...(diagnostic.jsonPath ? [diagnostic.jsonPath] : []), diagnostic.message],
          detailsWrap: true,
          footer: `${diagnostic.reason}${diagnostic.failClosed ? " · fails closed" : ""}`,
          state: "error" as const,
          category: "Configuration",
          value: `config:${index}`,
        })),
        {
          title: "Plugins",
          description: `${plugins().count} loaded`,
          footer: plugins().failed ? "Failed" : plugins().loading ? "Initializing" : "Healthy",
          state: plugins().failed ? "error" : plugins().loading ? "connecting" : "connected",
          category: "Services",
          value: "plugins",
        },
        ...(props.startupPlugins ?? []).map((plugin) => ({
          title: plugin.target,
          footer: plugin.status,
          details: plugin.status === "failed" ? [plugin.error] : undefined,
          detailsWrap: true,
          state:
            plugin.status === "failed"
              ? ("error" as const)
              : plugin.status === "loading"
                ? ("connecting" as const)
                : undefined,
          category: "Plugins",
          value: `startup-plugin:${plugin.target}`,
        })),
        { title: "Durable store", footer: "Healthy", state: "connected", category: "Session", value: "store" },
      ]}
      onSelect={(option) => {
        if (option.value === "mcp" || option.value.startsWith("mcp:")) dialog.replace(() => <DialogMcp />)
      }}
    />
  )
}

function urlLines(url: string | undefined, width: number) {
  if (url === undefined) return []
  return Array.from({ length: Math.ceil(url.length / width) }, (_, index) => url.slice(index * width, (index + 1) * width))
}
