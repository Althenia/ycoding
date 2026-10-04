import { createStore } from "solid-js/store"
import { createEffect, createMemo, For, Match, on, Show, Switch } from "solid-js"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import type { PermissionRequest } from "@ycoding-ai/client"
import { useClient } from "../../context/client"
import { SplitBorder } from "../../ui/border"
import { useData } from "../../context/data"
import { filetype } from "../../util/filetype"
import { permissionAlwaysLines, permissionOptionLabel, permissionPresentation } from "../../util/permission"
import { getScrollAcceleration } from "../../util/scroll"
import { useConfig } from "../../config"
import { Keymap } from "../../context/keymap"
import { usePathFormatter } from "../../context/path-format"
import { SimulationSemantics } from "../../simulation/semantics"

type PermissionStage = "permission" | "always" | "reject"

function EditBody(props: { file?: string; diff?: string; patch?: string }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useConfig().data
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => props.file ?? "")
  const diff = createMemo(() => props.diff ?? "")

  const view = createMemo(() => {
    const diffView = config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <diff
          diff={diff()}
          view={view()}
          filetype={ft()}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode="word"
          fg={theme.text.default}
          addedBg={theme.diff.background.added}
          removedBg={theme.diff.background.removed}
          contextBg={theme.diff.background.context}
          addedSignColor={theme.diff.highlight.added}
          removedSignColor={theme.diff.highlight.removed}
          lineNumberFg={theme.diff.lineNumber.text}
          lineNumberBg={theme.diff.background.context}
          addedLineNumberBg={theme.diff.lineNumber.background.added}
          removedLineNumberBg={theme.diff.lineNumber.background.removed}
        />
      </Show>
      <Show when={!diff()}>
        <Show
          when={props.patch}
          fallback={
            <box paddingLeft={1}>
              <text fg={theme.text.subdued}>No diff provided</text>
            </box>
          }
        >
          {(patch) => (
            <code
              filetype="diff"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={patch()}
              fg={theme.text.subdued}
            />
          )}
        </Show>
      </Show>
    </box>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest; directory?: string }) {
  const client = useClient()
  const data = useData()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })
  const pathFormatter = usePathFormatter()
  const session = createMemo(() => data.session.get(props.request.sessionID))

  const source = createMemo(() => {
    const tool = props.request.source
    if (!tool) return { input: undefined, structured: undefined }
    const message = data.session.message.get(props.request.sessionID, tool.messageID)
    if (message?.type !== "assistant") return { input: undefined, structured: undefined }
    const part = message.content.find((part) => part.type === "tool" && part.id === tool.callID)
    if (part?.type === "tool" && part.state.status !== "streaming") {
      return { input: part.state.input, structured: part.state.structured }
    }
    return { input: undefined, structured: undefined }
  })

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Always allow"
          semanticLabel={`Always allow ${props.request.action}`}
          instance={props.request.id}
          body={
            <box paddingLeft={1} gap={1}>
              <For each={permissionAlwaysLines(props.request)}>
                {(line, index) => <text fg={index() === 0 ? theme.text.subdued : theme.text.default}>{line}</text>}
              </For>
            </box>
          }
          options={{ confirm: permissionOptionLabel("confirm"), cancel: permissionOptionLabel("cancel") }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            void client.api.permission.reply({
              sessionID: props.request.sessionID,
              reply: "always",
              requestID: props.request.id,
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          action={props.request.action}
          instance={props.request.id}
          onConfirm={(message) => {
            void client.api.permission.reply({
              sessionID: props.request.sessionID,
              reply: "reject",
              requestID: props.request.id,
              message: message || undefined,
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const current = permissionPresentation(
            {
              action: props.request.action,
              resources: props.request.resources,
              metadata: props.request.metadata,
              input: source().input,
              structured: source().structured,
            },
            pathFormatter.format,
          )
          const presentationBody =
            props.request.action === "edit" ? (
              <box paddingLeft={3} paddingRight={3}>
                <EditBody file={current.file} diff={current.diff} patch={current.patch} />
              </box>
            ) : props.request.action === "external_directory" ? (
              <Show when={current.lines.length > 0}>
                <box paddingLeft={6} paddingRight={3} gap={1}>
                  <box>
                    <For each={current.lines}>{(line) => <text fg={theme.text.default}>{line}</text>}</For>
                  </box>
                </box>
              </Show>
            ) : (
              <box paddingLeft={6} paddingRight={3}>
                <For each={current.lines}>
                  {(line) => (
                    <text
                      fg={
                        props.request.action === "shell" ||
                        props.request.action === "subagent" ||
                        props.request.action === "task"
                          ? theme.text.default
                          : theme.text.subdued
                      }
                    >
                      {line.replace(/^(?:- |\$ )/, "")}
                    </text>
                  )}
                </For>
              </box>
            )

          const body = (
            <Prompt
              title="Permission required"
              semanticLabel={permissionSemanticLabel(props.request.action, current.title)}
              instance={props.request.id}
              body={
                <box flexDirection="column">
                  <box paddingLeft={3} paddingRight={3}>
                    <text fg={theme.text.feedback.info.default}>
                      {props.request.action === "shell" ? "bash wants to run" : current.title}
                    </text>
                  </box>
                  {presentationBody}
                </box>
              }
              options={
                props.request.save?.length
                  ? {
                      once: permissionOptionLabel("once"),
                      always: "Allow for this session",
                      reject: "Deny",
                    }
                  : { once: permissionOptionLabel("once"), reject: "Deny" }
              }
              escapeKey="reject"
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  void client.api.permission.reply({
                    sessionID: props.request.sessionID,
                    reply: "reject",
                    requestID: props.request.id,
                  })
                  return
                }
                void client.api.permission.reply({
                  sessionID: props.request.sessionID,
                  reply: "once",
                  requestID: props.request.id,
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

export function permissionSemanticLabel(action: string, title?: string) {
  return `Permission required: ${title ?? action}`
}

function RejectPrompt(props: {
  action: string
  instance: string
  onConfirm: (message: string) => void
  onCancel: () => void
}) {
  let input: TextareaRenderable
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      {
        id: "app.exit",
        title: "Cancel permission rejection",
        group: "Permission",
        run() {
          props.onCancel()
        },
      },
      { bind: "escape", title: "Cancel permission rejection", group: "Permission", run: () => props.onCancel() },
      {
        bind: "return",
        title: "Confirm permission rejection",
        group: "Permission",
        run: () => props.onConfirm(input.plainText),
      },
    ],
  }))

  return (
    <box
      id="session.permission.reject"
      ref={SimulationSemantics.bind(() => ({
        instance: props.instance,
        role: "dialog",
        label: `Reject permission: ${props.action}`,
      }))}
      backgroundColor={theme.background.default}
      border={["left"]}
      borderColor={theme.text.feedback.error.default}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.text.feedback.error.default}>{"△"}</text>
          <text fg={theme.text.default}>Reject permission</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.text.subdued}>Tell YCoding what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.raise(theme.background.default)}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          id="session.permission.reject.message"
          ref={(val: TextareaRenderable) => {
            input = val
            SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "textbox",
              label: "Rejection reason",
              focused: val.focused,
              disabled: false,
            }))(val)
            val.traits = { status: "REJECT" }
          }}
          focused
          textColor={theme.text.default}
          focusedTextColor={theme.text.default}
          cursorColor={theme.text.default}
        />
        <box
          id="session.permission.reject.actions"
          ref={SimulationSemantics.bind(() => ({
            instance: props.instance,
            role: "group",
            label: "Rejection actions",
          }))}
          flexDirection="row"
          gap={2}
          flexShrink={0}
        >
          <box
            id="session.permission.reject.confirm"
            ref={SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "button",
              label: "Confirm rejection",
              disabled: false,
            }))}
            onMouseUp={() => props.onConfirm(input.plainText)}
          >
            <text fg={theme.text.default}>
              enter <span style={{ fg: theme.text.subdued }}>confirm</span>
            </text>
          </box>
          <box
            id="session.permission.reject.cancel"
            ref={SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "button",
              label: "Cancel rejection",
              disabled: false,
            }))}
            onMouseUp={props.onCancel}
          >
            <text fg={theme.text.default}>
              esc <span style={{ fg: theme.text.subdued }}>cancel</span>
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

