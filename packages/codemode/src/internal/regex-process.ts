import { substitute } from "../limits.js"

export const REGEX_PROCESS_MARKER = "--ycoding-internal-regex"
export const MAX_REGEX_FRAME_BYTES = 128 * 1024 * 1024

const serve = (substitution: typeof substitute, maxFrameBytes: number) => {
  const maxStringLength = 16_777_216
  const maxArrayLength = 10_000_000
  const checkString = (length: number) => {
    if (length > maxStringLength) throw new RangeError(`String length exceeds ${maxStringLength}.`)
  }
  const encode = (input: unknown) => {
    let size = 0
    const account = (bytes: number) => {
      size += bytes
      if (size > maxFrameBytes - 128) throw new RangeError("Regex response exceeds the IPC frame limit.")
    }
    const pack = (value: unknown): unknown => {
      if (value === undefined) {
        account(7)
        return { u: 1 }
      }
      if (Array.isArray(value)) {
        if (value.length > maxArrayLength) throw new RangeError(`Array length exceeds ${maxArrayLength}.`)
        account(32 + value.length)
        const items = value.map(pack)
        const properties = ["index", "groups", "indices"]
          .filter((key) => Object.hasOwn(value, key))
          .map((key) => {
            account(16)
            return [key, pack(Reflect.get(value, key))]
          })
        return { a: items, p: properties }
      }
      if (value !== null && typeof value === "object") {
        account(8)
        return {
          o: Object.entries(value).map(([key, item]) => {
            account(Buffer.byteLength(JSON.stringify(key)) + 4)
            return [key, pack(item)]
          }),
        }
      }
      if (typeof value === "string") checkString(value.length)
      account(Buffer.byteLength(JSON.stringify(value)) + 1)
      return value
    }
    return pack(input)
  }
  const send = (value: unknown) => {
    const frame = JSON.stringify(value)
    if (Buffer.byteLength(frame) > maxFrameBytes) throw new RangeError("Regex response exceeds the IPC frame limit.")
    process.stdout.write(frame + "\n")
  }
  const handle = (request: {
    pattern: string
    flags: string
    lastIndex: unknown
    method: string
    input: string
    replacement?: string
    limit?: number
  }) => {
    try {
      checkString(request.pattern.length)
      checkString(request.input.length)
      if (request.replacement !== undefined) checkString(request.replacement.length)
      const re = new RegExp(request.pattern, request.flags)
      re.lastIndex = request.lastIndex as number
      const input = request.input
      let result: unknown
      if (request.method === "exec") result = re.exec(input)
      if (request.method === "test") result = re.test(input)
      if (request.method === "match") result = input.match(re)
      if (request.method === "matchAll") {
        const matches = []
        for (const match of input.matchAll(re)) {
          if (matches.length >= maxArrayLength) throw new RangeError(`Array length exceeds ${maxArrayLength}.`)
          matches.push(match)
        }
        result = matches
      }
      if (request.method === "search") result = input.search(re)
      if (request.method === "split") {
        result = input.split(
          re,
          Math.min(request.limit === undefined ? 4294967295 : request.limit >>> 0, maxArrayLength + 1),
        )
      }
      if (request.method === "replace" || request.method === "replaceAll" || request.method === "collect") {
        if (request.method === "replaceAll" && !re.global)
          throw new TypeError("String.replaceAll requires a global regular expression.")
        const collected: Array<Array<unknown>> = []
        let output = ""
        let end = 0
        input.replace(re, (...args: Array<unknown>) => {
          const hasGroups = typeof args[args.length - 1] === "object"
          const offset = args[args.length - (hasGroups ? 3 : 2)] as number
          if (request.method === "collect") {
            if (collected.length >= maxArrayLength) throw new RangeError(`Array length exceeds ${maxArrayLength}.`)
            args.splice(args.length - (hasGroups ? 2 : 1), 1)
            collected.push(args)
            return ""
          }
          const replacement = substitution(
            request.replacement!,
            args[0] as string,
            args.slice(1, hasGroups ? -3 : -2) as Array<string | undefined>,
            offset,
            input,
            hasGroups ? (args[args.length - 1] as Record<string, string | undefined>) : undefined,
          )
          checkString(output.length + offset - end + replacement.length)
          output += input.slice(end, offset) + replacement
          end = offset + (args[0] as string).length
          return ""
        })
        checkString(output.length + input.length - end)
        result = request.method === "collect" ? collected : output + input.slice(end)
      }
      send({ result: encode(result), lastIndex: re.lastIndex })
    } catch (error) {
      send({
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : "Regex operation failed.",
        },
      })
    }
  }
  process.stdin.setEncoding("utf8")
  let buffer = ""
  let bytes = 0
  process.stdin.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > maxFrameBytes + 1) {
      send({ error: { name: "RangeError", message: "Regex request exceeds the IPC frame limit." } })
      process.stdin.destroy()
      return
    }
    buffer += chunk
    const end = buffer.indexOf("\n")
    if (end === -1) return
    const frame = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    bytes = Buffer.byteLength(buffer)
    try {
      handle(JSON.parse(frame))
    } catch {
      process.exitCode = 1
      process.stdin.destroy()
    }
  })
  send({ ready: true })
}

export const regexProcessSource = `(${serve.toString()})(${substitute.toString()}, ${MAX_REGEX_FRAME_BYTES})`

let regexProcessStarted = false

export const runRegexProcess = (): boolean => {
  const args = process.argv.slice(1)
  const offset = args[0] === "-e" ? 0 : 1
  if (
    args.length !== offset + 4 ||
    args[offset] !== "-e" ||
    args[offset + 1] !== regexProcessSource ||
    args[offset + 2] !== "--" ||
    args[offset + 3] !== REGEX_PROCESS_MARKER
  )
    return false
  if (!regexProcessStarted) {
    regexProcessStarted = true
    serve(substitute, MAX_REGEX_FRAME_BYTES)
  }
  return true
}

export const decodeRegexValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  const wire = value as { u?: number; a?: Array<unknown>; p?: Array<[string, unknown]>; o?: Array<[string, unknown]> }
  if (wire.u === 1) return undefined
  if (wire.a) {
    const array = wire.a.map(decodeRegexValue)
    for (const [key, item] of wire.p ?? []) Reflect.set(array, key, decodeRegexValue(item))
    return array
  }
  const object = Object.create(null) as Record<string, unknown>
  for (const [key, item] of wire.o ?? []) object[key] = decodeRegexValue(item)
  return object
}
