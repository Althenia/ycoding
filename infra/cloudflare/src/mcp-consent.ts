import { randomToken } from "./auth/crypto"
import { isLoopbackRedirect } from "./auth/mcp/client"
import { withSecurityHeaders } from "./http"

export const authorityLines: readonly string[] = [
  "Read every existing and future Session on this device: messages, attachments, changes, logs, and todos.",
  "Create Sessions in recorded workspaces and in existing directories strictly below the home directory.",
  "Send prompts, interrupt running work, and answer questions and forms.",
  "Approve once, approve always, or reject permission and guardrail requests, including persistent approvals where available.",
  "Change autonomy modes (Manual, YOLO, or Auto for permissions, guardrails, and answers) and goals, switch models and agents, and run commands and skills.",
  "Manage provider connections, background shells, and keep-awake.",
  "Read usage, cost, and incident reports.",
]

export type NoticePage = {
  readonly clientName: string
  readonly redirectUri: string
  readonly resource: string
  readonly expiresInMinutes: number
  readonly csrfToken: string
}

export type ConsentPage = {
  readonly clientName: string
  readonly redirectUri: string
  readonly resource: string
  readonly deviceName: string
  readonly csrfToken: string
}

export type ErrorPage = { readonly title: string; readonly message: string }

const fontSans = '"Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
const fontMono = '"Geist Mono", ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace'

