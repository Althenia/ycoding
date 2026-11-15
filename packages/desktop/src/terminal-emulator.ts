export type TerminalColor = number | string
export type TerminalStyle = { readonly fg?: TerminalColor; readonly bg?: TerminalColor; readonly bold?: true; readonly dim?: true; readonly italic?: true; readonly underline?: true; readonly inverse?: true; readonly strike?: true }
export type TerminalCell = { readonly ch: string; readonly width: 0 | 1 | 2; readonly style: TerminalStyle }
export type TerminalPoint = { readonly line: number; readonly col: number }
export type TerminalRun = { readonly text: string; readonly style: TerminalStyle; readonly selected: boolean }
export type TerminalRow = { readonly line: number; readonly runs: readonly TerminalRun[] }
export type TerminalModes = { readonly applicationCursor: boolean; readonly bracketedPaste: boolean; readonly alternateScreen: boolean }
export type TerminalKey = { readonly key: string; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly metaKey: boolean }

type Line = { cells: TerminalCell[]; wrapped: boolean }
type Saved = { readonly x: number; readonly y: number; readonly style: TerminalStyle; readonly graphics: readonly [boolean, boolean]; readonly shift: 0 | 1 }
type Screen = { lines: Line[]; scrollback: Line[]; x: number; y: number; wrapPending: boolean; saved?: Saved }
type Mark = { readonly line: Line; readonly col: number }
type Parser =
  | { readonly state: "ground" }
  | { readonly state: "escape"; readonly intermediate: string }
  | { readonly state: "csi"; readonly body: string }
  | { readonly state: "string"; readonly osc: boolean; readonly body: string; readonly escaped: boolean }

const plain: TerminalStyle = Object.freeze({})
const styles = new Map<string, TerminalStyle>([["{}", plain]])
const blank = (style: TerminalStyle = plain): TerminalCell => ({ ch: " ", width: 1, style })
const decGraphics: Readonly<Record<string, string>> = { "`": "◆", a: "▒", f: "°", g: "±", j: "┘", k: "┐", l: "┌", m: "└", n: "┼", o: "⎺", p: "⎻", q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬", x: "│", y: "≤", z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·" }
const zeroWidth = [[0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef]] as const
const wide = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd]] as const
const within = (ranges: readonly (readonly [number, number])[], code: number) => ranges.some(([start, end]) => code >= start && code <= end)

export function charWidth(code: number): 0 | 1 | 2 {
  if (within(zeroWidth, code)) return 0
  return within(wide, code) ? 2 : 1
}

function intern(style: { -readonly [K in keyof TerminalStyle]: TerminalStyle[K] }): TerminalStyle {
  const value = Object.fromEntries(Object.entries(style).filter(([, item]) => item !== undefined))
  const key = JSON.stringify(value)
  const known = styles.get(key)
  if (known) return known
  const created = Object.freeze(value) as TerminalStyle
  if (styles.size < 4096) styles.set(key, created)
  return created
}

function numbers(body: string) {
  return body.split(";").map((group) => group.split(":").map((item) => item === "" ? undefined : Number(item)))
}

function extended(groups: (number | undefined)[][], index: number): { readonly color?: TerminalColor; readonly used: number } {
  const group = groups[index]!
  const hex = (r = 0, g = 0, b = 0) => `#${[r, g, b].map((item) => Math.max(0, Math.min(255, item)).toString(16).padStart(2, "0")).join("")}`
  if (group.length > 1) {
    if (group[1] === 5) return { color: group[2] ?? 0, used: 1 }
    if (group[1] === 2) return { color: group.length >= 6 ? hex(group[3], group[4], group[5]) : hex(group[2], group[3], group[4]), used: 1 }
    return { used: 1 }
  }
  const mode = groups[index + 1]?.[0]
  if (mode === 5) return { color: groups[index + 2]?.[0] ?? 0, used: 3 }
  if (mode === 2) return { color: hex(groups[index + 2]?.[0], groups[index + 3]?.[0], groups[index + 4]?.[0]), used: 5 }
  return { used: 1 }
}

