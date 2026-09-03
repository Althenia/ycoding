import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { Keymap, type KeymapCommand } from "../context/keymap"
import { useTheme } from "../context/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, createSignal, For, Show, type JSX, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import {
  DialogHeader,
  DialogSearchRow,
  DialogTitle,
  DIALOG_INSET_RIGHT,
  dialogContentWidth,
  dialogPanelWidth,
  useDialog,
  type DialogContext,
} from "./dialog"
import { Locale } from "../util/locale"
import { getScrollAcceleration } from "../util/scroll"
import { useConfig } from "../config"
import { moveSelection, reconcileSelection } from "./select-controller"
import { getGlyph, type GlyphName, type GlyphSlot } from "./glyph"

export interface DialogSelectProps<T> {
  title: string
  titleView?: JSX.Element
  placeholder?: string
  footer?: JSX.Element
  emptyView?: JSX.Element
  noMatchView?: JSX.Element
  options: DialogSelectOption<T>[]
  flat?: boolean
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  renderFilter?: boolean
  locked?: boolean
  layout?: "command-palette"
  preserveSelection?: boolean
  actions?: DialogSelectAction<T>[]
  footerHints?: {
    title: string
    label: string
    side?: "left" | "right"
  }[]
  bindings?: readonly KeymapCommand[]
  current?: T
  focusCurrent?: boolean
}

type DialogSelectActionBase<T> = {
  command: string
  title: string
  side?: "left" | "right"
  hidden?: boolean
  disabled?: boolean | ((option: DialogSelectOption<T> | undefined) => boolean)
}

type DialogSelectAction<T> =
  | (DialogSelectActionBase<T> & {
      selection?: "required"
      onTrigger: (option: DialogSelectOption<T>) => void
    })
  | (DialogSelectActionBase<T> & {
      selection: "none"
      onTrigger: () => void
    })

