/**
 * Sign-in allowlist.
 *
 * Initial deployment restricts remote access to explicitly listed Google
 * accounts. The list is server-only configuration (`GOOGLE_ALLOWED_EMAILS`) and is
 * never returned through an API, a redirect, a log, or the browser bundle.
 *
 * Matching is exact after trimming and lowercasing: no wildcards, no domain
 * suffixes, no substring matches. An empty or missing list denies every sign-in.
 * Durable ownership remains the issuer/subject pair; the email is only an
 * admission check at sign-in time.
 */

import type { GoogleIdentity } from "./google"

export type AllowlistEnv = { readonly GOOGLE_ALLOWED_EMAILS?: string }

/** Parses comma, whitespace, or newline separated addresses into a normalized set. */
export function parseAllowedEmails(env: AllowlistEnv): ReadonlySet<string> {
  const raw = env.GOOGLE_ALLOWED_EMAILS
  if (raw === undefined) return new Set()
  const emails = raw
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
  return new Set(emails)
}

/**
 * Fail-closed admission: requires a configured entry, a verified email, and an
 * exact normalized match.
 */
export function isIdentityAllowed(allowlist: ReadonlySet<string>, identity: GoogleIdentity): boolean {
  if (allowlist.size === 0) return false
  if (!identity.emailVerified) return false
  if (identity.email === undefined) return false
  return allowlist.has(identity.email.trim().toLowerCase())
}