export class TerminalEmulator {
  private cols: number
  private rows: number
  private readonly limit: number
  private readonly respond?: (data: string) => void
  private main: Screen
  private alternate: Screen
  private active: Screen
  private style: TerminalStyle = plain
  private parser: Parser = { state: "ground" }
  private decoder = new TextDecoder("utf-8")
  private top = 0
  private bottom: number
  private tabs: boolean[] = []
  private graphics: [boolean, boolean] = [false, false]
  private shift: 0 | 1 = 0
  private flags = { applicationCursor: false, bracketedPaste: false, autowrap: true, cursorVisible: true }
  private name = ""
  private selection?: { readonly anchor: Mark; readonly focus: Mark }

  constructor(options: { readonly cols: number; readonly rows: number; readonly scrollback?: number; readonly onResponse?: (data: string) => void }) {
    this.cols = Math.max(1, options.cols)
    this.rows = Math.max(1, options.rows)
    this.limit = options.scrollback ?? 2000
    this.respond = options.onResponse
    this.main = this.screenBuffer()
    this.alternate = this.screenBuffer()
    this.active = this.main
    this.bottom = this.rows - 1
    this.resetTabs()
  }

  write(data: Uint8Array) {
    const text = this.decoder.decode(data, { stream: true })
    for (const char of text) this.consume(char)
  }

  screen() { return this.active.lines.map((line) => this.text(line.cells).replace(/ +$/, "")) }
  scrollback() { return this.active.scrollback.map((line) => this.text(line.cells).replace(/ +$/, "")) }
  cell(row: number, col: number): TerminalCell | undefined { return this.active.lines[row]?.cells[col] }
  cursor() { return { x: Math.min(this.active.x, this.cols - 1), y: this.active.y, visible: this.flags.cursorVisible } }
  modes(): TerminalModes { return { applicationCursor: this.flags.applicationCursor, bracketedPaste: this.flags.bracketedPaste, alternateScreen: this.active === this.alternate } }
  title() { return this.name }
  size() { return { cols: this.cols, rows: this.rows } }
  lineCount() { return this.active.scrollback.length + this.rows }

  select(anchor: TerminalPoint, focus: TerminalPoint) {
    const lines = this.lines()
    const mark = (point: TerminalPoint): Mark | undefined => {
      const line = lines[Math.max(0, Math.min(lines.length - 1, point.line))]
      return line ? { line, col: Math.max(0, Math.min(this.cols - 1, point.col)) } : undefined
    }
    const start = mark(anchor), end = mark(focus)
    this.selection = start && end ? { anchor: start, focus: end } : undefined
  }

  clearSelection() { this.selection = undefined }
  hasSelection() { return this.range() !== undefined }

  getSelectedText() {
    const range = this.range()
    if (!range) return ""
    const lines = this.lines()
    let text = ""
    for (let index = range.start.line; index <= range.end.line; index++) {
      const line = lines[index]!
      const last = index === range.end.line
      const from = index === range.start.line ? range.start.col : 0
      const to = last ? range.end.col : line.cells.length - 1
      const part = this.text(line.cells.slice(from, to + 1))
      if (line.wrapped && !last) text += part
      else text += part.replace(/ +$/, "") + (last ? "" : "\n")
    }
    return text
  }

  view(scroll = 0): TerminalRow[] {
    const lines = this.lines()
    const start = Math.max(0, lines.length - this.rows - Math.max(0, scroll))
    const range = this.range()
    return lines.slice(start, start + this.rows).map((line, offset) => {
      const index = start + offset
      const selected = (col: number) => !!range && (index > range.start.line || (index === range.start.line && col >= range.start.col)) && (index < range.end.line || (index === range.end.line && col <= range.end.col))
      const runs: TerminalRun[] = []
      for (let col = 0; col < this.cols; col++) {
        const cell = line.cells[col] ?? blank()
        if (cell.width === 0) continue
        const marked = selected(col)
        const previous = runs.at(-1)
        if (previous && previous.style === cell.style && previous.selected === marked) runs[runs.length - 1] = { ...previous, text: previous.text + cell.ch }
        else runs.push({ text: cell.ch, style: cell.style, selected: marked })
      }
      return { line: index, runs }
    })
  }

