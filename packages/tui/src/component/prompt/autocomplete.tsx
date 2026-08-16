import type { BoxRenderable, RGBA, TextareaRenderable, ScrollBoxRenderable } from "@opentui/core"
import { pathToFileURL } from "node:url"
import fuzzysort from "fuzzysort"
import path from "path"
import { firstBy } from "remeda"
import { createMemo, createResource, createEffect, onMount, onCleanup, For, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useEditorContext } from "../../context/editor"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiPaths } from "../../context/runtime"
import { useConfig } from "../../config"
import { useLocation } from "../../context/location"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { useTerminalDimensions } from "@opentui/solid"
import { Locale } from "../../util/locale"
import type { PromptInfo, PromptPartRef } from "../../prompt/history"
import type { PromptSkill } from "../../prompt/skill"
import { useFrecency } from "../../prompt/frecency"
import { Keymap } from "../../context/keymap"
import { autocompleteTriggerIndex, displayCharAt, mentionTriggerIndex, skillTriggerIndex } from "../../prompt/display"
import {
  MENTION_DIRECTORY_LIMIT,
  MENTION_RESULT_LIMIT,
  clampAutocompleteIndex,
  expandDirectoryQuery,
  mergeAutocompleteOptions,
  mergeFileSearchEntries,
  resourceTriggerIndex,
} from "../../prompt/autocomplete"
import type { FileSystemEntry } from "@ycoding-ai/client"
import { stringWidth } from "../../util/string-width"
import { parseFileLineRange, stripFileLineRange } from "../../prompt/parse"
import type { ComponentTheme } from "../../theme/v2/component"

export type AutocompleteRef = {
  onInput: (value: string) => void
  visible: false | "@" | "/" | "$" | "#"
}

export type AutocompleteOption = {
  display: string
  value?: string
  aliases?: string[]
  disabled?: boolean
  description?: string
  marker?: string
  matches?: readonly number[]
  resourceDisplay?: string
  resourceValue?: string
  isDirectory?: boolean
  onSelect?: () => void
  path?: string
}

const COMMAND_DESCRIPTION_COLUMN = `${(244 / 992) * 100}%`
const COMMAND_DESCRIPTION_OFFSET = 244 / 992
const COMMAND_TEXT_LEFT_INSET = 3
const COMMAND_TEXT_RIGHT_INSET = 2
const COMMAND_COMPOSER_GAP = 1

export function autocompleteSelectionColors(theme: Pick<ComponentTheme, "background" | "text">) {
  return {
    fill: theme.background.action.primary.focused,
    foreground: theme.text.action.primary.focused,
  }
}