export interface DialogSelectOption<T = any> {
  title: string
  titleView?: JSX.Element
  value: T
  description?: string
  details?: string[]
  detailsColor?: RGBA
  detailsWrap?: boolean
  footer?: JSX.Element | string
  titleWidth?: number
  truncateTitle?: boolean | "left"
  category?: string
  categoryView?: JSX.Element
  state?: GlyphName
  disabled?: boolean
  bg?: RGBA
  gutter?: () => JSX.Element
  margin?: JSX.Element
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
  moveTo(value: T): void
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  type Action = NonNullable<DialogSelectProps<T>["actions"]>[number]
  type FooterHint = NonNullable<DialogSelectProps<T>["footerHints"]>[number]
  type VisibleAction = (Action & { label: string }) | FooterHint

  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const config = useConfig().data
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
  })
  const [focusedAction, setFocusedAction] = createSignal<number>()
  const actionFocused = createMemo(() => focusedAction() !== undefined)
  let selection: { value: T; category?: string } | undefined
  let resetSelection = false
  let visibilityGeneration = 0

  createEffect(
    on(
      () => props.current,
      (current) => {
        if (props.focusCurrent === false) return
        if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
            selection = flat()[currentIndex]
          }
        }
      },
    ),
  )

  let filterInput: InputRenderable | undefined
  let disposed = false
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    if (focusTimer) clearTimeout(focusTimer)
  })

  const actions = createMemo(() => props.actions ?? [])
  const shownActions = createMemo(() => actions().filter((item) => !item.hidden))
  const shortcuts = Keymap.useShortcuts()

  const actionLabels = createMemo(() => {
    const labels = new Map<string, string>()

    for (const action of shownActions()) {
      const label = shortcuts.all(action.command)
      if (label) labels.set(action.command, label)
    }

    return labels
  })
  const visibleActions = createMemo(() => [
    ...shownActions()
      .map((item) => ({ ...item, label: actionLabels().get(item.command) ?? "" }))
      .filter((item) => item.label),
    ...(props.footerHints ?? []),
  ])
  const actionItems = () =>
    visibleActions()
      .filter(isActionItem)
      .filter((item) => !isActionDisabled(item))

  createEffect(() => {
    const index = focusedAction()
    if (index !== undefined && index >= actionItems().length) setFocusedAction(undefined)
  })

  const filtered = createMemo(() => {
    if (props.skipFilter || props.renderFilter === false) return props.options.filter((x) => x.disabled !== true)
    const needle = store.filter.toLowerCase()
    const options = pipe(
      props.options,
      filter((x) => x.disabled !== true),
    )
    if (!needle) return options

    // prioritize title matches (weight: 2) over category matches (weight: 1).
    // users typically search by the item name, and not its category.
    const result = fuzzysort
      .go(needle, options, {
        keys: ["title", "category"],
        scoreFn: (r) => r[0].score * 2 + r[1].score,
      })
      .map((x) => x.obj)

    return result
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
    setFocusedAction(undefined)
  })

  const flatten = createMemo(() => props.flat && store.filter.length > 0)

  const grouped = createMemo<[string, DialogSelectOption<T>[]][]>(() => {
    if (flatten()) return [["", filtered()]]
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
    )
    return result
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const rows = createMemo(() => {
    // A category costs three rows: a leading blank row (the list inset for the first group), its label, and a trailing blank row.
    const headers = grouped().reduce((acc, [category]) => (category ? acc + 3 : acc), 0)
    return flat().reduce((acc, option) => acc + 1 + (option.details?.length ?? 0), headers)
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => Math.min(rows(), Math.max(0, Math.floor(dimensions().height / 2) - 6)))
  const paletteViewportHeight = createMemo(() => Math.min(26, Math.max(0, dimensions().height - 8)))
  const rowWidth = createMemo(() => dialogPanelWidth(dimensions().width))

  const selected = createMemo(() => flat()[store.selected])

  createEffect(
    on(
      () => props.options,
      () => {
        if (!props.preserveSelection) {
          const count = flat().length
          if (count === 0) return
          const next = reconcileSelection(store.selected, count)
          if (next !== store.selected) setStore("selected", next)
          return
        }
        if (resetSelection && store.filter.length > 0) {
          const option = flat()[0]
          if (!option) return
          setStore("selected", 0)
          selection = option
          return
        }
        if (!selection) {
          if (props.focusCurrent !== false && props.current !== undefined) {
            const index = flat().findIndex((option) => isDeepEqual(option.value, props.current))
            if (index >= 0) {
              setStore("selected", index)
              selection = flat()[index]
              return
            }
          }
          const option = selected()
          if (!option) return
          selection = option
          return
        }
        const previous = selection
        const index = flat().findIndex((option) => isDeepEqual(option.value, previous.value))
        if (index >= 0) {
          const option = flat()[index]
          const moved = index !== store.selected || option.category !== previous.category
          setStore("selected", index)
          selection = option
          if (!moved) return
          const value = option.value
          const generation = ++visibilityGeneration
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (generation !== visibilityGeneration) return
              if (!props.preserveSelection || store.filter.length > 0) return
              if (!isDeepEqual(selected()?.value, value)) return
              scrollToSelection(false)
            })
          })
          return
        }
        const next = reconcileSelection(store.selected, flat().length)
        if (flat().length === 0) return
        setStore("selected", next)
        selection = flat()[next]
      },
    ),
  )
  onCleanup(() => {
    visibilityGeneration++
  })

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      if (filter.length > 0) resetSelection = true
      setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true, false)
        } else if (current && props.focusCurrent !== false) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            moveTo(currentIndex, true)
          }
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (props.locked) return
    if (flat().length === 0) return
    moveTo(moveSelection(store.selected, { count: flat().length, delta: direction, policy: "wrap" }), true)
  }

  function moveTo(next: number, center = false, preserve = true) {
    setFocusedAction(undefined)
    setStore("selected", next)
    const option = selected()
    if (option) {
      selection = option
      resetSelection = !preserve
    }
    if (option) props.onMove?.(option)
    scrollToSelection(center)
  }

  function scrollToSelection(center: boolean) {
    if (!scroll) return
    let remaining = store.selected
    let index = 0
    // Locate the row by position because a unique renderable ID cannot currently be ensured.
    for (const [category, options] of grouped()) {
      if (category) index++
      if (remaining < options.length) {
        index += remaining
        break
      }
      index += options.length
      remaining -= options.length
    }
    const target = scroll.getChildren()[index]
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
    } else {
      if (y >= scroll.height) {
        scroll.scrollBy(y - scroll.height + 1)
      }
      if (y < 0) {
        scroll.scrollBy(y)
        if (isDeepEqual(flat()[0].value, selected()?.value)) {
          scroll.scrollTo(0)
        }
      }
    }
  }

  function submit() {
    if (props.locked) return
    setStore("input", "keyboard")
    const index = focusedAction()
    if (index !== undefined) {
      trigger(actionItems()[index])
      return
    }
    const option = selected()
    if (!option) return
    option.onSelect?.(dialog)
    props.onSelect?.(option)
  }

  function moveAction(direction: 1 | -1) {
    if (props.locked) return
    const total = actionItems().length
    if (total === 0) return
    setFocusedAction((index) => {
      if (index === undefined) return direction === 1 ? 0 : total - 1
      const next = index + direction
      return next < 0 || next >= total ? undefined : next
    })
  }

  Keymap.createLayer(() => {
    const visible = shownActions()

    return {
      mode: "modal",
      commands: [
        {
          id: "dialog.select.prev",
          title: "Previous item",
          group: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(-1)
          },
        },
        {
          id: "dialog.select.next",
          title: "Next item",
          group: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(1)
          },
        },
        {
          id: "dialog.select.page_up",
          title: "Page up",
          group: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(-10)
          },
        },
        {
          id: "dialog.select.page_down",
          title: "Page down",
          group: "Dialog",
          run() {
            setStore("input", "keyboard")
            move(10)
          },
        },
        {
          id: "dialog.select.home",
          title: "First item",
          group: "Dialog",
          run() {
            if (props.locked) return
            setStore("input", "keyboard")
            moveTo(0)
          },
        },
        {
          id: "dialog.select.end",
          title: "Last item",
          group: "Dialog",
          run() {
            if (props.locked) return
            setStore("input", "keyboard")
            moveTo(flat().length - 1)
          },
        },
        {
          id: "dialog.select.submit",
          title: "Select item",
          group: "Dialog",
          run: submit,
        },
        ...visible.map((item) => ({
          id: item.command,
          title: item.title,
          group: "Dialog",
          run: () => trigger(item),
        })),
        ...(visible.length
          ? [
              {
                bind: "tab",
                title: "Next dialog action",
                group: "Dialog",
                run: () => moveAction(1),
              },
              {
                bind: "shift+tab",
                title: "Previous dialog action",
                group: "Dialog",
                run: () => moveAction(-1),
              },
            ]
          : []),
        ...(props.bindings ?? []),
      ],
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
    moveTo(value) {
      const index = flat().findIndex((option) => isDeepEqual(option.value, value))
      if (index >= 0) moveTo(index, true)
    },
  }
  props.ref?.(ref)

  const left = createMemo(() => visibleActions().filter((item) => item.side !== "right"))
  const right = createMemo(() => visibleActions().filter((item) => item.side === "right"))

  function trigger(item: Action | undefined) {
    if (props.locked || !item || isActionDisabled(item)) return
    setStore("input", "keyboard")
    if (item.selection === "none") {
      item.onTrigger()
      return
    }
    const option = selected()
    if (!option) return
    item.onTrigger(option)
  }

  function isActionItem(item: VisibleAction): item is Action & { label: string } {
    return "onTrigger" in item
  }

  function isActionDisabled(item: Action) {
    const option = selected()
    if (item.selection !== "none" && !option) return true
    return typeof item.disabled === "function" ? item.disabled(option) : item.disabled
  }

  function isActionFocused(item: VisibleAction) {
    if (props.locked) return false
    if (!isActionItem(item)) return false
    return actionItems().indexOf(item) === focusedAction()
  }

  function FooterAction(action: { item: VisibleAction }) {
    if (!isActionItem(action.item))
      return (
        <text>
          <span style={{ fg: themeV2.text.default }}>{action.item.label} </span>
          <span style={{ fg: themeV2.text.subdued }}>{action.item.title}</span>
        </text>
      )
    const item = action.item
    const active = createMemo(() => isActionFocused(item))
    const disabled = createMemo(() => isActionDisabled(item))
    return (
      <box
        flexDirection="row"
        backgroundColor={active() ? themeV2.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
        onMouseUp={() => trigger(item)}
      >
        <text
          fg={
            disabled()
              ? themeV2.text.subdued
              : active()
                ? themeV2.text.action.primary.focused
                : themeV2.text.default
          }
          attributes={active() ? TextAttributes.BOLD : undefined}
        >
          {item.label}
        </text>
        <text fg={disabled() ? themeV2.text.subdued : active() ? themeV2.text.action.primary.focused : themeV2.text.subdued}>
          {" "}
          {item.title}
        </text>
      </box>
    )
  }

  return (
    <box paddingTop={1} paddingBottom={1} flexGrow={1}>
      <DialogHeader title={props.titleView ?? <DialogTitle>{props.title}</DialogTitle>} />
      <Show when={props.renderFilter !== false}>
        <DialogSearchRow>
          <input
            onInput={(e) => {
              if (props.locked) return
              batch(() => {
                setStore("filter", e)
                props.onFilter?.(e)
              })
            }}
            focusedBackgroundColor="transparent"
            cursorColor={themeV2.text.feedback.info.default}
            focusedTextColor={themeV2.text.default}
            ref={(r) => {
              filterInput = r
              filterInput.traits = { status: "FILTER" }
              if (focusTimer) clearTimeout(focusTimer)
              const node = filterInput
              focusTimer = setTimeout(() => {
                if (disposed) return
                if (filterInput !== node) return
                if (node.isDestroyed) return
                node.focus()
              }, 1)
            }}
            placeholder={props.placeholder ?? "Search"}
            placeholderColor={themeV2.text.subdued}
          />
          <Show when={store.filter.length === 0}>
            <box position="absolute" left={6} width={1} backgroundColor={themeV2.background.action.primary.focused}>
              <text fg={themeV2.text.action.primary.focused}>S</text>
            </box>
          </Show>
        </DialogSearchRow>
      </Show>
      <box paddingTop={props.renderFilter === false ? 0 : 1} flexGrow={1} flexShrink={1}>
        <Show
          when={grouped().length > 0}
          fallback={
            <Show
              when={props.renderFilter !== false && store.filter.length > 0}
              fallback={
                props.emptyView ?? (
                  <box paddingLeft={6} paddingRight={4}>
                    <text fg={themeV2.text.subdued}>No items available</text>
                  </box>
                )
              }
            >
              {props.noMatchView ?? (
                <box paddingLeft={6} paddingRight={4}>
                  <text fg={themeV2.text.subdued}>No results found</text>
                </box>
              )}
            </Show>
          }
        >
          <scrollbox
            paddingLeft={0}
            paddingRight={0}
            scrollbarOptions={{ visible: false }}
            scrollAcceleration={scrollAcceleration()}
            ref={(r: ScrollBoxRenderable) => (scroll = r)}
            paddingTop={grouped()[0]?.[0] ? 1 : 0}
            height={props.layout === "command-palette" ? paletteViewportHeight() : undefined}
            maxHeight={props.layout === "command-palette" ? paletteViewportHeight() : height()}
          >
            <For each={grouped()}>
              {([category, options], index) => (
                <>
                  <Show when={category}>
                    <box paddingTop={index() > 0 ? 1 : 0} paddingBottom={1} paddingLeft={3}>
                      <Show
                        when={options[0]?.categoryView}
                        fallback={
                          <text fg={themeV2.text.feedback.info.default} attributes={TextAttributes.BOLD}>
                            {category}
                          </text>
                        }
                      >
                        {options[0]?.categoryView}
                      </Show>
                    </box>
                  </Show>
                  <For each={options}>
                    {(option) => {
                      const active = createMemo(() => !props.locked && isDeepEqual(option.value, selected()?.value))
                      const current = createMemo(() => isDeepEqual(option.value, props.current))
                      return (
                        <box
                          flexDirection="column"
                          position="relative"
                          onMouseMove={() => {
                            if (props.locked) return
                            setStore("input", "mouse")
                            setFocusedAction(undefined)
                          }}
                          onMouseUp={() => {
                            if (props.locked) return
                            option.onSelect?.(dialog)
                            props.onSelect?.(option)
                          }}
                          onMouseOver={() => {
                            if (props.locked) return
                            if (store.input !== "mouse") return
                            const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                            if (index === -1) return
                            moveTo(index)
                          }}
                          onMouseDown={() => {
                            if (props.locked) return
                            const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                            if (index === -1) return
                            moveTo(index)
                          }}
                        >
                          <box flexDirection="column" height={1} width={rowWidth()}>
                            <box
                              flexDirection="row"
                              height={1}
                              width={rowWidth()}
                              backgroundColor={
                                active()
                                  ? actionFocused()
                                    ? themeV2.background.surface.overlay
                                    : (option.bg ?? themeV2.background.action.primary.focused)
                                  : RGBA.fromInts(0, 0, 0, 0)
                              }
                            >
                              <box
                                flexDirection="row"
                                width={dialogContentWidth(dimensions().width)}
                                paddingLeft={3}
                                paddingRight={DIALOG_INSET_RIGHT}
                              >
                                <Show when={!current() && option.margin}>
                                  <box position="absolute" left={3} flexShrink={0}>
                                    {option.margin}
                                  </box>
                                </Show>
                                <Option
                                  title={option.title}
                                  titleView={option.titleView}
                                  footer={flatten() ? (option.category ?? option.footer) : option.footer}
                                  titleWidth={option.titleWidth}
                                  truncateTitle={option.truncateTitle}
                                  description={option.description !== category ? option.description : undefined}
                                  active={active()}
                                  current={current()}
                                  muted={actionFocused()}
                                  gutter={option.gutter}
                                  state={option.state}
                                />
                              </box>
                            </box>
                          </box>
                          <For each={option.details}>
                            {(detail) => (
                              <box paddingLeft={6} paddingRight={4}>
                                <text
                                  fg={option.detailsColor ?? themeV2.text.subdued}
                                  wrapMode={option.detailsWrap ? "word" : "none"}
                                >
                                  {option.detailsWrap
                                    ? detail
                                    : Locale.truncateMiddle(detail, Math.max(1, Math.min(76, dimensions().width - 12)))}
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
      <Show when={props.footer || visibleActions().length}>
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingRight={4}
          paddingLeft={6}
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
        >
          <box flexDirection="row" gap={2}>
            {props.footer}
            <For each={left()}>{(item) => <FooterAction item={item} />}</For>
          </box>
          <box flexDirection="row" gap={2}>
            <For each={right()}>{(item) => <FooterAction item={item} />}</For>
          </box>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  titleView?: JSX.Element
  description?: string
  active?: boolean
  current?: boolean
  muted?: boolean
  footer?: JSX.Element | string
  titleWidth?: number
  truncateTitle?: boolean | "left"
  gutter?: () => JSX.Element
  state?: GlyphName
  onMouseOver?: () => void
}) {
  const { themeV2 } = useTheme().contextual("elevated")
  const stateGlyph = createMemo(() => (props.state ? getGlyph(props.state) : undefined))
  const text = createMemo(() => {
    if (props.active && !props.muted) return themeV2.text.action.primary.focused
    if (props.muted && (props.active || props.current)) return themeV2.text.subdued
    if (props.current) return themeV2.text.feedback.info.default
    return themeV2.text.default
  })
  const stateColor = createMemo(() => {
    if (props.active && !props.muted) return themeV2.text.action.primary.focused
    return glyphColor(themeV2, stateGlyph())
  })

  return (
    <>
      <box width={3} flexShrink={0}>
        <Show
          when={props.state}
          fallback={
            <Show
              when={props.gutter}
              fallback={
                <Show when={props.current}>
                  <text fg={text()}>●</text>
                </Show>
              }
            >
              {props.gutter?.()}
            </Show>
          }
        >
          <text fg={stateColor()}>{stateGlyph()?.rendered}</text>
        </Show>
      </box>
      <text
        flexGrow={1}
        fg={text()}
        attributes={props.active && !props.muted ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
      >
        {props.titleView ??
          (props.truncateTitle === false
            ? props.title
            : props.truncateTitle === "left"
              ? Locale.truncateLeft(props.title, props.titleWidth ?? 61)
              : Locale.truncate(props.title, props.titleWidth ?? 61))}
        <Show when={props.description}>
          <span style={{ fg: props.active && !props.muted ? themeV2.text.action.primary.focused : themeV2.text.subdued }}>
            {" "}
            {props.description}
          </span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text
            fg={props.active && !props.muted ? themeV2.text.action.primary.focused : themeV2.text.subdued}
          >
            {props.footer}
          </text>
        </box>
      </Show>
    </>
  )
}

function glyphColor(themeV2: ReturnType<typeof useTheme>["themeV2"], glyph: GlyphSlot | undefined) {
  switch (glyph?.token) {
    case "feedback.success":
      return themeV2.text.feedback.success.default
    case "feedback.error":
      return themeV2.text.feedback.error.default
    case "feedback.warning":
      return themeV2.text.feedback.warning.default
    case "feedback.info":
      return themeV2.text.feedback.info.default
    default:
      return themeV2.text.subdued
  }
}