  resize(cols: number, rows: number) {
    cols = Math.max(1, cols)
    rows = Math.max(1, rows)
    for (const screen of [this.main, this.alternate]) {
      for (const line of screen.lines) this.fit(line, cols)
      while (screen.lines.length > rows && screen.y < screen.lines.length - 1 && this.empty(screen.lines.at(-1)!)) screen.lines.pop()
      while (screen.lines.length > rows) {
        const removed = screen.lines.shift()!
        if (screen === this.main) this.keep(screen, removed)
        screen.y = Math.max(0, screen.y - 1)
      }
      while (screen.lines.length < rows) screen.lines.push(this.line(cols))
      screen.x = Math.min(screen.x, cols - 1)
      screen.y = Math.min(screen.y, rows - 1)
      screen.wrapPending = false
    }
    this.cols = cols
    this.rows = rows
    this.top = 0
    this.bottom = rows - 1
    this.resetTabs()
  }

  private screenBuffer(): Screen {
    return { lines: Array.from({ length: this.rows }, () => this.line(this.cols)), scrollback: [], x: 0, y: 0, wrapPending: false }
  }

  private line(cols = this.cols, style = plain): Line {
    return { cells: Array.from({ length: cols }, () => blank(style)), wrapped: false }
  }

  private fit(line: Line, cols: number) {
    if (line.cells.length > cols) {
      line.cells.length = cols
      if (line.cells[cols - 1]?.width === 2) line.cells[cols - 1] = blank(line.cells[cols - 1]!.style)
      line.wrapped = false
    }
    while (line.cells.length < cols) line.cells.push(blank())
  }

  private empty(line: Line) { return line.cells.every((cell) => cell.ch === " " && cell.style === plain) }
  private text(cells: readonly TerminalCell[]) { return cells.filter((cell) => cell.width !== 0).map((cell) => cell.ch).join("") }
  private lines() { return [...this.active.scrollback, ...this.active.lines] }
  private eraseStyle() { return this.style.bg === undefined ? plain : intern({ bg: this.style.bg }) }

  private range() {
    const selection = this.selection
    if (!selection) return undefined
    const lines = this.lines()
    const anchor = lines.indexOf(selection.anchor.line), focus = lines.indexOf(selection.focus.line)
    if (focus < 0) return undefined
    const a = { line: Math.max(0, anchor), col: anchor < 0 ? 0 : selection.anchor.col }, b = { line: focus, col: selection.focus.col }
    return a.line < b.line || (a.line === b.line && a.col <= b.col) ? { start: a, end: b } : { start: b, end: a }
  }

  private keep(screen: Screen, line: Line) {
    screen.scrollback.push(line)
    if (screen.scrollback.length > this.limit) screen.scrollback.splice(0, screen.scrollback.length - this.limit)
  }

  private resetTabs() {
    this.tabs = Array.from({ length: this.cols }, (_, col) => col > 0 && col % 8 === 0)
  }

  private consume(char: string) {
    const code = char.codePointAt(0)!
    const parser = this.parser
    if (parser.state === "string") {
      if (parser.escaped) {
        this.parser = { state: "ground" }
        if (parser.osc) this.osc(parser.body)
        if (char === "\\") return
        this.consume("\x1b")
        this.consume(char)
        return
      }
      if (code === 0x1b) { this.parser = { ...parser, escaped: true }; return }
      if (code === 0x07 || code === 0x9c) { this.parser = { state: "ground" }; if (parser.osc) this.osc(parser.body); return }
      if (code === 0x18 || code === 0x1a) { this.parser = { state: "ground" }; return }
      if (parser.osc && parser.body.length < 4096) this.parser = { ...parser, body: parser.body + char }
      return
    }
    if (code === 0x18 || code === 0x1a) { this.parser = { state: "ground" }; return }
    if (code === 0x1b) { this.parser = { state: "escape", intermediate: "" }; return }
    if (code < 0x20 || code === 0x7f) { this.control(code); return }
    if (parser.state === "escape") return this.escape(parser.intermediate, char)
    if (parser.state === "csi") {
      if (code >= 0x40 && code <= 0x7e) { this.parser = { state: "ground" }; this.csi(parser.body, char); return }
      this.parser = parser.body.length < 256 ? { state: "csi", body: parser.body + char } : { state: "ground" }
      return
    }
    if (code >= 0x80 && code < 0xa0) return
    this.print(char, code)
  }