export function Autocomplete(props: {
  value: string
  sessionID?: string
  setPrompt: (input: (prompt: PromptInfo) => void) => void
  setExtmark: (part: PromptPartRef, extmarkId: number) => void
  anchor: () => BoxRenderable
  input: () => TextareaRenderable
  ref: (ref: AutocompleteRef) => void
  fileStyleId: number
  agentStyleId: number
  skillStyleId: number
  promptPartTypeId: () => number
}) {
  const editor = useEditorContext()
  const client = useClient()
  const data = useData()
  const keymap = Keymap.use()
  const keymapCommands = Keymap.useCommands()
  const { theme, themeV2 } = useTheme()
  const selection = autocompleteSelectionColors(themeV2)
  const dimensions = useTerminalDimensions()
  const frecency = useFrecency()
  const config = useConfig().data
  const paths = useTuiPaths()
  const location = useLocation()
  const [store, setStore] = createStore({
    index: 0,
    selected: 0,
    visible: false as AutocompleteRef["visible"],
    input: "keyboard" as "keyboard" | "mouse",
  })
  const chromeHeight = createMemo(() => (store.visible === "/" ? 4 : 0))
  const commandMenu = createMemo(() => store.visible === "/")
  const textLeftInset = createMemo(() => (commandMenu() ? COMMAND_TEXT_LEFT_INSET : 1))
  const textRightInset = createMemo(() => (commandMenu() ? COMMAND_TEXT_RIGHT_INSET : 1))
  const composerGap = createMemo(() => (commandMenu() ? COMMAND_COMPOSER_GAP : 0))

  const [positionTick, setPositionTick] = createSignal(0)

  createEffect(() => {
    if (!store.visible) return
    const popMode = keymap.mode.push("autocomplete")
    onCleanup(popMode)
  })

  createEffect(() => {
    if (store.visible) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        const anchor = props.anchor()
        if (anchor.x !== lastPos.x || anchor.y !== lastPos.y || anchor.width !== lastPos.width) {
          lastPos = { x: anchor.x, y: anchor.y, width: anchor.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)

      onCleanup(() => clearInterval(interval))
    }
  })

  const position = createMemo(() => {
    if (!store.visible) return { x: 0, y: 0, width: 0 }
    dimensions()
    positionTick()
    const anchor = props.anchor()
    const parent = anchor.parent
    const parentX = parent?.x ?? 0
    const parentY = parent?.y ?? 0

    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: anchor.width,
    }
  })
  const popupWidth = createMemo(() => position().width)

  const filter = createMemo(() => {
    if (!store.visible) return
    // Track props.value to make memo reactive to text changes
    props.value // <- there surely is a better way to do this, like making .input() reactive

    return props.input().getTextRange(store.index + 1, props.input().cursorOffset)
  })

  // filter() reads reactive props.value plus non-reactive cursor/text state.
  // On keypress those can be briefly out of sync, so filter() may return an empty/partial string.
  // Copy it into search in an effect because effects run after reactive updates have been rendered and painted
  // so the input has settled and all consumers read the same stable value.
  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard so
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filter()
    setStore("input", "keyboard")
  })

  function insertPart(
    text: string,
    part:
      | { type: "file"; value: NonNullable<PromptInfo["files"]>[number]; path?: string }
      | { type: "agent"; value: NonNullable<PromptInfo["agents"]>[number] }
      | { type: "skill"; value: PromptSkill },
  ) {
    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    // props.value lags the textarea because onContentChange is async, so the char that
    // decides the trailing space has to come from the live buffer.
    const charAfterCursor = displayCharAt(input.plainText, currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const prefix = part.type === "skill" ? "$" : "@"
    const append = prefix + text + (needsSpace ? " " : "")

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText(append)

    const virtualText = prefix + text
    const extmarkStart = store.index
    const extmarkEnd = extmarkStart + stringWidth(virtualText)

    const styleId = part.type === "file" ? props.fileStyleId : part.type === "agent" ? props.agentStyleId : props.skillStyleId

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId,
      typeId: props.promptPartTypeId(),
    })

    props.setPrompt((draft) => {
      if (part.type === "file") {
        const files = (draft.files ??= [])
        const existingIndex = files.findIndex((file) => file.uri === part.value.uri)
        if (existingIndex !== -1) {
          const existing = files[existingIndex]
          if (existing?.mention) {
            existing.mention.start = extmarkStart
            existing.mention.end = extmarkEnd
            existing.mention.text = virtualText
          }
          return
        }
        if (part.value.mention) {
          part.value.mention.start = extmarkStart
          part.value.mention.end = extmarkEnd
          part.value.mention.text = virtualText
        }
        const index = files.length
        files.push(part.value)
        props.setExtmark({ type: "file", index }, extmarkId)
        return
      }

      if (part.type === "skill") {
        const skills = (draft.skills ??= [])
        if (part.value.mention) {
          part.value.mention.start = extmarkStart
          part.value.mention.end = extmarkEnd
          part.value.mention.text = virtualText
        }
        const index = skills.length
        skills.push(part.value)
        props.setExtmark({ type: "skill", index }, extmarkId)
        return
      }

      const agents = (draft.agents ??= [])
      if (part.value.mention) {
        part.value.mention.start = extmarkStart
        part.value.mention.end = extmarkEnd
        part.value.mention.text = virtualText
      }
      const index = agents.length
      agents.push(part.value)
      props.setExtmark({ type: "agent", index }, extmarkId)
    })

    if (part.type === "file" && part.path) frecency.updateFrecency(part.path)
  }

  function createFilePart(
    item: FileSystemEntry,
    filePath: string,
    lineRange?: { startLine: number; endLine?: number },
  ) {
    const urlObj = pathToFileURL(filePath)
    const filename =
      lineRange && item.type !== "directory"
        ? `${item.path}#${lineRange.startLine}${lineRange.endLine ? `-${lineRange.endLine}` : ""}`
        : item.path

    if (lineRange && item.type !== "directory") {
      urlObj.searchParams.set("start", String(lineRange.startLine))
      if (lineRange.endLine !== undefined) {
        urlObj.searchParams.set("end", String(lineRange.endLine))
      }
    }

    return {
      filename,
      part: {
        type: "file" as const,
        path: item.path,
        value: {
          uri: urlObj.href,
          name: filename,
          mention: { start: 0, end: 0, text: "" },
        },
      },
    }
  }

  const references = createMemo(() => data.location.reference.list(location.current) ?? [])

  const referenceMatch = createMemo(() => {
    if (!store.visible || store.visible === "/") return
    const base = parseFileLineRange(search()).base
    const slash = base.indexOf("/")
    const alias = slash === -1 ? base : base.slice(0, slash)
    return references().find((item) => !item.hidden && item.name === alias)
  })

  function normalizeMentionPath(filePath: string) {
    const baseDir = location.current?.directory || data.location.info()?.directory || paths.cwd
    const absolute = path.resolve(filePath)
    const relative = path.relative(baseDir, absolute)

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/")
    }

    return absolute.split(path.sep).join("/")
  }

  function insertFileMention(input: { filePath: string; lineStart: number; lineEnd: number }) {
    const item = normalizeMentionPath(input.filePath)
    const lineRange = {
      startLine: input.lineStart,
      endLine: input.lineEnd > input.lineStart ? input.lineEnd : undefined,
    }
    const { filename, part } = createFilePart({ path: item, type: "file" }, input.filePath, lineRange)
    const index = store.visible === "@" ? store.index : props.input().cursorOffset

    setStore("visible", false)
    setStore("index", index)
    insertPart(filename, part)
  }

  const [files] = createResource(
    () => ({ query: search(), location: location.current, visible: store.visible }),
    async (input) => {
      if (input.visible !== "@") return { options: [], failed: false }
      if (referenceMatch()) return { options: [], failed: false }
      const { lineRange, base } = parseFileLineRange(input.query ?? "")

      const query = {
        query: base,
        location: {
          directory: input.location?.directory,
          workspace: input.location?.workspaceID ?? data.location.default().workspaceID,
        },
      }
      const find = (type: "file" | "directory", limit: number) =>
        client.api.file.find({ ...query, type, limit }).then(
          (result) => result,
          () => undefined,
        )

      // Folders are searched separately: the mixed search spends every slot on file hits,
      // so directories that exist never made it into the menu.
      const [directories, matches] = await Promise.all([
        find("directory", MENTION_DIRECTORY_LIMIT),
        find("file", MENTION_RESULT_LIMIT),
      ])

      const result = matches ?? directories
      if (!result) return { options: [], failed: true }

      // Trust the order returned by fff within each group (frecency, fuzzy score,
      // filename bonus, etc. are already factored in); only folders are hoisted.
      const width = props.anchor().width - 4
      const options = mergeFileSearchEntries(directories?.data ?? [], matches?.data ?? []).map(
        (item): AutocompleteOption => {
          const { filename, part } = createFilePart(item, path.join(result.location.directory, item.path), lineRange)
          return {
            display: Locale.truncateMiddle(filename, width),
            value: filename,
            isDirectory: item.type === "directory",
            path: item.path,
            onSelect: () => {
              insertPart(filename, part)
            },
          }
        },
      )

      return { options, failed: false }
    },
    {
      initialValue: { options: [], failed: false },
    },
  )

  const mcpResources = createMemo(() => {
    if (store.visible !== "@") return []

    const options: AutocompleteOption[] = []
    const width = props.anchor().width - 4

    for (const res of data.location.mcp.resource.list(location.current) ?? []) {
      options.push({
        display: Locale.truncateMiddle(res.name, width),
        // Match the name only; matching the URI caused unrelated fuzzy hits.
        value: res.name,
        description: res.description,
        onSelect: () => {
          insertPart(res.name, {
            type: "file",
            value: {
              uri: res.uri,
              name: res.name,
              description: res.description,
              mention: { start: 0, end: 0, text: "" },
            },
          })
        },
      })
    }

    return options
  })

  const agents = createMemo(() => {
    return (data.location.agent.list(location.current) ?? [])
      .filter((agent) => !agent.hidden && agent.mode !== "primary" && agent.id !== "btw")
      .map(
        (agent): AutocompleteOption => ({
          display: "@" + agent.id,
          resourceDisplay: agent.name,
          resourceValue: agent.name,
          onSelect: () => {
            insertPart(agent.id, {
              type: "agent",
              value: {
                name: agent.id,
                mention: { start: 0, end: 0, text: "" },
              },
            })
          },
        }),
      )
  })

  // Ecosystem skill roots such as ~/.claude/skills carry no filesystem watcher, so the
  // server never announces skills deleted there. Refetch whenever the menu opens
  // instead of trusting the cached list.
  createEffect(() => {
    if (store.visible !== "$" && store.visible !== "#") return
    const target = location.current
    data.location.skill.invalidate(target)
    void data.location.skill.sync(target).catch(() => undefined)
  })

  const skills = createMemo(() =>
    (data.location.skill.list(location.current) ?? []).map(
      (skill): AutocompleteOption => ({
        display: "$" + skill.id,
        value: `${skill.id} ${skill.name} ${skill.description ?? ""}`,
        description: skill.description ?? skill.name,
        marker: skill.conflicts && (skill.conflicts.skills.length > 0 || skill.conflicts.instructions.length > 0) ? "conflict" : undefined,
        resourceDisplay: skill.name,
        resourceValue: skill.name,
        onSelect: () => {
          insertPart(skill.id, {
            type: "skill",
            value: {
              id: skill.id,
              name: skill.name,
              mention: { start: 0, end: 0, text: "" },
            },
          })
        },
      }),
    ),
  )

  const referenceAliases = createMemo(() =>
    references()
      .filter((reference) => !reference.hidden)
      .map(
        (reference): AutocompleteOption => ({
          display: "@" + reference.name,
          description: ` ${reference.source.type === "git" ? reference.source.repository : reference.source.path}`,
          onSelect: () => {
            insertPart(reference.name, {
              type: "file",
              path: reference.name,
              value: {
                uri: pathToFileURL(reference.path).href,
                name: reference.name,
                mention: { start: 0, end: 0, text: "" },
              },
            })
          },
        }),
      ),
  )

  function insertSlash(name: string) {
    const newText = `/${name} `
    const cursor = props.input().logicalCursor
    props.input().deleteRange(0, 0, cursor.row, cursor.col)
    props.input().insertText(newText)
    props.input().cursorOffset = stringWidth(newText)
  }

  const commands = createMemo((): AutocompleteOption[] => {
    const results: AutocompleteOption[] = keymapCommands().flatMap((command) => {
      const slash = command.slash
      if (!slash) return []
      return {
        display: `/${slash.name}`,
        description: command.description ?? command.title,
        aliases: slash.aliases?.map((alias) => `/${alias}`),
        onSelect: slash.arguments ? () => insertSlash(slash.name) : command.run,
      }
    })
    const commandNames = new Set<string>()

    for (const serverCommand of data.location.command.list(location.current) ?? []) {
      commandNames.add(serverCommand.name)
      results.push({
        display: "/" + serverCommand.name,
        description: serverCommand.description,
        onSelect: () => insertSlash(serverCommand.name),
      })
    }

    for (const skill of data.location.skill
      .list(location.current)
      ?.filter((skill) => skill.slash === true && !commandNames.has(skill.id)) ?? []) {
      results.push({
        display: "/" + skill.id,
        description: skill.description,
        onSelect: () => insertSlash(skill.id),
      })
    }

    results.sort((a, b) => a.display.localeCompare(b.display))

    const max = firstBy(results, [(x) => x.display.length, "desc"])?.display.length
    if (!max) return results
    return results.map((item) => ({
      ...item,
      display: item.display.padEnd(max + 2),
    }))
  })

  const options = createMemo(() => {
    const fileSearch = files()
    const referenceMatchValue = referenceMatch()
    const agentsValue = agents()
    const referenceAliasesValue = referenceAliases()
    const commandsValue = commands()
    const skillsValue = skills()
    const searchValue = search()

    if (store.visible === "@" && referenceMatchValue) {
      return referenceAliasesValue.filter((item) => item.display === `@${referenceMatchValue.name}`)
    }

    // Files come from fff already fuzzy ranked, filtered and grouped folders-first,
    // so they must not be re-sorted by fuzzysort as it would lose the results.
    // The previous results stay on screen while the next query is in flight; blanking
    // them on every keystroke made the menu look empty for files that do exist.
    const fileOptions: AutocompleteOption[] = store.visible === "@" ? fileSearch.options : []
    const nonFileOptions: AutocompleteOption[] =
      store.visible === "@"
        ? [...referenceAliasesValue, ...agentsValue, ...mcpResources()]
        : store.visible === "$"
          ? skillsValue
          : store.visible === "#"
            ? [...skillsValue, ...agentsValue].map((item) => ({
                ...item,
                display: item.resourceDisplay ?? item.display,
                value: item.resourceValue ?? item.value,
                description: undefined,
              }))
            : [...commandsValue]

    if (!searchValue) {
      const merged = mergeAutocompleteOptions(nonFileOptions, fileOptions)
      return store.visible === "#" ? merged.slice(0, 8) : merged
    }

    const fuzziedNonFiles = fuzzysort
      .go(stripFileLineRange(searchValue), nonFileOptions, {
        keys: [
          (obj) => stripFileLineRange((obj.value ?? obj.display).trimEnd()),
          // Matching descriptions for references surfaced unrelated items.
          ...(store.visible !== "@" ? ["description" as const] : []),
          (obj) => obj.aliases?.join(" ") ?? "",
        ],
        threshold: store.visible === "@" ? 0.5 : 0,
        limit: store.visible === "#" ? 8 : 10,
        scoreFn: (objResults) => {
          const displayResult = objResults[0]
          let score = objResults.score
          if (displayResult && displayResult.target.startsWith(store.visible + searchValue)) {
            score *= 2
          }
          const frecencyScore = objResults.obj.path ? frecency.getFrecency(objResults.obj.path) : 0
          return score * (1 + frecencyScore)
        },
      })
      .map((arr) => ({ ...arr.obj, matches: store.visible === "#" ? arr[0]?.indexes : undefined }))

    return mergeAutocompleteOptions(fuzziedNonFiles, fileOptions)
  })

  createEffect(() => {
    filter()
    setStore("selected", 0)
  })

  createEffect(() => {
    const next = clampAutocompleteIndex(store.selected, options().length)
    if (next !== store.selected) setStore("selected", next)
  })

  function move(direction: -1 | 1) {
    if (!store.visible) return
    if (!options().length) return
    let next = store.selected + direction
    if (next < 0) next = options().length - 1
    if (next >= options().length) next = 0
    moveTo(next)
  }

  function moveTo(next: number) {
    setStore("selected", next)
    if (!scroll) return
    const scrollBottom = scroll.scrollTop + height()
    if (next < scroll.scrollTop) {
      scroll.scrollBy(next - scroll.scrollTop)
    } else if (next + 1 > scrollBottom) {
      scroll.scrollBy(next + 1 - scrollBottom)
    }
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected) return
    hide()
    selected.onSelect?.()
  }

  function expandDirectory() {
    const selected = options()[store.selected]
    if (!selected) return

    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const query = expandDirectoryQuery(selected.value ?? selected.display)

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText("@" + query)

    setStore("selected", 0)
  }

  Keymap.createLayer(() => ({
    mode: "autocomplete",
    target: props.input,
    enabled: () => Boolean(store.visible),
    commands: [
      {
        id: "prompt.autocomplete.prev",
        title: "Previous autocomplete item",
        group: "Autocomplete",
        run() {
          setStore("input", "keyboard")
          move(-1)
        },
      },
      {
        id: "prompt.autocomplete.next",
        title: "Next autocomplete item",
        group: "Autocomplete",
        run() {
          setStore("input", "keyboard")
          move(1)
        },
      },
      {
        id: "prompt.autocomplete.hide",
        title: "Hide autocomplete",
        group: "Autocomplete",
        run() {
          hide()
        },
      },
      {
        id: "prompt.autocomplete.select",
        title: "Select autocomplete item",
        group: "Autocomplete",
        run() {
          select()
        },
      },
      {
        id: "prompt.autocomplete.complete",
        title: "Complete autocomplete item",
        group: "Autocomplete",
        run() {
          const selected = options()[store.selected]
          if (selected?.isDirectory) {
            expandDirectory()
            return
          }

          select()
        },
      },
    ],
  }))

  function show(mode: "@" | "/" | "$" | "#") {
    setStore({
      visible: mode,
      index: props.input().cursorOffset,
    })
  }

  function hide() {
    const text = props.input().plainText
    if (store.visible === "/" && !text.endsWith(" ") && text.startsWith("/")) {
      const cursor = props.input().logicalCursor
      props.input().deleteRange(0, 0, cursor.row, cursor.col)
      // Sync the prompt store immediately since onContentChange is async
      props.setPrompt((draft) => {
        draft.text = props.input().plainText
      })
    }
    setStore("visible", false)
  }

  onMount(() => {
    const unsubscribeMention = editor.onMention((mention) => {
      insertFileMention(mention)
    })

    onCleanup(() => {
      unsubscribeMention()
    })

    props.ref({
      get visible() {
        return store.visible
      },
      onInput(value) {
        if (store.visible) {
          const outsideToken =
            store.visible !== "/" &&
            (store.visible === "#"
              ? resourceTriggerIndex(value, props.input().cursorOffset)
              : autocompleteTriggerIndex(value, props.input().cursorOffset, store.visible)) !== store.index
          if (
            // Typed text before the trigger
            props.input().cursorOffset <= store.index ||
            // There is a space between the trigger and the cursor
            props.input().getTextRange(store.index, props.input().cursorOffset).match(/\s/) ||
            // "/<command>" is not the sole content
            (store.visible === "/" && value.match(/^\S+\s+\S+\s*$/)) ||
            outsideToken
          ) {
            hide()
          }
          return
        }

        // Check if autocomplete should reopen (e.g., after backspace deleted a space)
        const offset = props.input().cursorOffset
        if (offset === 0) return

        // Check for "/" at position 0 - reopen slash commands
        if (value.startsWith("/") && !value.slice(0, offset).match(/\s/)) {
          show("/")
          setStore("index", 0)
          return
        }

        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const idx = mentionTriggerIndex(value, offset)
        if (idx !== undefined) {
          show("@")
          setStore("index", idx)
          return
        }

        const skill = skillTriggerIndex(value, offset)
        if (skill !== undefined) {
          show("$")
          setStore("index", skill)
          return
        }

        const resource = resourceTriggerIndex(value, offset)
        if (resource !== undefined) {
          show("#")
          setStore("index", resource)
        }
      },
    })
  })

  const height = createMemo(() => {
    const count = options().length || 1
    if (!store.visible) return Math.min(10, count)
    positionTick()
    const availableRows = props.anchor().y - chromeHeight() - composerGap()
    return Math.min(10, count, Math.max(1, availableRows))
  })
  const commandDescriptionWidth = createMemo(() => {
    if (!commandMenu()) return COMMAND_DESCRIPTION_COLUMN
    const contentWidth = popupWidth() - 2
    const commandStart = 1 + textLeftInset()
    return Math.max(1, Math.round(contentWidth * COMMAND_DESCRIPTION_OFFSET) - commandStart - 1)
  })

  let scroll: ScrollBoxRenderable
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const emptyMessage = createMemo(() => {
    if (store.visible === "/") return "No matching commands"
    if (store.visible === "$") return "No matching skills"
    if (store.visible === "#") return "No matching skills or agents"
    if (files.loading) return "Searching…"
    if (files().failed) return "Could not search files. Keep typing to try again."
    return "No matching files, agents, or references"
  })
  const emptyError = createMemo(() => store.visible === "@" && !files.loading && files().failed)

  return (
    <box
      visible={store.visible !== false}
      position="absolute"
      top={position().y - height() - chromeHeight() - composerGap()}
      left={position().x}
      width={popupWidth()}
      zIndex={100}
      {...SplitBorder}
      backgroundColor={store.visible === "/" ? themeV2.background.surface.offset : undefined}
      borderColor={store.visible === "/" ? themeV2.border.default : theme.border}
      flexDirection="column"
    >
      <Show when={store.visible === "/"}>
        <>
          <box
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={textLeftInset()}
            paddingRight={textRightInset()}
            height={1}
          >
            <text fg={themeV2.text.label}>/ COMMANDS</text>
            <text fg={themeV2.text.label} flexShrink={0}>{`${options().length} of ${commands().length}`}</text>
          </box>
          <text fg={themeV2.border.default}>{"─".repeat(Math.max(1, popupWidth() - 2))}</text>
        </>
      </Show>
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        backgroundColor={store.visible === "/" ? themeV2.background.surface.offset : theme.backgroundMenu}
        height={height()}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={scrollAcceleration()}
      >
        <For
          each={options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={emptyError() ? theme.error : theme.textMuted}>{emptyMessage()}</text>
            </box>
          }
        >
          {(option, index) => (
            <box
              backgroundColor={
                store.visible === "/" ? themeV2.background.surface.offset : theme.backgroundMenu
              }
              height={1}
              flexDirection="column"
              onMouseMove={() => {
                setStore("input", "mouse")
                moveTo(index())
              }}
              onMouseOver={() => {
                setStore("input", "mouse")
                moveTo(index())
              }}
              onMouseDown={() => {
                setStore("input", "mouse")
                moveTo(index())
              }}
              onMouseUp={() => select()}
            >
              <box
                height={1}
                paddingLeft={textLeftInset()}
                paddingRight={textRightInset()}
                backgroundColor={
                  index() === store.selected
                    ? selection.fill
                    : store.visible === "/"
                      ? themeV2.background.surface.offset
                      : theme.backgroundMenu
                }
                flexDirection="row"
              >
                <box width={store.visible === "/" ? commandDescriptionWidth() : undefined} flexShrink={0} overflow="hidden">
                  <text fg={index() === store.selected ? selection.foreground : themeV2.text.default} flexShrink={0}>
                    <AutocompleteOptionText
                      text={option.display}
                      matches={
                        store.visible === "/" && option.display.toLowerCase().startsWith(`/${search().toLowerCase()}`)
                          ? Array.from({ length: search().length + 1 }, (_, match) => match)
                          : option.matches
                      }
                      selected={index() === store.selected}
                      foreground={index() === store.selected ? selection.foreground : themeV2.text.default}
                      background={
                        index() === store.selected
                          ? selection.fill
                          : store.visible === "/"
                            ? themeV2.background.surface.offset
                            : theme.backgroundMenu
                      }
                      accent={themeV2.text.feedback.success.default}
                    />
                  </text>
                </box>
                <Show when={option.marker}>
                  <text fg={index() === store.selected ? selection.foreground : themeV2.text.feedback.warning.default} flexShrink={0}>
                    {" · " + option.marker}
                  </text>
                </Show>
                <Show when={option.description}>
                  <text
                    fg={index() === store.selected ? selection.foreground : themeV2.text.subdued}
                    wrapMode="none"
                  >
                    <span
                      style={{
                        fg: index() === store.selected ? selection.foreground : themeV2.text.subdued,
                        bg:
                          index() === store.selected
                            ? selection.fill
                            : store.visible === "/"
                              ? themeV2.background.surface.offset
                              : theme.backgroundMenu,
                      }}
                    >
                      {" " + option.description?.trimStart()}
                    </span>
                  </text>
                </Show>
              </box>
            </box>
          )}
        </For>
      </scrollbox>
      <Show when={store.visible === "/"}>
        <>
          <text fg={themeV2.border.default}>{"─".repeat(Math.max(1, popupWidth() - 2))}</text>
          <box paddingLeft={textLeftInset()} paddingRight={textRightInset()} height={1}>
            <text fg={themeV2.text.subdued}>↑↓ move    Enter accept    Tab complete    Esc close</text>
          </box>
        </>
      </Show>
    </box>
  )
}

function AutocompleteOptionText(props: {
  text: string
  matches?: readonly number[]
  selected: boolean
  foreground: RGBA
  background?: RGBA
  accent: RGBA
}) {
  const matches = new Set(props.matches)
  const runs = Array.from(props.text).reduce<Array<{ text: string; matched: boolean }>>((result, character, index) => {
    const matched = matches.has(index)
    const previous = result.at(-1)
    if (previous?.matched === matched) {
      previous.text += character
      return result
    }
    result.push({ text: character, matched })
    return result
  }, [])
  return (
    <>
      {runs.map((run) => (
        <span style={{ fg: props.selected || !run.matched ? props.foreground : props.accent, bg: props.background, bold: run.matched }}>
          {run.text}
        </span>
      ))}
    </>
  )
}
