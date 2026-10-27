export const MAX_STRING_LENGTH = 16_777_216
export const MAX_ARRAY_LENGTH = 10_000_000
export const MAX_PENDING_PROMISES = 10_000

export class ValueLimitError extends RangeError {}

export const checkStringLength = (length: number): void => {
  if (length > MAX_STRING_LENGTH) throw new ValueLimitError(`String length exceeds ${MAX_STRING_LENGTH}.`)
}

export const checkArrayLength = (length: number): void => {
  if (length > MAX_ARRAY_LENGTH) throw new ValueLimitError(`Array length exceeds ${MAX_ARRAY_LENGTH}.`)
}

export const checkValueSize = <T>(value: T): T => {
  if (typeof value === "string") checkStringLength(value.length)
  if (Array.isArray(value)) checkArrayLength(value.length)
  return value
}

export const joinStrings = (items: ReadonlyArray<string>, separator: string): string => {
  checkStringLength(items.reduce((size, item) => size + item.length, Math.max(0, items.length - 1) * separator.length))
  return items.join(separator)
}

export const substitute = (
  replacement: string,
  match: string,
  captures: Array<string | undefined>,
  offset: number,
  input: string,
  groups?: Record<string, string | undefined>,
): string => {
  let output = ""
  for (let index = 0; index < replacement.length; index += 1) {
    let part = replacement[index]
    if (part === "$" && index + 1 < replacement.length) {
      const next = replacement[index + 1]
      if (next === "$" || next === "&" || next === "`" || next === "'") {
        part =
          next === "$"
            ? "$"
            : next === "&"
              ? match
              : next === "`"
                ? input.slice(0, offset)
                : input.slice(offset + match.length)
        index += 1
      } else if (next === "<" && groups !== undefined && replacement.indexOf(">", index + 2) !== -1) {
        const end = replacement.indexOf(">", index + 2)
        part = groups[replacement.slice(index + 2, end)] ?? ""
        index = end
      } else if (next >= "0" && next <= "9") {
        const second = replacement[index + 2]
        const two = second !== undefined && second >= "0" && second <= "9" ? Number(next + second) : 0
        const number = two > 0 && two <= captures.length ? two : Number(next)
        if (number > 0 && number <= captures.length) {
          part = captures[number - 1] ?? ""
          index += number === two ? 2 : 1
        }
      }
    }
    if (output.length + part.length > 16_777_216) throw new RangeError("String length exceeds 16777216.")
    output += part
  }
  return output
}
