import { expect, test } from "bun:test"
import { TerminalEmulator } from "../src/terminal-emulator"

const bytes = (text: string) => new TextEncoder().encode(text)
const term = (cols: number, rows: number, options: { scrollback?: number; onResponse?: (data: string) => void } = {}) => new TerminalEmulator({ cols, rows, ...options })
const write = (target: TerminalEmulator, text: string) => { target.write(bytes(text)); return target }

test("printable text wraps at the right margin and a soft-wrapped row copies as one line", () => {
  const t = write(term(5, 3), "hello world")
  expect(t.screen()).toEqual(["hello", " worl", "d"])
  expect(t.cursor()).toEqual({ x: 1, y: 2, visible: true })
  t.select({ line: 0, col: 0 }, { line: 2, col: 4 })
  expect(t.getSelectedText()).toBe("hello world")
})

test("line feeds scroll the full screen into scrollback and erase commands clear it", () => {
  const t = write(term(5, 2), "a\r\nb\r\nc")
  expect(t.scrollback()).toEqual(["a"])
  expect(t.screen()).toEqual(["b", "c"])
  write(t, "\x1b[3J")
  expect(t.scrollback()).toEqual([])
  write(t, "\x1b[2J")
  expect(t.screen()).toEqual(["", ""])
  const limited = write(term(3, 1, { scrollback: 2 }), "1\r\n2\r\n3\r\n4")
  expect(limited.scrollback()).toEqual(["2", "3"])
})

test("cursor addressing, carriage return, backspace and tabs place output where requested", () => {
  const t = write(term(5, 2), "abcde\r\nfghij")
  write(t, "\x1b[1;3H\x1b[K")
  expect(t.screen()).toEqual(["ab", "fghij"])
  write(t, "\x1b[2;2H\x1b[1K")
  expect(t.screen()).toEqual(["ab", "  hij"])
  write(t, "\x1b[1;1HXY\x1b[2;5H\x1b[DZ")
  expect(t.screen()).toEqual(["XY", "  hZj"])
  const overwrite = write(term(10, 1), "abc\b\bX\rQ")
  expect(overwrite.screen()).toEqual(["QXc"])
  const tab = write(term(20, 1), "a\tb")
  expect(tab.screen()).toEqual(["a       b"])
  const down = write(term(5, 3), "\x1b[3;4Hx\x1b[1;1H\x1b[2Bq\x1b[5Cy\x1b[A\x1b[Gz")
  expect(down.screen()).toEqual(["", "z", "q  xy"])
})

test("character and line insertion and deletion shift content", () => {
  const t = write(term(5, 3), "abcde")
  write(t, "\x1b[1;2H\x1b[2P")
  expect(t.screen()[0]).toBe("ade")
  write(t, "\x1b[1;2H\x1b[1@")
  expect(t.screen()[0]).toBe("a de")
  write(t, "\x1b[1;2H\x1b[2X")
  expect(t.screen()[0]).toBe("a  e")
  const lines = write(term(3, 3), "1\r\n2\r\n3\x1b[2;1H\x1b[L")
  expect(lines.screen()).toEqual(["1", "", "2"])
  write(lines, "\x1b[1;1H\x1b[M")
  expect(lines.screen()).toEqual(["", "2", ""])
})

test("select graphic rendition tracks colors and attributes until reset", () => {
  const t = write(term(10, 1), "\x1b[1;31mR\x1b[38;5;200mP\x1b[38;2;1;2;3mT\x1b[0mN\x1b[7;4;44mI\x1b[22;27;24;49;93;102mB\x1b[39;3;9;2mS\x1b[38:2::4:5:6mC")
  const style = (col: number) => t.cell(0, col)?.style
  expect(style(0)).toMatchObject({ fg: 1, bold: true })
  expect(style(1)).toMatchObject({ fg: 200, bold: true })
  expect(style(2)).toMatchObject({ fg: "#010203", bold: true })
  expect(style(3)).toEqual({})
  expect(style(4)).toEqual({ bg: 4, inverse: true, underline: true })
  expect(style(5)).toEqual({ fg: 11, bg: 10 })
  expect(style(6)).toEqual({ bg: 10, italic: true, strike: true, dim: true })
  expect(style(7)).toEqual({ fg: "#040506", bg: 10, italic: true, strike: true, dim: true })
})

