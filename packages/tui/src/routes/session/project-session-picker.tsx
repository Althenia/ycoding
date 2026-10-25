import { Show, type Accessor } from "solid-js"
import { useTheme } from "../../context/theme"
import { filterSessions, type ProjectSessionChoice } from "../../util/coordination"
import type { Row } from "./project-rows"

export const pickerLimit = 50

export function sessionPickerRows(input: {
  sessions: readonly ProjectSessionChoice[]
  query: string
  setQuery: (value: string) => void
  assigned: "show" | "hide"
  chosen?: string
  choose: (session: ProjectSessionChoice) => void
}): Row[] {
  const matches = filterSessions(
    input.assigned === "hide" ? input.sessions.filter((session) => !session.projectName) : input.sessions,
    input.query,
  )
  const find: Row = {
    key: "find",
    kind: "item",
    label: "Find",
    value: input.query || "title or directory",
    marker: "✎",
    edit: { initial: input.query, commit: input.setQuery, onInput: input.setQuery },
  }
  const rows = matches.slice(0, pickerLimit).map(
    (session): Row =>
      session.projectName
        ? {
            key: session.sessionID,
            kind: "item",
            label: session.title,
            detail: session.directory,
            badge: `in ${session.projectName}`,
            disabled: true,
            tone: "subdued",
          }
        : {
            key: session.sessionID,
            kind: "item",
            label: `${input.chosen === session.sessionID ? "● " : ""}${session.title}`,
            detail: session.directory,
            activate: () => input.choose(session),
          },
  )
  const hidden = matches.length - rows.length
  return [
    find,
    ...rows,
    ...(matches.length === 0 ? [{ key: "find:none", kind: "info", label: "No matching Sessions" } satisfies Row] : []),
    ...(hidden > 0 ? [{ key: "find:more", kind: "info", label: `${hidden} more · type to narrow` } satisfies Row] : []),
  ]
}

export function SessionPickerDetail(props: { session: Accessor<ProjectSessionChoice | undefined> }) {
  const { theme } = useTheme()
  return (
    <Show when={props.session()}>
      {(session) => (
        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text wrapMode="word">{session().title}</text>
          <text fg={theme.text.subdued} wrapMode="word">
            {session().directory}
          </text>
          <Show when={session().projectName}>
            <text fg={theme.text.subdued}>Already in {session().projectName}; unavailable</text>
          </Show>
        </box>
      )}
    </Show>
  )
}
