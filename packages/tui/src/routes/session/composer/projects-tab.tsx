import { onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { ProjectService, ProjectSessionChoice, ProjectView } from "../../../util/coordination"
import { ProjectMembers } from "../project-members"
import { useComposerTab } from "./index"

export type ProjectsTabProps = {
  project: ProjectView
  currentSessionID: string
  sessions: Accessor<readonly ProjectSessionChoice[]>
  service: ProjectService
  now: Accessor<number>
  loadedAt: Accessor<number | undefined>
  onOpen: (sessionID: string) => void
  onSettings: () => void
}

export function ProjectsTab(props: ProjectsTabProps) {
  const composer = useComposerTab()
  const dimensions = useTerminalDimensions()

  onMount(() => onCleanup(composer.register({ id: "projects", label: "Projects" })))

  return (
    <Show when={composer.active("projects")}>
      <box
        flexShrink={0}
        height={Math.max(6, Math.min(18, dimensions().height - 16))}
        paddingTop={dimensions().height <= 24 ? 0 : 1}
      >
        <ProjectMembers
          project={props.project}
          currentSessionID={props.currentSessionID}
          focused
          keymapMode="composer"
          onFocus={() => {}}
          onBack={composer.close}
          onOpen={(sessionID) => {
            composer.close()
            props.onOpen(sessionID)
          }}
          onSettings={() => {
            composer.close()
            props.onSettings()
          }}
          sessions={props.sessions}
          service={props.service}
          now={props.now}
          loadedAt={props.loadedAt}
          compact
          tab
        />
      </box>
    </Show>
  )
}