test("UTF-8 sequences split across writes decode as whole characters and wide characters take two columns", () => {
  const t = term(6, 1)
  const smile = bytes("é😀中x")
  for (const byte of smile) t.write(new Uint8Array([byte]))
  expect(t.screen()).toEqual(["é😀中x"])
  expect(t.cell(0, 0)?.ch).toBe("é")
  expect(t.cell(0, 1)?.ch).toBe("😀")
  expect(t.cell(0, 3)?.ch).toBe("中")
  expect(t.cell(0, 4)?.width).toBe(0)
  expect(t.cell(0, 5)?.ch).toBe("x")
  t.select({ line: 0, col: 0 }, { line: 0, col: 5 })
  expect(t.getSelectedText()).toBe("é😀中x")
})

test("the alternate screen keeps the main screen and cursor untouched and never feeds scrollback", () => {
  const t = write(term(6, 2), "main\r\nline")
  write(t, "\x1b[?1049h")
  expect(t.modes().alternateScreen).toBe(true)
  expect(t.screen()).toEqual(["", ""])
  write(t, "alt\r\n1\r\n2\r\n3")
  expect(t.scrollback()).toEqual([])
  write(t, "\x1b[?1049l")
  expect(t.screen()).toEqual(["main", "line"])
  expect(t.cursor()).toMatchObject({ x: 4, y: 1 })
})

test("a scroll region scrolls only its rows and reverse index scrolls down at its top", () => {
  const t = write(term(3, 4), "1\r\n2\r\n3\r\n4")
  write(t, "\x1b[2;3r\x1b[3;1H\n")
  expect(t.screen()).toEqual(["1", "3", "", "4"])
  expect(t.scrollback()).toEqual([])
  write(t, "\x1b[2;1H\x1bM")
  expect(t.screen()).toEqual(["1", "", "3", "4"])
})

test("private modes and line-drawing charset are honored", () => {
  const t = write(term(5, 1), "\x1b[?1h\x1b[?2004h\x1b[?25l\x1b(0qx\x1b(Bq")
  expect(t.modes()).toMatchObject({ applicationCursor: true, bracketedPaste: true, alternateScreen: false })
  expect(t.cursor().visible).toBe(false)
  expect(t.screen()).toEqual(["─│q"])
  write(t, "\x1b[?1l\x1b[?2004l\x1b[?25h\x1b]0;title\x07")
  expect(t.modes()).toMatchObject({ applicationCursor: false, bracketedPaste: false })
  expect(t.cursor().visible).toBe(true)
  expect(t.title()).toBe("title")
})

test("status and attribute queries produce terminal responses", () => {
  const responses: string[] = []
  const t = write(term(10, 5, { onResponse: (data) => responses.push(data) }), "\x1b[2;3H\x1b[6n\x1b[5n\x1b[c\x1b[>c")
  expect(responses).toEqual(["\x1b[2;3R", "\x1b[0n", "\x1b[?1;2c", "\x1b[>0;0;0c"])
  expect(t.screen()).toEqual(["", "", "", "", ""])
})

test("resizing truncates or pads columns, keeps the cursor row on screen and clamps the cursor", () => {
  const t = write(term(5, 3), "abcde\r\nfg")
  t.resize(3, 2)
  expect(t.screen()).toEqual(["abc", "fg"])
  expect(t.cursor()).toMatchObject({ x: 2, y: 1 })
  t.resize(6, 3)
  expect(t.screen()).toEqual(["abc", "fg", ""])
  const bottom = write(term(3, 3), "1\r\n2\r\n3")
  bottom.resize(3, 1)
  expect(bottom.screen()).toEqual(["3"])
  expect(bottom.scrollback()).toEqual(["1", "2"])
})

test("selection normalizes reversed endpoints, trims trailing blanks and clears", () => {
  const t = write(term(6, 2), "ab  \r\ncdef")
  expect(t.hasSelection()).toBe(false)
  t.select({ line: 1, col: 2 }, { line: 0, col: 1 })
  expect(t.hasSelection()).toBe(true)
  expect(t.getSelectedText()).toBe("b\ncde")
  t.clearSelection()
  expect(t.getSelectedText()).toBe("")
  const rows = t.view()
  expect(rows).toHaveLength(2)
  expect(rows[1]?.runs.map((run) => run.text).join("")).toBe("cdef  ")
})

test("full reset restores defaults", () => {
  const t = write(term(4, 2), "\x1b[1mab\x1b[?2004h\x1b[?1049h\x1bc")
  expect(t.screen()).toEqual(["", ""])
  expect(t.modes()).toEqual({ applicationCursor: false, bracketedPaste: false, alternateScreen: false })
  write(t, "x")
  expect(t.cell(0, 0)?.style).toEqual({})
})