export const consentStyles = `
@font-face {
  font-family: "Geist";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/Geist.woff2") format("woff2");
}

@font-face {
  font-family: "Geist Mono";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/GeistMono.woff2") format("woff2");
}

:root {
  color-scheme: light dark;
  --yc-green-strong: #0a7b47;
  --yc-primary-bg: #0b8550;
  --yc-primary-fg: #ffffff;
  --yc-yellow-strong: #946200;
  --yc-yellow-soft: rgba(244, 189, 61, 0.16);
  --yc-focus: #0b8b50;
  --yc-bg: #ffffff;
  --yc-surface: #f7f9f8;
  --yc-surface-raised: #ffffff;
  --yc-text: #0b0f14;
  --yc-text-muted: #5c6672;
  --yc-border: #e4e8e6;
  --yc-border-strong: #78847e;
  --yc-font-sans: ${fontSans};
  --yc-font-mono: ${fontMono};
  --yc-cursor-action: pointer;
  --yc-size-2xs: 12px;
  --yc-leading-2xs: 16px;
  --yc-size-xs: 13px;
  --yc-leading-xs: 20px;
  --yc-size-sm: 14px;
  --yc-leading-sm: 22px;
  --yc-size-xl: 20px;
  --yc-leading-xl: 30px;
  --yc-weight-semibold: 600;
  --yc-tracking-wide: 0.06em;
  --yc-measure-narrow: 54ch;
  --yc-space-1: 4px;
  --yc-space-2: 8px;
  --yc-space-3: 12px;
  --yc-space-4: 16px;
  --yc-space-5: 20px;
  --yc-space-6: 24px;
  --yc-space-8: 32px;
  --yc-space-10: 40px;
  --yc-radius-sm: 6px;
  --yc-radius-md: 10px;
  --yc-radius-pill: 999px;
  --yc-control-h: 44px;
  --yc-control-pad-x: 16px;
  --yc-border-width: 1px;
  --yc-scrollbar-size: 12px;
  --yc-gutter: 16px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --yc-green-strong: #4ee29b;
    --yc-primary-bg: #4ee29b;
    --yc-primary-fg: #04150c;
    --yc-yellow-strong: #f7d37c;
    --yc-yellow-soft: rgba(244, 189, 61, 0.14);
    --yc-focus: #4ee29b;
    --yc-bg: #0b1115;
    --yc-surface: #11181d;
    --yc-surface-raised: #151e24;
    --yc-text: #f4f7f6;
    --yc-text-muted: #99a2ad;
    --yc-border: #263039;
    --yc-border-strong: #718278;
  }
}

@media (min-width: 480px) {
  :root {
    --yc-gutter: 20px;
  }
}

@media (min-width: 640px) {
  :root {
    --yc-gutter: 24px;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  background: var(--yc-bg);
  color: var(--yc-text);
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  min-block-size: 100dvh;
  background: var(--yc-bg);
  color: var(--yc-text);
  font-family: var(--yc-font-sans);
  font-size: var(--yc-size-sm);
  line-height: var(--yc-leading-sm);
}

:focus-visible {
  outline: 2px solid var(--yc-focus);
  outline-offset: 2px;
  border-radius: var(--yc-radius-sm);
}

.consent {
  max-inline-size: calc(var(--yc-measure-narrow) + 2 * var(--yc-gutter));
  margin-inline: auto;
  padding: var(--yc-space-6) var(--yc-gutter) var(--yc-space-10);
}

.consent__brand {
  margin: 0 0 var(--yc-space-3);
  color: var(--yc-text-muted);
  font-size: var(--yc-size-2xs);
  line-height: var(--yc-leading-2xs);
  font-weight: var(--yc-weight-semibold);
  letter-spacing: var(--yc-tracking-wide);
  text-transform: uppercase;
}

.consent__title {
  margin: 0 0 var(--yc-space-3);
  font-size: var(--yc-size-xl);
  line-height: var(--yc-leading-xl);
  font-weight: var(--yc-weight-semibold);
  overflow-wrap: anywhere;
}

.consent__heading {
  margin: var(--yc-space-6) 0 var(--yc-space-2);
  font-size: var(--yc-size-sm);
  line-height: var(--yc-leading-sm);
  font-weight: var(--yc-weight-semibold);
}

.consent__lead {
  margin: 0 0 var(--yc-space-4);
  color: var(--yc-text-muted);
  overflow-wrap: anywhere;
}

.consent__facts {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--yc-space-1) var(--yc-space-4);
  margin: 0 0 var(--yc-space-4);
  padding: var(--yc-space-4);
  background: var(--yc-surface);
  border: var(--yc-border-width) solid var(--yc-border);
  border-radius: var(--yc-radius-md);
}

.consent__facts dt {
  color: var(--yc-text-muted);
  font-size: var(--yc-size-xs);
  line-height: var(--yc-leading-xs);
}

.consent__facts dd {
  margin: 0 0 var(--yc-space-2);
  overflow-wrap: anywhere;
}

.consent__facts dd:last-child {
  margin-bottom: 0;
}

@media (min-width: 480px) {
  .consent__facts {
    grid-template-columns: max-content minmax(0, 1fr);
  }

  .consent__facts dd {
    margin-bottom: 0;
  }
}

.consent__mono {
  font-family: var(--yc-font-mono);
  font-size: var(--yc-size-xs);
  line-height: var(--yc-leading-xs);
}

.consent__list {
  margin: 0;
  padding-inline-start: var(--yc-space-5);
}

.consent__list li {
  margin-block: var(--yc-space-2);
  overflow-wrap: anywhere;
}

.consent__warning {
  margin: 0 0 var(--yc-space-4);
  padding: var(--yc-space-3) var(--yc-space-4);
  background: var(--yc-yellow-soft);
  border: var(--yc-border-width) solid var(--yc-yellow-strong);
  border-radius: var(--yc-radius-md);
  overflow-wrap: anywhere;
}

.consent__warning strong {
  color: var(--yc-yellow-strong);
}

.consent__hint {
  margin: var(--yc-space-4) 0 0;
  color: var(--yc-text-muted);
  font-size: var(--yc-size-xs);
  line-height: var(--yc-leading-xs);
  overflow-wrap: anywhere;
}

.consent__form {
  margin: 0;
}

.consent__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yc-space-3);
  margin-top: var(--yc-space-6);
}

.button {
  --button-bg: var(--yc-surface-raised);
  --button-fg: var(--yc-text);
  --button-border: var(--yc-border-strong);
  display: inline-flex;
  flex: 1 1 9rem;
  align-items: center;
  justify-content: center;
  min-block-size: var(--yc-control-h);
  padding: 0 var(--yc-control-pad-x);
  background: var(--button-bg);
  color: var(--button-fg);
  border: var(--yc-border-width) solid var(--button-border);
  border-radius: var(--yc-radius-md);
  font-family: inherit;
  font-size: var(--yc-size-sm);
  font-weight: var(--yc-weight-semibold);
  line-height: 1;
  text-align: center;
  cursor: var(--yc-cursor-action);
}

.button:hover {
  background: color-mix(in srgb, var(--button-bg) 92%, var(--yc-text) 8%);
}

.button:active {
  translate: 0 1px;
}

.button--primary {
  --button-bg: var(--yc-primary-bg);
  --button-fg: var(--yc-primary-fg);
  --button-border: var(--yc-primary-bg);
  background: var(--yc-primary-bg);
  color: var(--yc-primary-fg);
}

.button--primary:hover {
  background: color-mix(in srgb, var(--yc-primary-bg) 92%, var(--yc-text) 8%);
  color: var(--yc-primary-fg);
}

.button--secondary {
  --button-bg: var(--yc-surface-raised);
  --button-fg: var(--yc-text);
  --button-border: var(--yc-border-strong);
}

@media (pointer: fine) and (forced-colors: none) {
  ::-webkit-scrollbar {
    width: var(--yc-scrollbar-size);
    height: var(--yc-scrollbar-size);
  }

  ::-webkit-scrollbar-track,
  ::-webkit-scrollbar-corner {
    background: transparent;
  }

  ::-webkit-scrollbar-button {
    display: none;
  }

  ::-webkit-scrollbar-thumb {
    border: var(--yc-space-1) solid transparent;
    border-radius: var(--yc-radius-pill);
    background-color: var(--yc-border-strong);
    background-clip: padding-box;
  }

  ::-webkit-scrollbar-thumb:vertical {
    min-height: var(--yc-space-8);
  }

  ::-webkit-scrollbar-thumb:horizontal {
    min-width: var(--yc-space-8);
  }

  ::-webkit-scrollbar-thumb:hover {
    border-width: calc(var(--yc-space-1) / 2);
    background-color: var(--yc-text-muted);
  }

  ::-webkit-scrollbar-thumb:active {
    border-width: calc(var(--yc-space-1) / 2);
    background-color: var(--yc-green-strong);
  }
}

@supports not selector(::-webkit-scrollbar) {
  @media (pointer: fine) and (forced-colors: none) {
    :root {
      scrollbar-color: var(--yc-border-strong) transparent;
      scrollbar-width: thin;
    }
  }
}
`

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function noticeResponse(page: NoticePage, cookies: readonly string[]): Response {
  const authority = authoritySection()
  const loopback = loopbackWarning(page.redirectUri)
  const body = `
<h1 class="consent__title">Connect <bdi>${escapeHtml(page.clientName)}</bdi> to YCoding</h1>
<p class="consent__lead">This application asks to control a YCoding device through Relay MCP. Review the access below, then sign in with Google to verify that you own the device.</p>
<dl class="consent__facts">
<dt>Application</dt><dd><bdi>${escapeHtml(page.clientName)}</bdi></dd>
<dt>Returns to</dt><dd><bdi>${escapeHtml(redirectHost(page.redirectUri))}</bdi></dd>
<dt>Resource</dt><dd class="consent__mono"><bdi>${escapeHtml(page.resource)}</bdi></dd>
</dl>
${loopback}${authority}
<form class="consent__form" method="post" action="/api/mcp/oauth/login">
<input type="hidden" name="csrf" value="${escapeHtml(page.csrfToken)}">
<div class="consent__actions"><button class="button button--primary" type="submit">Continue to Google</button></div>
</form>
<p class="consent__hint">The device name appears after you sign in. To cancel, close this tab. This request expires in ${page.expiresInMinutes} ${page.expiresInMinutes === 1 ? "minute" : "minutes"}.</p>`
  return pageResponse("Connect to YCoding", body, 200, cookies)
}