  private control(code: number) {
    const screen = this.active
    if (code === 0x08) { screen.wrapPending = false; screen.x = Math.max(0, Math.min(screen.x, this.cols - 1) - 1); return }
    if (code === 0x09) { this.tab(1); return }
    if (code >= 0x0a && code <= 0x0c) { this.index(); return }
    if (code === 0x0d) { screen.x = 0; screen.wrapPending = false; return }
    if (code === 0x0e) { this.shift = 1; return }
    if (code === 0x0f) this.shift = 0
  }

  private escape(intermediate: string, char: string) {
    const code = char.charCodeAt(0)
    if (code >= 0x20 && code <= 0x2f) { this.parser = { state: "escape", intermediate: intermediate + char }; return }
    this.parser = { state: "ground" }
    if (intermediate === "(" || intermediate === ")") { this.graphics[intermediate === "(" ? 0 : 1] = char === "0"; return }
    if (intermediate) return
    if (char === "[") { this.parser = { state: "csi", body: "" }; return }
    if (char === "]") { this.parser = { state: "string", osc: true, body: "", escaped: false }; return }
    if (char === "P" || char === "X" || char === "^" || char === "_") { this.parser = { state: "string", osc: false, body: "", escaped: false }; return }
    if (char === "7") return this.save()
    if (char === "8") return this.restore()
    if (char === "D") return this.index()
    if (char === "E") { this.active.x = 0; this.index(); return }
    if (char === "M") return this.reverseIndex()
    if (char === "H") { this.tabs[Math.min(this.active.x, this.cols - 1)] = true; return }
    if (char === "c") this.reset()
  }

  private osc(body: string) {
    const split = body.indexOf(";")
    const command = split < 0 ? body : body.slice(0, split)
    if (command === "0" || command === "2") this.name = Array.from(body.slice(split + 1)).filter((char) => char >= " ").join("").slice(0, 256)
  }

  private print(char: string, code: number) {
    const screen = this.active
    const width = charWidth(code)
    if (width === 0) {
      const line = screen.lines[screen.y]!
      let col = screen.wrapPending ? screen.x : screen.x - 1
      if (line.cells[col]?.width === 0) col--
      const target = line.cells[col]
      if (target) line.cells[col] = { ...target, ch: target.ch + char }
      return
    }
    const translated = this.graphics[this.shift] ? decGraphics[char] ?? char : char
    if (screen.wrapPending && this.flags.autowrap) this.wrap()
    if (width === 2 && screen.x >= this.cols - 1) {
      if (this.cols < 2) return
      if (this.flags.autowrap) this.wrap()
      else screen.x = this.cols - 2
    }
    const line = screen.lines[screen.y]!
    this.clearWide(line, screen.x)
    if (width === 2) this.clearWide(line, screen.x + 1)
    line.cells[screen.x] = { ch: translated, width, style: this.style }
    if (width === 2) line.cells[screen.x + 1] = { ch: "", width: 0, style: this.style }
    screen.x += width
    if (screen.x >= this.cols) { screen.x = this.cols - 1; screen.wrapPending = this.flags.autowrap }
  }

  private wrap() {
    const screen = this.active
    screen.lines[screen.y]!.wrapped = true
    screen.x = 0
    screen.wrapPending = false
    this.index()
  }

  private clearWide(line: Line, col: number) {
    const cell = line.cells[col]
    if (cell?.width === 0 && line.cells[col - 1]?.width === 2) line.cells[col - 1] = blank(line.cells[col - 1]!.style)
    if (cell?.width === 2 && line.cells[col + 1]?.width === 0) line.cells[col + 1] = blank(cell.style)
  }

  private index() {
    const screen = this.active
    screen.wrapPending = false
    if (screen.y === this.bottom) this.scrollUp(1)
    else if (screen.y < this.rows - 1) screen.y++
  }

  private reverseIndex() {
    const screen = this.active
    screen.wrapPending = false
    if (screen.y === this.top) this.scrollDown(1)
    else if (screen.y > 0) screen.y--
  }

  private scrollUp(count: number) {
    const screen = this.active
    for (let index = 0; index < Math.min(count, this.bottom - this.top + 1); index++) {
      const [removed] = screen.lines.splice(this.top, 1)
      if (this.top === 0 && screen === this.main && removed) this.keep(screen, removed)
      screen.lines.splice(this.bottom, 0, this.line(this.cols, this.eraseStyle()))
    }
  }

