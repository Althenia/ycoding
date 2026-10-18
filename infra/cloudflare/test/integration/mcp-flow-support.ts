import { spawn } from "bun"
import { createHash, randomBytes } from "node:crypto"
import { base64UrlEncode } from "../../src/auth/crypto"

export const repositoryRoot = new URL("../../../../", import.meta.url).pathname
export const wranglerBin = `${repositoryRoot}node_modules/.bin/wrangler`
export const configPath = "infra/cloudflare/wrangler.jsonc"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`MCP-flow check failed: ${message}`)
}

export async function run(command: string, args: string[]): Promise<string> {
  const child = spawn([command, ...args], { cwd: repositoryRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}

export async function waitFor<Value>(
  check: () => Value | undefined | Promise<Value | undefined>,
  timeoutMs: number,
  message: string | (() => string),
): Promise<Value> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await Promise.resolve(check())
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`MCP-flow check failed: ${typeof message === "function" ? message() : message}`)
    await Bun.sleep(50)
  }
}

export async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function pkce() {
  const verifier = base64UrlEncode(randomBytes(48))
  return { verifier, challenge: base64UrlEncode(createHash("sha256").update(verifier).digest()) }
}

export async function rsaIdentity(kid = "mcp-flow-kid") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" }
  return { pair, jwk, kid }
}

export async function signedIdToken(identity: { pair: CryptoKeyPair; kid: string }, claims: Record<string, unknown>) {
  const header = { alg: "RS256", kid: identity.kid, typ: "JWT" }
  const signingInput = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))}`
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", identity.pair.privateKey, new TextEncoder().encode(signingInput)),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

export function setCookiePair(response: Response, name: string): string {
  for (const value of response.headers.getSetCookie()) if (value.startsWith(`${name}=`)) return value.split(";")[0] ?? ""
  throw new Error(`response carried no ${name} cookie`)
}

export function cookieValue(pair: string): string {
  const separator = pair.indexOf("=")
  return separator === -1 ? "" : pair.slice(separator + 1)
}

export function cookieHeader(responses: readonly Response[]) {
  const jar = new Map<string, string>()
  for (const response of responses)
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0] ?? ""
      const separator = pair.indexOf("=")
      if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

export type Form = {
  readonly action: string
  readonly method: string
  readonly fields: Readonly<Record<string, string>>
  readonly buttons: readonly { readonly name?: string; readonly value?: string; readonly text: string }[]
}

export function parseForms(html: string): Form[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((match) => {
    const attributes = attributesOf(match[1] ?? "")
    const inner = match[2] ?? ""
    const fields = Object.fromEntries(
      [...inner.matchAll(/<input\b([^>]*)>/gi)].flatMap((input) => {
        const attribute = attributesOf(input[1] ?? "")
        return attribute.type?.toLowerCase() === "hidden" && attribute.name !== undefined ? [[attribute.name, attribute.value ?? ""] as const] : []
      }),
    )
    const buttons = [...inner.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((button) => {
      const attribute = attributesOf(button[1] ?? "")
      return {
        ...(attribute.name === undefined ? {} : { name: attribute.name }),
        ...(attribute.value === undefined ? {} : { value: attribute.value }),
        text: decodeEntities((button[2] ?? "").replace(/<[^>]*>/g, "")).trim(),
      }
    })
    return { action: attributes.action ?? "", method: (attributes.method ?? "get").toLowerCase(), fields, buttons }
  })
}

export function decisionSubmission(forms: readonly Form[], action: string, decision: string) {
  for (const form of forms.filter((candidate) => candidate.action.includes(action))) {
    if (form.fields.decision === decision) return { form, extra: {} as Record<string, string> }
    const button = form.buttons.find((candidate) => candidate.value === decision || new RegExp(`^\\s*${decision}\\b`, "i").test(candidate.text))
    if (button) return { form, extra: { [button.name ?? "decision"]: button.value ?? decision } }
  }
  throw new Error(`no ${decision} control was found in a form posting to ${action}`)
}

function attributesOf(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
    result[(match[1] ?? "").toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")
  return result
}

function decodeEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

export function d1Rows(persist: string, sql: string): Promise<Record<string, unknown>[]> {
  return run(wranglerBin, [
    "d1", "execute", "ycoding-prod-db", "--local", "--config", configPath, "--persist-to", persist, "--json", "--command", sql,
  ]).then((output) => {
    const parsed: unknown = JSON.parse(output)
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((batch) =>
      isRecord(batch) && Array.isArray(batch.results) ? batch.results.filter(isRecord) : [],
    )
  })
}

export async function markerRowCount(persist: string, marker: string) {
  const columns = await d1Rows(
    persist,
    "SELECT m.name AS table_name, p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
      "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' " +
      "AND (p.type = '' OR upper(p.type) LIKE '%TEXT%' OR upper(p.type) LIKE '%CHAR%' OR upper(p.type) LIKE '%CLOB%' OR upper(p.type) LIKE '%JSON%')",
  )
  expect(columns.length > 0, "the D1 text-column inventory was empty")
  const safe = marker.replace(/[^A-Za-z0-9_-]/g, "")
  const statements = columns
      .flatMap((row) =>
        typeof row.table_name === "string" && typeof row.column_name === "string" && /^[A-Za-z0-9_]+$/.test(row.table_name) && /^[A-Za-z0-9_]+$/.test(row.column_name)
          ? [`SELECT '${row.table_name}.${row.column_name}' AS location, count(*) AS matches FROM "${row.table_name}" WHERE instr(CAST("${row.column_name}" AS TEXT), '${safe}') > 0`]
          : [],
      )
  expect(statements.length === columns.length, "a D1 text column could not be scanned")
  const counts: Record<string, unknown>[] = []
  for (let offset = 0; offset < statements.length; offset += 16)
    counts.push(...await d1Rows(persist, statements.slice(offset, offset + 16).join("; ")))
  expect(counts.length === columns.length, "the D1 text-column scan was incomplete")
  return {
    scanned: columns.length,
    matches: counts.reduce((total, row) => total + (typeof row.matches === "number" ? row.matches : 0), 0),
    locations: counts.filter((row) => typeof row.matches === "number" && row.matches > 0).map((row) => String(row.location)),
  }
}