export function consentResponse(page: ConsentPage, cookies: readonly string[]): Response {
  const body = `
<h1 class="consent__title">Allow <bdi>${escapeHtml(page.clientName)}</bdi> to control <bdi>${escapeHtml(page.deviceName)}</bdi>?</h1>
<p class="consent__lead">You are signed in as the owner of this device. Allow grants the access below until you turn off Relay MCP, revoke the device, or the 30-day grant ends.</p>
<dl class="consent__facts">
<dt>Application</dt><dd><bdi>${escapeHtml(page.clientName)}</bdi></dd>
<dt>Device</dt><dd><bdi>${escapeHtml(page.deviceName)}</bdi></dd>
<dt>Returns to</dt><dd><bdi>${escapeHtml(redirectHost(page.redirectUri))}</bdi></dd>
<dt>Resource</dt><dd class="consent__mono"><bdi>${escapeHtml(page.resource)}</bdi></dd>
</dl>
${loopbackWarning(page.redirectUri)}${authoritySection()}
<form class="consent__form" method="post" action="/api/mcp/oauth/consent">
<input type="hidden" name="csrf" value="${escapeHtml(page.csrfToken)}">
<div class="consent__actions">
<button class="button button--primary" type="submit" name="decision" value="allow">Allow access</button>
<button class="button button--secondary" type="submit" name="decision" value="deny">Deny</button>
</div>
</form>`
  return pageResponse("Allow access to YCoding", body, 200, cookies)
}

export function errorResponse(status: number, page: ErrorPage, cookies: readonly string[] = []): Response {
  const body = `
<h1 class="consent__title">${escapeHtml(page.title)}</h1>
<p class="consent__lead" role="alert">${escapeHtml(page.message)}</p>
<p class="consent__hint">Return to your MCP client and start the connection again.</p>`
  return pageResponse(page.title, body, status, cookies)
}

function authoritySection(): string {
  return `<h2 class="consent__heading">Access it will have</h2>
<ul class="consent__list">
${authorityLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("\n")}
</ul>`
}

function loopbackWarning(redirectUri: string): string {
  if (!isLoopbackRedirect(redirectUri)) return ""
  return `<p class="consent__warning" role="note"><strong>Local address.</strong> This application returns to a program on the computer running your browser. Continue only if you started this connection from an application on your own computer.</p>
`
}

function redirectHost(redirectUri: string): string {
  return new URL(redirectUri).host
}

function pageResponse(title: string, body: string, status: number, cookies: readonly string[]): Response {
  const nonce = randomToken(16)
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  })
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${consentStyles}</style>
</head>
<body>
<main class="consent">
<p class="consent__brand">YCoding</p>${body}
</main>
</body>
</html>
`
  return withSecurityHeaders(new Response(html, { status, headers }))
}