  private scrollDown(count: number) {
    const screen = this.active
    for (let index = 0; index < Math.min(count, this.bottom - this.top + 1); index++) {
      screen.lines.splice(this.bottom, 1)
      screen.lines.splice(this.top, 0, this.line(this.cols, this.eraseStyle()))
    }
  }

  private tab(count: number) {
    const screen = this.active
    screen.wrapPending = false
    for (let step = 0; step < count; step++) {
      let col = screen.x + 1
      while (col < this.cols - 1 && !this.tabs[col]) col++
      screen.x = Math.min(col, this.cols - 1)
    }
  }

  private backTab(count: number) {
    const screen = this.active
    for (let step = 0; step < count; step++) {
      let col = screen.x - 1
      while (col > 0 && !this.tabs[col]) col--
      screen.x = Math.max(0, col)
    }
  }

  private save() {
    const screen = this.active
    screen.saved = { x: screen.x, y: screen.y, style: this.style, graphics: [...this.graphics], shift: this.shift }
  }

  private restore() {
    const screen = this.active
    const saved = screen.saved ?? { x: 0, y: 0, style: plain, graphics: [false, false] as const, shift: 0 as const }
    screen.x = Math.min(saved.x, this.cols - 1)
    screen.y = Math.min(saved.y, this.rows - 1)
    screen.wrapPending = false
    this.style = saved.style
    this.graphics = [...saved.graphics]
    this.shift = saved.shift
  }

  private erase(line: Line, from: number, to: number) {
    const style = this.eraseStyle()
    for (let col = Math.max(0, from); col <= Math.min(this.cols - 1, to); col++) line.cells[col] = blank(style)
    if (to >= this.cols - 1) line.wrapped = false
  }

  private move(x: number, y: number) {
    const screen = this.active
    screen.x = Math.max(0, Math.min(this.cols - 1, x))
    screen.y = Math.max(0, Math.min(this.rows - 1, y))
    screen.wrapPending = false
  }

  private switchScreen(alternate: boolean, save: boolean, clear: boolean) {
    if ((this.active === this.alternate) === alternate) return
    if (alternate) {
      if (save) this.save()
      this.active = this.alternate
      if (clear) this.alternate.lines = Array.from({ length: this.rows }, () => this.line())
      this.alternate.wrapPending = false
      this.alternate.x = this.main.x
      this.alternate.y = this.main.y
    } else {
      this.active = this.main
      if (save) this.restore()
    }
    this.selection = undefined
  }

  private reset() {
    this.main = this.screenBuffer()
    this.alternate = this.screenBuffer()
    this.active = this.main
    this.style = plain
    this.top = 0
    this.bottom = this.rows - 1
    this.graphics = [false, false]
    this.shift = 0
    this.flags = { applicationCursor: false, bracketedPaste: false, autowrap: true, cursorVisible: true }
    this.selection = undefined
    this.resetTabs()
  }