export function Prompt<const T extends Record<string, string>>(props: {
  title: string
  kind?: "permission" | "guardrail"
  semanticLabel?: string
  instance: string
  body: JSX.Element
  footer?: JSX.Element
  options: T
  defaultOption?: keyof T
  escapeKey?: keyof T
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  const config = useConfig().data
  let details: ScrollBoxRenderable | undefined
  const kind = props.kind ?? "permission"
  const keys = createMemo(() => Object.keys(props.options) as (keyof T)[])
  const [store, setStore] = createStore({
    selected: props.defaultOption ?? keys()[0],
  })
  const footer = () =>
    props.footer ??
    (kind === "guardrail" ? <text fg={theme.text.subdued}>guardrails apply even in YOLO mode.</text> : undefined)
  const compact = () => dimensions().height < 30
  const chromeHeight = () =>
    3 + keys().length * (compact() ? 1 : 2) + Number(props.footer !== undefined || kind === "guardrail") + (compact() ? 0 : 3)
  const detailsHeight = () =>
    Math.max(
      1,
      Math.min(dimensions().height - 1, Math.max(chromeHeight() + 2, Math.floor(dimensions().height * 0.65))) - chromeHeight(),
    )
  const move = (direction: -1 | 1) => {
    const index = keys().indexOf(store.selected)
    setStore("selected", keys()[(index + direction + keys().length) % keys().length])
  }
  createEffect(
    on(
      () => props.instance,
      () => {
        setStore("selected", props.defaultOption ?? keys()[0])
        details?.scrollTo(0)
      },
    ),
  )

  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      {
        bind: "pageup",
        title: "Previous approval details page",
        group: "Permission",
        run: () => details?.scrollBy(-Math.max(1, details.viewport.height)),
      },
      {
        bind: "pagedown",
        title: "Next approval details page",
        group: "Permission",
        run: () => details?.scrollBy(Math.max(1, details.viewport.height)),
      },
      {
        id: "app.exit",
        title: "Reject permission",
        group: "Permission",
        bind: false,
        run() {
          if (!props.escapeKey) return
          props.onSelect(props.escapeKey)
        },
      },
      {
        bind: "left",
        title: "Previous permission option",
        group: "Permission",
        run: () => move(-1),
      },
      {
        bind: "h",
        title: "Previous permission option",
        group: "Permission",
        run: () => move(-1),
      },
      {
        bind: "up",
        title: "Previous permission option",
        group: "Permission",
        run: () => move(-1),
      },
      {
        bind: "right",
        title: "Next permission option",
        group: "Permission",
        run: () => move(1),
      },
      {
        bind: "l",
        title: "Next permission option",
        group: "Permission",
        run: () => move(1),
      },
      {
        bind: "down",
        title: "Next permission option",
        group: "Permission",
        run: () => move(1),
      },
      {
        bind: "return",
        title: "Select permission option",
        group: "Permission",
        run: () => props.onSelect(store.selected),
      },
      ...(props.escapeKey
        ? [
            {
              bind: "escape",
              title: "Reject permission",
              group: "Permission",
              run: () => props.onSelect(props.escapeKey!),
            },
          ]
        : []),
    ],
    bindings: props.escapeKey ? ["app.exit"] : [],
  }))

  const content = () => (
    <box
      id={`session.${kind}`}
      ref={SimulationSemantics.bind(() => ({
        instance: props.instance,
        role: "dialog",
        label: props.semanticLabel ?? props.title,
      }))}
      width="100%"
      maxHeight={dimensions().height - 1}
      flexShrink={0}
      backgroundColor={theme.background.surface.offset}
      paddingTop={compact() ? 0 : 1}
      paddingRight={1}
    >
      <box
        width="100%"
        height={1}
        flexShrink={0}
        paddingLeft={3}
        paddingRight={3}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={theme.text.default}>{props.title}</text>
        <box flexGrow={1} />
        <box width={3} flexShrink={0}>
          <text fg={theme.text.subdued} onMouseUp={() => props.onSelect(props.escapeKey ?? keys()[keys().length - 1])}>
            esc
          </text>
        </box>
      </box>
      <scrollbox
        id={`session.${kind}.details`}
        ref={(value: ScrollBoxRenderable) => {
          details = value
        }}
        width="100%"
        maxHeight={detailsHeight()}
        minHeight={1}
        scrollX={false}
        scrollAcceleration={getScrollAcceleration(config)}
        contentOptions={{ flexShrink: 0, minHeight: 0 }}
        scrollbarOptions={{ visible: false }}
      >
        <box width="100%" flexDirection="column" flexShrink={0}>
          {props.body}
        </box>
      </scrollbox>
      <box width="100%" paddingTop={compact() ? 0 : 1} paddingLeft={3} flexShrink={0}>
        <text fg={theme.text.feedback.info.default}>Choose</text>
      </box>
      <box
        width="100%"
        id={`session.${kind}.actions`}
        ref={SimulationSemantics.bind(() => ({
          instance: props.instance,
          role: "listbox",
          label: kind === "guardrail" ? "Guardrail choices" : "Permission choices",
        }))}
        flexDirection="column"
        flexShrink={0}
      >
        <For each={keys()}>
          {(option) => (
            <box
              id={`session.${kind}.action.${String(option)}`}
              ref={SimulationSemantics.bind(() => ({
                instance: props.instance,
                role: "option",
                label: props.options[option],
                focused: option === store.selected,
                selected: option === store.selected,
                disabled: false,
              }))}
              width="100%"
              height={compact() ? 1 : 2}
              flexDirection="column"
              onMouseOver={() => setStore("selected", option)}
              onMouseUp={() => {
                setStore("selected", option)
                props.onSelect(option)
              }}
            >
              <box
                id={`session.${kind}.action.${String(option)}.${option === store.selected ? "band" : "label"}`}
                width="100%"
                height={1}
                paddingLeft={6}
                paddingRight={3}
                backgroundColor={
                  option === store.selected
                    ? theme.background.action.primary.focused
                    : theme.background.surface.offset
                }
              >
                <text
                  fg={
                    option === store.selected
                      ? theme.text.action.primary.focused
                      : option === "reject"
                        ? theme.text.feedback.error.default
                        : theme.text.default
                  }
                >
                  {props.options[option]}
                </text>
              </box>
              <Show when={!compact()}>
                <box
                  id={`session.${kind}.action.${String(option)}.spacer`}
                  height={1}
                  backgroundColor={theme.background.surface.offset}
                />
              </Show>
            </box>
          )}
        </For>
      </box>
      <box
        id={`session.${kind}.footer`}
        width="100%"
        paddingTop={compact() ? 0 : 1}
        paddingLeft={6}
        paddingRight={3}
        flexShrink={0}
      >
        <text fg={theme.text.subdued} wrapMode="none">
          {dimensions().width < 60 ? "pgup/pgdn review · enter/esc" : "pgup/pgdn review · ↑↓ choose · enter select · esc"}
        </text>
        <Show when={footer()}>{footer()}</Show>
      </box>
    </box>
  )

  return content()
}
