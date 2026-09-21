import { For, Show, createSignal, type JSX } from "solid-js"
import { Link, useRouter } from "../router/router"
import { SITE } from "../content/site"
import { useTheme } from "../theme/theme-store"
import { themePreferenceLabel } from "../theme/theme"
import { shouldShowOfflineNotice, useOnlineStatus } from "./online"
import { Modal } from "./modal"
import { Icon, type IconName } from "./icon"
import { Chip } from "./chip"
import { CodeBlock } from "./docs"

const featureIcons: Record<string, IconName> = {
  terminal: "terminal",
  puzzle: "package",
  target: "target",
  shield: "shield",
  bell: "bell",
  devices: "devices",
}

export function BrandMark(props: { readonly compact?: boolean }): JSX.Element {
  return (
    <>
      <span class="brand__mark">
        <img src="/brand/ycoding-mark.svg" alt="" width="28" height="28" />
      </span>
      <span class="brand__text">
        <span class="brand__name">{SITE.productName}</span>
        <Show when={!props.compact}>
          <span class="brand__descriptor">{SITE.descriptor}</span>
        </Show>
      </span>
    </>
  )
}

export function ThemeToggle(): JSX.Element {
  const theme = useTheme()
  const label = () => `Theme: ${themePreferenceLabel(theme.preference())}. Switch theme.`
  const icon = () => (theme.preference() === "system" ? "monitor" : theme.resolved() === "dark" ? "moon" : "sun")
  return (
    <button
      type="button"
      class="button button--ghost button--icon"
      aria-label={label()}
      title={label()}
      onClick={() => theme.cycle()}
    >
      <Icon name={icon()} />
    </button>
  )
}

export function OfflineBanner(): JSX.Element {
  const online = useOnlineStatus()
  return (
    <Show when={shouldShowOfflineNotice(online())}>
      <div class="offline-banner" role="status">
        <Icon name="alert" size={16} />
        <span>You are offline. Documentation already loaded stays readable; remote controls need a live connection.</span>
      </div>
    </Show>
  )
}