  private csi(body: string, final: string) {
    const prefix = /^[?>=<]/.test(body) ? body[0]! : ""
    const intermediates = body.match(/[ -/]+$/)?.[0] ?? ""
    const params = body.slice(prefix.length, body.length - intermediates.length)
    if (/[^0-9;:]/.test(params)) return
    const groups = numbers(params)
    const at = (index: number, fallback: number) => groups[index]?.[0] ?? fallback
    const n = Math.max(1, at(0, 1))
    const screen = this.active
    const line = screen.lines[screen.y]!
    if (intermediates) {
      if (intermediates === "!" && final === "p") { this.flags = { ...this.flags, applicationCursor: false, autowrap: true, cursorVisible: true }; this.style = plain; this.top = 0; this.bottom = this.rows - 1 }
      return
    }
    if (prefix === "?" && (final === "h" || final === "l")) return this.privateModes(groups.map((group) => group[0] ?? 0), final === "h")
    if (prefix === ">" && final === "c") { this.respond?.("\x1b[>0;0;0c"); return }
    if (prefix) return
    switch (final) {
      case "A": return this.move(screen.x, Math.max(screen.y >= this.top ? this.top : 0, screen.y - n))
      case "B": case "e": return this.move(screen.x, Math.min(screen.y <= this.bottom ? this.bottom : this.rows - 1, screen.y + n))
      case "C": case "a": return this.move(screen.x + n, screen.y)
      case "D": return this.move(Math.min(screen.x, this.cols - 1) - n, screen.y)
      case "E": return this.move(0, screen.y + n)
      case "F": return this.move(0, screen.y - n)
      case "G": case "`": return this.move(n - 1, screen.y)
      case "d": return this.move(screen.x, n - 1)
      case "H": case "f": return this.move(Math.max(1, at(1, 1)) - 1, Math.max(1, at(0, 1)) - 1)
      case "I": return this.tab(n)
      case "Z": return this.backTab(n)
      case "J": {
        const mode = at(0, 0)
        if (mode === 3) { screen.scrollback = []; this.selection = undefined; return }
        if (mode === 0) { this.erase(line, screen.x, this.cols - 1); for (let row = screen.y + 1; row < this.rows; row++) this.erase(screen.lines[row]!, 0, this.cols - 1) }
        if (mode === 1) { this.erase(line, 0, screen.x); for (let row = 0; row < screen.y; row++) this.erase(screen.lines[row]!, 0, this.cols - 1) }
        if (mode === 2) for (const row of screen.lines) this.erase(row, 0, this.cols - 1)
        screen.wrapPending = false
        return
      }
      case "K": {
        const mode = at(0, 0)
        if (mode === 0) this.erase(line, screen.x, this.cols - 1)
        if (mode === 1) this.erase(line, 0, screen.x)
        if (mode === 2) this.erase(line, 0, this.cols - 1)
        screen.wrapPending = false
        return
      }
      case "X": { this.erase(line, screen.x, screen.x + n - 1); screen.wrapPending = false; return }
      case "@": {
        const count = Math.min(n, this.cols - screen.x)
        line.cells.splice(screen.x, 0, ...Array.from({ length: count }, () => blank(this.eraseStyle())))
        line.cells.length = this.cols
        screen.wrapPending = false
        return
      }
      case "P": {
        const count = Math.min(n, this.cols - screen.x)
        line.cells.splice(screen.x, count)
        while (line.cells.length < this.cols) line.cells.push(blank(this.eraseStyle()))
        screen.wrapPending = false
        return
      }
      case "L": case "M": {
        if (screen.y < this.top || screen.y > this.bottom) return
        const count = Math.min(n, this.bottom - screen.y + 1)
        for (let index = 0; index < count; index++) {
          if (final === "L") { screen.lines.splice(this.bottom, 1); screen.lines.splice(screen.y, 0, this.line(this.cols, this.eraseStyle())) }
          else { screen.lines.splice(screen.y, 1); screen.lines.splice(this.bottom, 0, this.line(this.cols, this.eraseStyle())) }
        }
        screen.x = 0
        screen.wrapPending = false
        return
      }
      case "S": return this.scrollUp(n)
      case "T": return this.scrollDown(n)
      case "g": {
        const mode = at(0, 0)
        if (mode === 0) this.tabs[Math.min(screen.x, this.cols - 1)] = false
        if (mode === 3) this.tabs = this.tabs.map(() => false)
        return
      }
      case "r": {
        const top = Math.max(1, at(0, 1)) - 1, bottom = Math.min(this.rows, at(1, this.rows) || this.rows) - 1
        if (top >= bottom) return
        this.top = top
        this.bottom = bottom
        return this.move(0, 0)
      }
      case "s": return params ? undefined : this.save()
      case "u": return this.restore()
      case "m": return this.sgr(groups)
      case "n": {
        const mode = at(0, 0)
        if (mode === 5) this.respond?.("\x1b[0n")
        if (mode === 6) this.respond?.(`\x1b[${screen.y + 1};${Math.min(screen.x, this.cols - 1) + 1}R`)
        return
      }
      case "c": { if (at(0, 0) === 0) this.respond?.("\x1b[?1;2c"); return }
    }
  }

