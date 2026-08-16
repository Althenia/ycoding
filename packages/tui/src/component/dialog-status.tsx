import { useData } from "../context/data"
import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"

export type DialogStatusProps = {
  version?: string
  bunVersion?: string
  pluginCount?: number
  serviceSummary?: { configured: number; connected: number }
}

export function DialogStatus(props: DialogStatusProps = {}) {
  const data = useData()
  const mcp = createMemo(() => data.location.mcp.server.list() ?? [])
  const connected = createMemo(() => mcp().filter((server) => server.status.status === "connected").length)
  return (
    <DialogSelect
      title="Status"
      options={[
        { title: "YCoding", description: props.version ?? InstallationVersion, footer: "Connected", category: "Runtime", value: "ycoding" },
        { title: "Bun", footer: props.bunVersion ?? process.versions.bun ?? "unknown", category: "Runtime", value: "bun" },
        {
          title: "MCP servers",
          description: `${props.serviceSummary?.configured ?? mcp().length} configured`,
          footer: `${props.serviceSummary?.connected ?? connected()} connected`,
          state: "connected",
          category: "Services",
          value: "mcp",
        },
        ...mcp()
          .filter((server) => server.status.status === "failed")
          .map((server) => ({
            title: server.name,
            description: (server as typeof server & { transport?: string }).transport,
            footer: "Failed",
            state: "error" as const,
            category: "Services",
            value: `mcp:${server.name}`,
          })),
        { title: "Plugins", description: `${props.pluginCount ?? 0} loaded`, footer: "Healthy", state: "connected", category: "Services", value: "plugins" },
        { title: "Durable store", footer: "Healthy", state: "connected", category: "Session", value: "store" },
      ]}
    />
  )
}
