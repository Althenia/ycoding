export * as CcaMitmCa from "./mitm-ca"

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import tls from "node:tls"
import forge from "node-forge"

export const CCA_CUSTOM_CA_ENV_KEYS: readonly string[] = [
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "PIP_CERT",
  "BUNDLE_SSL_CA_CERT",
  "npm_config_cafile",
  "NPM_CONFIG_CAFILE",
]

const CA_COMMON_NAME = "network_proxy MITM CA"
const CA_PREFIX = "ca"
const BUNDLE_PREFIX = "ca-bundle"
const MAX_STARTUP_CA_FILE_BYTES = 1024 * 1024
const MAX_CACHED_HOST_CONTEXTS = 256
const DAY_MS = 86_400_000

export interface CcaMitmAuthority {
  readonly certificatePath: string
  readonly trustBundlePath: string
  readonly upstreamCa: readonly string[]
  readonly secureContextForHost: (host: string) => tls.SecureContext
  readonly isManagedTrustBundlePath: (value: string) => boolean
  readonly applyChildTrust: (env: Record<string, string>) => void
}

interface IssuedKeyPair {
  readonly forgePrivate: forge.pki.rsa.PrivateKey
  readonly forgePublic: forge.pki.rsa.PublicKey
  readonly privatePem: string
}

function generateRsaKeyPair(): IssuedKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
  return {
    forgePrivate: forge.pki.privateKeyFromPem(privatePem),
    forgePublic: forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString()),
    privatePem,
  }
}

function serialNumber(): string {
  const bytes = randomBytes(16)
  bytes[0] = bytes[0] & 0x7f
  return bytes.toString("hex")
}

function issueCa(): { readonly certificatePem: string; readonly certificate: forge.pki.Certificate; readonly key: IssuedKeyPair } {
  const key = generateRsaKeyPair()
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = key.forgePublic
  certificate.serialNumber = serialNumber()
  certificate.validity.notBefore = new Date(Date.now() - DAY_MS)
  certificate.validity.notAfter = new Date(Date.now() + 3650 * DAY_MS)
  const subject = [{ name: "commonName", value: CA_COMMON_NAME }]
  certificate.setSubject(subject)
  certificate.setIssuer(subject)
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ])
  certificate.sign(key.forgePrivate, forge.md.sha256.create())
  return { certificatePem: forge.pki.certificateToPem(certificate), certificate, key }
}

function issueLeaf(
  host: string,
  ca: { readonly certificate: forge.pki.Certificate; readonly key: IssuedKeyPair },
): { readonly certificatePem: string; readonly keyPem: string } {
  const key = generateRsaKeyPair()
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = key.forgePublic
  certificate.serialNumber = serialNumber()
  certificate.validity.notBefore = new Date(Date.now() - DAY_MS)
  certificate.validity.notAfter = new Date(Date.now() + 365 * DAY_MS)
  certificate.setSubject([{ name: "commonName", value: host }])
  certificate.setIssuer(ca.certificate.subject.attributes)
  const altName = net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [altName] },
  ])
  certificate.sign(ca.key.forgePrivate, forge.md.sha256.create())
  return { certificatePem: forge.pki.certificateToPem(certificate), keyPem: key.privatePem }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function writeCreateNewOrReuse(target: string, contents: string): void {
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, "utf8") === contents) return
    throw new Error("managed MITM CA artifact exists with different contents")
  }
  const temporary = `${target}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  fs.writeFileSync(temporary, contents, { mode: 0o644, flag: "wx" })
  try {
    fs.linkSync(temporary, target)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || fs.readFileSync(target, "utf8") !== contents) throw error
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function pemCertificates(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
}

function normalizedPem(pem: string): string {
  return `${pem.trim().replace(/\r\n/g, "\n")}\n`
}

function readStartupCertificates(file: string): string[] {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_STARTUP_CA_FILE_BYTES) return []
    return pemCertificates(fs.readFileSync(file, "utf8"))
  } catch {
    return []
  }
}

function platformRootCertificates(): string[] {
  const system = (() => {
    try {
      return tls.getCACertificates("system")
    } catch {
      return []
    }
  })()
  return [...system, ...tls.rootCertificates]
}

const authorities = new Map<string, CcaMitmAuthority>()

export function loadCcaMitmAuthority(
  directory: string,
  startupEnv: Readonly<Record<string, string | undefined>> = process.env,
): CcaMitmAuthority {
  const resolved = path.resolve(directory)
  const existing = authorities.get(resolved)
  if (existing) return existing
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const ca = issueCa()
  const certificatePath = path.join(resolved, `${CA_PREFIX}-${sha256(ca.certificatePem)}.pem`)
  writeCreateNewOrReuse(certificatePath, ca.certificatePem)

  const isGenerated = (value: string) => {
    const candidate = path.resolve(value)
    return path.dirname(candidate) === resolved && new RegExp(`^(?:${CA_PREFIX}|${BUNDLE_PREFIX})-[0-9a-f]{64}\\.pem$`).test(path.basename(candidate))
  }
  const startupValues = new Map<string, string>()
  const startupCertificates: string[] = []
  const seenStartupFiles = new Set<string>()
  for (const key of CCA_CUSTOM_CA_ENV_KEYS) {
    const value = startupEnv[key]
    if (!value) continue
    startupValues.set(key, value)
    if (isGenerated(value) || seenStartupFiles.has(value)) continue
    seenStartupFiles.add(value)
    startupCertificates.push(...readStartupCertificates(value))
  }
  const caPem = normalizedPem(ca.certificatePem)
  const roots: string[] = []
  for (const pem of [...platformRootCertificates(), ...startupCertificates].map(normalizedPem)) {
    if (pem !== caPem && !roots.includes(pem)) roots.push(pem)
  }
  const bundle = [...roots, caPem].join("")
  const trustBundlePath = path.join(resolved, `${BUNDLE_PREFIX}-${sha256(bundle)}.pem`)
  writeCreateNewOrReuse(trustBundlePath, bundle)

  const contexts = new Map<string, tls.SecureContext>()
  const secureContextForHost = (host: string) => {
    const cached = contexts.get(host)
    if (cached) {
      contexts.delete(host)
      contexts.set(host, cached)
      return cached
    }
    const leaf = issueLeaf(host, ca)
    const context = tls.createSecureContext({ key: leaf.keyPem, cert: `${leaf.certificatePem}${ca.certificatePem}` })
    contexts.set(host, context)
    if (contexts.size > MAX_CACHED_HOST_CONTEXTS) contexts.delete(contexts.keys().next().value!)
    return context
  }

  const authority: CcaMitmAuthority = {
    certificatePath,
    trustBundlePath,
    upstreamCa: roots,
    secureContextForHost,
    isManagedTrustBundlePath: isGenerated,
    applyChildTrust: (env) => {
      for (const key of CCA_CUSTOM_CA_ENV_KEYS) {
        const value = env[key]
        if (value && value !== trustBundlePath && startupValues.get(key) !== value) continue
        env[key] = trustBundlePath
      }
    },
  }
  authorities.set(resolved, authority)
  return authority
}