  private privateModes(modes: readonly number[], enabled: boolean) {
    for (const mode of modes) {
      if (mode === 1) this.flags.applicationCursor = enabled
      if (mode === 7) this.flags.autowrap = enabled
      if (mode === 25) this.flags.cursorVisible = enabled
      if (mode === 2004) this.flags.bracketedPaste = enabled
      if (mode === 47 || mode === 1047) this.switchScreen(enabled, false, enabled)
      if (mode === 1048 && enabled) this.save()
      if (mode === 1048 && !enabled) this.restore()
      if (mode === 1049) this.switchScreen(enabled, true, true)
    }
  }

  private sgr(groups: (number | undefined)[][]) {
    const next: { -readonly [K in keyof TerminalStyle]: TerminalStyle[K] } = { ...this.style }
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!
      const code = group[0] ?? 0
      if (code === 0) { for (const key of Object.keys(next) as (keyof TerminalStyle)[]) delete next[key] }
      else if (code === 1) next.bold = true
      else if (code === 2) next.dim = true
      else if (code === 3) next.italic = true
      else if (code === 4) { if (group[1] === 0) delete next.underline; else next.underline = true }
      else if (code === 7) next.inverse = true
      else if (code === 9) next.strike = true
      else if (code === 21) next.underline = true
      else if (code === 22) { delete next.bold; delete next.dim }
      else if (code === 23) delete next.italic
      else if (code === 24) delete next.underline
      else if (code === 27) delete next.inverse
      else if (code === 29) delete next.strike
      else if (code >= 30 && code <= 37) next.fg = code - 30
      else if (code >= 40 && code <= 47) next.bg = code - 40
      else if (code >= 90 && code <= 97) next.fg = code - 82
      else if (code >= 100 && code <= 107) next.bg = code - 92
      else if (code === 39) delete next.fg
      else if (code === 49) delete next.bg
      else if (code === 38 || code === 48) {
        const color = extended(groups, index)
        if (color.color !== undefined) next[code === 38 ? "fg" : "bg"] = color.color
        index += color.used - 1
      }
    }
    this.style = intern(next)
  }
}

const cursorKeys: Readonly<Record<string, string>> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" }
const tildeKeys: Readonly<Record<string, number>> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 }
const functionKeys: Readonly<Record<string, string>> = { F1: "P", F2: "Q", F3: "R", F4: "S" }
const controlSymbols: Readonly<Record<string, string>> = { "@": "\x00", " ": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", _: "\x1f", "?": "\x7f" }

export function terminalKey(event: TerminalKey, modes: Pick<TerminalModes, "applicationCursor">): string | undefined {
  if (event.metaKey) return undefined
  const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0)
  const cursor = cursorKeys[event.key]
  if (cursor) return modifier > 1 ? `\x1b[1;${modifier}${cursor}` : `${modes.applicationCursor ? "\x1bO" : "\x1b["}${cursor}`
  const tilde = tildeKeys[event.key]
  if (tilde !== undefined) return modifier > 1 ? `\x1b[${tilde};${modifier}~` : `\x1b[${tilde}~`
  const fn = functionKeys[event.key]
  if (fn) return modifier > 1 ? `\x1b[1;${modifier}${fn}` : `\x1bO${fn}`
  const alt = (value: string) => event.altKey ? `\x1b${value}` : value
  if (event.key === "Enter") return alt("\r")
  if (event.key === "Backspace") return alt(event.ctrlKey ? "\x08" : "\x7f")
  if (event.key === "Tab") return event.shiftKey ? "\x1b[Z" : alt("\t")
  if (event.key === "Escape") return alt("\x1b")
  if (Array.from(event.key).length !== 1) return undefined
  if (event.ctrlKey) {
    const lower = event.key.toLowerCase()
    if (lower >= "a" && lower <= "z") return alt(String.fromCharCode(lower.charCodeAt(0) - 96))
    const symbol = controlSymbols[event.key] ?? (event.key === "2" ? "\x00" : event.key === "6" ? "\x1e" : event.key === "-" ? "\x1f" : undefined)
    return symbol === undefined ? undefined : alt(symbol)
  }
  return alt(event.key)
}

export function terminalPaste(text: string, bracketed: boolean) {
  const normalized = text.replace(/\r\n|\n/g, "\r")
  return bracketed ? `\x1b[200~${normalized.replaceAll("\x1b[201~", "")}\x1b[201~` : normalized
}