export function MarketingLayout(props: { readonly children: JSX.Element }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const router = useRouter()
  const inDocs = () => router.path().startsWith("/docs")
  const inChangelog = () => router.path().startsWith("/changelog")
  return (
    <div class="marketing">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <OfflineBanner />
      <header class="app-header">
        <div class="container app-header__inner">
          <Link href="/" class="brand">
            <BrandMark />
          </Link>
          <nav class="nav" aria-label="Primary">
            <Link href="/docs" class={`nav__link${inDocs() ? " nav__link--active" : ""}`}>
              Docs
            </Link>
            <Link href="/changelog" class={`nav__link${inChangelog() ? " nav__link--active" : ""}`}>
              Changelog
            </Link>
            <a class="nav__link" href={SITE.repositoryURL} rel="noreferrer noopener" target="_blank">
              GitHub
              <Icon name="external" size={14} />
            </a>
          </nav>
          <div class="app-header__end">
            <span class="app-header__theme">
              <ThemeToggle />
            </span>
            <span class="app-header__cta">
              <Link href="/remote" class="button button--primary">
                Open Remote
                <Icon name="chevron-right" size={16} />
              </Link>
            </span>
            <button
              type="button"
              class="button button--ghost button--icon app-header__menu"
              aria-label="Navigation"
              aria-expanded={open()}
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>
          </div>
        </div>
      </header>

      <Show when={open()}>
        <Modal class="overlay--sheet" label="Navigation" onClose={() => setOpen(false)}>
          <nav class="docs-nav pane" aria-label="Site">
            <Link href="/" class="docs-nav__link" onClick={() => setOpen(false)}>
              Home
            </Link>
            <Link href="/docs" class="docs-nav__link" onClick={() => setOpen(false)}>
              Documentation
            </Link>
            <Link href="/changelog" class="docs-nav__link" onClick={() => setOpen(false)}>
              Changelog
            </Link>
            <Link href="/remote" class="docs-nav__link" onClick={() => setOpen(false)}>
              Remote workspace
            </Link>
            <a class="docs-nav__link" href={SITE.repositoryURL} rel="noreferrer noopener" target="_blank">
              GitHub
            </a>
          </nav>
        </Modal>
      </Show>

      <main id="main" tabindex="-1">
        {props.children}
      </main>

      <footer class="site-footer">
        <div class="container">
          <div class="footer__grid">
            <div class="footer__brand">
              <Link href="/" class="brand">
                <BrandMark />
              </Link>
              <p class="footer__note">{SITE.description}</p>
            </div>
            <For each={SITE.footerColumns}>
              {(column) => (
                <div>
                  <h2 class="footer__title">{column.title}</h2>
                  <div class="footer__links">
                    <For each={column.links}>
                      {(link) =>
                        link.href.startsWith("http") ? (
                          <a href={link.href} rel="noreferrer noopener" target="_blank">
                            {link.label}
                          </a>
                        ) : (
                          <Link href={link.href}>{link.label}</Link>
                        )
                      }
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div class="footer__legal">
            <span>MIT licensed. Terminal-first, local execution.</span>
            <span>{SITE.origin.replace("https://", "")}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

/**
 * The terminal plate replaces the shipped product mock's rail and phone stack with
 * one plate and one callout bar. Its text is the shipped illustration: the same
 * session lines the mock showed, read as terminal lines.
 */
function TerminalPlate(): JSX.Element {
  return (
    <div class="terminal-plate" aria-label="YCoding session on Studio Mac">
      <div class="terminal-plate__bar" aria-hidden="true">
        <span class="terminal-plate__dot" />
        <span class="terminal-plate__dot" />
        <span class="terminal-plate__dot" />
        <span class="terminal-plate__title">Studio Mac</span>
      </div>
      <div class="terminal-plate__body">
        <div class="terminal-plate__row">
          <span class="terminal-plate__key">›</span>
          <span class="terminal-plate__step">Refactor the session store and run the tests.</span>
        </div>
        <div class="terminal-plate__row">
          <span class="terminal-plate__note">·</span>
          <span class="terminal-plate__step">Reading the session module</span>
        </div>
        <div class="terminal-plate__row">
          <span class="terminal-plate__note">·</span>
          <span class="terminal-plate__step">Editing durable admission</span>
        </div>
        <div class="terminal-plate__row">
          <span class="terminal-plate__note">·</span>
          <span class="terminal-plate__step">Running the targeted tests</span>
        </div>
      </div>
    </div>
  )
}

export function LandingPage(): JSX.Element {
  const router = useRouter()
  return (
    <>
      <section class="hero">
        <div class="container hero__grid">
          <div>
            <p class="hero__eyebrow">
              <For each={SITE.hero.eyebrow}>
                {(item, index) => (
                  <>
                    <span>{item}</span>
                    <Show when={index() < SITE.hero.eyebrow.length - 1}>
                      <span class="hero__times" aria-hidden="true">
                        ×
                      </span>
                    </Show>
                  </>
                )}
              </For>
            </p>
            <h1 class="hero__headline">{SITE.hero.headline}</h1>
            {/* The second support line carries the plate's callout bar, so it is
                rendered once, where the approved composition puts it. */}
            <p class="hero__support">{SITE.hero.support[0]}</p>
            <div class="hero__actions">
              <button
                type="button"
                class="button button--primary button--large"
                onClick={() => router.navigate(SITE.hero.primaryAction.href)}
              >
                <Icon name="terminal" size={18} />
                {SITE.hero.primaryAction.label}
                <Icon name="chevron-right" size={16} />
              </button>
              <button
                type="button"
                class="button button--secondary button--large"
                onClick={() => router.navigate(SITE.hero.secondaryAction.href)}
              >
                {SITE.hero.secondaryAction.label}
              </button>
            </div>
            <p class="hero__footnote">{SITE.hero.footnote}</p>
          </div>
          <div>
            <TerminalPlate />
            <div class="callout-bar">
              <Icon name="devices" size={18} />
              <span>{SITE.hero.support[1]}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="section features" aria-label="Capabilities">
        <div class="container">
          <div class="features__grid">
            <For each={SITE.features}>
              {(feature) => (
                <article class="feature">
                  <span class="feature__icon" aria-hidden="true">
                    <Icon name={featureIcons[feature.icon] ?? "terminal"} />
                  </span>
                  <h2 class="feature__title">{feature.title}</h2>
                  <p class="feature__text">{feature.text}</p>
                </article>
              )}
            </For>
          </div>
        </div>
      </section>

      <section class="section trust" aria-label="Why local">
        <div class="container">
          <div class="trust__grid">
            <For each={SITE.trust}>
              {(item) => (
                <article class="trust__item">
                  <h2 class="trust__title">{item.title}</h2>
                  <p class="prose">{item.text}</p>
                </article>
              )}
            </For>
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="install-heading">
        <div class="container install">
          <div>
            <h2 id="install-heading">Install YCoding</h2>
            <p class="prose">
              The installer downloads the newest release, verifies its SHA-256 checksum, and puts the terminal
              application in
              <code> ~/.local/bin</code>.
            </p>
            <div class="install__platforms">
              <For each={SITE.installing.platforms}>{(platform) => <Chip label={platform} />}</For>
            </div>
            <p class="install__link">
              <Link href="/docs/installation" class="text-link">
                Installation guide
                <Icon name="chevron-right" size={14} />
              </Link>
            </p>
          </div>
          <div class="install__commands">
            <CodeBlock code={SITE.installing.command} language="shell" label="Terminal" />
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="remote-heading">
        <div class="container">
          <div class="callout-bar">
            <Icon name="devices" size={18} />
            <span class="callout-bar__body">
              <strong id="remote-heading">{SITE.remoteStatus.title}</strong>
              <span>{SITE.remoteStatus.body}</span>
            </span>
            <span class="callout-bar__action">
              <Link href={SITE.remoteStatus.cta.href} class="button button--secondary">
                {SITE.remoteStatus.cta.label}
                <Icon name="chevron-right" size={16} />
              </Link>
            </span>
          </div>
        </div>
      </section>
    </>
  )
}

export function NotFoundPage(): JSX.Element {
  return (
    <div class="not-found">
      <p class="not-found__eyebrow">404</p>
      <h1>That page does not exist.</h1>
      <p class="prose">The link may be outdated, or the page may have moved into the documentation.</p>
      <div class="not-found__actions">
        <Link href="/docs" class="button button--primary">
          Browse documentation
        </Link>
        <Link href="/" class="button button--secondary">
          Go home
        </Link>
      </div>
    </div>
  )
}
